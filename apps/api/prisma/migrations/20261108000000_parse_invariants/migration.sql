ALTER TABLE "DocumentChunk"
  ADD CONSTRAINT "DocumentChunk_range_check"
    CHECK ("ordinal" >= 0 AND "charStart" >= 0 AND "charEnd" > "charStart"
      AND char_length("content") BETWEEN 1 AND "charEnd" - "charStart"),
  ADD CONSTRAINT "DocumentChunk_pages_check"
    CHECK (("pageFrom" IS NULL) = ("pageTo" IS NULL) AND ("pageFrom" IS NULL OR ("pageFrom" >= 1 AND "pageTo" >= "pageFrom"))),
  ADD CONSTRAINT "DocumentChunk_version_check" CHECK (length("chunkerVersion") > 0);

ALTER TABLE "DocumentVersion"
  ADD CONSTRAINT "DocumentVersion_parse_result_check"
    CHECK ("parseState" <> 'SUCCEEDED' OR ("parserVersion" IS NOT NULL AND "charCount" IS NOT NULL AND "parseErrorCode" IS NULL));

CREATE INDEX "DocumentVersion_parse_pending_idx" ON "DocumentVersion" ("createdAt")
  WHERE "parseState" IN ('PENDING', 'PROCESSING');
CREATE INDEX "AIJob_version_kind_idx" ON "AIJob" ("versionId", "kind") WHERE "versionId" IS NOT NULL;
