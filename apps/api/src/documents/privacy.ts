import { PrivacyLevel } from '@prisma/client';

const ORDER: readonly PrivacyLevel[] = ['STRUCTURED_ONLY', 'TEXT_AND_EMBEDDINGS', 'ENCRYPTED_COPY'];

export const DEFAULT_PRIVACY_LEVEL: PrivacyLevel = 'ENCRYPTED_COPY';

export function effectivePrivacy(account: PrivacyLevel, document: PrivacyLevel | null | undefined): PrivacyLevel {
  if (!document) return account;
  return ORDER.indexOf(document) < ORDER.indexOf(account) ? document : account;
}

export function isLowerPrivacy(next: PrivacyLevel, current: PrivacyLevel): boolean {
  return ORDER.indexOf(next) < ORDER.indexOf(current);
}
