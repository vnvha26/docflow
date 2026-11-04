-- Decision 04/11/2026: new accounts start at level 3 (ENCRYPTED_COPY) so every document
-- keeps structured data, text and an encrypted original. Users may still choose a lower level.
-- Existing accounts keep the level they have: retention is never raised without consent.
ALTER TABLE "User" ALTER COLUMN "privacyLevel" SET DEFAULT 'ENCRYPTED_COPY';
