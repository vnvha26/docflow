export const PARSER_VERSION = 'p2';
export const EXTRACT_REPLY = 'docflow:extract';
export const MAX_PAGES = 1_000;
export const MAX_TEXT_CHARS = 2_000_000;
export const MAX_RAW_TEXT_CHARS = 2 * MAX_TEXT_CHARS;
export const MAX_PREVIEW_CHARS = 100_000_000;

export const UNSUPPORTED_CODES = [
  'NO_TEXT_LAYER', 'EMPTY_TEXT', 'LEGACY_VIETNAMESE_FONT', 'UNREADABLE_TEXT', 'PDF_ENCRYPTED',
  'FILE_DAMAGED', 'TOO_MANY_PAGES', 'TEXT_TOO_LONG', 'FILE_TOO_COMPLEX',
] as const;
export type UnsupportedCode = typeof UNSUPPORTED_CODES[number];

export class UnsupportedDocumentError extends Error {
  constructor(readonly code: UnsupportedCode, readonly detail?: string) {
    super(code);
    this.name = 'UnsupportedDocumentError';
  }
}

export class ParserFailedError extends Error {
  constructor(readonly detail: string) {
    super('PARSER_FAILED');
    this.name = 'ParserFailedError';
  }
}

export function isUnsupportedCode(value: unknown): value is UnsupportedCode {
  return typeof value === 'string' && (UNSUPPORTED_CODES as readonly string[]).includes(value);
}

export interface NormalizedText {
  text: string;
  pageStarts: number[];
}

export function normalizeBlock(value: string): string {
  return value
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizePages(pages: readonly string[]): NormalizedText {
  let text = '';
  const pageStarts: number[] = [];
  for (const page of pages) {
    const block = normalizeBlock(page);
    if (text && block) text += '\n\n';
    pageStarts.push(text.length);
    text += block;
  }
  return { text, pageStarts };
}

const VIETNAMESE = /[\u0102\u0103\u0110\u0111\u0128\u0129\u0168\u0169\u01A0\u01A1\u01AF\u01B0\u1EA0-\u1EF9]/g;
const TCVN3 = /[\u00A1-\u00A6\u00A8-\u00AA\u00AC-\u00AF\u00B5-\u00BA\u00BC-\u00BE\u00D7]/g;
const VNI = /(?<=[A-Za-z])[\u00F8\u00F9\u00FB\u00F5\u00EF]|[\u00D1\u00F1](?=[\u00F6\u00F4A-Za-z])/g;
const UNREADABLE = /[\uFFFD\uE000-\uF8FF]/g;

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

export function looksLikeLegacyVietnamese(text: string): boolean {
  const legacy = count(text, TCVN3) + count(text, VNI);
  return legacy >= 15 && count(text, VIETNAMESE) * 4 < legacy;
}

export function assertRawLength(pages: readonly string[]): void {
  let total = 0;
  for (const page of pages) {
    total += page.length;
    if (total > MAX_RAW_TEXT_CHARS) throw new UnsupportedDocumentError('TEXT_TOO_LONG');
  }
}

export function assessText(text: string, fromPdf: boolean): void {
  if (text.length > MAX_TEXT_CHARS) throw new UnsupportedDocumentError('TEXT_TOO_LONG');
  const readable = count(text, /[\p{L}\p{N}]/gu);
  const unreadable = count(text, UNREADABLE);
  if (readable === 0) throw new UnsupportedDocumentError(unreadable > 0 ? 'UNREADABLE_TEXT' : fromPdf ? 'NO_TEXT_LAYER' : 'EMPTY_TEXT');
  if (unreadable / (readable + unreadable) > 0.2) throw new UnsupportedDocumentError('UNREADABLE_TEXT');
  if (looksLikeLegacyVietnamese(text)) throw new UnsupportedDocumentError('LEGACY_VIETNAMESE_FONT');
}
