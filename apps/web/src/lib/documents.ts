import { authClient } from './api';
import type { User } from './api';

export type PrivacyLevel = User['privacyLevel'];

export type DocumentStatus = 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'UNSUPPORTED';

export interface DocumentSummary {
  id: string;
  title: string;
  createdAt: string;
  typeCode: string | null;
  privacyLevel: PrivacyLevel;
  status: DocumentStatus;
  problem: string | null;
  file: { name: string; mimeType: string; byteSize: number };
  privacyOverride: PrivacyLevel | null;
  originalAvailable: boolean;
  originalDeleting: boolean;
}

export const LEVEL_ORDER: PrivacyLevel[] = ['STRUCTURED_ONLY', 'TEXT_AND_EMBEDDINGS', 'ENCRYPTED_COPY'];
export const isLower = (next: PrivacyLevel, current: PrivacyLevel) => LEVEL_ORDER.indexOf(next) < LEVEL_ORDER.indexOf(current);

export function lossesOf(next: PrivacyLevel, current: PrivacyLevel): string[] {
  const losses: string[] = [];
  if (current === 'ENCRYPTED_COPY' && next !== 'ENCRYPTED_COPY') losses.push('Bản gốc đã mã hóa bị xóa vĩnh viễn; nâng lại mức 3 sau này không khôi phục được.');
  if (next === 'STRUCTURED_ONLY' && current !== 'STRUCTURED_ONLY') losses.push('Nội dung chữ, tóm tắt và đoạn trích dẫn nguyên văn bị xóa; chỉ giữ thông tin có cấu trúc và việc cần làm.');
  return losses;
}

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const isProcessing =(document: Pick<DocumentSummary, 'status'>) => document.status === 'PENDING' || document.status === 'PROCESSING';

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

export function problemMessage(document: Pick<DocumentSummary, 'status' | 'problem'>): string | null {
  if (document.status !== 'FAILED' && document.status !== 'UNSUPPORTED') return null;
  return (document.problem && problemMessages[document.problem])
    ?? (document.status === 'FAILED' ? 'Chưa đọc được tệp do lỗi tạm thời. Tải lại đúng tệp này để thử lại.' : 'Không đọc được nội dung tệp này.');
}

export interface StorageUsage { encryptedBytes: number; quotaBytes: number }

export const MAX_UPLOAD_MB = 50;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
export const ACCEPTED_EXTENSIONS = ['pdf', 'docx', 'txt'];

export const privacyLabels: Record<PrivacyLevel, string> = {
  STRUCTURED_ONLY: 'Chỉ thông tin có cấu trúc',
  TEXT_AND_EMBEDDINGS: 'Nội dung & tìm kiếm',
  ENCRYPTED_COPY: 'Bản gốc được mã hóa',
};

export function precheck(file: File): string | null {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
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
  list(cursor?: string) {
    const query = new URLSearchParams({ limit: '20', ...(cursor ? { cursor } : {}) });
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
  setLevel(id: string, privacyLevel: PrivacyLevel | null) {
    return authClient.request<DocumentSummary>(`/documents/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ privacyLevel }) });
  },
};
