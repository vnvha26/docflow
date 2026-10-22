-- CreateEnum
CREATE TYPE "PrivacyLevel" AS ENUM ('STRUCTURED_ONLY', 'TEXT_AND_EMBEDDINGS', 'ENCRYPTED_COPY');

-- CreateEnum
CREATE TYPE "NotificationDetail" AS ENUM ('MINIMAL', 'DETAILED');

-- CreateEnum
CREATE TYPE "DocumentSource" AS ENUM ('WEB_UPLOAD');

-- CreateEnum
CREATE TYPE "ParseState" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "FileCopyKind" AS ENUM ('WEB_SOURCE', 'ENCRYPTED_COPY');

-- CreateEnum
CREATE TYPE "FileCopyState" AS ENUM ('UPLOADING', 'AVAILABLE', 'DELETE_PENDING', 'DELETED');

-- CreateEnum
CREATE TYPE "ExtractionStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ObligationStatus" AS ENUM ('ACTIVE', 'NEEDS_REVIEW', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ActionKind" AS ENUM ('PAYMENT', 'RENEWAL', 'CANCELLATION', 'EXPIRY', 'WARRANTY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ActionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('UPCOMING', 'DONE', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "IntegrationKind" AS ENUM ('TELEGRAM', 'EMAIL');

-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('PENDING', 'SENT', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "JobKind" AS ENUM ('PARSE', 'CLASSIFY', 'EXTRACT', 'SUMMARIZE', 'EMBED', 'PURGE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD', 'CANCELLED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "notificationDetail" "NotificationDetail" NOT NULL DEFAULT 'MINIMAL',
ADD COLUMN     "privacyLevel" "PrivacyLevel" NOT NULL DEFAULT 'TEXT_AND_EMBEDDINGS';

-- CreateTable
CREATE TABLE "DocumentType" (
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "pathTemplate" VARCHAR(255) NOT NULL,
    "fieldSchema" JSONB NOT NULL,
    "obligationRules" JSONB NOT NULL DEFAULT '[]',
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentType_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "source" "DocumentSource" NOT NULL,
    "typeCode" VARCHAR(64),
    "privacyLevel" "PrivacyLevel",
    "deletedAt" TIMESTAMPTZ(3),
    "revision" BIGINT NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentVersion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "byteSize" BIGINT NOT NULL,
    "mimeType" VARCHAR(127) NOT NULL,
    "originalFilename" VARCHAR(255) NOT NULL,
    "source" "DocumentSource" NOT NULL,
    "parseState" "ParseState" NOT NULL DEFAULT 'PENDING',
    "parseErrorCode" VARCHAR(64),
    "parserVersion" VARCHAR(32),
    "pageCount" INTEGER,
    "charCount" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileCopy" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "kind" "FileCopyKind" NOT NULL,
    "state" "FileCopyState" NOT NULL DEFAULT 'UPLOADING',
    "storageKey" VARCHAR(512) NOT NULL,
    "contentType" VARCHAR(127) NOT NULL,
    "byteSize" BIGINT,
    "sha256" CHAR(64),
    "encryptionKeyRef" VARCHAR(256),
    "expiresAt" TIMESTAMPTZ(3),
    "deleteRequestedAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),
    "revision" BIGINT NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileCopy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentChunk" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "charStart" INTEGER NOT NULL,
    "charEnd" INTEGER NOT NULL,
    "pageFrom" INTEGER,
    "pageTo" INTEGER,
    "tokenCount" INTEGER,
    "chunkerVersion" VARCHAR(32) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractedMetadata" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "status" "ExtractionStatus" NOT NULL DEFAULT 'PENDING',
    "typeCode" VARCHAR(64),
    "confidence" DECIMAL(4,3),
    "fields" JSONB NOT NULL DEFAULT '{}',
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "summary" TEXT,
    "confirmedFields" JSONB,
    "modelId" VARCHAR(128) NOT NULL,
    "promptVersion" VARCHAR(32) NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "confirmedAt" TIMESTAMPTZ(3),
    "revision" BIGINT NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtractedMetadata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Collection" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "nameKey" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "revision" BIGINT NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Collection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentCollection" (
    "documentId" UUID NOT NULL,
    "collectionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentCollection_pkey" PRIMARY KEY ("documentId","collectionId")
);

-- CreateTable
CREATE TABLE "Obligation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "metadataId" UUID NOT NULL,
    "sourceKey" VARCHAR(128) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "counterparty" VARCHAR(200),
    "status" "ObligationStatus" NOT NULL DEFAULT 'ACTIVE',
    "startDate" DATE,
    "endDate" DATE,
    "noticePeriodDays" INTEGER,
    "revision" BIGINT NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Obligation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Action" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "obligationId" UUID NOT NULL,
    "kind" "ActionKind" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "amount" DECIMAL(19,4),
    "currency" CHAR(3),
    "recurrence" VARCHAR(255),
    "anchorDate" DATE,
    "anchorTime" TIME(0),
    "untilDate" DATE,
    "timezone" VARCHAR(64) NOT NULL,
    "leadMinutes" INTEGER[] DEFAULT ARRAY[10080, 4320, 0]::INTEGER[],
    "materializedUntil" DATE,
    "status" "ActionStatus" NOT NULL DEFAULT 'ACTIVE',
    "revision" BIGINT NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Action_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "actionId" UUID NOT NULL,
    "occurrenceKey" VARCHAR(64) NOT NULL,
    "dueDate" DATE,
    "dueAt" TIMESTAMPTZ(3),
    "status" "EventStatus" NOT NULL DEFAULT 'UPCOMING',
    "completedAt" TIMESTAMPTZ(3),
    "revision" BIGINT NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "kind" "IntegrationKind" NOT NULL,
    "target" VARCHAR(320),
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMPTZ(3),
    "verificationCodeHash" CHAR(64),
    "verificationExpiresAt" TIMESTAMPTZ(3),
    "revision" BIGINT NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reminder" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "leadMinutes" INTEGER NOT NULL,
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL,
    "snoozedUntil" TIMESTAMPTZ(3),
    "status" "ReminderStatus" NOT NULL DEFAULT 'PENDING',
    "deliveryGeneration" INTEGER NOT NULL DEFAULT 1,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" VARCHAR(64),
    "leaseUntil" TIMESTAMPTZ(3),
    "sentAt" TIMESTAMPTZ(3),
    "revision" BIGINT NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "reminderId" UUID NOT NULL,
    "deliveryGeneration" INTEGER NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "providerMessageId" VARCHAR(128),
    "lastErrorCode" VARCHAR(64),
    "lastAttemptAt" TIMESTAMPTZ(3),
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIJob" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "kind" "JobKind" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "documentId" UUID,
    "versionId" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "priority" SMALLINT NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" VARCHAR(64),
    "leaseUntil" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "lastErrorCode" VARCHAR(64),
    "lastErrorMessage" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" BIGSERIAL NOT NULL,
    "userId" UUID,
    "aggregateType" VARCHAR(64) NOT NULL,
    "aggregateId" UUID NOT NULL,
    "eventType" VARCHAR(100) NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(3),
    "lastErrorCode" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Document_userId_createdAt_idx" ON "Document"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Document_userId_typeCode_idx" ON "Document"("userId", "typeCode");

-- CreateIndex
CREATE UNIQUE INDEX "Document_id_userId_key" ON "Document"("id", "userId");

-- CreateIndex
CREATE INDEX "DocumentVersion_userId_sha256_idx" ON "DocumentVersion"("userId", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentVersion_documentId_number_key" ON "DocumentVersion"("documentId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentVersion_id_documentId_key" ON "DocumentVersion"("id", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "FileCopy_storageKey_key" ON "FileCopy"("storageKey");

-- CreateIndex
CREATE INDEX "FileCopy_userId_idx" ON "FileCopy"("userId");

-- CreateIndex
CREATE INDEX "FileCopy_documentId_idx" ON "FileCopy"("documentId");

-- CreateIndex
CREATE INDEX "FileCopy_versionId_idx" ON "FileCopy"("versionId");

-- CreateIndex
CREATE INDEX "DocumentChunk_documentId_idx" ON "DocumentChunk"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentChunk_versionId_ordinal_key" ON "DocumentChunk"("versionId", "ordinal");

-- CreateIndex
CREATE INDEX "ExtractedMetadata_documentId_idx" ON "ExtractedMetadata"("documentId");

-- CreateIndex
CREATE INDEX "ExtractedMetadata_versionId_idx" ON "ExtractedMetadata"("versionId");

-- CreateIndex
CREATE INDEX "ExtractedMetadata_userId_status_idx" ON "ExtractedMetadata"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ExtractedMetadata_id_documentId_key" ON "ExtractedMetadata"("id", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "Collection_id_userId_key" ON "Collection"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Collection_userId_nameKey_key" ON "Collection"("userId", "nameKey");

-- CreateIndex
CREATE INDEX "DocumentCollection_collectionId_idx" ON "DocumentCollection"("collectionId");

-- CreateIndex
CREATE INDEX "Obligation_userId_status_idx" ON "Obligation"("userId", "status");

-- CreateIndex
CREATE INDEX "Obligation_versionId_idx" ON "Obligation"("versionId");

-- CreateIndex
CREATE INDEX "Obligation_metadataId_idx" ON "Obligation"("metadataId");

-- CreateIndex
CREATE UNIQUE INDEX "Obligation_id_userId_key" ON "Obligation"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Obligation_documentId_sourceKey_key" ON "Obligation"("documentId", "sourceKey");

-- CreateIndex
CREATE INDEX "Action_obligationId_idx" ON "Action"("obligationId");

-- CreateIndex
CREATE INDEX "Action_userId_status_idx" ON "Action"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Action_id_userId_key" ON "Action"("id", "userId");

-- CreateIndex
CREATE INDEX "Event_userId_dueDate_idx" ON "Event"("userId", "dueDate");

-- CreateIndex
CREATE INDEX "Event_userId_dueAt_idx" ON "Event"("userId", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "Event_id_userId_key" ON "Event"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Event_actionId_occurrenceKey_key" ON "Event"("actionId", "occurrenceKey");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_id_userId_key" ON "Integration"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_userId_kind_key" ON "Integration"("userId", "kind");

-- CreateIndex
CREATE INDEX "Reminder_integrationId_idx" ON "Reminder"("integrationId");

-- CreateIndex
CREATE UNIQUE INDEX "Reminder_id_userId_key" ON "Reminder"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Reminder_eventId_integrationId_leadMinutes_key" ON "Reminder"("eventId", "integrationId", "leadMinutes");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_idempotencyKey_key" ON "Notification"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Notification_reminderId_deliveryGeneration_key" ON "Notification"("reminderId", "deliveryGeneration");

-- CreateIndex
CREATE UNIQUE INDEX "AIJob_idempotencyKey_key" ON "AIJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AIJob_userId_status_idx" ON "AIJob"("userId", "status");

-- CreateIndex
CREATE INDEX "AIJob_documentId_idx" ON "AIJob"("documentId");

-- CreateIndex
CREATE INDEX "AIJob_versionId_idx" ON "AIJob"("versionId");

-- CreateIndex
CREATE INDEX "OutboxEvent_aggregateType_aggregateId_idx" ON "OutboxEvent"("aggregateType", "aggregateId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_typeCode_fkey" FOREIGN KEY ("typeCode") REFERENCES "DocumentType"("code") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_documentId_userId_fkey" FOREIGN KEY ("documentId", "userId") REFERENCES "Document"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileCopy" ADD CONSTRAINT "FileCopy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileCopy" ADD CONSTRAINT "FileCopy_documentId_userId_fkey" FOREIGN KEY ("documentId", "userId") REFERENCES "Document"("id", "userId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileCopy" ADD CONSTRAINT "FileCopy_versionId_documentId_fkey" FOREIGN KEY ("versionId", "documentId") REFERENCES "DocumentVersion"("id", "documentId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentChunk" ADD CONSTRAINT "DocumentChunk_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentChunk" ADD CONSTRAINT "DocumentChunk_documentId_userId_fkey" FOREIGN KEY ("documentId", "userId") REFERENCES "Document"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentChunk" ADD CONSTRAINT "DocumentChunk_versionId_documentId_fkey" FOREIGN KEY ("versionId", "documentId") REFERENCES "DocumentVersion"("id", "documentId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedMetadata" ADD CONSTRAINT "ExtractedMetadata_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedMetadata" ADD CONSTRAINT "ExtractedMetadata_documentId_userId_fkey" FOREIGN KEY ("documentId", "userId") REFERENCES "Document"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedMetadata" ADD CONSTRAINT "ExtractedMetadata_versionId_documentId_fkey" FOREIGN KEY ("versionId", "documentId") REFERENCES "DocumentVersion"("id", "documentId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedMetadata" ADD CONSTRAINT "ExtractedMetadata_typeCode_fkey" FOREIGN KEY ("typeCode") REFERENCES "DocumentType"("code") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentCollection" ADD CONSTRAINT "DocumentCollection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentCollection" ADD CONSTRAINT "DocumentCollection_documentId_userId_fkey" FOREIGN KEY ("documentId", "userId") REFERENCES "Document"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentCollection" ADD CONSTRAINT "DocumentCollection_collectionId_userId_fkey" FOREIGN KEY ("collectionId", "userId") REFERENCES "Collection"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Obligation" ADD CONSTRAINT "Obligation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Obligation" ADD CONSTRAINT "Obligation_documentId_userId_fkey" FOREIGN KEY ("documentId", "userId") REFERENCES "Document"("id", "userId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Obligation" ADD CONSTRAINT "Obligation_versionId_documentId_fkey" FOREIGN KEY ("versionId", "documentId") REFERENCES "DocumentVersion"("id", "documentId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Obligation" ADD CONSTRAINT "Obligation_metadataId_documentId_fkey" FOREIGN KEY ("metadataId", "documentId") REFERENCES "ExtractedMetadata"("id", "documentId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Action" ADD CONSTRAINT "Action_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Action" ADD CONSTRAINT "Action_obligationId_userId_fkey" FOREIGN KEY ("obligationId", "userId") REFERENCES "Obligation"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_actionId_userId_fkey" FOREIGN KEY ("actionId", "userId") REFERENCES "Action"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_eventId_userId_fkey" FOREIGN KEY ("eventId", "userId") REFERENCES "Event"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_integrationId_userId_fkey" FOREIGN KEY ("integrationId", "userId") REFERENCES "Integration"("id", "userId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_reminderId_userId_fkey" FOREIGN KEY ("reminderId", "userId") REFERENCES "Reminder"("id", "userId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIJob" ADD CONSTRAINT "AIJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIJob" ADD CONSTRAINT "AIJob_documentId_userId_fkey" FOREIGN KEY ("documentId", "userId") REFERENCES "Document"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIJob" ADD CONSTRAINT "AIJob_versionId_documentId_fkey" FOREIGN KEY ("versionId", "documentId") REFERENCES "DocumentVersion"("id", "documentId") ON DELETE CASCADE ON UPDATE CASCADE;

