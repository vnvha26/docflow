import {
  ConflictException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException,
  ServiceUnavailableException, UnsupportedMediaTypeException,
} from '@nestjs/common';
import { FileCopyKind, Prisma, PrivacyLevel } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { API_CONFIG, ApiConfig } from '../config';
import { encryptedSize } from '../crypto/file-encryption';
import { FileVault } from '../crypto/file-vault.service';
import { lockUserFiles } from '../database/locks';
import { PrismaService } from '../database/prisma.service';
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
const UPLOAD_IN_PROGRESS = 'Một bản giống hệt tệp này đang được tải lên. Vui lòng thử lại sau ít giây.';

interface Duplicate { documentId: string; inFlight: boolean }
const SUMMARY_SELECT = {
  id: true, title: true, createdAt: true, typeCode: true, privacyLevel: true,
  user: { select: { privacyLevel: true } },
  versions: {
    orderBy: { number: 'desc' }, take: 1,
    select: { id: true, originalFilename: true, mimeType: true, byteSize: true, parseState: true },
  },
  fileCopies: { where: { kind: 'ENCRYPTED_COPY', state: { in: ['AVAILABLE', 'DELETE_PENDING'] } }, select: { versionId: true, state: true } },
} satisfies Prisma.DocumentSelect;
type SummaryRow = Prisma.DocumentGetPayload<{ select: typeof SUMMARY_SELECT }>;

function toSummary(row: SummaryRow): DocumentSummary {
  const version = row.versions[0];
  const privacyLevel = effectivePrivacy(row.user.privacyLevel, row.privacyLevel);
  return {
    id: row.id, title: row.title, createdAt: row.createdAt, typeCode: row.typeCode, privacyLevel,
    status: version.parseState,
    file: { name: version.originalFilename, mimeType: version.mimeType, byteSize: Number(version.byteSize) },
    privacyOverride: row.privacyLevel,
    originalAvailable: privacyLevel === 'ENCRYPTED_COPY'
      && row.fileCopies.some((copy) => copy.versionId === version.id && copy.state === 'AVAILABLE'),
    originalDeleting: row.fileCopies.some((copy) => copy.versionId === version.id && copy.state === 'DELETE_PENDING'),
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

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ObjectStorage) private readonly storage: ObjectStorage,
    @Inject(FileVault) private readonly vault: FileVault,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  private async duplicateOf(db: Prisma.TransactionClient, userId: string, sha256: string, size: number): Promise<Duplicate | null> {
    const version = await db.documentVersion.findFirst({
      where: {
        userId, sha256, byteSize: BigInt(size), document: { deletedAt: null },
        fileCopies: { none: { state: 'UPLOADING', createdAt: { lt: new Date(Date.now() - STALE_UPLOAD_MS) } } },
      },
      orderBy: { createdAt: 'asc' },
      select: { documentId: true, fileCopies: { where: { state: 'UPLOADING' }, select: { id: true }, take: 1 } },
    });
    return version ? { documentId: version.documentId, inFlight: version.fileCopies.length > 0 } : null;
  }

  private async settledDuplicate(userId: string, sha256: string, size: number): Promise<string | null> {
    const deadline = Date.now() + IN_FLIGHT_WAIT_MS;
    for (;;) {
      const known = await this.duplicateOf(this.prisma, userId, sha256, size);
      if (!known) return null;
      if (!known.inFlight) return known.documentId;
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

    let plan: { duplicateOf: string } | { kind: FileCopyKind; key: string } | null = null;
    let dek: Buffer | null = null;
    for (let attempt = 0; !plan; attempt++) {
      const settled = await this.settledDuplicate(userId, sha256, file.size);
      if (settled) return { document: await this.summary(userId, settled), duplicate: true };
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
      const stored = await this.prisma.fileCopy.updateMany({
        where: { id: copyId, state: 'UPLOADING' }, data: { state: 'AVAILABLE', sha256: sealed.sha256 },
      });
      if (stored.count === 0) await this.storage.delete(plan.key).catch(() => undefined);
    } catch (error) {
      this.logger.error(`Không thể lưu tệp đã mã hóa (copy ${copyId}).`);
      await this.discard(documentId, versionId, copyId, plan.key);
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Chưa thể lưu tệp lúc này. Vui lòng thử lại sau.');
    }
    return { document: await this.summary(userId, documentId), duplicate: false };
  }

  private async reserve(transaction: Prisma.TransactionClient, input: {
    userId: string; sha256: string; size: number; storedBytes: number; documentId: string; versionId: string;
    copyId: string; keyRef: string; title: string; mimeType: string; fileName: string;
  }): Promise<{ duplicateOf: string } | { kind: FileCopyKind; key: string } | null> {
    const { userId, sha256, documentId, versionId, copyId, keyRef, title, storedBytes, fileName } = input;
    const file = { size: input.size };
    const type = { mimeType: input.mimeType };
    await lockUserFiles(transaction, userId);
    const duplicate = await this.duplicateOf(transaction, userId, sha256, file.size);
    if (duplicate) return duplicate.inFlight ? null : { duplicateOf: duplicate.documentId };
    const user = await transaction.user.findUnique({ where: { id: userId }, select: { privacyLevel: true } });
    if (!user) throw new NotFoundException('Không tìm thấy tài khoản.');
    const kind: FileCopyKind = user.privacyLevel === 'ENCRYPTED_COPY' ? 'ENCRYPTED_COPY' : 'WEB_SOURCE';
    if (kind === 'ENCRYPTED_COPY') await this.checkQuota(transaction, userId, storedBytes);
    const key = storageKey(kind === 'ENCRYPTED_COPY' ? 'encrypted' : 'web-source', userId, copyId);
    await transaction.document.create({ data: { id: documentId, userId, title, source: 'WEB_UPLOAD' } });
    await transaction.documentVersion.create({
      data: {
        id: versionId, userId, documentId, number: 1, sha256, byteSize: BigInt(file.size),
        mimeType: type.mimeType, originalFilename: fileName, source: 'WEB_UPLOAD',
      },
    });
    await transaction.fileCopy.create({
      data: {
        id: copyId, userId, documentId, versionId, kind, state: 'UPLOADING', storageKey: key,
        contentType: 'application/octet-stream', byteSize: BigInt(storedBytes), encryptionKeyRef: keyRef,
        expiresAt: kind === 'WEB_SOURCE' ? new Date(Date.now() + this.config.files.webSourceTtlMs) : null,
      },
    });
    return { kind, key };
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

  private async discard(documentId: string, versionId: string, copyId: string, key: string): Promise<void> {
    await this.storage.delete(key).catch(() => undefined);
    try {
      await this.prisma.$transaction([
        this.prisma.fileCopy.deleteMany({ where: { id: copyId, state: 'UPLOADING' } }),
        this.prisma.documentVersion.deleteMany({ where: { id: versionId } }),
        this.prisma.document.deleteMany({ where: { id: documentId } }),
      ]);
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

