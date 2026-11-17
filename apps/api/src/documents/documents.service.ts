import {
  ConflictException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException,
  ServiceUnavailableException, UnprocessableEntityException, UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ParseState, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { API_CONFIG, ApiConfig } from '../config';
import { encryptedSize } from '../crypto/file-encryption';
import { FileVault } from '../crypto/file-vault.service';
import { fieldError } from '../common/field-error';
import { lockUserFiles } from '../database/locks';
import { PrismaService } from '../database/prisma.service';
import { freeDocumentTitle } from '../folders/names';
import { JobQueue } from '../jobs/job-queue.service';
import { renderDocxHtml } from '../parsing/text-extract';
import { ParserFailedError, UnsupportedDocumentError } from '../parsing/text';
import { ObjectStorage, storageKey } from '../storage/object-storage';
import { cleanTitle, downloadName, sanitizeFileName, titleFromFileName } from './file-name';
import { Candidate, classifyDuplicates, DuplicateCheck, rankCandidates } from './duplicates';
import { detectFileType, IMAGE_MIME_TYPES } from './file-type';
import {
  DocumentChange, DocumentFilters, DocumentSort, DocumentSummary, DocumentTypeFilter, MAX_UPLOAD_BYTES, RenameResult, StorageUsage,
  TOO_LARGE_MESSAGE, UNFILED, UploadResult,
} from './documents.types';

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

interface Found extends Candidate {
  versionId: string; inFlight: boolean; retryable: boolean;
  previous: { parseState: ParseState; parseErrorCode: string | null };
}
interface Reserved {
  key: string; documentId: string; versionId: string; revived: boolean; renamed: boolean;
  previous: Found['previous'] | null;
}
interface Blocked { conflict: DuplicateCheck; documentId: string; retryVersionId: string | null }
type Plan = Blocked | Reserved;
export interface UploadDecision { mode: 'new' | 'supplement'; targetId?: string }
const SUMMARY_SELECT = {
  id: true, title: true, createdAt: true, updatedAt: true, typeCode: true, folderId: true, originalTrashedAt: true,
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
  const originalInTrash = row.originalTrashedAt !== null;
  return {
    id: row.id, title: row.title, createdAt: row.createdAt, typeCode: row.typeCode, folderId: row.folderId,
    status: version.parseState,
    problem: version.parseState === 'FAILED' || version.parseState === 'UNSUPPORTED' ? version.parseErrorCode : null,
    file: { name: version.originalFilename, mimeType: version.mimeType, byteSize: Number(version.byteSize) },
    originalAvailable: !originalInTrash && row.fileCopies.some((copy) => copy.versionId === version.id && copy.state === 'AVAILABLE'),
    originalDeleting: row.fileCopies.some((copy) => copy.versionId === version.id && copy.state === 'DELETE_PENDING'),
    updatedAt: row.updatedAt > version.updatedAt ? row.updatedAt : version.updatedAt,
    pageCount: version.pageCount,
    summary: row.extractedMetadata[0]?.summary ?? null,
    originalInTrash,
  };
}

const TYPE_MIME: Record<DocumentTypeFilter, readonly string[]> = {
  pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  txt: ['text/plain'],
  md: ['text/markdown'],
  image: IMAGE_MIME_TYPES,
};
function versionFilter(filters: DocumentFilters): Prisma.DocumentVersionWhereInput {
  return filters.type ? { mimeType: { in: [...TYPE_MIME[filters.type]] } } : {};
}

function folderFilter(folder?: string): Prisma.DocumentWhereInput {
  if (folder === undefined) return {};
  return { folderId: folder === UNFILED ? null : folder };
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 * 1024 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${Math.ceil(bytes / 1024 ** 2)} MB`;
}

type SortField = 'createdAt' | 'updatedAt' | 'title';
const SORTS: Record<DocumentSort, { field: SortField; direction: 'asc' | 'desc' }> = {
  created: { field: 'createdAt', direction: 'desc' },
  updated: { field: 'updatedAt', direction: 'desc' },
  name: { field: 'title', direction: 'asc' },
  'name-desc': { field: 'title', direction: 'desc' },
};
const INVALID_CURSOR = 'Con trỏ phân trang không hợp lệ.';

function encodeCursor(row: { createdAt: Date; updatedAt: Date; title: string; id: string }, field: SortField): string {
  const value = field === 'title' ? Buffer.from(row.title, 'utf8').toString('base64url') : row[field].toISOString();
  return Buffer.from(`${value}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, field: SortField): { value: Date | string; id: string } {
  const [raw, id, extra] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (extra !== undefined || raw === undefined || !UUID.test(id ?? '')) throw fieldError('cursor', INVALID_CURSOR);
  if (field === 'title') {
    const title = Buffer.from(raw, 'base64url').toString('utf8');
    if (!/^[A-Za-z0-9_-]+$/.test(raw) || !title || title.includes('\ufffd') || title.length > 255) throw fieldError('cursor', INVALID_CURSOR);
    return { value: title, id };
  }
  const time = new Date(raw);
  if (Number.isNaN(time.getTime()) || time.toISOString() !== raw) throw fieldError('cursor', INVALID_CURSOR);
  return { value: time, id };
}

function afterCursor(field: SortField, direction: 'asc' | 'desc', cursor: { value: Date | string; id: string }): Prisma.DocumentWhereInput {
  const beyond = direction === 'asc' ? 'gt' : 'lt';
  return { OR: [{ [field]: { [beyond]: cursor.value } }, { [field]: cursor.value, id: { [beyond]: cursor.id } }] };
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

  private async candidates(db: Prisma.TransactionClient, userId: string, sha256: string, size: number, withTrash: boolean): Promise<Found[]> {
    const versions = await db.documentVersion.findMany({
      where: {
        userId, sha256, byteSize: BigInt(size), document: { purgedAt: null, ...(withTrash ? {} : { deletedAt: null }) },
        fileCopies: { none: { state: 'UPLOADING', createdAt: { lt: new Date(Date.now() - STALE_UPLOAD_MS) } } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 50,
      select: {
        id: true, documentId: true, parseState: true, parseErrorCode: true, createdAt: true,
        document: { select: {
          title: true, folderId: true, deletedAt: true, originalTrashedAt: true, trashedById: true,
          trashItems: { select: { id: true, kind: true } },
        } },
        fileCopies: { where: { state: { in: [...LIVE] } }, select: { state: true, kind: true } },
      },
    });
    if (!versions.length) return [];
    const folders = await db.folder.findMany({ where: { userId }, select: { id: true, parentId: true, name: true } });
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const label = (id: string | null): string | null => {
      const names: string[] = [];
      for (let current = id ? byId.get(id) : undefined; current && names.length <= folders.length; current = current.parentId ? byId.get(current.parentId) : undefined) {
        names.unshift(current.name);
      }
      return names.join(' › ') || null;
    };
    const batchIds = versions.flatMap((version) => version.document.deletedAt && version.document.trashedById ? [version.document.trashedById] : []);
    const batches = new Map((batchIds.length
      ? await db.trashItem.findMany({ where: { userId, id: { in: batchIds }, kind: 'FOLDER' }, select: { id: true, name: true } })
      : []).map((entry) => [entry.id, entry.name]));
    const found: Found[] = [];
    for (const version of versions) {
      const { document, fileCopies } = version;
      const item = (kind: 'DOCUMENT' | 'ORIGINAL') => document.trashItems.find((entry) => entry.kind === kind)?.id ?? null;
      let state: Found['state'];
      let trashId: string | null = null;
      let trashFolder: string | null = null;
      if (document.deletedAt) {
        trashId = item('DOCUMENT');
        if (!trashId && document.trashedById && batches.has(document.trashedById)) {
          trashId = document.trashedById;
          trashFolder = batches.get(document.trashedById) ?? null;
        }
        if (!trashId) continue;
        state = 'trashed';
      } else if (document.originalTrashedAt) {
        state = 'original-trashed';
        trashId = item('ORIGINAL');
      } else {
        state = fileCopies.some((copy) => copy.kind === 'ENCRYPTED_COPY') ? 'full' : 'no-original';
      }
      found.push({
        documentId: version.documentId, versionId: version.id, title: document.title, folderId: document.folderId, location: label(document.folderId),
        state, trashId, trashFolder, createdAt: version.createdAt,
        inFlight: !document.deletedAt && fileCopies.some((copy) => copy.state === 'UPLOADING'),
        retryable: !document.deletedAt && version.parseState === 'FAILED' && fileCopies.some((copy) => copy.state === 'AVAILABLE'),
        previous: { parseState: version.parseState, parseErrorCode: version.parseErrorCode },
      });
    }
    return found;
  }

  private async waitForInFlight(userId: string, sha256: string, size: number): Promise<void> {
    const deadline = Date.now() + IN_FLIGHT_WAIT_MS;
    for (;;) {
      const live = await this.candidates(this.prisma, userId, sha256, size, false);
      if (!live.some((candidate) => candidate.inFlight)) return;
      if (Date.now() >= deadline) throw new ConflictException(UPLOAD_IN_PROGRESS);
      await sleep(IN_FLIGHT_POLL_MS);
    }
  }

  async check(userId: string, sha256: string, size: number, folderId: string | null): Promise<DuplicateCheck> {
    return classifyDuplicates(await this.candidates(this.prisma, userId, sha256, size, true), folderId);
  }

  private async summary(userId: string, documentId: string): Promise<DocumentSummary> {
    const row = await this.prisma.document.findFirst({ where: { id: documentId, userId, deletedAt: null }, select: SUMMARY_SELECT });
    if (!row || !row.versions.length) throw new NotFoundException('Không tìm thấy tài liệu.');
    return toSummary(row);
  }

  async upload(
    userId: string, file: UploadedFile | undefined, requestedTitle?: string, folderId: string | null = null, decision?: UploadDecision,
  ): Promise<UploadResult> {
    if (!file) throw fieldError('file', 'Chọn một tệp để tải lên.');
    if (file.size === 0) throw fieldError('file', 'Tệp rỗng, không có gì để lưu.');
    if (file.size > MAX_UPLOAD_BYTES) throw fieldError('file', TOO_LARGE_MESSAGE, HttpStatus.PAYLOAD_TOO_LARGE);
    const type = detectFileType(file.buffer, file.originalname);
    if (!type) {
      throw new UnsupportedMediaTypeException('Chỉ hỗ trợ PDF, DOCX, TXT, Markdown (mã hóa UTF-8) và ảnh PNG, JPG, WebP. Hãy lưu lại tệp ở một trong các định dạng này.');
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
      await this.waitForInFlight(userId, sha256, file.size);
      if (attempt >= 3) throw new ConflictException(UPLOAD_IN_PROGRESS);
      const key = this.vault.newKey(context);
      dek = key.dek;
      try {
        plan = await this.prisma.$transaction(async (transaction) => this.reserve(transaction, {
          userId, sha256, size: file.size, storedBytes, documentId, versionId, copyId, keyRef: key.keyRef,
          title, mimeType: type.mimeType, fileName, folderId, decision,
        }));
      } catch (error) {
        dek.fill(0);
        throw error;
      }
      if (plan === null) dek.fill(0);
    }
    if ('conflict' in plan) {
      dek!.fill(0);
      if (plan.retryVersionId) await this.retryParse(userId, plan.retryVersionId);
      return { document: await this.summary(userId, plan.documentId), duplicate: true, renamed: false, supplemented: false, conflict: plan.conflict };
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
    return { document: await this.summary(userId, plan.documentId), duplicate: false, renamed: plan.renamed, supplemented: plan.revived };
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
    copyId: string; keyRef: string; title: string; mimeType: string; fileName: string; folderId: string | null; decision?: UploadDecision;
  }): Promise<Plan | null> {
    const { userId, sha256, documentId, versionId, copyId, keyRef, title, storedBytes, fileName, folderId } = input;
    const file = { size: input.size };
    const type = { mimeType: input.mimeType };
    await lockUserFiles(transaction, userId);
    const live = await this.candidates(transaction, userId, sha256, file.size, false);
    if (live.some((candidate) => candidate.inFlight)) return null;
    const conflict = classifyDuplicates(live, folderId);
    const first = rankCandidates(live, folderId)[0];
    const blocked = (): Plan => ({ conflict, documentId: first.documentId, retryVersionId: first.retryable ? first.versionId : null });
    let duplicate: Found | null = null;
    if (input.decision?.mode === 'supplement') {
      duplicate = live.find((candidate) => candidate.documentId === input.decision!.targetId && candidate.state === 'no-original') ?? null;
      if (!duplicate) {
        if (!first) throw fieldError('targetId', 'Tài liệu cần bổ sung bản gốc không còn phù hợp. Hãy tải lại tệp để chọn lại.', HttpStatus.CONFLICT);
        return blocked();
      }
    } else if (input.decision?.mode !== 'new' && first) {
      if (conflict.situation !== 'auto-supplement') return blocked();
      duplicate = first;
    }
    await this.checkQuota(transaction, userId, storedBytes);
    const key = storageKey('encrypted', userId, copyId);
    const target = duplicate
      ? { documentId: duplicate.documentId, versionId: duplicate.versionId }
      : { documentId, versionId };
    let renamed = false;
    if (duplicate) {
      await transaction.documentVersion.update({ where: { id: duplicate.versionId }, data: { parseState: 'PENDING', parseErrorCode: null } });
      await transaction.document.update({ where: { id: duplicate.documentId }, data: { revision: { increment: 1 } } });
    } else {
      await this.assertFolder(transaction, userId, folderId);
      const free = await freeDocumentTitle(transaction, userId, folderId, title);
      renamed = free.renamed;
      await transaction.document.create({ data: { id: documentId, userId, title: free.name, folderId, source: 'WEB_UPLOAD' } });
      await transaction.documentVersion.create({
        data: {
          id: versionId, userId, documentId, number: 1, sha256, byteSize: BigInt(file.size),
          mimeType: type.mimeType, originalFilename: fileName, source: 'WEB_UPLOAD',
        },
      });
    }
    await transaction.fileCopy.create({
      data: {
        id: copyId, userId, documentId: target.documentId, versionId: target.versionId, kind: 'ENCRYPTED_COPY', state: 'UPLOADING', storageKey: key,
        contentType: 'application/octet-stream', byteSize: BigInt(storedBytes), encryptionKeyRef: keyRef,
      },
    });
    return { key, ...target, revived: Boolean(duplicate), renamed, previous: duplicate?.previous ?? null };
  }

  private async assertFolder(transaction: Prisma.TransactionClient, userId: string, folderId: string | null): Promise<void> {
    if (!folderId) return;
    const folder = await transaction.folder.findFirst({ where: { id: folderId, userId, deletedAt: null }, select: { id: true } });
    if (!folder) throw fieldError('folderId', 'Không tìm thấy thư mục.', HttpStatus.NOT_FOUND);
  }

  async update(userId: string, documentId: string, change: DocumentChange): Promise<RenameResult> {
    if (change.title === undefined && change.folderId === undefined) throw fieldError('title', 'Không có thay đổi nào để lưu.');
    const wanted = change.title === undefined ? undefined : cleanTitle(change.title);
    if (change.title !== undefined && !wanted) throw fieldError('title', 'Tên tài liệu không được để trống.');
    const renamed = await this.prisma.$transaction(async (transaction) => {
      await lockUserFiles(transaction, userId);
      const current = await transaction.document.findFirst({
        where: { id: documentId, userId, deletedAt: null, versions: { some: {} } }, select: { id: true, title: true, folderId: true },
      });
      if (!current) throw new NotFoundException('Không tìm thấy tài liệu.');
      const folderId = change.folderId === undefined ? current.folderId : change.folderId;
      if (folderId !== current.folderId) await this.assertFolder(transaction, userId, folderId);
      const free = await freeDocumentTitle(transaction, userId, folderId, wanted ?? current.title, current.id);
      if (free.name !== current.title || folderId !== current.folderId) {
        await transaction.document.update({ where: { id: current.id }, data: { title: free.name, folderId, revision: { increment: 1 } } });
      }
      return free.renamed;
    });
    return { document: await this.summary(userId, documentId), renamed };
  }

  private async checkQuota(transaction: Prisma.TransactionClient, userId: string, incoming: number): Promise<void> {
    const used = await this.encryptedBytes(transaction, userId);
    const quota = this.config.files.encryptedQuotaBytes;
    if (used + incoming > quota) {
      throw fieldError('file',
        `Vượt hạn mức lưu bản gốc: đã dùng ${formatBytes(used)} / ${formatBytes(quota)}. Tệp trong thùng rác vẫn tính vào hạn mức: hãy dọn thùng rác hoặc xóa vĩnh viễn bản gốc không cần nữa.`,
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
            where: { id: plan.versionId, parseState: 'PENDING' },
            data: { parseState: plan.previous?.parseState ?? 'FAILED', parseErrorCode: plan.previous ? plan.previous.parseErrorCode : 'SOURCE_UNAVAILABLE' },
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

  async list(userId: string, cursor?: string, limit = 20, filters: DocumentFilters = {}): Promise<{ items: DocumentSummary[]; nextCursor: string | null }> {
    const { field, direction } = SORTS[filters.sort ?? 'created'];
    const after = cursor ? decodeCursor(cursor, field) : null;
    const rows = await this.prisma.document.findMany({
      where: {
        userId, deletedAt: null, versions: { some: versionFilter(filters) }, ...folderFilter(filters.folder),
        ...(after ? afterCursor(field, direction, after) : {}),
      },
      orderBy: [{ [field]: direction }, { id: direction }],
      take: limit + 1,
      select: SUMMARY_SELECT,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map(toSummary),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1], field) : null,
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
        title: true, originalTrashedAt: true,
        versions: { orderBy: { number: 'desc' }, take: 1, select: { id: true, originalFilename: true, mimeType: true, byteSize: true } },
      },
    });
    const version = row?.versions[0];
    const copy = version && !row?.originalTrashedAt
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
    return { body, decrypt, fileName: downloadName(row!.title, version.originalFilename), mimeType: version.mimeType, byteSize: Number(version.byteSize) };
  }
}

