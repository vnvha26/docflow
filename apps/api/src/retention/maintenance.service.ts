import { Inject, Injectable, Logger } from '@nestjs/common';
import { FileVault } from '../crypto/file-vault.service';
import { PrismaService } from '../database/prisma.service';
import { PARSER_VERSION } from '../parsing/text';
import { ObjectStorage } from '../storage/object-storage';
import { RetentionService } from './retention.service';

const ABANDONED_UPLOAD_MS = 60 * 60_000;

@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ObjectStorage) private readonly storage: ObjectStorage,
    @Inject(RetentionService) private readonly retention: RetentionService,
    @Inject(FileVault) private readonly vault: FileVault,
  ) {}

  async expireTemporaryCopies(): Promise<number> {
    const result = await this.prisma.fileCopy.updateMany({
      where: { kind: 'WEB_SOURCE', state: 'AVAILABLE', expiresAt: { lt: new Date() } },
      data: { state: 'DELETE_PENDING', deleteRequestedAt: new Date(), revision: { increment: 1 } },
    });
    return result.count;
  }

  async sweepAbandonedUploads(): Promise<number> {
    const stale = await this.prisma.fileCopy.findMany({
      where: { state: 'UPLOADING', createdAt: { lt: new Date(Date.now() - ABANDONED_UPLOAD_MS) } },
      take: 100, select: { id: true, storageKey: true, documentId: true, versionId: true },
    });
    let removed = 0;
    for (const copy of stale) {
      try {
        await this.storage.delete(copy.storageKey);
        await this.prisma.$transaction(async (transaction) => {
          const gone = await transaction.fileCopy.deleteMany({ where: { id: copy.id, state: 'UPLOADING' } });
          if (!gone.count) return;
          const others = await transaction.fileCopy.count({ where: { documentId: copy.documentId } });
          const versions = await transaction.documentVersion.count({ where: { documentId: copy.documentId } });
          if (others === 0 && versions === 1) {
            await transaction.aIJob.deleteMany({ where: { documentId: copy.documentId } });
            await transaction.documentVersion.deleteMany({ where: { id: copy.versionId } });
            await transaction.document.deleteMany({ where: { id: copy.documentId } });
          }
          removed++;
        });
      } catch {
        this.logger.warn(`Chưa dọn được upload bị bỏ dở (copy ${copy.id}).`);
      }
    }
    return removed;
  }

  async resumeParsing(limit = 100): Promise<{ queued: number; failed: number }> {
    await this.prisma.$executeRaw`
      UPDATE "DocumentVersion" v
      SET "parseState" = 'PENDING', "parseErrorCode" = NULL, "updatedAt" = now()
      WHERE v."id" IN (
        SELECT u."id" FROM "DocumentVersion" u
        WHERE u."parseState" = 'UNSUPPORTED' AND u."parserVersion" IS DISTINCT FROM ${PARSER_VERSION}
          AND EXISTS (SELECT 1 FROM "FileCopy" c WHERE c."versionId" = u."id" AND c."state" = 'AVAILABLE')
          AND NOT EXISTS (
            SELECT 1 FROM "AIJob" a WHERE a."versionId" = u."id" AND a."kind" = 'PARSE' AND a."status" IN ('QUEUED', 'RUNNING', 'FAILED'))
        ORDER BY u."createdAt"
        LIMIT ${limit})`;
    const dead = await this.prisma.$executeRaw`
      WITH latest AS (
        SELECT DISTINCT ON (a."versionId") a."versionId", a."status", a."lastErrorCode"
        FROM "AIJob" a JOIN "DocumentVersion" u ON u."id" = a."versionId"
        WHERE a."kind" = 'PARSE' AND u."parseState" IN ('PENDING', 'PROCESSING')
        ORDER BY a."versionId", a."createdAt" DESC, a."id" DESC)
      UPDATE "DocumentVersion" v
      SET "parseState" = 'FAILED', "parseErrorCode" = COALESCE(j."lastErrorCode", 'PARSE_FAILED'), "updatedAt" = now()
      FROM latest j
      WHERE j."versionId" = v."id" AND j."status" = 'DEAD'
        AND v."parseState" IN ('PENDING', 'PROCESSING')
        AND NOT EXISTS (SELECT 1 FROM "FileCopy" c WHERE c."versionId" = v."id" AND c."state" = 'UPLOADING')
        AND NOT EXISTS (
          SELECT 1 FROM "AIJob" a WHERE a."versionId" = v."id" AND a."kind" = 'PARSE' AND a."status" IN ('QUEUED', 'RUNNING', 'FAILED'))`;
    const lost = await this.prisma.$executeRaw`
      UPDATE "DocumentVersion" v
      SET "parseState" = 'FAILED', "parseErrorCode" = 'SOURCE_UNAVAILABLE', "updatedAt" = now()
      WHERE v."parseState" IN ('PENDING', 'PROCESSING') AND v."createdAt" < now() - interval '1 hour'
        AND NOT EXISTS (SELECT 1 FROM "FileCopy" c WHERE c."versionId" = v."id" AND c."state" IN ('UPLOADING', 'AVAILABLE'))`;
    const queued = await this.prisma.$executeRaw`
      INSERT INTO "AIJob" ("userId", "kind", "documentId", "versionId", "idempotencyKey", "maxAttempts", "updatedAt")
      SELECT v."userId", 'PARSE', v."documentId", v."id", 'parse:' || v."id" || ':' || c."id" || ':' || ${PARSER_VERSION}, 3, now()
      FROM "DocumentVersion" v
      JOIN "Document" d ON d."id" = v."documentId" AND d."deletedAt" IS NULL
      JOIN LATERAL (
        SELECT "id" FROM "FileCopy" WHERE "versionId" = v."id" AND "state" = 'AVAILABLE' ORDER BY "createdAt" DESC LIMIT 1
      ) c ON true
      WHERE v."parseState" = 'PENDING'
        AND NOT EXISTS (
          SELECT 1 FROM "AIJob" a WHERE a."versionId" = v."id" AND a."kind" = 'PARSE' AND a."status" IN ('QUEUED', 'RUNNING', 'FAILED'))
      ORDER BY v."createdAt"
      LIMIT ${limit}
      ON CONFLICT ("idempotencyKey") DO NOTHING`;
    return { queued, failed: dead + lost };
  }

  async rewrapKeys(limit = 200): Promise<number> {
    const active = this.vault.activeKekId;
    const copies = await this.prisma.fileCopy.findMany({
      where: { state: { in: ['UPLOADING', 'AVAILABLE'] }, encryptionKeyRef: { not: null }, NOT: { encryptionKeyRef: { startsWith: `w1.${active}.` } } },
      take: limit, select: { id: true, userId: true, encryptionKeyRef: true },
    });
    let rewrapped = 0;
    for (const copy of copies) {
      try {
        const next = this.vault.rewrap(copy.encryptionKeyRef!, { copyId: copy.id, userId: copy.userId });
        if (!next) continue;
        const result = await this.prisma.fileCopy.updateMany({
          where: { id: copy.id, encryptionKeyRef: copy.encryptionKeyRef },
          data: { encryptionKeyRef: next, revision: { increment: 1 } },
        });
        rewrapped += result.count;
      } catch {
        this.logger.error(`Không bọc lại được khóa dữ liệu (copy ${copy.id}); kiểm tra FILE_KEKS còn khóa cũ.`);
      }
    }
    return rewrapped;
  }

  async runOnce(): Promise<{ expired: number; deleted: number; abandoned: number; rewrapped: number; parseQueued: number; parseFailed: number }> {
    const expired = await this.expireTemporaryCopies();
    const { deleted } = await this.retention.deletePendingBlobs();
    const abandoned = await this.sweepAbandonedUploads();
    const rewrapped = await this.rewrapKeys();
    const parse = await this.resumeParsing();
    return { expired, deleted, abandoned, rewrapped, parseQueued: parse.queued, parseFailed: parse.failed };
  }
}
