import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { JobKind, Prisma, TrashKind } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { API_CONFIG, ApiConfig } from '../config';
import { lockUserFiles } from '../database/locks';
import { PrismaService } from '../database/prisma.service';
import { freeDocumentTitle, freeFolderName } from '../folders/names';
import { JobQueue } from '../jobs/job-queue.service';

const DOCUMENT_JOBS: JobKind[] = ['PARSE', 'CLASSIFY', 'EXTRACT', 'SUMMARIZE', 'EMBED'];
const LIVE = ['UPLOADING', 'AVAILABLE'] as const;
const SEPARATOR = ' › ';

export interface TrashEntry {
  id: string;
  kind: TrashKind;
  documentId: string | null;
  folderId: string | null;
  name: string;
  location: string | null;
  documentCount: number;
  folderCount: number;
  deletedAt: Date;
  expiresAt: Date;
}

export interface RestoreResult {
  kind: TrashKind;
  name: string;
  renamed: boolean;
  moved: boolean;
  folderId: string | null;
  location: string | null;
  inTrash?: boolean;
}

interface FolderNode { id: string; parentId: string | null; name: string; deletedAt: Date | null; purgedAt: Date | null; trashedById: string | null }
type Tx = Prisma.TransactionClient;

const ENTRY_SELECT = {
  id: true, kind: true, documentId: true, folderId: true, name: true, location: true, documentCount: true, folderCount: true, deletedAt: true, expiresAt: true,
} satisfies Prisma.TrashItemSelect;

function subtreeOf(nodes: readonly FolderNode[], rootId: string): FolderNode[] {
  const root = nodes.find((node) => node.id === rootId);
  if (!root) return [];
  const found = [root];
  for (let index = 0; index < found.length && found.length <= nodes.length; index++) {
    for (const node of nodes) {
      if (node.parentId === found[index].id && !found.includes(node)) found.push(node);
    }
  }
  return found;
}

function pathOf(nodes: readonly FolderNode[], id: string | null): FolderNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path: FolderNode[] = [];
  for (let current = id ? byId.get(id) : undefined; current && path.length <= nodes.length; current = current.parentId ? byId.get(current.parentId) : undefined) {
    path.unshift(current);
  }
  return path;
}

const labelOf = (nodes: readonly FolderNode[], id: string | null) => pathOf(nodes, id).map((node) => node.name).join(SEPARATOR).slice(0, 600) || null;

function liveAncestor(nodes: readonly FolderNode[], id: string | null): string | null {
  const path = pathOf(nodes, id);
  for (let index = path.length - 1; index >= 0; index--) {
    if (path.slice(0, index + 1).every((node) => node.deletedAt === null)) return path[index].id;
  }
  return null;
}

@Injectable()
export class TrashService {
  private readonly logger = new Logger(TrashService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JobQueue) private readonly jobs: JobQueue,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  private expiry(): Date {
    return new Date(Date.now() + this.config.files.trashTtlMs);
  }

  private folders(transaction: Tx, userId: string): Promise<FolderNode[]> {
    return transaction.folder.findMany({ where: { userId }, select: { id: true, parentId: true, name: true, deletedAt: true, purgedAt: true, trashedById: true } });
  }

  private async queuePurge(transaction: Tx, userId: string): Promise<void> {
    const waiting = await transaction.aIJob.count({ where: { userId, kind: 'PURGE', status: { in: ['QUEUED', 'FAILED'] } } });
    if (!waiting) await this.jobs.enqueue(transaction, { userId, kind: 'PURGE', idempotencyKey: `purge:${userId}:${randomUUID()}`, priority: 10 });
  }

  private async retire(transaction: Tx, userId: string, documentIds: string[], trashItemId: string): Promise<void> {
    if (!documentIds.length) return;
    const now = new Date();
    await transaction.document.updateMany({
      where: { id: { in: documentIds }, userId }, data: { deletedAt: now, trashedById: trashItemId, revision: { increment: 1 } },
    });
    const unfinished = await transaction.fileCopy.updateMany({
      where: { userId, documentId: { in: documentIds }, state: 'UPLOADING' },
      data: { state: 'DELETE_PENDING', deleteRequestedAt: now, revision: { increment: 1 } },
    });
    await this.jobs.cancel(transaction, { userId, kinds: DOCUMENT_JOBS, documentIds });
    await transaction.documentVersion.updateMany({
      where: { documentId: { in: documentIds }, parseState: { in: ['PENDING', 'PROCESSING'] }, fileCopies: { none: { state: 'AVAILABLE' } } },
      data: { parseState: 'FAILED', parseErrorCode: 'SOURCE_UNAVAILABLE' },
    });
    await transaction.documentVersion.updateMany({
      where: { documentId: { in: documentIds }, parseState: 'PROCESSING' }, data: { parseState: 'PENDING', parseErrorCode: null },
    });
    if (unfinished.count > 0) await this.queuePurge(transaction, userId);
  }

  async trashDocument(userId: string, documentId: string): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await lockUserFiles(transaction, userId);
      const document = await transaction.document.findFirst({
        where: { id: documentId, userId, deletedAt: null }, select: { id: true, title: true, folderId: true },
      });
      if (!document) throw new NotFoundException('Không tìm thấy tài liệu.');
      const nodes = await this.folders(transaction, userId);
      const item = await transaction.trashItem.create({
        data: { userId, kind: 'DOCUMENT', documentId: document.id, name: document.title, location: labelOf(nodes, document.folderId), expiresAt: this.expiry() },
        select: { id: true },
      });
      await this.retire(transaction, userId, [document.id], item.id);
    });
  }

  async trashOriginal(userId: string, documentId: string): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await lockUserFiles(transaction, userId);
      const document = await transaction.document.findFirst({
        where: { id: documentId, userId, deletedAt: null },
        select: {
          id: true, title: true, folderId: true, originalTrashedAt: true,
          versions: { orderBy: { number: 'desc' }, take: 1, select: { id: true, parseState: true } },
        },
      });
      const version = document?.versions[0];
      if (!document || !version) throw new NotFoundException('Không tìm thấy tài liệu.');
      const original = document.originalTrashedAt ? 0 : await transaction.fileCopy.count({
        where: { userId, documentId, versionId: version.id, kind: 'ENCRYPTED_COPY', state: 'AVAILABLE' },
      });
      if (!original) throw new NotFoundException('Tài liệu này không có bản gốc để xóa.');
      if (version.parseState === 'PENDING' || version.parseState === 'PROCESSING') {
        throw new ConflictException('Tài liệu đang được đọc nội dung. Hãy chờ xử lý xong rồi xóa bản gốc.');
      }
      const nodes = await this.folders(transaction, userId);
      await transaction.document.update({ where: { id: document.id }, data: { originalTrashedAt: new Date(), revision: { increment: 1 } } });
      await transaction.trashItem.create({
        data: { userId, kind: 'ORIGINAL', documentId: document.id, name: document.title, location: labelOf(nodes, document.folderId), expiresAt: this.expiry() },
      });
    });
  }

  async trashFolder(userId: string, folderId: string): Promise<{ documentCount: number; folderCount: number }> {
    return this.prisma.$transaction(async (transaction) => {
      await lockUserFiles(transaction, userId);
      const nodes = await this.folders(transaction, userId);
      const folder = nodes.find((node) => node.id === folderId && node.deletedAt === null);
      if (!folder) throw new NotFoundException('Không tìm thấy thư mục.');
      const subtree = subtreeOf(nodes, folder.id).filter((node) => node.deletedAt === null);
      const ids = subtree.map((node) => node.id);
      const documents = await transaction.document.findMany({ where: { userId, folderId: { in: ids }, deletedAt: null }, select: { id: true } });
      const counts = { documentCount: documents.length, folderCount: subtree.length - 1 };
      const item = await transaction.trashItem.create({
        data: { userId, kind: 'FOLDER', folderId: folder.id, name: folder.name, location: labelOf(nodes, folder.parentId), expiresAt: this.expiry(), ...counts },
        select: { id: true },
      });
      await this.retire(transaction, userId, documents.map((document) => document.id), item.id);
      await transaction.folder.updateMany({
        where: { id: { in: ids }, userId }, data: { deletedAt: new Date(), trashedById: item.id, revision: { increment: 1 } },
      });
      return counts;
    });
  }

  list(userId: string): Promise<TrashEntry[]> {
    return this.prisma.trashItem.findMany({ where: { userId }, orderBy: [{ deletedAt: 'desc' }, { id: 'desc' }], take: 500, select: ENTRY_SELECT });
  }

  private async reviveDocument(transaction: Tx, userId: string, nodes: readonly FolderNode[], documentId: string): Promise<RestoreResult | null> {
    const document = await transaction.document.findFirst({
      where: { id: documentId, userId, deletedAt: { not: null }, purgedAt: null }, select: { id: true, title: true, folderId: true },
    });
    if (!document) return null;
    const folderId = liveAncestor(nodes, document.folderId);
    const free = await freeDocumentTitle(transaction, userId, folderId, document.title, document.id);
    await transaction.document.update({
      where: { id: document.id }, data: { deletedAt: null, trashedById: null, folderId, title: free.name, revision: { increment: 1 } },
    });
    return { kind: 'DOCUMENT', name: free.name, renamed: free.renamed, moved: folderId !== document.folderId, folderId, location: labelOf(nodes, folderId) };
  }

  private async reviveFolder(transaction: Tx, userId: string, nodes: FolderNode[], itemId: string, folderId: string): Promise<RestoreResult | null> {
    const root = nodes.find((node) => node.id === folderId && node.trashedById === itemId);
    if (!root) return null;
    const batch = subtreeOf(nodes, root.id).filter((node) => node.trashedById === itemId);
    const parentId = liveAncestor(nodes, root.parentId);
    let result: RestoreResult | null = null;
    for (const node of batch) {
      const target = node === root ? parentId : node.parentId;
      const free = await freeFolderName(transaction, userId, target, node.name, node.id);
      await transaction.folder.update({
        where: { id: node.id }, data: { deletedAt: null, trashedById: null, parentId: target, name: free.name, revision: { increment: 1 } },
      });
      if (node === root) {
        result = { kind: 'FOLDER', name: free.name, renamed: free.renamed, moved: parentId !== root.parentId, folderId: node.id, location: null };
        node.parentId = parentId;
      }
      node.deletedAt = null;
      node.trashedById = null;
      node.name = free.name;
    }
    const documents = await transaction.document.findMany({
      where: { userId, trashedById: itemId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true },
    });
    for (const document of documents) await this.reviveDocument(transaction, userId, nodes, document.id);
    if (result) result.location = labelOf(nodes, parentId);
    return result;
  }

  async restore(userId: string, itemId: string): Promise<RestoreResult> {
    return this.prisma.$transaction(async (transaction) => {
      await lockUserFiles(transaction, userId);
      const item = await transaction.trashItem.findFirst({ where: { id: itemId, userId }, select: { id: true, kind: true, documentId: true, folderId: true, name: true } });
      if (!item) throw new NotFoundException('Mục này không còn trong thùng rác.');
      const nodes = await this.folders(transaction, userId);
      let result: RestoreResult | null = null;
      if (item.kind === 'FOLDER') {
        result = await this.reviveFolder(transaction, userId, nodes, item.id, item.folderId!);
      } else if (item.kind === 'DOCUMENT') {
        result = await this.reviveDocument(transaction, userId, nodes, item.documentId!);
      } else {
        const changed = await transaction.document.updateMany({
          where: { id: item.documentId!, userId, purgedAt: null, originalTrashedAt: { not: null } }, data: { originalTrashedAt: null, revision: { increment: 1 } },
        });
        const document = await transaction.document.findFirst({ where: { id: item.documentId!, userId }, select: { title: true, folderId: true, deletedAt: true } });
        if (changed.count && document) {
          result = {
            kind: 'ORIGINAL', name: document.title, renamed: false, moved: false, folderId: document.folderId, location: labelOf(nodes, document.folderId),
            inTrash: document.deletedAt !== null,
          };
        }
      }
      await transaction.trashItem.deleteMany({ where: { id: item.id } });
      if (!result) throw new NotFoundException('Mục này không còn trong thùng rác.');
      if (result.moved && await transaction.folder.count({ where: { userId, purgedAt: { not: null } } })) await this.queuePurge(transaction, userId);
      return result;
    }, { maxWait: 10_000, timeout: 60_000 });
  }

  private async purgeDocuments(transaction: Tx, userId: string, documentIds: string[]): Promise<void> {
    if (!documentIds.length) return;
    const now = new Date();
    await transaction.document.updateMany({ where: { id: { in: documentIds }, userId, deletedAt: null }, data: { deletedAt: now } });
    await transaction.document.updateMany({
      where: { id: { in: documentIds }, userId }, data: { purgedAt: now, trashedById: null, originalTrashedAt: null, revision: { increment: 1 } },
    });
    await transaction.fileCopy.updateMany({
      where: { userId, documentId: { in: documentIds }, state: { in: [...LIVE] } },
      data: { state: 'DELETE_PENDING', deleteRequestedAt: now, revision: { increment: 1 } },
    });
    await this.jobs.cancel(transaction, { userId, kinds: DOCUMENT_JOBS, documentIds });
    await transaction.documentChunk.deleteMany({ where: { userId, documentId: { in: documentIds } } });
    await transaction.extractedMetadata.updateMany({
      where: { userId, documentId: { in: documentIds } },
      data: { fields: {}, evidence: {}, summary: null, confirmedFields: Prisma.DbNull, revision: { increment: 1 } },
    });
    await transaction.obligation.updateMany({
      where: { userId, documentId: { in: documentIds }, status: { in: ['ACTIVE', 'NEEDS_REVIEW'] } }, data: { status: 'CANCELLED', revision: { increment: 1 } },
    });
    await transaction.trashItem.deleteMany({ where: { userId, documentId: { in: documentIds } } });
  }

  private async purgeItem(transaction: Tx, userId: string, item: { id: string; kind: TrashKind; documentId: string | null; folderId: string | null }): Promise<void> {
    if (item.kind === 'DOCUMENT') {
      await this.purgeDocuments(transaction, userId, [item.documentId!]);
    } else if (item.kind === 'ORIGINAL') {
      const now = new Date();
      await transaction.fileCopy.updateMany({
        where: { userId, documentId: item.documentId!, kind: 'ENCRYPTED_COPY', state: { in: [...LIVE] } },
        data: { state: 'DELETE_PENDING', deleteRequestedAt: now, revision: { increment: 1 } },
      });
      await transaction.documentChunk.deleteMany({ where: { userId, documentId: item.documentId! } });
      await transaction.document.updateMany({ where: { id: item.documentId!, userId }, data: { originalTrashedAt: null, revision: { increment: 1 } } });
    } else {
      const documents = await transaction.document.findMany({ where: { userId, trashedById: item.id }, select: { id: true } });
      await this.purgeDocuments(transaction, userId, documents.map((document) => document.id));
      await transaction.folder.updateMany({
        where: { userId, trashedById: item.id }, data: { purgedAt: new Date(), trashedById: null, revision: { increment: 1 } },
      });
    }
    await transaction.trashItem.deleteMany({ where: { id: item.id } });
    await this.queuePurge(transaction, userId);
  }

  async purge(userId: string, itemId: string): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await lockUserFiles(transaction, userId);
      const item = await transaction.trashItem.findFirst({ where: { id: itemId, userId }, select: { id: true, kind: true, documentId: true, folderId: true } });
      if (!item) throw new NotFoundException('Mục này không còn trong thùng rác.');
      await this.purgeItem(transaction, userId, item);
    }, { maxWait: 10_000, timeout: 60_000 });
  }

  async empty(userId: string): Promise<number> {
    return this.prisma.$transaction(async (transaction) => {
      await lockUserFiles(transaction, userId);
      let purged = 0;
      for (;;) {
        const item = await transaction.trashItem.findFirst({
          where: { userId }, orderBy: [{ kind: 'desc' }, { deletedAt: 'asc' }], select: { id: true, kind: true, documentId: true, folderId: true },
        });
        if (!item) return purged;
        await this.purgeItem(transaction, userId, item);
        purged++;
      }
    }, { maxWait: 10_000, timeout: 120_000 });
  }

  async purgeExpired(limit = 50): Promise<number> {
    const due = await this.prisma.trashItem.findMany({
      where: { expiresAt: { lt: new Date() } }, orderBy: { expiresAt: 'asc' }, take: limit, select: { id: true, userId: true },
    });
    let purged = 0;
    for (const item of due) {
      try {
        await this.purge(item.userId, item.id);
        purged++;
      } catch (error) {
        if (!(error instanceof NotFoundException)) this.logger.warn(`Chưa xóa vĩnh viễn được mục thùng rác ${item.id}; sẽ thử lại.`);
      }
    }
    return purged;
  }
}
