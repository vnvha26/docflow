export type UploadState = 'waiting' | 'uploading' | 'done' | 'duplicate' | 'error';

export interface UploadItem { key: string; name: string; state: UploadState; message?: string; savedAs?: string }

export interface UploadSummary { tone: 'busy' | 'done' | 'warn' | 'error'; text: string; details: string[] }

const quoted = (name: string) => `“${name}”`;

export function summarizeUploads(items: readonly UploadItem[]): UploadSummary | null {
  if (!items.length) return null;
  const finished = items.filter((item) => item.state === 'done' || item.state === 'duplicate' || item.state === 'error');
  if (finished.length < items.length) {
    const text = items.length === 1
      ? `Đang tải lên ${quoted(items[0].name)}…`
      : `Đang tải lên ${Math.min(finished.length + 1, items.length)}/${items.length} tệp…`;
    return { tone: 'busy', text, details: [] };
  }
  const saved = items.filter((item) => item.state === 'done');
  const duplicates = items.filter((item) => item.state === 'duplicate');
  const failed = items.filter((item) => item.state === 'error');
  const reason = (item: UploadItem) => item.message || 'Chưa thể tải lên. Vui lòng thử lại.';

  if (items.length === 1) {
    const [item] = items;
    if (item.state === 'done' && item.savedAs) {
      return { tone: 'done', text: `Đã tải lên tệp ${quoted(item.name)}, lưu với tên ${quoted(item.savedAs)} vì tên này đã có trong thư mục.`, details: [] };
    }
    if (item.state === 'done') return { tone: 'done', text: `Đã tải lên tệp ${quoted(item.name)}.`, details: [] };
    if (item.state === 'duplicate') return { tone: 'done', text: `Tệp ${quoted(item.name)} đã có sẵn trong thư viện, không lưu thêm.`, details: [] };
    return { tone: 'error', text: `Không tải lên được ${quoted(item.name)}: ${reason(item)}`, details: [] };
  }

  const parts: string[] = [];
  if (saved.length) parts.push(`Đã tải lên ${saved.length} tệp`);
  if (duplicates.length) parts.push(`${duplicates.length} tệp đã có sẵn`);
  if (failed.length) parts.push(saved.length || duplicates.length ? `${failed.length} tệp lỗi` : `Không tải lên được ${failed.length} tệp`);
  return {
    tone: !failed.length ? 'done' : failed.length === items.length ? 'error' : 'warn',
    text: `${parts.join(' · ')}.`,
    details: [
      ...failed.map((item) => `${quoted(item.name)}: ${reason(item)}`),
      ...saved.filter((item) => item.savedAs).map((item) => `${quoted(item.name)}: lưu với tên ${quoted(item.savedAs!)} vì tên đã có trong thư mục.`),
    ],
  };
}
