export const CHUNKER_VERSION = 'c1';

export interface TextChunk {
  ordinal: number;
  content: string;
  charStart: number;
  charEnd: number;
  pageFrom: number | null;
  pageTo: number | null;
}

export interface ChunkOptions {
  target?: number;
  overlap?: number;
}

const WHITESPACE = /\s/;
const JOINED = /[\p{M}\u200C\u200D\uFE00-\uFE0F]/u;

function isHigh(code: number): boolean {
  return code >= 0xD800 && code <= 0xDBFF;
}

function isLow(code: number): boolean {
  return code >= 0xDC00 && code <= 0xDFFF;
}

function safeBoundary(text: string, index: number, floor: number): number {
  let boundary = index;
  while (boundary > floor + 1 && boundary < text.length) {
    const splitsPair = isLow(text.charCodeAt(boundary)) && isHigh(text.charCodeAt(boundary - 1));
    const splitsCluster = JOINED.test(String.fromCodePoint(text.codePointAt(boundary)!)) || text.charCodeAt(boundary - 1) === 0x200D;
    if (!splitsPair && !splitsCluster) break;
    boundary--;
  }
  if (boundary < text.length && isLow(text.charCodeAt(boundary)) && isHigh(text.charCodeAt(boundary - 1))) boundary++;
  return boundary;
}

function breakPoint(text: string, start: number, limit: number): number {
  if (limit >= text.length) return text.length;
  const floor = start + Math.floor((limit - start) * 0.6);
  const window = text.slice(floor, limit);
  for (const pattern of [/\n\n/g, /\n/g, /[.!?…;:](?=\s)/g, /\s/g]) {
    let last = -1;
    for (const match of window.matchAll(pattern)) last = match.index! + match[0].length;
    if (last > 0) return floor + last;
  }
  return safeBoundary(text, limit, start);
}

function pageOf(pageStarts: readonly number[] | null, offset: number): number | null {
  if (!pageStarts?.length) return null;
  let low = 0;
  let high = pageStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (pageStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

export function chunkText(text: string, pageStarts: readonly number[] | null, options: ChunkOptions = {}): TextChunk[] {
  const target = options.target ?? 1_200;
  const overlap = Math.min(options.overlap ?? 150, Math.floor(target / 3));
  const chunks: TextChunk[] = [];
  let position = 0;
  while (position < text.length) {
    while (position < text.length && WHITESPACE.test(text[position])) position++;
    if (position >= text.length) break;
    const end = breakPoint(text, position, position + target);
    let charEnd = end;
    while (charEnd > position && WHITESPACE.test(text[charEnd - 1])) charEnd--;
    chunks.push({
      ordinal: chunks.length,
      content: text.slice(position, charEnd),
      charStart: position,
      charEnd,
      pageFrom: pageOf(pageStarts, position),
      pageTo: pageOf(pageStarts, charEnd - 1),
    });
    if (end >= text.length) break;
    let next = Math.max(end - overlap, position + 1);
    while (next < end && !WHITESPACE.test(text[next - 1])) next++;
    position = next;
  }
  return chunks;
}
