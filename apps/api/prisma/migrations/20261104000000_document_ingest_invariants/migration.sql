-- Document ingest (B1–B3, P3) invariants that Prisma cannot express: CHECK constraints,
-- partial indexes and a trigger. Existing migrations stay immutable.
--
-- KEEP THIS MIGRATION. If a future `prisma migrate diff` proposes `DROP INDEX` for an index
-- created here, delete those lines from the generated migration.

-- A relative '/'-separated object key. Defence in depth: the code that builds keys validates too.
CREATE FUNCTION docflow_is_safe_relpath(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT p <> ''
     AND p IS NFC NORMALIZED
     AND left(p, 1) <> '/'
     AND right(p, 1) <> '/'
     AND strpos(p, '\') = 0
     AND strpos(p, '//') = 0
     AND p !~ '^[A-Za-z]:'
     AND ('/' || p || '/') !~ '/\.\.?/'
     AND p !~ '[[:cntrl:]]'
$$;

-- One file name as shown to the user. Windows reserved names are handled by the app.
CREATE FUNCTION docflow_is_safe_segment(n text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT btrim(n) <> ''
     AND n IS NFC NORMALIZED
     AND n NOT IN ('.', '..')
     AND strpos(n, '/') = 0
     AND strpos(n, '\') = 0
     AND n !~ '[[:cntrl:]]'
     AND right(n, 1) NOT IN ('.', ' ')
$$;

ALTER TABLE "Document"
  ADD CONSTRAINT "Document_title_check" CHECK (btrim("title") <> ''),
  ADD CONSTRAINT "Document_revision_check" CHECK ("revision" >= 1);

ALTER TABLE "DocumentVersion"
  ADD CONSTRAINT "DocumentVersion_number_check" CHECK ("number" >= 1),
  ADD CONSTRAINT "DocumentVersion_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "DocumentVersion_byteSize_check" CHECK ("byteSize" >= 0),
  ADD CONSTRAINT "DocumentVersion_filename_check" CHECK (docflow_is_safe_segment("originalFilename")),
  ADD CONSTRAINT "DocumentVersion_parse_error_check"
    CHECK ("parseState" NOT IN ('FAILED', 'UNSUPPORTED') OR "parseErrorCode" IS NOT NULL),
  ADD CONSTRAINT "DocumentVersion_counts_check"
    CHECK (("pageCount" IS NULL OR "pageCount" >= 0) AND ("charCount" IS NULL OR "charCount" >= 0));

-- A version is a content snapshot: identity and fingerprint never change after insert.
CREATE FUNCTION docflow_document_version_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."sha256" IS DISTINCT FROM OLD."sha256"
     OR NEW."byteSize" IS DISTINCT FROM OLD."byteSize"
     OR NEW."number" IS DISTINCT FROM OLD."number"
     OR NEW."documentId" IS DISTINCT FROM OLD."documentId"
     OR NEW."userId" IS DISTINCT FROM OLD."userId" THEN
    RAISE EXCEPTION 'DocumentVersion % is immutable (sha256, byteSize, number, documentId, userId)', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "DocumentVersion_immutable"
  BEFORE UPDATE ON "DocumentVersion"
  FOR EACH ROW EXECUTE FUNCTION docflow_document_version_immutable();

-- FileCopy.sha256/byteSize describe the stored object bytes (ciphertext), see ADR 0002.
ALTER TABLE "FileCopy"
  ADD CONSTRAINT "FileCopy_storageKey_check"
    CHECK (docflow_is_safe_relpath("storageKey") AND "storageKey" !~ '^[A-Za-z][A-Za-z0-9+.-]*:'),
  ADD CONSTRAINT "FileCopy_encryption_check" CHECK ("kind" = 'WEB_SOURCE' OR "encryptionKeyRef" IS NOT NULL),
  ADD CONSTRAINT "FileCopy_content_check"
    CHECK (("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$')
           AND ("byteSize" IS NULL OR "byteSize" >= 0)
           AND ("state" <> 'AVAILABLE' OR ("sha256" IS NOT NULL AND "byteSize" IS NOT NULL))),
  ADD CONSTRAINT "FileCopy_deletion_check"
    CHECK (("state" NOT IN ('DELETE_PENDING', 'DELETED') OR "deleteRequestedAt" IS NOT NULL)
           AND (("state" = 'DELETED') = ("deletedAt" IS NOT NULL))),
  ADD CONSTRAINT "FileCopy_retention_check" CHECK ("kind" = 'WEB_SOURCE' OR "expiresAt" IS NULL),
  ADD CONSTRAINT "FileCopy_revision_check" CHECK ("revision" >= 1);

-- At most one live blob per (version, kind); deleted copies keep their history rows.
CREATE UNIQUE INDEX "FileCopy_one_live_per_version_kind_key" ON "FileCopy" ("versionId", "kind")
  WHERE "state" IN ('UPLOADING', 'AVAILABLE');
-- Work queues for the cleanup worker (P5): expired temporary copies, pending deletions.
CREATE INDEX "FileCopy_expiry_idx" ON "FileCopy" ("expiresAt")
  WHERE "state" = 'AVAILABLE' AND "expiresAt" IS NOT NULL;
CREATE INDEX "FileCopy_delete_pending_idx" ON "FileCopy" ("deleteRequestedAt")
  WHERE "state" = 'DELETE_PENDING';
-- Quota (P7) sums the user's live encrypted copies.
CREATE INDEX "FileCopy_user_live_kind_idx" ON "FileCopy" ("userId", "kind")
  WHERE "state" IN ('UPLOADING', 'AVAILABLE');
