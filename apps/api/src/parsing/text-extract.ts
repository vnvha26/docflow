import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { EXTRACT_REPLY, isUnsupportedCode, ParserFailedError, UnsupportedDocumentError } from './text';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface ExtractedPages {
  pages: string[];
  pageCount: number | null;
}

export interface ExtractLimits {
  timeoutMs?: number;
  memoryMb?: number;
}

export class ParserCrashedError extends Error {
  constructor(readonly detail = 'worker exited') {
    super('PARSER_CRASHED');
    this.name = 'ParserCrashedError';
  }
}

type ExtractReply =
  | { type: typeof EXTRACT_REPLY; ok: true; pages: string[]; pageCount: number | null }
  | { type: typeof EXTRACT_REPLY; ok: false; code: string | null; detail: string };

function isExtractReply(message: unknown): message is ExtractReply {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === EXTRACT_REPLY;
}

export function extractPages(mimeType: string, file: Buffer, limits: ExtractLimits = {}): Promise<ExtractedPages> {
  return runExtractor(mimeType, file, limits);
}

export async function renderDocxHtml(file: Buffer, limits: ExtractLimits = {}): Promise<string> {
  const result = await runExtractor(DOCX, file, limits, 'html');
  return result.pages[0] ?? '';
}

function runExtractor(mimeType: string, file: Buffer, limits: ExtractLimits, format?: 'html'): Promise<ExtractedPages> {
  const data = new Uint8Array(new ArrayBuffer(file.byteLength));
  data.set(file);
  const worker = new Worker(join(__dirname, 'text-extract.worker.js'), {
    workerData: { mimeType, data, format },
    transferList: [data.buffer],
    resourceLimits: { maxOldGenerationSizeMb: limits.memoryMb ?? 768, maxYoungGenerationSizeMb: 64 },
    stdout: true,
    stderr: true,
  });
  worker.stdout.resume();
  worker.stderr.resume();
  return new Promise<ExtractedPages>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
      void worker.terminate();
    };
    const timer = setTimeout(() => settle(() => reject(new UnsupportedDocumentError('FILE_TOO_COMPLEX', 'timed out'))), limits.timeoutMs ?? 120_000);
    worker.on('message', (message: unknown) => {
      if (!isExtractReply(message)) return;
      settle(() => {
        if (message.ok) resolve({ pages: message.pages, pageCount: message.pageCount });
        else if (isUnsupportedCode(message.code)) reject(new UnsupportedDocumentError(message.code, message.detail));
        else reject(new ParserFailedError(message.detail));
      });
    });
    worker.once('error', (error: NodeJS.ErrnoException) => settle(() => reject(
      error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new UnsupportedDocumentError('FILE_TOO_COMPLEX', 'out of memory') : new ParserCrashedError(`${error.name}${error.code ? ` ${error.code}` : ''}`),
    )));
    worker.once('exit', () => settle(() => reject(new ParserCrashedError())));
  });
}
