import { Inject, Injectable } from '@nestjs/common';
import { JobKind, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { PrismaService } from '../database/prisma.service';

export interface ClaimedJob {
  id: string;
  userId: string;
  kind: JobKind;
  documentId: string | null;
  versionId: string | null;
  payload: Prisma.JsonValue;
  attempts: number;
  maxAttempts: number;
}

export interface EnqueueInput {
  userId: string;
  kind: JobKind;
  documentId?: string | null;
  versionId?: string | null;
  payload?: Prisma.InputJsonObject;
  idempotencyKey: string;
  priority?: number;
  maxAttempts?: number;
}

const LEASE_SECONDS = 120;
const MAX_BACKOFF_MS = 15 * 60_000;

export function retryDelayMs(attempts: number, random = Math.random): number {
  const base = Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (0.8 + 0.4 * random()));
}

@Injectable()
export class JobQueue {
  readonly workerId = `${hostname().slice(0, 40)}:${process.pid}:${randomUUID().slice(0, 8)}`;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async enqueue(db: Prisma.TransactionClient, input: EnqueueInput): Promise<void> {
    await db.aIJob.createMany({
      data: [{
        userId: input.userId, kind: input.kind, documentId: input.documentId ?? null, versionId: input.versionId ?? null,
        payload: input.payload ?? {}, idempotencyKey: input.idempotencyKey,
        priority: input.priority ?? 0, maxAttempts: input.maxAttempts ?? 5,
      }],
      skipDuplicates: true,
    });
  }

  async reapExpired(): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE "AIJob" SET "status" = 'DEAD', "finishedAt" = now(), "leaseOwner" = NULL, "leaseUntil" = NULL,
        "lastErrorCode" = 'LEASE_EXPIRED', "updatedAt" = now()
      WHERE "status" = 'RUNNING' AND "leaseUntil" < now() AND "attempts" >= "maxAttempts"`;
  }

  async claim(kinds: readonly JobKind[], limit = 5, leaseSeconds = LEASE_SECONDS): Promise<ClaimedJob[]> {
    if (!kinds.length) return [];
    return this.prisma.$queryRaw<ClaimedJob[]>`
      UPDATE "AIJob" AS job
      SET "status" = 'RUNNING', "leaseOwner" = ${this.workerId},
          "leaseUntil" = now() + make_interval(secs => ${leaseSeconds}),
          "attempts" = job."attempts" + 1, "startedAt" = coalesce(job."startedAt", now()), "updatedAt" = now()
      WHERE job."id" IN (
        SELECT "id" FROM "AIJob"
        WHERE "kind"::text = ANY(${[...kinds]})
          AND ((("status" IN ('QUEUED', 'FAILED')) AND "availableAt" <= now())
            OR ("status" = 'RUNNING' AND "leaseUntil" < now() AND "attempts" < "maxAttempts"))
        ORDER BY "priority" DESC, "availableAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      RETURNING job."id", job."userId", job."kind", job."documentId", job."versionId", job."payload",
                job."attempts", job."maxAttempts"`;
  }

  async extend(job: ClaimedJob, leaseSeconds = LEASE_SECONDS): Promise<boolean> {
    const changed = await this.prisma.$executeRaw`
      UPDATE "AIJob" SET "leaseUntil" = now() + make_interval(secs => ${leaseSeconds}), "updatedAt" = now()
      WHERE "id" = ${job.id}::uuid AND "status" = 'RUNNING' AND "leaseOwner" = ${this.workerId}`;
    return changed === 1;
  }

  async holds(db: Prisma.TransactionClient, job: ClaimedJob): Promise<boolean> {
    return await db.aIJob.count({ where: { id: job.id, status: 'RUNNING', leaseOwner: this.workerId } }) === 1;
  }

  async complete(job: ClaimedJob): Promise<boolean> {
    const result = await this.prisma.aIJob.updateMany({
      where: { id: job.id, status: 'RUNNING', leaseOwner: this.workerId },
      data: { status: 'SUCCEEDED', finishedAt: new Date(), leaseOwner: null, leaseUntil: null, lastErrorCode: null, lastErrorMessage: null },
    });
    return result.count === 1;
  }

  async fail(job: ClaimedJob, code: string): Promise<'retry' | 'dead' | 'lost'> {
    const dead = job.attempts >= job.maxAttempts;
    const result = await this.prisma.aIJob.updateMany({
      where: { id: job.id, status: 'RUNNING', leaseOwner: this.workerId },
      data: dead
        ? { status: 'DEAD', finishedAt: new Date(), leaseOwner: null, leaseUntil: null, lastErrorCode: code.slice(0, 64) }
        : { status: 'FAILED', availableAt: new Date(Date.now() + retryDelayMs(job.attempts)), leaseOwner: null, leaseUntil: null, lastErrorCode: code.slice(0, 64) },
    });
    if (result.count !== 1) return 'lost';
    return dead ? 'dead' : 'retry';
  }

  async cancel(db: Prisma.TransactionClient, where: { userId: string; kinds: JobKind[]; documentId?: string; documentIds?: string[] }): Promise<number> {
    const result = await db.aIJob.updateMany({
      where: {
        userId: where.userId, kind: { in: where.kinds }, status: { in: ['QUEUED', 'FAILED', 'RUNNING'] },
        ...(where.documentId ? { documentId: where.documentId } : {}),
        ...(where.documentIds ? { documentId: { in: where.documentIds } } : {}),
      },
      data: { status: 'CANCELLED', finishedAt: new Date(), leaseOwner: null, leaseUntil: null, lastErrorCode: 'CANCELLED' },
    });
    return result.count;
  }
}
