export type UploadState = 'waiting' | 'uploading' | 'asking' | 'done' | 'supplemented' | 'restored' | 'duplicate' | 'error';

export interface UploadItem { key: string; name: string; state: UploadState; message?: string; savedAs?: string; target?: string }

export interface UploadSummary { tone: 'busy' | 'done' | 'warn' | 'error'; text: string; details: string[] }

const quoted = (name: string) => `“${name}”`;
const RUNNING: readonly UploadState[] = ['waiting', 'uploading'];

export const isRunning = (item: Pick<UploadItem, 'state'>) => RUNNING.includes(item.state);

export function summarizeUploads(items: readonly UploadItem[]): UploadSummary | null {
  if (!items.length) return null;
  const running = items.filter(isRunning);
  const asking = items.filter((item) => item.state === 'asking');
  if (running.length) {
    const settled = items.length - running.length;
    const text = items.length === 1
      ? `Đang tải lên ${quoted(items[0].name)}…`
      : `Đang tải lên ${Math.min(settled + 1, items.length)}/${items.length} tệp…`;
    return { tone: 'busy', text, details: [] };
  }
  if (asking.length) {
    const text = asking.length === 1 && items.length === 1
      ? `Tệp ${quoted(asking[0].name)} đã có trong thư viện; đang chờ bạn chọn cách xử lý.`
      : `${asking.length} tệp đã có trong thư viện; đang chờ bạn chọn cách xử lý.`;
    return { tone: 'warn', text, details: [] };
  }
  const saved = items.filter((item) => item.state === 'done');
  const supplemented = items.filter((item) => item.state === 'supplemented');
  const restored = items.filter((item) => item.state === 'restored');
  const skipped = items.filter((item) => item.state === 'duplicate');
  const failed = items.filter((item) => item.state === 'error');
  const reason = (item: UploadItem) => item.message || 'Chưa thể tải lên. Vui lòng thử lại.';
  const target = (item: UploadItem) => quoted(item.target ?? item.name);

  if (items.length === 1) {
    const [item] = items;
    if (item.state === 'done' && item.savedAs) {
      return { tone: 'done', text: `Đã tải lên tệp ${quoted(item.name)}, lưu với tên ${quoted(item.savedAs)} vì tên này đã có trong thư mục.`, details: [] };
    }
    if (item.state === 'done') return { tone: 'done', text: `Đã tải lên tệp ${quoted(item.name)}.`, details: [] };
    if (item.state === 'supplemented') return { tone: 'done', text: `Đã bổ sung bản gốc cho ${target(item)}.`, details: [] };
    if (item.state === 'restored') return { tone: 'done', text: `Đã khôi phục ${target(item)} từ thùng rác, không cần tải lại.`, details: [] };
    if (item.state === 'duplicate') return { tone: 'done', text: `Không tải ${quoted(item.name)} vì đã có trong thư viện.`, details: [] };
    return { tone: 'error', text: `Không tải lên được ${quoted(item.name)}: ${reason(item)}`, details: [] };
  }

  const parts: string[] = [];
  if (saved.length) parts.push(`Đã tải lên ${saved.length} tệp`);
  if (supplemented.length) parts.push(`bổ sung bản gốc cho ${supplemented.length} tài liệu`);
  if (restored.length) parts.push(`khôi phục ${restored.length} mục từ thùng rác`);
  if (skipped.length) parts.push(`bỏ qua ${skipped.length} tệp đã có`);
  if (failed.length) parts.push(parts.length ? `${failed.length} tệp lỗi` : `Không tải lên được ${failed.length} tệp`);
  const text = parts.join(' · ');
  return {
    tone: !failed.length ? 'done' : failed.length === items.length ? 'error' : 'warn',
    text: `${text.charAt(0).toLocaleUpperCase('vi')}${text.slice(1)}.`,
    details: [
      ...failed.map((item) => `${quoted(item.name)}: ${reason(item)}`),
      ...saved.filter((item) => item.savedAs).map((item) => `${quoted(item.name)}: lưu với tên ${quoted(item.savedAs!)} vì tên đã có trong thư mục.`),
      ...supplemented.map((item) => `${quoted(item.name)}: bổ sung bản gốc cho ${target(item)}.`),
      ...restored.map((item) => `${quoted(item.name)}: khôi phục ${target(item)} từ thùng rác.`),
    ],
  };
}
