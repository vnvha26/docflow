import { authClient } from './api.ts';

export type DocumentStatus = 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'UNSUPPORTED';

export interface DocumentSummary {
  id: string;
  title: string;
  createdAt: string;
  typeCode: string | null;
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
export type DocumentStatusFilter = 'read' | 'processing' | 'problem' | 'details-deleted';
export interface DocumentFilters { type?: DocumentTypeFilter; status?: DocumentStatusFilter }

export const typeFilterLabels: Record<DocumentTypeFilter, string> = { pdf: 'PDF', docx: 'DOCX', txt: 'TXT' };
export const statusFilterLabels: Record<DocumentStatusFilter, string> = {
  read: 'Đã đọc nội dung', processing: 'Đang đọc', problem: 'Không đọc được', 'details-deleted': 'Đã xóa bản chi tiết',
};
const filterMime: Record<DocumentTypeFilter, string> = { pdf: 'application/pdf', docx: DOCX_MIME, txt: 'text/plain' };

export function matchesFilters(document: Pick<DocumentSummary, 'file' | 'status' | 'detailsDeleted'>, filters: DocumentFilters): boolean {
  if (filters.type && document.file.mimeType !== filterMime[filters.type]) return false;
  switch (filters.status) {
    case 'read': return document.status === 'SUCCEEDED' && !document.detailsDeleted;
    case 'processing': return document.status === 'PENDING' || document.status === 'PROCESSING';
    case 'problem': return (document.status === 'FAILED' || document.status === 'UNSUPPORTED') && !document.detailsDeleted;
    case 'details-deleted': return document.detailsDeleted;
    default: return true;
  }
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
  PENDING: 'Chờ đọc nội dung', PROCESSING: 'Đang đọc nội dung', SUCCEEDED: 'Đã đọc nội dung', FAILED: 'Chưa đọc được', UNSUPPORTED: 'Không đọc được',
};

export function infoLine(document: Pick<DocumentSummary, 'file' | 'pageCount' | 'status' | 'detailsDeleted'>): string {
  const parts = [fileTypeLabel(document)];
  if (document.pageCount) parts.push(`${document.pageCount.toLocaleString('vi-VN')} trang`);
  parts.push(document.detailsDeleted ? 'Đã xóa bản chi tiết' : statusLabels[document.status]);
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

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export const documentsApi = {
  list(cursor?: string, filters: DocumentFilters = {}) {
    const query = new URLSearchParams({
      limit: '20', ...(cursor ? { cursor } : {}), ...(filters.type ? { type: filters.type } : {}), ...(filters.status ? { status: filters.status } : {}),
    });
    return authClient.request<{ items: DocumentSummary[]; nextCursor: string | null }>(`/documents?${query}`);
  },
  get(id: string) {
    return authClient.request<DocumentSummary>(`/documents/${encodeURIComponent(id)}`);
  },
  upload(file: File, userId: string) {
    const form = new FormData();
    form.append('file', file, file.name);
    return authClient.request<{ document: DocumentSummary; duplicate: boolean }>('/documents', { method: 'POST', body: form }, { asUser: userId });
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
