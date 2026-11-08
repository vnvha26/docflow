-- B5 soft delete: a deleted document stays deleted and never receives new text or live stored copies.
CREATE FUNCTION docflow_document_delete_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."deletedAt" IS NOT NULL AND NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt" THEN
    RAISE EXCEPTION 'Document % is deleted and cannot be restored', OLD."id" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "Document_delete_is_final"
  BEFORE UPDATE OF "deletedAt" ON "Document"
  FOR EACH ROW EXECUTE FUNCTION docflow_document_delete_is_final();

CREATE FUNCTION docflow_chunk_needs_live_document() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Document" WHERE "id" = NEW."documentId" AND "deletedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'Document % is deleted; its text cannot be stored', NEW."documentId" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "DocumentChunk_live_document"
  BEFORE INSERT OR UPDATE OF "documentId" ON "DocumentChunk"
  FOR EACH ROW EXECUTE FUNCTION docflow_chunk_needs_live_document();

CREATE FUNCTION docflow_copy_needs_live_document() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."state" IN ('UPLOADING', 'AVAILABLE')
     AND EXISTS (SELECT 1 FROM "Document" WHERE "id" = NEW."documentId" AND "deletedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'Document % is deleted; it cannot hold a live stored copy', NEW."documentId" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "FileCopy_live_document"
  BEFORE INSERT OR UPDATE OF "state", "documentId" ON "FileCopy"
  FOR EACH ROW EXECUTE FUNCTION docflow_copy_needs_live_document();
