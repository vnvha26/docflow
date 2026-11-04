import { authClient } from './api';
import type { User } from './api';

export type PrivacyLevel = User['privacyLevel'];

export interface DocumentSummary {
  id: string;
  title: string;
  createdAt: string;
  typeCode: string | null;
  privacyLevel: PrivacyLevel;
  status: 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'UNSUPPORTED';
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
  deleteOriginal(id: string) {
    return authClient.request<DocumentSummary>(`/documents/${encodeURIComponent(id)}/original`, { method: 'DELETE' });
  },
  setLevel(id: string, privacyLevel: PrivacyLevel | null) {
    return authClient.request<DocumentSummary>(`/documents/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ privacyLevel }) });
  },
};
