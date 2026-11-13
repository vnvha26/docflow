-- Trash: deleted documents, folders and originals stay restorable for 30 days, then are purged for good.
-- "deletedAt" now means "in the trash"; "purgedAt" means "permanently deleted, waiting for its stored files to go".
DROP TRIGGER "Document_delete_is_final" ON "Document";
DROP FUNCTION docflow_document_delete_is_final();

ALTER TABLE "Document"
  ADD COLUMN "originalTrashedAt" TIMESTAMPTZ(3),
  ADD COLUMN "purgedAt" TIMESTAMPTZ(3),
  ADD CONSTRAINT "Document_purged_is_deleted_check" CHECK ("purgedAt" IS NULL OR "deletedAt" IS NOT NULL);

ALTER TABLE "Folder"
  ADD COLUMN "deletedAt" TIMESTAMPTZ(3),
  ADD COLUMN "purgedAt" TIMESTAMPTZ(3),
  ADD CONSTRAINT "Folder_purged_is_deleted_check" CHECK ("purgedAt" IS NULL OR "deletedAt" IS NOT NULL);

DROP INDEX "Folder_sibling_name_key";
CREATE UNIQUE INDEX "Folder_sibling_name_key"
  ON "Folder"("userId", COALESCE("parentId", '00000000-0000-0000-0000-000000000000'::uuid), "nameKey")
  WHERE "deletedAt" IS NULL;

CREATE FUNCTION docflow_purge_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."purgedAt" IS NOT NULL AND (NEW."purgedAt" IS NULL OR NEW."deletedAt" IS NULL) THEN
    RAISE EXCEPTION '% % is permanently deleted and cannot be restored', TG_TABLE_NAME, OLD."id" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "Document_purge_is_final"
  BEFORE UPDATE OF "deletedAt", "purgedAt" ON "Document"
  FOR EACH ROW EXECUTE FUNCTION docflow_purge_is_final();

CREATE TRIGGER "Folder_purge_is_final"
  BEFORE UPDATE OF "deletedAt", "purgedAt" ON "Folder"
  FOR EACH ROW EXECUTE FUNCTION docflow_purge_is_final();

-- Nothing live sits inside something in the trash: a live document needs a live folder, a live folder a live parent.
CREATE FUNCTION docflow_document_needs_live_folder() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."deletedAt" IS NULL AND NEW."folderId" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "Folder" WHERE "id" = NEW."folderId" AND "deletedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'Document % cannot be live inside a deleted folder', NEW."id" USING ERRCODE = '23514', CONSTRAINT = 'Document_live_folder';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "Document_live_folder"
  BEFORE INSERT OR UPDATE OF "folderId", "deletedAt" ON "Document"
  FOR EACH ROW EXECUTE FUNCTION docflow_document_needs_live_folder();

CREATE FUNCTION docflow_folder_needs_live_parent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."deletedAt" IS NULL AND NEW."parentId" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "Folder" WHERE "id" = NEW."parentId" AND "deletedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'Folder % cannot be live inside a deleted folder', NEW."id" USING ERRCODE = '23514', CONSTRAINT = 'Folder_live_parent';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "Folder_live_parent"
  BEFORE INSERT OR UPDATE OF "parentId", "deletedAt" ON "Folder"
  FOR EACH ROW EXECUTE FUNCTION docflow_folder_needs_live_parent();

CREATE TYPE "TrashKind" AS ENUM ('DOCUMENT', 'FOLDER', 'ORIGINAL');

CREATE TABLE "TrashItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "kind" "TrashKind" NOT NULL,
    "documentId" UUID,
    "folderId" UUID,
    "name" VARCHAR(255) NOT NULL,
    "location" VARCHAR(600),
    "documentCount" INTEGER NOT NULL DEFAULT 0,
    "folderCount" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TrashItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TrashItem_target_check" CHECK (
      ("kind" = 'FOLDER' AND "folderId" IS NOT NULL AND "documentId" IS NULL)
      OR ("kind" IN ('DOCUMENT', 'ORIGINAL') AND "documentId" IS NOT NULL AND "folderId" IS NULL)),
    CONSTRAINT "TrashItem_expiry_check" CHECK ("expiresAt" > "deletedAt"),
    CONSTRAINT "TrashItem_counts_check" CHECK ("documentCount" >= 0 AND "folderCount" >= 0)
);

CREATE UNIQUE INDEX "TrashItem_document_kind_key" ON "TrashItem"("documentId", "kind") WHERE "documentId" IS NOT NULL;
CREATE UNIQUE INDEX "TrashItem_folder_key" ON "TrashItem"("folderId") WHERE "folderId" IS NOT NULL;
CREATE INDEX "TrashItem_userId_deletedAt_idx" ON "TrashItem"("userId", "deletedAt" DESC);
CREATE INDEX "TrashItem_expiresAt_idx" ON "TrashItem"("expiresAt");

ALTER TABLE "TrashItem" ADD CONSTRAINT "TrashItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrashItem" ADD CONSTRAINT "TrashItem_documentId_userId_fkey" FOREIGN KEY ("documentId", "userId") REFERENCES "Document"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrashItem" ADD CONSTRAINT "TrashItem_folderId_userId_fkey" FOREIGN KEY ("folderId", "userId") REFERENCES "Folder"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
