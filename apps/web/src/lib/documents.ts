import { authClient } from './api.ts';

export type DocumentStatus = 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'UNSUPPORTED';

export interface DocumentSummary {
  id: string;
  title: string;
  createdAt: string;
  typeCode: string | null;
  folderId: string | null;
  status: DocumentStatus;
  problem: string | null;
  file: { name: string; mimeType: string; byteSize: number };
  originalAvailable: boolean;
  originalDeleting: boolean;
  updatedAt: string;
  pageCount: number | null;
  summary: string | null;
  detailsDeleted: boolean;
}

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const isProcessing = (document: Pick<DocumentSummary, 'status'>) => document.status === 'PENDING' || document.status === 'PROCESSING';

export type DocumentTypeFilter = 'pdf' | 'docx' | 'txt';
export type DocumentSort = 'created' | 'updated' | 'name' | 'name-desc';
export interface DocumentFilters { type?: DocumentTypeFilter; folder?: string; sort?: DocumentSort }
export const sortLabels: Record<DocumentSort, string> = {
  created: 'Mới tải lên trước', updated: 'Mới cập nhật trước', name: 'Tên A → Z', 'name-desc': 'Tên Z → A',
};
export const UNFILED = 'none';

export const typeFilterLabels: Record<DocumentTypeFilter, string> = { pdf: 'PDF', docx: 'DOCX', txt: 'TXT' };
const filterMime: Record<DocumentTypeFilter, string> = { pdf: 'application/pdf', docx: DOCX_MIME, txt: 'text/plain' };

export function matchesFilters(document: Pick<DocumentSummary, 'file' | 'folderId'>, filters: DocumentFilters): boolean {
  if (filters.folder !== undefined && document.folderId !== (filters.folder === UNFILED ? null : filters.folder)) return false;
  if (filters.type && document.file.mimeType !== filterMime[filters.type]) return false;
  return true;
}

export const isChanging = (document: Pick<DocumentSummary, 'status' | 'originalDeleting'>) => isProcessing(document) || document.originalDeleting;

const problemMessages: Record<string, string> = {
  NO_TEXT_LAYER: 'PDF này là ảnh scan, không có lớp chữ. Hãy dùng bản PDF xuất từ Word hoặc chạy nhận dạng chữ (OCR) trước khi tải lên.',
  EMPTY_TEXT: 'Tệp không có nội dung chữ.',
  LEGACY_VIETNAMESE_FONT: 'Văn bản dùng font tiếng Việt cũ (TCVN3/VNI). Hãy chuyển sang Unicode, ví dụ bằng công cụ chuyển mã của Unikey, rồi tải lại.',
  UNREADABLE_TEXT: 'Chữ trong tệp dùng font nhúng không đọc được. Hãy xuất lại PDF hoặc lưu sang DOCX rồi tải lại.',
  PDF_ENCRYPTED: 'PDF đang có mật khẩu. Hãy gỡ mật khẩu rồi tải lại.',
  FILE_DAMAGED: 'Tệp bị hỏng hoặc không đúng định dạng nên không đọc được.',
  TOO_MANY_PAGES: 'Tài liệu dài quá 1.000 trang.',
  TEXT_TOO_LONG: 'Nội dung quá dài (hơn 2 triệu ký tự).',
  FILE_TOO_COMPLEX: 'Tệp quá phức tạp để đọc trong thời gian cho phép.',
  SOURCE_UNAVAILABLE: 'Bản tạm của tệp không còn nên chưa đọc được. Hãy tải lại đúng tệp này để xử lý tiếp.',
};

export function problemMessage(document: Pick<DocumentSummary, 'status' | 'problem'> & Partial<Pick<DocumentSummary, 'detailsDeleted'>>): string | null {
  if (document.detailsDeleted) return null;
  if (document.status !== 'FAILED' && document.status !== 'UNSUPPORTED') return null;
  return (document.problem && problemMessages[document.problem])
    ?? (document.status === 'FAILED' ? 'Chưa đọc được tệp do lỗi tạm thời. Tải lại đúng tệp này để thử lại.' : 'Không đọc được nội dung tệp này.');
}

export interface StorageUsage { encryptedBytes: number; quotaBytes: number }

export const MAX_UPLOAD_MB = 50;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
export const ACCEPTED_EXTENSIONS = ['pdf', 'docx', 'txt'];

const typeLabels: Record<string, string> = {
  'application/pdf': 'PDF',
  [DOCX_MIME]: 'DOCX',
  'text/plain': 'TXT',
};

export const fileTypeLabel = (document: Pick<DocumentSummary, 'file'>) => typeLabels[document.file.mimeType] ?? 'TỆP';

const statusLabels: Record<DocumentStatus, string> = {
  PENDING: 'Chờ đọc nội dung…', PROCESSING: 'Đang đọc nội dung…', SUCCEEDED: 'Đã đọc nội dung', FAILED: 'Chưa đọc được', UNSUPPORTED: 'Không đọc được',
};

type InfoFields = 'file' | 'pageCount' | 'status' | 'detailsDeleted' | 'originalAvailable' | 'originalDeleting';

export function infoLine(document: Pick<DocumentSummary, InfoFields>): string {
  const parts = [fileTypeLabel(document)];
  if (document.pageCount) parts.push(`${document.pageCount.toLocaleString('vi-VN')} trang`);
  if (document.detailsDeleted) parts.push('Đã xóa bản chi tiết');
  else if (document.status === 'SUCCEEDED') parts.push(formatBytes(document.file.byteSize));
  else parts.push(statusLabels[document.status]);
  if (!document.detailsDeleted && !isProcessing(document) && !document.originalAvailable && !document.originalDeleting) parts.push('Không còn bản gốc');
  return parts.join(' · ');
}

export const canViewOriginal = (document: Pick<DocumentSummary, 'file' | 'originalAvailable'>) =>
  document.originalAvailable && ['application/pdf', 'text/plain', DOCX_MIME].includes(document.file.mimeType);

export function precheck(file: File): string | null {
  const extension = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (!ACCEPTED_EXTENSIONS.includes(extension)) return 'Chỉ hỗ trợ tệp PDF, DOCX và TXT.';
  if (file.size === 0) return 'Tệp rỗng, không có gì để lưu.';
  if (file.size > MAX_UPLOAD_BYTES) return `Tệp vượt quá ${MAX_UPLOAD_MB} MB.`;
  return null;
}

const decimal = (value: number, digits: number) => value.toFixed(digits).replace('.', ',');

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${decimal(bytes / 1024, bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 ** 3) return `${decimal(bytes / 1024 ** 2, 1)} MB`;
  return `${decimal(bytes / 1024 ** 3, 2)} GB`;
}

export function titleProblem(value: string): string | null {
  const title = value.trim();
  if (!title) return 'Nhập tên tài liệu.';
  if (title.length > 255) return 'Tên tài liệu không được vượt quá 255 ký tự.';
  return null;
}

export const documentsApi = {
  list(cursor?: string, filters: DocumentFilters = {}) {
    const query = new URLSearchParams({
      limit: '20', ...(cursor ? { cursor } : {}), ...(filters.type ? { type: filters.type } : {}),
      ...(filters.folder ? { folder: filters.folder } : {}), ...(filters.sort && filters.sort !== 'created' ? { sort: filters.sort } : {}),
    });
    return authClient.request<{ items: DocumentSummary[]; nextCursor: string | null }>(`/documents?${query}`);
  },
  get(id: string) {
    return authClient.request<DocumentSummary>(`/documents/${encodeURIComponent(id)}`);
  },
  upload(file: File, userId: string, folderId: string | null = null) {
    const form = new FormData();
    form.append('file', file, file.name);
    if (folderId) form.append('folderId', folderId);
    return authClient.request<{ document: DocumentSummary; duplicate: boolean; renamed: boolean }>('/documents', { method: 'POST', body: form }, { asUser: userId });
  },
  update(id: string, change: { title?: string; folderId?: string | null }, userId: string) {
    return authClient.request<{ document: DocumentSummary; renamed: boolean }>(
      `/documents/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(change) }, { asUser: userId });
  },
  usage() {
    return authClient.request<StorageUsage>('/documents/usage');
  },
  original(id: string) {
    return authClient.download(`/documents/${encodeURIComponent(id)}/original`);
  },
  preview(id: string) {
    return authClient.download(`/documents/${encodeURIComponent(id)}/preview`);
  },
  remove(id: string) {
    return authClient.request<void>(`/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  deleteOriginal(id: string) {
    return authClient.request<DocumentSummary>(`/documents/${encodeURIComponent(id)}/original`, { method: 'DELETE' });
  },
  deleteDetails(id: string) {
    return authClient.request<DocumentSummary>(`/documents/${encodeURIComponent(id)}/details`, { method: 'DELETE' });
  },
};
