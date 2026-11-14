UPDATE "FileCopy" SET "state" = 'DELETE_PENDING', "deleteRequestedAt" = now(), "revision" = "revision" + 1
WHERE "kind" = 'WEB_SOURCE' AND "state" IN ('UPLOADING', 'AVAILABLE');

ALTER TABLE "Document" DROP COLUMN "privacyLevel";
ALTER TABLE "User" DROP COLUMN "privacyLevel";
DROP TYPE "PrivacyLevel";
