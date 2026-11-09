import {
  ConflictException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException,
  ServiceUnavailableException, UnprocessableEntityException, UnsupportedMediaTypeException,
} from '@nestjs/common';
import { FileCopyKind, Prisma, PrivacyLevel } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { API_CONFIG, ApiConfig } from '../config';
import { encryptedSize } from '../crypto/file-encryption';
import { FileVault } from '../crypto/file-vault.service';
import { lockUserFiles } from '../database/locks';
import { PrismaService } from '../database/prisma.service';
import { JobQueue } from '../jobs/job-queue.service';
import { renderDocxHtml } from '../parsing/text-extract';
import { ParserFailedError, UnsupportedDocumentError } from '../parsing/text';
import { ObjectStorage, storageKey } from '../storage/object-storage';
import { cleanTitle, sanitizeFileName, titleFromFileName } from './file-name';
import { detectFileType } from './file-type';
import { effectivePrivacy } from './privacy';
import { DocumentSummary, MAX_UPLOAD_BYTES, StorageUsage, TOO_LARGE_MESSAGE, UploadResult } from './documents.types';

export interface UploadedFile { buffer: Buffer; originalname: string; size: number }

const LIVE = ['UPLOADING', 'AVAILABLE'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IN_FLIGHT_WAIT_MS = 15_000;
const IN_FLIGHT_POLL_MS = 200;
const STALE_UPLOAD_MS = 5 * 60_000;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_PREVIEWS = 2;
const PREVIEW_LIMITS = { timeoutMs: 60_000, memoryMb: 512 };
const UPLOAD_IN_PROGRESS ='Một bản giống hệt tệp này đang được tải lên. Vui lòng thử lại sau ít giây.';

interface Duplicate {
  documentId: string; versionId: string; documentLevel: PrivacyLevel | null; inFlight: boolean; revivable: boolean; retryable: boolean;
}
interface Reserved { kind: FileCopyKind; key: string; documentId: string; versionId: string; revived: boolean }
type Plan = { duplicateOf: string } | Reserved;
const SUMMARY_SELECT = {
  id: true, title: true, createdAt: true, updatedAt: true, typeCode: true, privacyLevel: true,
  user: { select: { privacyLevel: true } },
  versions: {
    orderBy: { number: 'desc' }, take: 1,
    select: { id: true, originalFilename: true, mimeType: true, byteSize: true, parseState: true, parseErrorCode: true, pageCount: true, updatedAt: true },
  },
  extractedMetadata: { where: { summary: { not: null } }, orderBy: { createdAt: 'desc' }, take: 1, select: { summary: true } },
  fileCopies: { where: { kind: 'ENCRYPTED_COPY', state: { in: ['AVAILABLE', 'DELETE_PENDING'] } }, select: { versionId: true, state: true } },
} satisfies Prisma.DocumentSelect;
type SummaryRow = Prisma.DocumentGetPayload<{ select: typeof SUMMARY_SELECT }>;

function toSummary(row: SummaryRow): DocumentSummary {
  const version = row.versions[0];
  const privacyLevel = effectivePrivacy(row.user.privacyLevel, row.privacyLevel);
  const detailsDeleted = row.privacyLevel === 'STRUCTURED_ONLY';
  return {
    id: row.id, title: row.title, createdAt: row.createdAt, typeCode: row.typeCode,
    status: version.parseState,
    problem: !detailsDeleted && (version.parseState === 'FAILED' || version.parseState === 'UNSUPPORTED') ? version.parseErrorCode : null,
    file: { name: version.originalFilename, mimeType: version.mimeType, byteSize: Number(version.byteSize) },
    originalAvailable: privacyLevel === 'ENCRYPTED_COPY'
      && row.fileCopies.some((copy) => copy.versionId === version.id && copy.state === 'AVAILABLE'),
    originalDeleting: row.fileCopies.some((copy) => copy.versionId === version.id && copy.state === 'DELETE_PENDING'),
    updatedAt: row.updatedAt > version.updatedAt ? row.updatedAt : version.updatedAt,
    pageCount: version.pageCount,
    summary: privacyLevel === 'STRUCTURED_ONLY' ? null : row.extractedMetadata[0]?.summary ?? null,
    detailsDeleted,
  };
}

function fieldError(field: string, message: string, status = HttpStatus.BAD_REQUEST): HttpException {
  return new HttpException({ statusCode: status, message, fieldErrors: { [field]: message } }, status);
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 * 1024 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${Math.ceil(bytes / 1024 ** 2)} MB`;
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [time, id, extra] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(time ?? '');
  if (extra !== undefined || Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== time || !UUID.test(id ?? '')) {
    throw fieldError('cursor', 'Con trỏ phân trang không hợp lệ.');
  }
  return { createdAt, id };
}

async function collect(body: Readable, decrypt: NodeJS.ReadWriteStream, expectedBytes: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > expectedBytes) return callback(new Error('SOURCE_CORRUPT'));
      parts.push(chunk);
      callback();
    },
  });
  try {
    await pipeline(body, decrypt, sink);
    if (total !== expectedBytes) throw new Error('SOURCE_CORRUPT');
    return Buffer.concat(parts, total);
  } finally {
    for (const part of parts) part.fill(0);
  }
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);
  private previewing = 0;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ObjectStorage) private readonly storage: ObjectStorage,
    @Inject(FileVault) private readonly vault: FileVault,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(JobQueue) private readonly jobs: JobQueue,
  ) {}

  private async duplicateOf(db: Prisma.TransactionClient, userId: string, sha256: string, size: number): Promise<Duplicate | null> {
    const version = await db.documentVersion.findFirst({
      where: {
        userId, sha256, byteSize: BigInt(size), document: { deletedAt: null },
        fileCopies: { none: { state: 'UPLOADING', createdAt: { lt: new Date(Date.now() - STALE_UPLOAD_MS) } } },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, documentId: true, parseState: true, document: { select: { privacyLevel: true } }, fileCopies: { where: { state: { in: [...LIVE] } }, select: { state: true } } },
    });
    if (!version) return null;
    return {
      documentId: version.documentId,
      versionId: version.id,
      documentLevel: version.document.privacyLevel,
      inFlight: version.fileCopies.some((copy) => copy.state === 'UPLOADING'),
      revivable: version.parseState === 'FAILED' && version.fileCopies.length === 0,
      retryable: version.parseState === 'FAILED' && version.fileCopies.some((copy) => copy.state === 'AVAILABLE'),
    };
  }

  private async settledDuplicate(userId: string, sha256: string, size: number): Promise<Duplicate | null> {
    const deadline = Date.now() + IN_FLIGHT_WAIT_MS;
    for (;;) {
      const known = await this.duplicateOf(this.prisma, userId, sha256, size);
      if (!known) return null;
      if (!known.inFlight) return known;
      if (Date.now() >= deadline) throw new ConflictException(UPLOAD_IN_PROGRESS);
      await sleep(IN_FLIGHT_POLL_MS);
    }
  }

  private async summary(userId: string, documentId: string): Promise<DocumentSummary> {
    const row = await this.prisma.document.findFirst({ where: { id: documentId, userId, deletedAt: null }, select: SUMMARY_SELECT });
    if (!row || !row.versions.length) throw new NotFoundException('Không tìm thấy tài liệu.');
    return toSummary(row);
  }

  async upload(userId: string, file: UploadedFile | undefined, requestedTitle?: string): Promise<UploadResult> {
    if (!file) throw fieldError('file', 'Chọn một tệp để tải lên.');
    if (file.size === 0) throw fieldError('file', 'Tệp rỗng, không có gì để lưu.');
    if (file.size > MAX_UPLOAD_BYTES) throw fieldError('file', TOO_LARGE_MESSAGE, HttpStatus.PAYLOAD_TOO_LARGE);
    const type = detectFileType(file.buffer, file.originalname);
    if (!type) {
      throw new UnsupportedMediaTypeException('Chỉ hỗ trợ PDF, DOCX và TXT (mã hóa UTF-8). Hãy lưu lại tệp ở một trong các định dạng này.');
    }
    const fileName = sanitizeFileName(file.originalname, type.extension);
    const title = cleanTitle(requestedTitle) ?? titleFromFileName(fileName);
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');

    const documentId = randomUUID();
    const versionId = randomUUID();
    const copyId = randomUUID();
    const context = { copyId, userId };
    const storedBytes = encryptedSize(file.size);

    let plan: Plan | null = null;
    let dek: Buffer | null = null;
    for (let attempt = 0; !plan; attempt++) {
      const settled = await this.settledDuplicate(userId, sha256, file.size);
      if (settled && !settled.revivable) {
        if (settled.retryable) await this.retryParse(userId, settled.versionId);
        return { document: await this.summary(userId, settled.documentId), duplicate: true };
      }
      if (attempt >= 3) throw new ConflictException(UPLOAD_IN_PROGRESS);
      const key = this.vault.newKey(context);
      dek = key.dek;
      try {
        plan = await this.prisma.$transaction(async (transaction) => this.reserve(transaction, {
          userId, sha256, size: file.size, storedBytes, documentId, versionId, copyId, keyRef: key.keyRef,
          title, mimeType: type.mimeType, fileName,
        }));
      } catch (error) {
        dek.fill(0);
        throw error;
      }
      if (plan === null) dek.fill(0);
    }
    if ('duplicateOf' in plan) {
      dek!.fill(0);
      return { document: await this.summary(userId, plan.duplicateOf), duplicate: true };
    }

    try {
      const sealed = await this.vault.seal(dek!, context, file.buffer);
      await this.storage.put(plan.key, sealed.data);
      const reserved = plan;
      const stored = await this.prisma.$transaction(async (transaction) => {
        const result = await transaction.fileCopy.updateMany({
          where: { id: copyId, state: 'UPLOADING' }, data: { state: 'AVAILABLE', sha256: sealed.sha256 },
        });
        if (result.count === 1) {
          await this.jobs.enqueue(transaction, {
            userId, kind: 'PARSE', documentId: reserved.documentId, versionId: reserved.versionId,
            idempotencyKey: `parse:${reserved.versionId}:${copyId}`, maxAttempts: 3,
          });
        }
        return result.count;
      });
      if (stored === 0) await this.storage.delete(plan.key).catch(() => undefined);
    } catch (error) {
      this.logger.error(`Không thể lưu tệp đã mã hóa (copy ${copyId}).`);
      await this.discard(plan, copyId);
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Chưa thể lưu tệp lúc này. Vui lòng thử lại sau.');
    }
    return { document: await this.summary(userId, plan.documentId), duplicate: false };
  }

  private async retryParse(userId: string, versionId: string): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await lockUserFiles(transaction, userId);
      const version = await transaction.documentVersion.findFirst({
        where: { id: versionId, userId, parseState: 'FAILED', fileCopies: { some: { state: 'AVAILABLE' } } },
        select: { id: true, documentId: true },
      });
      if (!version) return;
      await transaction.documentVersion.update({ where: { id: version.id }, data: { parseState: 'PENDING', parseErrorCode: null } });
      await this.jobs.enqueue(transaction, {
        userId, kind: 'PARSE', documentId: version.documentId, versionId: version.id,
        idempotencyKey: `parse:${version.id}:retry:${randomUUID()}`, maxAttempts: 3,
      });
    });
  }

  private async reserve(transaction: Prisma.TransactionClient, input: {
    userId: string; sha256: string; size: number; storedBytes: number; documentId: string; versionId: string;
    copyId: string; keyRef: string; title: string; mimeType: string; fileName: string;
  }): Promise<Plan | null> {
    const { userId, sha256, documentId, versionId, copyId, keyRef, title, storedBytes, fileName } = input;
    const file = { size: input.size };
    const type = { mimeType: input.mimeType };
    await lockUserFiles(transaction, userId);
    const duplicate = await this.duplicateOf(transaction, userId, sha256, file.size);
    if (duplicate?.inFlight) return null;
    if (duplicate && !duplicate.revivable) return { duplicateOf: duplicate.documentId };
    const user = await transaction.user.findUnique({ where: { id: userId }, select: { privacyLevel: true } });
    if (!user) throw new NotFoundException('Không tìm thấy tài khoản.');
    const level = effectivePrivacy(user.privacyLevel, duplicate?.documentLevel ?? null);
    const kind: FileCopyKind = level === 'ENCRYPTED_COPY' ? 'ENCRYPTED_COPY' : 'WEB_SOURCE';
    if (kind === 'ENCRYPTED_COPY') await this.checkQuota(transaction, userId, storedBytes);
    const key = storageKey(kind === 'ENCRYPTED_COPY' ? 'encrypted' : 'web-source', userId, copyId);
    const target = duplicate
      ? { documentId: duplicate.documentId, versionId: duplicate.versionId }
      : { documentId, versionId };
    if (duplicate) {
      await transaction.documentVersion.update({ where: { id: duplicate.versionId }, data: { parseState: 'PENDING', parseErrorCode: null } });
    } else {
      await transaction.document.create({ data: { id: documentId, userId, title, source: 'WEB_UPLOAD' } });
      await transaction.documentVersion.create({
        data: {
          id: versionId, userId, documentId, number: 1, sha256, byteSize: BigInt(file.size),
          mimeType: type.mimeType, originalFilename: fileName, source: 'WEB_UPLOAD',
        },
      });
    }
    await transaction.fileCopy.create({
      data: {
        id: copyId, userId, documentId: target.documentId, versionId: target.versionId, kind, state: 'UPLOADING', storageKey: key,
        contentType: 'application/octet-stream', byteSize: BigInt(storedBytes), encryptionKeyRef: keyRef,
        expiresAt: kind === 'WEB_SOURCE' ? new Date(Date.now() + this.config.files.webSourceTtlMs) : null,
      },
    });
    return { kind, key, ...target, revived: Boolean(duplicate) };
  }

  private async checkQuota(transaction: Prisma.TransactionClient, userId: string, incoming: number): Promise<void> {
    const used = await this.encryptedBytes(transaction, userId);
    const quota = this.config.files.encryptedQuotaBytes;
    if (used + incoming > quota) {
      throw fieldError('file',
        `Vượt hạn mức lưu bản gốc: đã dùng ${formatBytes(used)} / ${formatBytes(quota)}. Hãy xóa bớt bản gốc hoặc chọn mức lưu trữ thấp hơn.`,
        HttpStatus.PAYLOAD_TOO_LARGE);
    }
  }

  private async encryptedBytes(db: Prisma.TransactionClient, userId: string): Promise<number> {
    const result = await db.fileCopy.aggregate({
      where: { userId, kind: 'ENCRYPTED_COPY', state: { in: [...LIVE] } }, _sum: { byteSize: true },
    });
    return Number(result._sum.byteSize ?? 0n);
  }

  private async discard(plan: Reserved, copyId: string): Promise<void> {
    await this.storage.delete(plan.key).catch(() => undefined);
    try {
      if (plan.revived) {
        await this.prisma.$transaction([
          this.prisma.fileCopy.deleteMany({ where: { id: copyId, state: 'UPLOADING' } }),
          this.prisma.documentVersion.updateMany({
            where: { id: plan.versionId, parseState: 'PENDING' }, data: { parseState: 'FAILED', parseErrorCode: 'SOURCE_UNAVAILABLE' },
          }),
        ]);
      } else {
        await this.prisma.$transaction([
          this.prisma.fileCopy.deleteMany({ where: { id: copyId, state: 'UPLOADING' } }),
          this.prisma.aIJob.deleteMany({ where: { versionId: plan.versionId } }),
          this.prisma.documentVersion.deleteMany({ where: { id: plan.versionId } }),
          this.prisma.document.deleteMany({ where: { id: plan.documentId } }),
        ]);
      }
    } catch {
      this.logger.warn(`Không thể dọn bản ghi upload lỗi (copy ${copyId}); sẽ được dọn sau.`);
    }
  }

  async list(userId: string, cursor?: string, limit = 20): Promise<{ items: DocumentSummary[]; nextCursor: string | null }> {
    const after = cursor ? decodeCursor(cursor) : null;
    const rows = await this.prisma.document.findMany({
      where: {
        userId, deletedAt: null, versions: { some: {} },
        ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: SUMMARY_SELECT,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map(toSummary),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  get(userId: string, documentId: string): Promise<DocumentSummary> {
    return this.summary(userId, documentId);
  }

  async usage(userId: string): Promise<StorageUsage> {
    return { encryptedBytes: await this.encryptedBytes(this.prisma, userId), quotaBytes: this.config.files.encryptedQuotaBytes };
  }

  async preview(userId: string, documentId: string): Promise<string> {
    const original = await this.openOriginal(userId, documentId);
    if (original.mimeType !== DOCX) {
      original.body.destroy();
      throw new NotFoundException('Chỉ tạo bản xem cho tệp DOCX.');
    }
    if (this.previewing >= MAX_PREVIEWS) {
      original.body.destroy();
      throw new ServiceUnavailableException('Đang tạo bản xem cho tài liệu khác. Vui lòng thử lại sau ít giây.');
    }
    this.previewing++;
    let file: Buffer | null = null;
    try {
      file = await collect(original.body, original.decrypt, original.byteSize);
      return await renderDocxHtml(file, PREVIEW_LIMITS);
    } catch (error) {
      if (error instanceof UnsupportedDocumentError || error instanceof ParserFailedError) {
        throw new UnprocessableEntityException('Không tạo được bản xem cho tệp này. Hãy dùng "Tải bản gốc" để mở bằng Word.');
      }
      this.logger.error(`Không tạo được bản xem (document ${documentId}).`);
      throw new ServiceUnavailableException('Chưa thể tạo bản xem lúc này. Vui lòng thử lại sau.');
    } finally {
      file?.fill(0);
      this.previewing--;
    }
  }

  async openOriginal(userId: string, documentId: string): Promise<{
    body: Readable; decrypt: NodeJS.ReadWriteStream; fileName: string; mimeType: string; byteSize: number;
  }> {
    const row = await this.prisma.document.findFirst({
      where: { id: documentId, userId, deletedAt: null },
      select: {
        privacyLevel: true, user: { select: { privacyLevel: true } },
        versions: { orderBy: { number: 'desc' }, take: 1, select: { id: true, originalFilename: true, mimeType: true, byteSize: true } },
      },
    });
    const version = row?.versions[0];
    const level: PrivacyLevel | null = row ? effectivePrivacy(row.user.privacyLevel, row.privacyLevel) : null;
    const copy = version && level === 'ENCRYPTED_COPY'
      ? await this.prisma.fileCopy.findFirst({
        where: { userId, documentId, versionId: version.id, kind: 'ENCRYPTED_COPY', state: 'AVAILABLE' },
        select: { id: true, storageKey: true, encryptionKeyRef: true },
      })
      : null;
    if (!version || !copy?.encryptionKeyRef) throw new NotFoundException('Tài liệu này không có bản gốc để tải.');
    let decrypt: NodeJS.ReadWriteStream;
    let body: Readable;
    try {
      decrypt = this.vault.openStream(copy.encryptionKeyRef, { copyId: copy.id, userId });
      body = await this.storage.get(copy.storageKey);
    } catch {
      this.logger.error(`Không mở được bản gốc mã hóa (copy ${copy.id}).`);
      throw new ServiceUnavailableException('Chưa thể tải bản gốc lúc này. Vui lòng thử lại sau.');
    }
    return { body, decrypt, fileName: version.originalFilename, mimeType: version.mimeType, byteSize: Number(version.byteSize) };
  }
}

