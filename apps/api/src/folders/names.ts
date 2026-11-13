import { Prisma } from '@prisma/client';

export const MAX_FOLDER_NAME = 100;
export const MAX_FOLDER_PURPOSE = 500;
export const MAX_FOLDER_DEPTH = 5;
export const MAX_TITLE = 255;
const FORBIDDEN = /[\\/\u0000-\u001f\u007f-\u009f]/;
const ROOT = '00000000-0000-0000-0000-000000000000';

export interface FreeName { name: string; renamed: boolean }

export function cleanFolderName(value: string): string | null {
  const name = value.normalize('NFC').trim();
  if (!name || name.length > MAX_FOLDER_NAME || FORBIDDEN.test(name)) return null;
  return name;
}

export function cleanPurpose(value: string | null | undefined): string | null {
  const purpose = (value ?? '').normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '').trim();
  return purpose || null;
}

export async function freeFolderName(
  db: Prisma.TransactionClient, userId: string, parentId: string | null, wanted: string, exceptId: string | null = null,
): Promise<FreeName> {
  const rows = await db.$queryRaw<{ name: string }[]>`
    SELECT c.name FROM (
      SELECT n, CASE WHEN n = 1 THEN ${wanted}::text
        ELSE left(${wanted}::text, ${MAX_FOLDER_NAME}::int - char_length(' (' || n || ')')) || ' (' || n || ')' END AS name
      FROM generate_series(1, 1000) AS n) c
    WHERE NOT EXISTS (
      SELECT 1 FROM "Folder" f
      WHERE f."userId" = ${userId}::uuid AND f."deletedAt" IS NULL
        AND COALESCE(f."parentId", ${ROOT}::uuid) = COALESCE(${parentId}::uuid, ${ROOT}::uuid)
        AND f."nameKey" = docflow_name_key(c.name) AND f."id" IS DISTINCT FROM ${exceptId}::uuid)
    ORDER BY c.n LIMIT 1`;
  if (!rows[0]) throw new Error('NO_FREE_NAME');
  return { name: rows[0].name, renamed: rows[0].name !== wanted };
}

export async function freeDocumentTitle(
  db: Prisma.TransactionClient, userId: string, folderId: string | null, wanted: string, exceptId: string | null = null,
): Promise<FreeName> {
  const rows = await db.$queryRaw<{ name: string }[]>`
    SELECT c.name FROM (
      SELECT n, CASE WHEN n = 1 THEN ${wanted}::text
        ELSE left(${wanted}::text, ${MAX_TITLE}::int - char_length(' (' || n || ')')) || ' (' || n || ')' END AS name
      FROM generate_series(1, 1000) AS n) c
    WHERE NOT EXISTS (
      SELECT 1 FROM "Document" d
      WHERE d."userId" = ${userId}::uuid AND d."deletedAt" IS NULL
        AND COALESCE(d."folderId", ${ROOT}::uuid) = COALESCE(${folderId}::uuid, ${ROOT}::uuid)
        AND d."titleKey" = docflow_name_key(c.name) AND d."id" IS DISTINCT FROM ${exceptId}::uuid)
    ORDER BY c.n LIMIT 1`;
  if (!rows[0]) throw new Error('NO_FREE_NAME');
  return { name: rows[0].name, renamed: rows[0].name !== wanted };
}
