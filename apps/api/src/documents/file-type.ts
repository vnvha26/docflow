export interface DetectedType {
  kind: 'pdf' | 'docx' | 'txt' | 'md' | 'png' | 'jpg' | 'webp';
  mimeType: string;
  extension: string;
}

const TYPES: Record<DetectedType['kind'], DetectedType> = {
  pdf: { kind: 'pdf', mimeType: 'application/pdf', extension: 'pdf' },
  docx: { kind: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: 'docx' },
  txt: { kind: 'txt', mimeType: 'text/plain', extension: 'txt' },
  md: { kind: 'md', mimeType: 'text/markdown', extension: 'md' },
  png: { kind: 'png', mimeType: 'image/png', extension: 'png' },
  jpg: { kind: 'jpg', mimeType: 'image/jpeg', extension: 'jpg' },
  webp: { kind: 'webp', mimeType: 'image/webp', extension: 'webp' },
};

export const IMAGE_MIME_TYPES: readonly string[] = [TYPES.png.mimeType, TYPES.jpg.mimeType, TYPES.webp.mimeType];
export const TEXT_MIME_TYPES: readonly string[] = [TYPES.txt.mimeType, TYPES.md.mimeType];

const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');
const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function imageType(data: Buffer): DetectedType | null {
  if (data.length >= 24 && data.subarray(0, 8).equals(PNG_MAGIC) && data.toString('latin1', 12, 16) === 'IHDR') return TYPES.png;
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return TYPES.jpg;
  if (data.length >= 16 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return TYPES.webp;
  return null;
}

function withExtension(type: DetectedType, fileName: string, aliases: string[]): DetectedType {
  const extension = /\.([A-Za-z0-9]+)$/.exec(fileName.trim())?.[1]?.toLowerCase();
  return extension && aliases.includes(extension) ? { ...type, extension } : type;
}

function isPdf(data: Buffer): boolean {
  return data.subarray(0, 1024).indexOf(PDF_MAGIC) !== -1;
}

export function zipEntryNames(data: Buffer, maxEntries = 10_000): string[] | null {
  if (data.length < 22 || data.readUInt32LE(0) !== ZIP_LOCAL) return null;
  let end = -1;
  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 22 - 0xffff); offset--) {
    if (data.readUInt32LE(offset) === ZIP_END) { end = offset; break; }
  }
  if (end < 0) return null;
  const entries = data.readUInt16LE(end + 10);
  const size = data.readUInt32LE(end + 12);
  let offset = data.readUInt32LE(end + 16);
  if (entries > maxEntries || offset + size > end) return null;
  const names: string[] = [];
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > end || data.readUInt32LE(offset) !== ZIP_CENTRAL) return null;
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > end) return null;
    names.push(data.toString('utf8', offset + 46, nameEnd));
    offset = nameEnd + extraLength + commentLength;
  }
  return names;
}

function isDocx(data: Buffer): boolean {
  const names = zipEntryNames(data);
  return Boolean(names?.includes('[Content_Types].xml') && names.includes('word/document.xml'));
}

const decoder = new TextDecoder('utf-8', { fatal: true });

function isUtf8Text(data: Buffer): boolean {
  try {
    const text = decoder.decode(data);
    return !/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text);
  } catch {
    return false;
  }
}

export function detectFileType(data: Buffer, fileName: string): DetectedType | null {
  if (isPdf(data)) return TYPES.pdf;
  if (isDocx(data)) return TYPES.docx;
  const image = imageType(data);
  if (image) return image === TYPES.jpg ? withExtension(image, fileName, ['jpg', 'jpeg']) : image;
  if (/\.txt$/i.test(fileName.trim()) && isUtf8Text(data)) return TYPES.txt;
  if (/\.(md|markdown)$/i.test(fileName.trim()) && isUtf8Text(data)) return withExtension(TYPES.md, fileName, ['md', 'markdown']);
  return null;
}
