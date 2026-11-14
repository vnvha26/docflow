import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, PrivacyLevel } from '@prisma/client';
import { lockUserFiles } from '../database/locks';
import { PrismaService } from '../database/prisma.service';
import { ObjectStorage } from '../storage/object-storage';

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
  ) {}

  async assertMayStore(transaction: Prisma.TransactionClient, userId: string, documentId: string, minimum: PrivacyLevel): Promise<PrivacyLevel> {
    await lockUserFiles(transaction, userId);
    const rows = await transaction.$queryRaw<{ level: PrivacyLevel }[]>`
      SELECT LEAST(u."privacyLevel", COALESCE(d."privacyLevel", u."privacyLevel")) AS level
      FROM "Document" d JOIN "User" u ON u."id" = d."userId"
      WHERE d."id" = ${documentId}::uuid AND d."userId" = ${userId}::uuid AND d."deletedAt" IS NULL`;
    if (!rows[0] || RANK[rows[0].level] < RANK[minimum]) throw new PrivacyPolicyChangedError();
    return rows[0].level;
  }

  async purgeText(db: Prisma.TransactionClient, userId: string): Promise<number> {
    const level1 = Prisma.sql`d."userId" = ${userId}::uuid
      AND (d."purgedAt" IS NOT NULL OR LEAST(u."privacyLevel", COALESCE(d."privacyLevel", u."privacyLevel")) = 'STRUCTURED_ONLY')`;
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
      await this.removePurged(transaction, userId);
    });
    if (blobs.failed > 0) throw new Error('BLOB_DELETE_FAILED');
  }

  async sweepPurged(limit = 50): Promise<number> {
    const owners = await this.prisma.$queryRaw<{ userId: string }[]>`
      SELECT d."userId" FROM "Document" d
      WHERE d."purgedAt" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "FileCopy" c WHERE c."documentId" = d."id" AND c."state" <> 'DELETED')
      UNION
      SELECT f."userId" FROM "Folder" f
      WHERE f."purgedAt" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Document" d WHERE d."folderId" = f."id")
        AND NOT EXISTS (SELECT 1 FROM "Folder" c WHERE c."parentId" = f."id")
      LIMIT ${limit}`;
    let removed = 0;
    for (const { userId } of owners) {
      try {
        removed += await this.prisma.$transaction(async (transaction) => {
          await lockUserFiles(transaction, userId);
          const result = await this.removePurged(transaction, userId);
          return result.documents + result.folders;
        });
      } catch {
        this.logger.warn('Chưa dọn được dữ liệu đã xóa vĩnh viễn của một tài khoản; sẽ thử lại.');
      }
    }
    return removed;
  }

  async removePurged(transaction: Prisma.TransactionClient, userId: string): Promise<{ documents: number; folders: number }> {
    const gone = await transaction.document.findMany({
      where: { userId, purgedAt: { not: null }, fileCopies: { none: { state: { not: 'DELETED' } } } }, take: 500, select: { id: true },
    });
    const ids = gone.map((document) => document.id);
    if (ids.length) {
      await transaction.$executeRaw`
        DELETE FROM "Notification" n USING "Reminder" r, "Event" e, "Action" a, "Obligation" o
        WHERE n."reminderId" = r."id" AND r."eventId" = e."id" AND e."actionId" = a."id" AND a."obligationId" = o."id"
          AND o."userId" = ${userId}::uuid AND o."documentId"::text = ANY(${ids})`;
      await transaction.obligation.deleteMany({ where: { userId, documentId: { in: ids } } });
      await transaction.fileCopy.deleteMany({ where: { userId, documentId: { in: ids } } });
      await transaction.document.deleteMany({ where: { userId, id: { in: ids } } });
    }
    let folders = 0;
    for (let round = 0; round < 6; round++) {
      const removed = await transaction.folder.deleteMany({ where: { userId, purgedAt: { not: null }, documents: { none: {} }, children: { none: {} } } });
      folders += removed.count;
      if (!removed.count) break;
    }
    return { documents: ids.length, folders };
  }
}
