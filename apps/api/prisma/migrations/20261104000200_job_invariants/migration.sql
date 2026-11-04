-- Background jobs (I2 foundation, used first by P5/P6 purge). AIJob is the durable state of
-- every job; a message queue may later carry job ids only. Existing migrations stay immutable.
--
-- Status lifecycle: QUEUED -> RUNNING -> SUCCEEDED
--                                    \-> FAILED (retry at availableAt) -> RUNNING ...
--                                    \-> DEAD (attempts exhausted)
--                   any non-terminal -> CANCELLED (policy changed, e.g. privacy level lowered)

ALTER TABLE "AIJob"
  -- MATCH SIMPLE skips the (versionId, documentId) FK when documentId is NULL; forbid that shape.
  ADD CONSTRAINT "AIJob_target_check" CHECK ("versionId" IS NULL OR "documentId" IS NOT NULL),
  ADD CONSTRAINT "AIJob_attempts_check"
    CHECK ("maxAttempts" BETWEEN 1 AND 50 AND "attempts" BETWEEN 0 AND "maxAttempts"),
  ADD CONSTRAINT "AIJob_lease_check"
    CHECK (("leaseOwner" IS NULL) = ("leaseUntil" IS NULL) AND ("status" <> 'RUNNING' OR "leaseUntil" IS NOT NULL)),
  ADD CONSTRAINT "AIJob_finished_check"
    CHECK (("status" IN ('SUCCEEDED', 'DEAD', 'CANCELLED')) = ("finishedAt" IS NOT NULL)),
  ADD CONSTRAINT "AIJob_payload_check" CHECK (jsonb_typeof("payload") = 'object');

-- Claim order for workers; the reaper finds expired leases.
CREATE INDEX "AIJob_ready_idx" ON "AIJob" ("availableAt", "priority" DESC) WHERE "status" IN ('QUEUED', 'FAILED');
CREATE INDEX "AIJob_lease_idx" ON "AIJob" ("leaseUntil") WHERE "status" = 'RUNNING';

-- At most one waiting purge per user: policy changes coalesce into it.
CREATE UNIQUE INDEX "AIJob_one_waiting_purge_per_user_key" ON "AIJob" ("userId")
  WHERE "kind" = 'PURGE' AND "status" IN ('QUEUED', 'FAILED');

ALTER TABLE "OutboxEvent"
  ADD CONSTRAINT "OutboxEvent_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "OutboxEvent_payload_check" CHECK (jsonb_typeof("payload") = 'object');
CREATE INDEX "OutboxEvent_unpublished_idx" ON "OutboxEvent" ("availableAt", "id") WHERE "publishedAt" IS NULL;

-- Workers skip DELETE_PENDING copies quickly when purging one user.
CREATE INDEX "FileCopy_user_delete_pending_idx" ON "FileCopy" ("userId") WHERE "state" = 'DELETE_PENDING';
