import { convertToHtml, extractRawText } from 'mammoth';
import { parentPort, workerData } from 'node:worker_threads';
import { assertRawLength, EXTRACT_REPLY, isUnsupportedCode, MAX_PAGES, MAX_PREVIEW_CHARS, MAX_RAW_TEXT_CHARS, UnsupportedDocumentError } from './text';

interface Input { mimeType: string; data: Uint8Array; format?: 'html' }

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function renderHtml({ mimeType, data }: Input): Promise<{ pages: string[]; pageCount: null }> {
  if (mimeType !== DOCX) throw new UnsupportedDocumentError('FILE_DAMAGED');
  const result = await convertToHtml({ buffer: Buffer.from(data.buffer, data.byteOffset, data.byteLength) });
  if (result.value.length > MAX_PREVIEW_CHARS) throw new UnsupportedDocumentError('FILE_TOO_COMPLEX');
  return { pages: [result.value], pageCount: null };
}

async function read({ mimeType, data }: Input): Promise<{ pages: string[]; pageCount: number | null }> {
  const isText = mimeType === 'text/plain' || mimeType === 'text/markdown';
  if (isText && data.byteLength > MAX_RAW_TEXT_CHARS * 4) throw new UnsupportedDocumentError('TEXT_TOO_LONG');
  if (isText) return { pages: [Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')], pageCount: null };
  if (mimeType === DOCX) {
    const result = await extractRawText({ buffer: Buffer.from(data.buffer, data.byteOffset, data.byteLength) });
    return { pages: [result.value], pageCount: null };
  }
  if (mimeType === 'application/pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(data, {
      verbosity: 0, disableFontFace: true, useSystemFonts: false, stopAtErrors: false, enableXfa: false,
    });
    if (pdf.numPages > MAX_PAGES) throw new UnsupportedDocumentError('TOO_MANY_PAGES');
    const { text } = await extractText(pdf, { mergePages: false });
    return { pages: text, pageCount: pdf.numPages };
  }
  throw new UnsupportedDocumentError('FILE_DAMAGED');
}

async function extract(input: Input): Promise<{ pages: string[]; pageCount: number | null }> {
  if (input.format === 'html') return renderHtml(input);
  const result = await read(input);
  assertRawLength(result.pages);
  return result;
}

const DAMAGED_PDF = new Set(['InvalidPDFException', 'FormatError', 'MissingPDFException']);
const DAMAGED_DOCX = /central directory|corrupted zip|end of data|is this a zip|could not find .*(document|part|body element)|invalid (xml|signature)|unexpected (close|end)|^(warning|error|fatalError): /i;

function codeOf(error: unknown, mimeType: string): string | null {
  if (error instanceof UnsupportedDocumentError) return error.code;
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'PasswordException') return 'PDF_ENCRYPTED';
  if (mimeType === 'application/pdf' && DAMAGED_PDF.has(name)) return 'FILE_DAMAGED';
  if (mimeType === DOCX && DAMAGED_DOCX.test(message)) return 'FILE_DAMAGED';
  return null;
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const frame = error.stack?.split('\n').map((line) => line.trim()).find((line) => line.startsWith('at ')) ?? '';
  return `${error.name} ${frame}`.replace(/\s+/g, ' ').trim().slice(0, 300);
}

const input = workerData as Input;
extract(input).then(
  (result) => parentPort!.postMessage({ type: EXTRACT_REPLY, ok: true, ...result }),
  (error: unknown) => {
    const code = codeOf(error, input.mimeType);
    parentPort!.postMessage({ type: EXTRACT_REPLY, ok: false, code: code && isUnsupportedCode(code) ? code : null, detail: describe(error) });
  },
);
