-- Folders (tree, at most 5 levels) and name rules shared by folders and documents.
-- Names are compared without case and without the position of the Vietnamese tone mark ("Hóa" = "hoá" = "HÓA").
CREATE FUNCTION docflow_name_key(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT normalize(regexp_replace(translate(lower(normalize(btrim(value), NFD)), 'Đ', 'đ'),
    '([̣̀́̃̉])([a-zđ̛̂̆]+)', '\2\1', 'g'), NFC)
$$;

CREATE TABLE "Folder" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "parentId" UUID,
    "name" VARCHAR(100) NOT NULL,
    "nameKey" TEXT GENERATED ALWAYS AS (docflow_name_key("name")) STORED,
    "purpose" VARCHAR(500),
    "revision" BIGINT NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Folder_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Folder_name_check" CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 100 AND strpos("name", '/') = 0 AND strpos("name", chr(92)) = 0 AND "name" !~ '[[:cntrl:]]'),
    CONSTRAINT "Folder_purpose_check" CHECK ("purpose" IS NULL OR ("purpose" = btrim("purpose") AND char_length("purpose") BETWEEN 1 AND 500)),
    CONSTRAINT "Folder_not_own_parent_check" CHECK ("parentId" IS DISTINCT FROM "id"),
    CONSTRAINT "Folder_revision_check" CHECK ("revision" > 0)
);

CREATE UNIQUE INDEX "Folder_id_userId_key" ON "Folder"("id", "userId");
CREATE INDEX "Folder_userId_parentId_idx" ON "Folder"("userId", "parentId");
CREATE UNIQUE INDEX "Folder_sibling_name_key"
  ON "Folder"("userId", COALESCE("parentId", '00000000-0000-0000-0000-000000000000'::uuid), "nameKey");

ALTER TABLE "Folder" ADD CONSTRAINT "Folder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_parentId_userId_fkey" FOREIGN KEY ("parentId", "userId") REFERENCES "Folder"("id", "userId") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE FUNCTION docflow_folder_tree_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  above integer := 0;
  below integer := 0;
  looped boolean := false;
BEGIN
  IF NEW."parentId" IS NOT NULL THEN
    WITH RECURSIVE up AS (
      SELECT f."id", f."parentId", 1 AS depth FROM "Folder" f WHERE f."id" = NEW."parentId"
      UNION ALL
      SELECT p."id", p."parentId", up.depth + 1 FROM "Folder" p JOIN up ON p."id" = up."parentId" WHERE up.depth < 16
    )
    SELECT COALESCE(max(depth), 0), COALESCE(bool_or("id" = NEW."id"), false) INTO above, looped FROM up;
    IF looped THEN
      RAISE EXCEPTION 'Folder % cannot be moved into itself or one of its descendants', NEW."id" USING ERRCODE = '23514', CONSTRAINT = 'Folder_no_cycle';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    WITH RECURSIVE down AS (
      SELECT f."id", 1 AS depth FROM "Folder" f WHERE f."parentId" = NEW."id"
      UNION ALL
      SELECT c."id", down.depth + 1 FROM "Folder" c JOIN down ON c."parentId" = down."id" WHERE down.depth < 16
    )
    SELECT COALESCE(max(depth), 0) INTO below FROM down;
  END IF;
  IF above + 1 + below > 5 THEN
    RAISE EXCEPTION 'Folder tree would be % levels deep; the limit is 5', above + 1 + below USING ERRCODE = '23514', CONSTRAINT = 'Folder_max_depth';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "Folder_tree_check"
  BEFORE INSERT OR UPDATE OF "parentId" ON "Folder"
  FOR EACH ROW EXECUTE FUNCTION docflow_folder_tree_check();

-- Documents: one folder at most (NULL = "Chưa phân loại"), and no two live documents with the same name in one folder.
ALTER TABLE "Document"
  ADD COLUMN "folderId" UUID,
  ADD COLUMN "titleKey" TEXT GENERATED ALWAYS AS (docflow_name_key("title")) STORED;

ALTER TABLE "Document" ADD CONSTRAINT "Document_folderId_userId_fkey" FOREIGN KEY ("folderId", "userId") REFERENCES "Folder"("id", "userId") ON DELETE NO ACTION ON UPDATE CASCADE;
CREATE INDEX "Document_userId_folderId_idx" ON "Document"("userId", "folderId");

DO $$
DECLARE
  round integer := 0;
  changed integer;
BEGIN
  LOOP
    UPDATE "Document" d
    SET "title" = left(d."title", 255 - char_length(s.suffix)) || s.suffix
    FROM (
      SELECT "id", ' (' || row_number() OVER (PARTITION BY "userId", "titleKey" ORDER BY "createdAt", "id") || ')' AS suffix,
             row_number() OVER (PARTITION BY "userId", "titleKey" ORDER BY "createdAt", "id") AS position
      FROM "Document" WHERE "deletedAt" IS NULL
    ) s
    WHERE s."id" = d."id" AND s.position > 1;
    GET DIAGNOSTICS changed = ROW_COUNT;
    round := round + 1;
    EXIT WHEN changed = 0 OR round >= 20;
  END LOOP;
END $$;

CREATE UNIQUE INDEX "Document_folder_title_key"
  ON "Document"("userId", COALESCE("folderId", '00000000-0000-0000-0000-000000000000'::uuid), "titleKey")
  WHERE "deletedAt" IS NULL;
