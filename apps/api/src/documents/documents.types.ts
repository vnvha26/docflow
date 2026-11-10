import { ParseState } from '@prisma/client';

export const MAX_UPLOAD_MB = 50;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
export const TOO_LARGE_MESSAGE = `Tệp vượt quá ${MAX_UPLOAD_MB} MB.`;

export interface DocumentSummary {
  id: string;
  title: string;
  createdAt: Date;
  typeCode: string | null;
  status: ParseState;
  problem: string | null;
  file: { name: string; mimeType: string; byteSize: number };
  originalAvailable: boolean;
  originalDeleting: boolean;
  updatedAt: Date;
  pageCount: number | null;
  summary: string | null;
  detailsDeleted: boolean;
}


export const DOCUMENT_TYPE_FILTERS = ['pdf', 'docx', 'txt'] as const;
export type DocumentTypeFilter = (typeof DOCUMENT_TYPE_FILTERS)[number];
export const DOCUMENT_STATUS_FILTERS = ['read', 'processing', 'problem', 'details-deleted'] as const;
export type DocumentStatusFilter = (typeof DOCUMENT_STATUS_FILTERS)[number];

export interface DocumentFilters {
  type?: DocumentTypeFilter;
  status?: DocumentStatusFilter;
}

export interface UploadResult {
  document: DocumentSummary;
  duplicate: boolean;
}

export interface StorageUsage {
  encryptedBytes: number;
  quotaBytes: number;
}
