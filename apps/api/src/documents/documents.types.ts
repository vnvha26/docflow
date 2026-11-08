import { ParseState, PrivacyLevel } from '@prisma/client';

export const MAX_UPLOAD_MB = 50;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
export const TOO_LARGE_MESSAGE = `Tệp vượt quá ${MAX_UPLOAD_MB} MB.`;

export interface DocumentSummary {
  id: string;
  title: string;
  createdAt: Date;
  typeCode: string | null;
  privacyLevel: PrivacyLevel;
  status: ParseState;
  problem: string | null;
  file: { name: string; mimeType: string; byteSize: number };
  privacyOverride: PrivacyLevel | null;
  originalAvailable: boolean;
  originalDeleting: boolean;
}

export interface UploadResult {
  document: DocumentSummary;
  duplicate: boolean;
}

export interface StorageUsage {
  encryptedBytes: number;
  quotaBytes: number;
}
