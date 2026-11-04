const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_LENGTH = 255;

function clean(value: string): string {
  return value.normalize('NFC')
    .replace(/[\t\n\r\f\v]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeFileName(raw: string | undefined, extension: string): string {
  const last = (raw ?? '').split(/[\\/]/).pop() ?? '';
  let base = clean(last);
  const suffix = `.${extension}`;
  if (base.toLowerCase().endsWith(suffix)) base = base.slice(0, -suffix.length);
  base = base.replace(/[. ]+$/g, '').replace(/^[. ]+/g, '');
  if (!base) base = 'tai-lieu';
  if (RESERVED.test(base)) base = `_${base}`;
  const chars = Array.from(base);
  if (chars.length + suffix.length > MAX_LENGTH) base = chars.slice(0, MAX_LENGTH - suffix.length).join('').replace(/[. ]+$/g, '');
  return `${base}${suffix}`;
}

export function titleFromFileName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '') || fileName;
}

export function cleanTitle(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const title = Array.from(clean(value)).slice(0, 255).join('').trim();
  return title || undefined;
}

export function contentDisposition(fileName: string): string {
  const ascii = fileName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/[^\x20-\x7e]/g, '_').replace(/["\\%]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
