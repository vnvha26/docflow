import { ParseState } from '@prisma/client';

export const MAX_UPLOAD_MB = 50;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
export const TOO_LARGE_MESSAGE = `Tệp vượt quá ${MAX_UPLOAD_MB} MB.`;

export interface DocumentSummary {
  id: string;
  title: string;
  createdAt: Date;
  typeCode: string | null;
  folderId: string | null;
  status: ParseState;
  problem: string | null;
  file: { name: string; mimeType: string; byteSize: number };
  originalAvailable: boolean;
  originalDeleting: boolean;
  updatedAt: Date;
  pageCount: number | null;
  summary: string | null;
  originalInTrash: boolean;
}


export const DOCUMENT_TYPE_FILTERS = ['pdf', 'docx', 'txt'] as const;
export type DocumentTypeFilter = (typeof DOCUMENT_TYPE_FILTERS)[number];

export const UNFILED = 'none';
export const DOCUMENT_SORTS = ['created', 'updated', 'name', 'name-desc'] as const;
export type DocumentSort = (typeof DOCUMENT_SORTS)[number];

export interface DocumentFilters {
  type?: DocumentTypeFilter;
  folder?: string;
  sort?: DocumentSort;
}

export interface DocumentChange {
  title?: string;
  folderId?: string | null;
}

export interface RenameResult {
  document: DocumentSummary;
  renamed: boolean;
}

export interface UploadResult {
  document: DocumentSummary;
  duplicate: boolean;
  renamed: boolean;
}

export interface StorageUsage {
  encryptedBytes: number;
  quotaBytes: number;
}
