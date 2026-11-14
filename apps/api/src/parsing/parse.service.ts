import { Inject, Injectable, Logger } from '@nestjs/common';
import { ParseState } from '@prisma/client';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FileVault } from '../crypto/file-vault.service';
import { lockUserFiles } from '../database/locks';
import { PrismaService } from '../database/prisma.service';
import { ClaimedJob, JobQueue } from '../jobs/job-queue.service';
import { DocumentUnavailableError, RetentionService } from '../retention/retention.service';
import { ObjectNotFoundError, ObjectStorage } from '../storage/object-storage';
import { CHUNKER_VERSION, chunkText } from './chunker';
import { extractPages, ParserCrashedError } from './text-extract';
import { assertRawLength, assessText, normalizePages, PARSER_VERSION, ParserFailedError, UnsupportedDocumentError } from './text';

const PARSE_LEASE_SECONDS = 300;
const STORE_TRANSACTION = { maxWait: 10_000, timeout: 60_000 };
const DONE: ParseState[] = ['SUCCEEDED', 'UNSUPPORTED'];

type Outcome =
  | { kind: 'parsed'; text: string; pageStarts: number[] | null; pageCount: number | null }
  | { kind: 'unsupported'; code: string }
  | { kind: 'failed'; code: string };

interface Target { userId: string; documentId: string; versionId: string }

@Injectable()
export class ParseService {
  private readonly logger = new Logger(ParseService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ObjectStorage) private readonly storage: ObjectStorage,
    @Inject(FileVault) private readonly vault: FileVault,
    @Inject(RetentionService) private readonly retention: RetentionService,
    @Inject(JobQueue) private readonly jobs: JobQueue,
  ) {}

  async handle(job: ClaimedJob): Promise<void> {
    if (!job.documentId || !job.versionId) throw new Error('INVALID_JOB');
    const target = { userId: job.userId, documentId: job.documentId, versionId: job.versionId };
    const version = await this.prisma.documentVersion.findFirst({
      where: { id: target.versionId, documentId: target.documentId, userId: target.userId, document: { deletedAt: null } },
      select: { mimeType: true, byteSize: true, parseState: true },
    });
    if (!version || DONE.includes(version.parseState)) return;
    const copy = await this.prisma.fileCopy.findFirst({
      where: { versionId: target.versionId, userId: target.userId, state: { in: ['AVAILABLE', 'UPLOADING'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, state: true, storageKey: true, encryptionKeyRef: true },
    });
    if (!copy?.encryptionKeyRef) {
      await this.store(target, { kind: 'failed', code: 'SOURCE_UNAVAILABLE' }, job);
      return;
    }
    if (copy.state === 'UPLOADING') throw new Error('SOURCE_NOT_READY');
    if (!await this.jobs.extend(job, PARSE_LEASE_SECONDS)) throw new Error('LEASE_LOST');
    const started = await this.prisma.$transaction(async (transaction) => {
      await lockUserFiles(transaction, target.userId);
      if (!await this.jobs.holds(transaction, job)) return false;
      await transaction.documentVersion.updateMany({
        where: { id: target.versionId, parseState: { in: ['PENDING', 'FAILED'] } },
        data: { parseState: 'PROCESSING', parseErrorCode: null },
      });
      return true;
    });
    if (!started) throw new Error('LEASE_LOST');
    const file = await this.read(copy.storageKey, copy.encryptionKeyRef, { copyId: copy.id, userId: target.userId }, Number(version.byteSize));
    let outcome: Outcome;
    try {
      const extracted = await extractPages(version.mimeType, file);
      assertRawLength(extracted.pages);
      const { text, pageStarts } = normalizePages(extracted.pages);
      assessText(text, version.mimeType === 'application/pdf');
      outcome = { kind: 'parsed', text, pageStarts: extracted.pageCount ? pageStarts : null, pageCount: extracted.pageCount };
    } catch (error) {
      if (error instanceof ParserFailedError || error instanceof ParserCrashedError) {
        this.logger.warn(`Đọc tệp lỗi (version ${target.versionId}, ${version.mimeType}): ${error.detail}`);
      }
      if (!(error instanceof UnsupportedDocumentError)) throw error;
      if (error.detail) this.logger.warn(`Không đọc được tệp (version ${target.versionId}, ${error.code}): ${error.detail}`);
      outcome = { kind: 'unsupported', code: error.code };
    } finally {
      file.fill(0);
    }
    if (!await this.jobs.extend(job, PARSE_LEASE_SECONDS)) throw new Error('LEASE_LOST');
    await this.store(target, outcome, job);
  }

  async markFailed(job: ClaimedJob, code: string): Promise<void> {
    if (!job.documentId || !job.versionId) return;
    await this.store({ userId: job.userId, documentId: job.documentId, versionId: job.versionId }, { kind: 'failed', code });
  }

  private async read(key: string, keyRef: string, context: { copyId: string; userId: string }, expectedBytes: number): Promise<Buffer> {
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
      await pipeline(await this.storage.get(key), this.vault.openStream(keyRef, context), sink);
    } catch (error) {
      for (const part of parts) part.fill(0);
      if (error instanceof ObjectNotFoundError) throw new Error('SOURCE_MISSING');
      throw new Error('SOURCE_UNREADABLE');
    }
    const file = Buffer.concat(parts, total);
    for (const part of parts) part.fill(0);
    if (total !== expectedBytes) {
      file.fill(0);
      throw new Error('SOURCE_CORRUPT');
    }
    return file;
  }

  private async store(target: Target, outcome: Outcome, job?: ClaimedJob): Promise<void> {
    const { userId, documentId, versionId } = target;
    await this.prisma.$transaction(async (transaction) => {
      try {
        await this.retention.assertMayStore(transaction, userId, documentId);
      } catch (error) {
        if (error instanceof DocumentUnavailableError) return;
        throw error;
      }
      if (job && !await this.jobs.holds(transaction, job)) throw new Error('LEASE_LOST');
      const current = await transaction.documentVersion.findFirst({ where: { id: versionId, documentId }, select: { parseState: true } });
      if (!current || DONE.includes(current.parseState)) return;
      await transaction.documentChunk.deleteMany({ where: { versionId } });
      await transaction.document.update({ where: { id: documentId }, data: { revision: { increment: 1 } } });
      if (outcome.kind === 'failed') {
        await transaction.documentVersion.update({ where: { id: versionId }, data: { parseState: 'FAILED', parseErrorCode: outcome.code.slice(0, 64) } });
        return;
      }
      if (outcome.kind === 'unsupported') {
        await transaction.documentVersion.update({
          where: { id: versionId },
          data: { parseState: 'UNSUPPORTED', parseErrorCode: outcome.code, parserVersion: PARSER_VERSION, pageCount: null, charCount: null },
        });
      } else {
        const chunks = chunkText(outcome.text, outcome.pageStarts);
        await transaction.documentChunk.createMany({
          data: chunks.map((chunk) => ({ ...chunk, userId, documentId, versionId, chunkerVersion: CHUNKER_VERSION })),
        });
        await transaction.documentVersion.update({
          where: { id: versionId },
          data: {
            parseState: 'SUCCEEDED', parseErrorCode: null, parserVersion: PARSER_VERSION,
            pageCount: outcome.pageCount, charCount: outcome.text.length,
          },
        });
      }
    }, STORE_TRANSACTION);
  }
}
