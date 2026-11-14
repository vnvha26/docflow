ALTER TABLE "Document" ADD COLUMN "trashedById" UUID;
ALTER TABLE "Folder" ADD COLUMN "trashedById" UUID;

UPDATE "Document" d SET "trashedById" = t."id"
FROM "TrashItem" t
WHERE t."kind" = 'DOCUMENT' AND t."documentId" = d."id" AND d."deletedAt" IS NOT NULL AND d."purgedAt" IS NULL;

UPDATE "Folder" f SET "trashedById" = t."id"
FROM "TrashItem" t
WHERE t."kind" = 'FOLDER' AND t."folderId" = f."id" AND f."deletedAt" IS NOT NULL AND f."purgedAt" IS NULL;

DO $$
BEGIN
  FOR level IN 1..5 LOOP
    UPDATE "Folder" c SET "trashedById" = p."trashedById"
    FROM "Folder" p
    WHERE c."parentId" = p."id" AND c."trashedById" IS NULL AND c."deletedAt" IS NOT NULL AND c."purgedAt" IS NULL
      AND p."trashedById" IS NOT NULL;
  END LOOP;
END $$;

UPDATE "Document" d SET "trashedById" = f."trashedById"
FROM "Folder" f JOIN "TrashItem" t ON t."id" = f."trashedById"
WHERE d."folderId" = f."id" AND d."trashedById" IS NULL AND d."deletedAt" IS NOT NULL AND d."purgedAt" IS NULL
  AND d."deletedAt" >= t."deletedAt" - interval '5 minutes';

UPDATE "FileCopy" c SET "state" = 'DELETE_PENDING', "deleteRequestedAt" = now()
FROM "Document" d
WHERE c."documentId" = d."id" AND c."state" IN ('UPLOADING', 'AVAILABLE')
  AND d."deletedAt" IS NOT NULL AND d."purgedAt" IS NULL AND d."trashedById" IS NULL;

DELETE FROM "DocumentChunk" k USING "Document" d
WHERE k."documentId" = d."id" AND d."deletedAt" IS NOT NULL AND d."purgedAt" IS NULL AND d."trashedById" IS NULL;

DELETE FROM "TrashItem" t USING "Document" d
WHERE t."documentId" = d."id" AND d."deletedAt" IS NOT NULL AND d."purgedAt" IS NULL AND d."trashedById" IS NULL;

UPDATE "Document" SET "purgedAt" = now(), "originalTrashedAt" = NULL
WHERE "deletedAt" IS NOT NULL AND "purgedAt" IS NULL AND "trashedById" IS NULL;

UPDATE "Folder" SET "purgedAt" = now()
WHERE "deletedAt" IS NOT NULL AND "purgedAt" IS NULL AND "trashedById" IS NULL;

ALTER TABLE "Document"
  ADD CONSTRAINT "Document_trashedById_fkey" FOREIGN KEY ("trashedById") REFERENCES "TrashItem"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Document_trashed_by_check" CHECK ("trashedById" IS NULL OR ("deletedAt" IS NOT NULL AND "purgedAt" IS NULL));
ALTER TABLE "Folder"
  ADD CONSTRAINT "Folder_trashedById_fkey" FOREIGN KEY ("trashedById") REFERENCES "TrashItem"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Folder_trashed_by_check" CHECK ("trashedById" IS NULL OR ("deletedAt" IS NOT NULL AND "purgedAt" IS NULL));

CREATE INDEX "Document_trashedById_idx" ON "Document"("trashedById") WHERE "trashedById" IS NOT NULL;
CREATE INDEX "Folder_trashedById_idx" ON "Folder"("trashedById") WHERE "trashedById" IS NOT NULL;
