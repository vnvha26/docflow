// Schema tests for the cloud database. Runs every Prisma migration, in order, on an in-process
// PostgreSQL 17 (PGlite) and checks keys, foreign keys, unique constraints and delete semantics.
// Hand-written invariants (CHECK, partial index, trigger) are added per module, each with a violating case.
// Run: npm.cmd run db:test
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = new URL('../apps/api/prisma/migrations/', import.meta.url);
const hex = (c) => c.repeat(64);

/** @type {PGlite} */
let db;

before(async () => {
  db = new PGlite();
  const dirs = (await readdir(MIGRATIONS, { withFileTypes: true }))
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.equal(dirs.length, 2);
  for (const dir of dirs) await db.exec(await readFile(new URL(`${dir}/migration.sql`, MIGRATIONS), 'utf8'));
  await db.exec(`INSERT INTO "DocumentType" ("code","name","pathTemplate","fieldSchema")
                 VALUES ('RENTAL_CONTRACT','Hợp đồng thuê nhà','Hợp đồng/Thuê nhà/{year}','{"type":"object"}')`);
});
after(async () => db?.close());

// Every test runs in a transaction that is rolled back, so tests are independent.
beforeEach(async () => db.exec('BEGIN'));
afterEach(async () => db.exec('ROLLBACK'));

const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const id = async (sql, params = []) => (await one(`${sql} RETURNING "id"`, params)).id;

/** Expects the statement to fail; `match` is the violated constraint name or a message regex. */
async function rejects(sql, params, match) {
  await db.exec('SAVEPOINT expect_error');
  try {
    await db.query(sql, params);
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT expect_error');
    const text = `${error.constraint ?? ''} ${error.message}`;
    if (typeof match === 'string') assert.ok(text.includes(match), `expected "${match}", got: ${text}`);
    else assert.match(text, match);
    return;
  }
  await db.exec('ROLLBACK TO SAVEPOINT expect_error');
  assert.fail(`statement should have been rejected (${match}): ${sql}`);
}

/** Builds one user's full graph: document -> version -> confirmed metadata -> obligation -> action -> event -> reminder -> notification, plus a collection and a job. */
async function seedUser(tag) {
  const u = {};
  u.user = await id(`INSERT INTO "User" ("email","passwordHash") VALUES ($1,'x')`, [`${tag}@example.com`]);
  u.session = await id(`INSERT INTO "Session" ("userId","refreshTokenHash","expiresAt") VALUES ($1,$2, now() + interval '30 days')`, [u.user, hex(tag === 'a' ? '1' : '2')]);
  u.doc = await id(`INSERT INTO "Document" ("userId","title","source","typeCode") VALUES ($1,'Hợp đồng thuê','WEB_UPLOAD','RENTAL_CONTRACT')`, [u.user]);
  u.version = await id(`INSERT INTO "DocumentVersion" ("userId","documentId","number","sha256","byteSize","mimeType","originalFilename","source")
                        VALUES ($1,$2,1,$3,1024,'application/pdf','hop-dong.pdf','WEB_UPLOAD')`, [u.user, u.doc, hex('a')]);
  u.chunk = await id(`INSERT INTO "DocumentChunk" ("userId","documentId","versionId","ordinal","content","charStart","charEnd","chunkerVersion")
                      VALUES ($1,$2,$3,0,'Tiền thuê 8.000.000 VNĐ',0,23,'v1')`, [u.user, u.doc, u.version]);
  u.meta = await id(`INSERT INTO "ExtractedMetadata" ("userId","documentId","versionId","status","typeCode","confidence","fields","confirmedFields","modelId","promptVersion","schemaVersion","confirmedAt")
                     VALUES ($1,$2,$3,'CONFIRMED','RENTAL_CONTRACT',0.92,'{"rent":"8000000"}','{"rent":"8000000"}','qwen3:4b','p1',1,now())`, [u.user, u.doc, u.version]);
  u.obligation = await id(`INSERT INTO "Obligation" ("userId","documentId","versionId","metadataId","sourceKey","title")
                           VALUES ($1,$2,$3,$4,'rent.monthly_payment','Tiền thuê nhà')`, [u.user, u.doc, u.version, u.meta]);
  u.action = await id(`INSERT INTO "Action" ("userId","obligationId","kind","title","amount","currency","recurrence","anchorDate","timezone")
                       VALUES ($1,$2,'PAYMENT','Trả tiền thuê',8000000,'VND','FREQ=MONTHLY;BYMONTHDAY=5','2026-11-05','Asia/Ho_Chi_Minh')`, [u.user, u.obligation]);
  u.event = await id(`INSERT INTO "Event" ("userId","actionId","occurrenceKey","dueDate") VALUES ($1,$2,'2026-11-05','2026-11-05')`, [u.user, u.action]);
  u.integration = await id(`INSERT INTO "Integration" ("userId","kind","target","enabled","verifiedAt") VALUES ($1,'TELEGRAM','123456789',true,now())`, [u.user]);
  u.reminder = await id(`INSERT INTO "Reminder" ("userId","eventId","integrationId","leadMinutes","scheduledAt") VALUES ($1,$2,$3,10080,'2026-10-29T02:00:00Z')`, [u.user, u.event, u.integration]);
  u.notification = await id(`INSERT INTO "Notification" ("userId","reminderId","deliveryGeneration","idempotencyKey") VALUES ($1,$2,1,$3)`, [u.user, u.reminder, `${tag}:reminder:1`]);
  u.collection = await id(`INSERT INTO "Collection" ("userId","name","nameKey") VALUES ($1,'Căn nhà số 12','căn nhà số 12')`, [u.user]);
  await db.query(`INSERT INTO "DocumentCollection" ("documentId","collectionId","userId") VALUES ($1,$2,$3)`, [u.doc, u.collection, u.user]);
  u.job = await id(`INSERT INTO "AIJob" ("userId","kind","documentId","versionId","idempotencyKey") VALUES ($1,'EXTRACT',$2,$3,$4)`, [u.user, u.doc, u.version, `extract:${tag}`]);
  return u;
}

// ───────────────────────────── Structure ─────────────────────────────

test('migrations create the 18 CP1 tables', async () => {
  const { count } = await one(`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public'`);
  assert.equal(count, 18);
});

test('privacy enum is ordered so LEAST() gives the effective level', async () => {
  const row = await one(`SELECT LEAST('ENCRYPTED_COPY'::"PrivacyLevel", 'STRUCTURED_ONLY', 'TEXT_AND_EMBEDDINGS') AS level`);
  assert.equal(row.level, 'STRUCTURED_ONLY');
});

// ───────────────────────────── Delete semantics ─────────────────────────────

test('deleting a user removes the whole graph (NoAction FKs are checked at end of statement)', async () => {
  const a = await seedUser('a');
  const b = await seedUser('b');
  await db.query(`DELETE FROM "User" WHERE "id" = $1`, [a.user]);
  for (const table of ['Session', 'Document', 'Obligation', 'Event', 'Reminder', 'Notification', 'AIJob', 'Collection']) {
    const { n } = await one(`SELECT count(*)::int AS n FROM "${table}" WHERE "userId" = $1`, [a.user]);
    assert.equal(n, 0, table);
  }
  const { n } = await one(`SELECT count(*)::int AS n FROM "Obligation" WHERE "userId" = $1`, [b.user]);
  assert.equal(n, 1, 'other tenant untouched');
});

test('a user with FileCopy rows cannot be deleted until blobs are purged', async () => {
  const a = await seedUser('a');
  await db.query(`INSERT INTO "FileCopy" ("userId","documentId","versionId","kind","storageKey","contentType") VALUES ($1,$2,$3,'WEB_SOURCE','u/a/blob1','application/pdf')`, [a.user, a.doc, a.version]);
  await rejects(`DELETE FROM "User" WHERE "id" = $1`, [a.user], 'FileCopy_userId_fkey');
});

test('a document with obligations cannot be hard-deleted; without them it can', async () => {
  const a = await seedUser('a');
  await rejects(`DELETE FROM "Document" WHERE "id" = $1`, [a.doc], 'Obligation_documentId_userId_fkey');
  const doc = await id(`INSERT INTO "Document" ("userId","title","source") VALUES ($1,'Ghi chú','WEB_UPLOAD')`, [a.user]);
  await db.query(`INSERT INTO "DocumentVersion" ("userId","documentId","number","sha256","byteSize","mimeType","originalFilename","source") VALUES ($1,$2,1,$3,1,'text/plain','a.txt','WEB_UPLOAD')`, [a.user, doc, hex('c')]);
  await db.query(`DELETE FROM "Document" WHERE "id" = $1`, [doc]);
});

test('a reminder with delivery history cannot be deleted (cancel it instead)', async () => {
  const a = await seedUser('a');
  await rejects(`DELETE FROM "Reminder" WHERE "id" = $1`, [a.reminder], 'Notification_reminderId_userId_fkey');
});

// ───────────────────────────── Tenant isolation ─────────────────────────────

test('composite FKs reject links across users', async () => {
  const a = await seedUser('a');
  const b = await seedUser('b');
  await rejects(`INSERT INTO "Obligation" ("userId","documentId","versionId","metadataId","sourceKey","title") VALUES ($1,$2,$3,$4,'x','x')`,
    [a.user, b.doc, b.version, b.meta], 'Obligation_documentId_userId_fkey');
  await rejects(`INSERT INTO "DocumentCollection" ("documentId","collectionId","userId") VALUES ($1,$2,$3)`,
    [a.doc, b.collection, a.user], 'DocumentCollection_collectionId_userId_fkey');
  await rejects(`INSERT INTO "Reminder" ("userId","eventId","integrationId","leadMinutes","scheduledAt") VALUES ($1,$2,$3,0,now())`,
    [a.user, a.event, b.integration], 'Reminder_integrationId_userId_fkey');
});

test('version references must belong to the same document', async () => {
  const a = await seedUser('a');
  const other = await id(`INSERT INTO "Document" ("userId","title","source") VALUES ($1,'Khác','WEB_UPLOAD')`, [a.user]);
  await rejects(`INSERT INTO "Obligation" ("userId","documentId","versionId","metadataId","sourceKey","title") VALUES ($1,$2,$3,$4,'x','x')`,
    [a.user, other, a.version, a.meta], 'Obligation_versionId_documentId_fkey');
});

// ───────────────────────────── Documents & files ─────────────────────────────

test('the same content may appear in several versions (A -> B -> A)', async () => {
  const a = await seedUser('a');
  await db.query(`INSERT INTO "DocumentVersion" ("userId","documentId","number","sha256","byteSize","mimeType","originalFilename","source") VALUES ($1,$2,2,$3,1,'application/pdf','b.pdf','WEB_UPLOAD')`, [a.user, a.doc, hex('d')]);
  await db.query(`INSERT INTO "DocumentVersion" ("userId","documentId","number","sha256","byteSize","mimeType","originalFilename","source") VALUES ($1,$2,3,$3,1024,'application/pdf','a.pdf','WEB_UPLOAD')`, [a.user, a.doc, hex('a')]);
  await rejects(`INSERT INTO "DocumentVersion" ("userId","documentId","number","sha256","byteSize","mimeType","originalFilename","source") VALUES ($1,$2,3,$3,1,'application/pdf','c.pdf','WEB_UPLOAD')`, [a.user, a.doc, hex('e')], 'DocumentVersion_documentId_number_key');
});

test('file copies: storage key is unique; a blob row blocks dropping its document', async () => {
  const a = await seedUser('a');
  const insert = `INSERT INTO "FileCopy" ("userId","documentId","versionId","kind","storageKey","contentType","encryptionKeyRef") VALUES ($1,$2,$3,$4,$5,'application/pdf',$6)`;
  await db.query(insert, [a.user, a.doc, a.version, 'ENCRYPTED_COPY', 'u/a/c1', 'kms:key/1']);
  await rejects(insert, [a.user, a.doc, a.version, 'ENCRYPTED_COPY', 'u/a/c1', 'kms:key/1'], 'FileCopy_storageKey_key');
  // A version whose only dependant is a blob row cannot be dropped by cascade (blob would leak).
  const doc = await id(`INSERT INTO "Document" ("userId","title","source") VALUES ($1,'Upload','WEB_UPLOAD')`, [a.user]);
  const version = await id(`INSERT INTO "DocumentVersion" ("userId","documentId","number","sha256","byteSize","mimeType","originalFilename","source") VALUES ($1,$2,1,$3,1,'application/pdf','u.pdf','WEB_UPLOAD')`, [a.user, doc, hex('7')]);
  await db.query(insert, [a.user, doc, version, 'WEB_SOURCE', 'u/a/web1', null]);
  await rejects(`DELETE FROM "Document" WHERE "id" = $1`, [doc], /FileCopy_(documentId_userId|versionId_documentId)_fkey/);
});

// ───────────────────── Obligation → Action → Event → Reminder → Notification ─────────────────────

test('re-confirming cannot duplicate an obligation (stable sourceKey)', async () => {
  const a = await seedUser('a');
  await rejects(`INSERT INTO "Obligation" ("userId","documentId","versionId","metadataId","sourceKey","title") VALUES ($1,$2,$3,$4,'rent.monthly_payment','Dup')`,
    [a.user, a.doc, a.version, a.meta], 'Obligation_documentId_sourceKey_key');
});

test('money is stored as an exact decimal', async () => {
  const a = await seedUser('a');
  const { amount } = await one(`UPDATE "Action" SET "amount" = 1234567.8912 WHERE "id" = $1 RETURNING "amount"::text`, [a.action]);
  assert.equal(amount, '1234567.8912', 'decimal is exact');
});

test('an occurrence key is unique per action', async () => {
  const a = await seedUser('a');
  await rejects(`INSERT INTO "Event" ("userId","actionId","occurrenceKey","dueDate") VALUES ($1,$2,'2026-11-05','2026-11-05')`, [a.user, a.action], 'Event_actionId_occurrenceKey_key');
});

test('reminders: one per (event, channel, lead)', async () => {
  const a = await seedUser('a');
  await rejects(`INSERT INTO "Reminder" ("userId","eventId","integrationId","leadMinutes","scheduledAt") VALUES ($1,$2,$3,10080,now())`,
    [a.user, a.event, a.integration], 'Reminder_eventId_integrationId_leadMinutes_key');
});

test('notifications: one per (reminder, generation); idempotency key is global', async () => {
  const a = await seedUser('a');
  await rejects(`INSERT INTO "Notification" ("userId","reminderId","deliveryGeneration","idempotencyKey") VALUES ($1,$2,1,'other')`,
    [a.user, a.reminder], 'Notification_reminderId_deliveryGeneration_key');
  await rejects(`INSERT INTO "Notification" ("userId","reminderId","deliveryGeneration","idempotencyKey") VALUES ($1,$2,2,'a:reminder:1')`,
    [a.user, a.reminder], 'Notification_idempotencyKey_key');
  await db.query(`INSERT INTO "Notification" ("userId","reminderId","deliveryGeneration","idempotencyKey") VALUES ($1,$2,2,'a:reminder:2')`, [a.user, a.reminder]);
});

test('one channel of each kind per user', async () => {
  const a = await seedUser('a');
  await rejects(`INSERT INTO "Integration" ("userId","kind","target") VALUES ($1,'TELEGRAM','42')`, [a.user], 'Integration_userId_kind_key');
});

// ───────────────────────────── Jobs ─────────────────────────────

test('job idempotency key is unique', async () => {
  const a = await seedUser('a');
  await rejects(`INSERT INTO "AIJob" ("userId","kind","idempotencyKey") VALUES ($1,'EMBED','extract:a')`, [a.user], 'AIJob_idempotencyKey_key');
});
