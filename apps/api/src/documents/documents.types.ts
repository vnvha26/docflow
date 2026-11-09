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


export interface UploadResult {
  document: DocumentSummary;
  duplicate: boolean;
}

export interface StorageUsage {
  encryptedBytes: number;
  quotaBytes: number;
}
