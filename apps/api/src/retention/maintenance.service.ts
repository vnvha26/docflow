import { Inject, Injectable, Logger } from '@nestjs/common';
import { FileVault } from '../crypto/file-vault.service';
import { PrismaService } from '../database/prisma.service';
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

  async runOnce(): Promise<{ expired: number; deleted: number; abandoned: number; rewrapped: number }> {
    const expired = await this.expireTemporaryCopies();
    const { deleted } = await this.retention.deletePendingBlobs();
    const abandoned = await this.sweepAbandonedUploads();
    const rewrapped = await this.rewrapKeys();
    return { expired, deleted, abandoned, rewrapped };
  }
}
