import { Inject, Injectable, Logger } from '@nestjs/common';
import { JobKind } from '@prisma/client';
import { setTimeout as sleep } from 'node:timers/promises';
import { API_CONFIG, ApiConfig } from '../config';
import { ClaimedJob, JobQueue } from '../jobs/job-queue.service';
import { PrivacyPolicyChangedError, RetentionService } from '../retention/retention.service';
import { MaintenanceService } from '../retention/maintenance.service';

type Handler = (job: ClaimedJob) => Promise<void>;

@Injectable()
export class WorkerRunner {
  private readonly logger = new Logger(WorkerRunner.name);
  private readonly handlers: Partial<Record<JobKind, Handler>>;
  private stopping = false;
  private wake: AbortController | null = null;

  constructor(
    @Inject(JobQueue) private readonly jobs: JobQueue,
    @Inject(RetentionService) private readonly retention: RetentionService,
    @Inject(MaintenanceService) private readonly maintenance: MaintenanceService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {
    this.handlers = {
      PURGE: (job) => this.retention.purgeUser(job.userId),
    };
  }

  stop(): void {
    this.stopping = true;
    this.wake?.abort();
  }

  async runJob(job: ClaimedJob): Promise<void> {
    const handler = this.handlers[job.kind];
    try {
      if (!handler) throw new Error('NO_HANDLER');
      await handler(job);
      await this.jobs.complete(job);
    } catch (error) {
      const code = error instanceof PrivacyPolicyChangedError ? 'POLICY_CHANGED'
        : error instanceof Error && /^[A-Z_]{3,64}$/.test(error.message) ? error.message : 'HANDLER_FAILED';
      const outcome = await this.jobs.fail(job, code).catch(() => 'lost' as const);
      if (outcome !== 'retry') this.logger.warn(`Job ${job.kind} ${job.id}: ${code} (${outcome}).`);
    }
  }

  async tick(): Promise<number> {
    await this.jobs.reapExpired();
    const claimed = await this.jobs.claim(Object.keys(this.handlers) as JobKind[]);
    for (const job of claimed) await this.runJob(job);
    return claimed.length;
  }

  async run(): Promise<void> {
    let nextMaintenance = 0;
    this.logger.log(`Worker ${this.jobs.workerId} đã chạy.`);
    while (!this.stopping) {
      try {
        if (Date.now() >= nextMaintenance) {
          nextMaintenance = Date.now() + this.config.worker.maintenanceMs;
          const summary = await this.maintenance.runOnce();
          if (Object.values(summary).some(Boolean)) this.logger.log(`Dọn dẹp: ${JSON.stringify(summary)}`);
        }
        if (await this.tick() > 0) continue;
      } catch {
        this.logger.error('Vòng xử lý job thất bại; sẽ thử lại.');
      }
      this.wake = new AbortController();
      await sleep(this.config.worker.pollMs, undefined, { signal: this.wake.signal }).catch(() => undefined);
    }
  }
}
