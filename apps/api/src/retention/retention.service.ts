import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { JobKind, Prisma, PrivacyLevel } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { lockUserFiles } from '../database/locks';
import { PrismaService } from '../database/prisma.service';
import { isLowerPrivacy } from '../documents/privacy';
import { JobQueue } from '../jobs/job-queue.service';
import { ObjectStorage } from '../storage/object-storage';

const TEXT_JOBS: JobKind[] = ['SUMMARIZE', 'EMBED'];

export class PrivacyPolicyChangedError extends ConflictException {
  constructor() { super('Mức lưu trữ của tài liệu đã thay đổi; dữ liệu này không còn được giữ.'); }
}

const RANK: Record<PrivacyLevel, number> = { STRUCTURED_ONLY: 1, TEXT_AND_EMBEDDINGS: 2, ENCRYPTED_COPY: 3 };

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ObjectStorage) private readonly storage: ObjectStorage,
    @Inject(JobQueue) private readonly jobs: JobQueue,
  ) {}

  async assertMayStore(transaction: Prisma.TransactionClient, userId: string, documentId: string, minimum: PrivacyLevel): Promise<void> {
    await lockUserFiles(transaction, userId);
    const rows = await transaction.$queryRaw<{ level: PrivacyLevel }[]>`
      SELECT LEAST(u."privacyLevel", COALESCE(d."privacyLevel", u."privacyLevel")) AS level
      FROM "Document" d JOIN "User" u ON u."id" = d."userId"
      WHERE d."id" = ${documentId}::uuid AND d."userId" = ${userId}::uuid AND d."deletedAt" IS NULL`;
    if (!rows[0] || RANK[rows[0].level] < RANK[minimum]) throw new PrivacyPolicyChangedError();
  }

  async enforceAccount(transaction: Prisma.TransactionClient, userId: string, previous: PrivacyLevel, next: PrivacyLevel): Promise<void> {
    if (!isLowerPrivacy(next, previous)) return;
    await this.enforce(transaction, userId);
  }

  async setDocumentLevel(userId: string, documentId: string, level: PrivacyLevel | null): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await lockUserFiles(transaction, userId);
      const document = await transaction.document.findFirst({
        where: { id: documentId, userId, deletedAt: null }, select: { id: true, user: { select: { privacyLevel: true } } },
      });
      if (!document) throw new NotFoundException('Không tìm thấy tài liệu.');
      if (level && isLowerPrivacy(document.user.privacyLevel, level)) {
        throw new ConflictException({
          statusCode: 409, message: 'Mức của tài liệu không được cao hơn mức của tài khoản.',
          fieldErrors: { privacyLevel: 'Mức của tài liệu không được cao hơn mức của tài khoản.' },
        });
      }
      await transaction.document.update({ where: { id: documentId }, data: { privacyLevel: level, revision: { increment: 1 } } });
      await this.enforce(transaction, userId, documentId);
    });
  }

  async deleteOriginal(userId: string, documentId: string): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await lockUserFiles(transaction, userId);
      const document = await transaction.document.findFirst({ where: { id: documentId, userId, deletedAt: null }, select: { id: true } });
      if (!document) throw new NotFoundException('Không tìm thấy tài liệu.');
      const changed = await transaction.fileCopy.updateMany({
        where: { userId, documentId, kind: 'ENCRYPTED_COPY', state: { in: ['UPLOADING', 'AVAILABLE'] } },
        data: { state: 'DELETE_PENDING', deleteRequestedAt: new Date(), revision: { increment: 1 } },
      });
      if (changed.count === 0) throw new NotFoundException('Tài liệu này không có bản gốc để xóa.');
      await this.queuePurge(transaction, userId);
    });
  }

  private async enforce(transaction: Prisma.TransactionClient, userId: string, documentId?: string): Promise<void> {
    const onlyDocument = documentId ? Prisma.sql`AND d."id" = ${documentId}::uuid` : Prisma.empty;
    const originals = await transaction.$executeRaw`
      UPDATE "FileCopy" c
      SET "state" = 'DELETE_PENDING', "deleteRequestedAt" = now(), "revision" = c."revision" + 1, "updatedAt" = now()
      FROM "Document" d JOIN "User" u ON u."id" = d."userId"
      WHERE c."documentId" = d."id" AND d."userId" = ${userId}::uuid ${onlyDocument}
        AND c."kind" = 'ENCRYPTED_COPY' AND c."state" IN ('UPLOADING', 'AVAILABLE')
        AND LEAST(u."privacyLevel", COALESCE(d."privacyLevel", u."privacyLevel")) <> 'ENCRYPTED_COPY'`;
    const textDocuments = await transaction.$queryRaw<{ id: string }[]>`
      SELECT d."id" FROM "Document" d JOIN "User" u ON u."id" = d."userId"
      WHERE d."userId" = ${userId}::uuid ${onlyDocument}
        AND LEAST(u."privacyLevel", COALESCE(d."privacyLevel", u."privacyLevel")) = 'STRUCTURED_ONLY'`;
    for (const { id } of textDocuments) await this.jobs.cancel(transaction, { userId, kinds: TEXT_JOBS, documentId: id });
    const text = await this.purgeText(transaction, userId);
    if (originals > 0 || text > 0) await this.queuePurge(transaction, userId);
  }

  async purgeText(db: Prisma.TransactionClient, userId: string): Promise<number> {
    const level1 = Prisma.sql`d."userId" = ${userId}::uuid
      AND LEAST(u."privacyLevel", COALESCE(d."privacyLevel", u."privacyLevel")) = 'STRUCTURED_ONLY'`;
    const chunks = await db.$executeRaw`
      DELETE FROM "DocumentChunk" c USING "Document" d JOIN "User" u ON u."id" = d."userId"
      WHERE c."documentId" = d."id" AND ${level1}`;
    const metadata = await db.$executeRaw`
      UPDATE "ExtractedMetadata" m
      SET "summary" = NULL,
          "evidence" = COALESCE((
            SELECT jsonb_object_agg(e.key, CASE WHEN jsonb_typeof(e.value) = 'object' THEN e.value - 'quote' ELSE e.value END)
            FROM jsonb_each(m."evidence") AS e), '{}'::jsonb),
          "revision" = m."revision" + 1, "updatedAt" = now()
      FROM "Document" d JOIN "User" u ON u."id" = d."userId"
      WHERE m."documentId" = d."id" AND ${level1}
        AND (m."summary" IS NOT NULL OR jsonb_path_exists(m."evidence", '$.*.quote'))`;
    return chunks + metadata;
  }

  private async queuePurge(transaction: Prisma.TransactionClient, userId: string): Promise<void> {
    const waiting = await transaction.aIJob.count({ where: { userId, kind: 'PURGE', status: { in: ['QUEUED', 'FAILED'] } } });
    if (!waiting) await this.jobs.enqueue(transaction, { userId, kind: 'PURGE', idempotencyKey: `purge:${userId}:${randomUUID()}`, priority: 10 });
  }

  async deletePendingBlobs(userId?: string, limit = 200): Promise<{ deleted: number; failed: number }> {
    const copies = await this.prisma.fileCopy.findMany({
      where: { state: 'DELETE_PENDING', ...(userId ? { userId } : {}) },
      orderBy: { deleteRequestedAt: 'asc' }, take: limit, select: { id: true, storageKey: true },
    });
    let deleted = 0;
    let failed = 0;
    for (const copy of copies) {
      try {
        await this.storage.delete(copy.storageKey);
        const result = await this.prisma.fileCopy.updateMany({
          where: { id: copy.id, state: 'DELETE_PENDING' },
          data: { state: 'DELETED', deletedAt: new Date(), revision: { increment: 1 } },
        });
        deleted += result.count;
      } catch {
        failed++;
        this.logger.warn(`Chưa xóa được blob (copy ${copy.id}); sẽ thử lại.`);
      }
    }
    return { deleted, failed };
  }

  async purgeUser(userId: string): Promise<void> {
    const blobs = await this.deletePendingBlobs(userId, 1_000);
    await this.prisma.$transaction(async (transaction) => {
      await lockUserFiles(transaction, userId);
      await this.purgeText(transaction, userId);
    });
    if (blobs.failed > 0) throw new Error('BLOB_DELETE_FAILED');
  }
}
