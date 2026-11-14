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
  assert.equal(dirs.length, 12);
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

test('migrations create the 20 CP1 tables including email challenges and folders', async () => {
  const { count } = await one(`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public'`);
  assert.equal(count, 21);
});

test('accounts default to level 3 (ENCRYPTED_COPY)', async () => {
  const row = await one(`INSERT INTO "User" ("email","passwordHash") VALUES ('default@example.com','x') RETURNING "privacyLevel"`);
  assert.equal(row.privacyLevel, 'ENCRYPTED_COPY');
});

test('privacy enum is ordered so LEAST() gives the effective level', async () => {
  const row = await one(`SELECT LEAST('ENCRYPTED_COPY'::"PrivacyLevel", 'STRUCTURED_ONLY', 'TEXT_AND_EMBEDDINGS') AS level`);
  assert.equal(row.level, 'STRUCTURED_ONLY');
});

// Auth data must be valid even when written outside the HTTP API.
test('auth rejects unnormalized email and a nonpositive user revision', async () => {
  for (const email of ['A@example.com', ' a@example.com', 'a@example.com ', 'invalid']) {
    await rejects(`INSERT INTO "User" ("email","passwordHash") VALUES ($1,'x')`, [email], 'User_email_normalized_check');
  }
  const a = await seedUser('a');
  await rejects(`UPDATE "User" SET "revision" = 0 WHERE "id" = $1`, [a.user], 'User_revision_check');
});

test('session refresh hashes must be lowercase SHA-256 hex', async () => {
  const a = await seedUser('a');
  for (const hash of ['raw-refresh-token', 'A'.repeat(64), 'g'.repeat(64)]) {
    await rejects(`UPDATE "Session" SET "refreshTokenHash" = $2 WHERE "id" = $1`, [a.session, hash], 'Session_refreshTokenHash_hex_check');
  }
});

test('session expiry must be after its creation', async () => {
  const a = await seedUser('a');
  await rejects(`UPDATE "Session" SET "expiresAt" = "createdAt" WHERE "id" = $1`, [a.session], 'Session_expiry_check');
});

test('email challenges enforce bounded attempts, normalized email and keyed hash format', async () => {
  const challenge = await id(`INSERT INTO "EmailChallenge" ("email","purpose","codeHash","passwordHash","expiresAt","resendAvailableAt")
    VALUES ('verify@example.com','REGISTER',$1,'argon-hash',now()+interval '10 minutes',now()+interval '60 seconds')`, [hex('a')]);
  await rejects(`UPDATE "EmailChallenge" SET "attempts" = 6 WHERE "id" = $1`, [challenge], 'EmailChallenge_attempts_check');
  await rejects(`UPDATE "EmailChallenge" SET "attempts" = -1 WHERE "id" = $1`, [challenge], 'EmailChallenge_attempts_check');
  await rejects(`UPDATE "EmailChallenge" SET "codeHash" = '123456' WHERE "id" = $1`, [challenge], 'EmailChallenge_hash_check');
  await rejects(`UPDATE "EmailChallenge" SET "email" = 'Verify@Example.com' WHERE "id" = $1`, [challenge], 'EmailChallenge_email_check');
  await db.query(`UPDATE "EmailChallenge" SET "attempts" = 5 WHERE "id" = $1`, [challenge]);
});

test('challenge purpose and lifetime stay consistent, and consumed registration data can be scrubbed', async () => {
  const challenge = await id(`INSERT INTO "EmailChallenge" ("email","purpose","codeHash","passwordHash","expiresAt","resendAvailableAt")
    VALUES ('verify@example.com','REGISTER',$1,'argon-hash',now()+interval '10 minutes',now()+interval '60 seconds')`, [hex('b')]);
  await rejects(`UPDATE "EmailChallenge" SET "passwordHash" = NULL WHERE "id" = $1`, [challenge], 'EmailChallenge_purpose_check');
  await rejects(`UPDATE "EmailChallenge" SET "purpose" = 'RESET_PASSWORD' WHERE "id" = $1`, [challenge], 'EmailChallenge_purpose_check');
  await rejects(`UPDATE "EmailChallenge" SET "expiresAt" = "createdAt" WHERE "id" = $1`, [challenge], 'EmailChallenge_times_check');
  await db.query(`UPDATE "EmailChallenge" SET "consumedAt" = now(), "passwordHash" = NULL WHERE "id" = $1`, [challenge]);
});

test('password reset challenges cannot reference missing users and are removed with their account', async () => {
  const a = await seedUser('a');
  const insert = `INSERT INTO "EmailChallenge" ("email","purpose","userId","codeHash","expiresAt","resendAvailableAt")
    VALUES ('a@example.com','RESET_PASSWORD',$1,$2,now()+interval '10 minutes',now()+interval '60 seconds')`;
  await rejects(insert, ['00000000-0000-0000-0000-000000000001', hex('c')], 'EmailChallenge_userId_fkey');
  const challenge = await id(insert, [a.user, hex('c')]);
  await db.query(`DELETE FROM "User" WHERE "id" = $1`, [a.user]);
  assert.equal((await one(`SELECT count(*)::int AS n FROM "EmailChallenge" WHERE "id" = $1`, [challenge])).n, 0);
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

const versionSql = `INSERT INTO "DocumentVersion" ("userId","documentId","number","sha256","byteSize","mimeType","originalFilename","source") VALUES ($1,$2,$3,$4,$5,'application/pdf',$6,'WEB_UPLOAD')`;
const copySql = `INSERT INTO "FileCopy" ("userId","documentId","versionId","kind","state","storageKey","contentType","byteSize","sha256","encryptionKeyRef","expiresAt","deleteRequestedAt","deletedAt")
                 VALUES ($1,$2,$3,$4,$5,$6,'application/octet-stream',$7,$8,$9,$10,$11,$12)`;

test('documents need a title; versions need a safe file name and a hex SHA-256', async () => {
  const a = await seedUser('a');
  await rejects(`INSERT INTO "Document" ("userId","title","source") VALUES ($1,'  ','WEB_UPLOAD')`, [a.user], 'Document_title_check');
  for (const [name, sha, size, constraint] of [
    ['../evil.pdf', hex('b'), 1, 'DocumentVersion_filename_check'],
    ['dir\\evil.pdf', hex('b'), 1, 'DocumentVersion_filename_check'],
    ['trailing.', hex('b'), 1, 'DocumentVersion_filename_check'],
    ['ok.pdf', 'A'.repeat(64), 1, 'DocumentVersion_sha256_check'],
    ['ok.pdf', hex('b'), -1, 'DocumentVersion_byteSize_check'],
  ]) await rejects(versionSql, [a.user, a.doc, 9, sha, size, name], constraint);
  await rejects(versionSql, [a.user, a.doc, 0, hex('b'), 1, 'ok.pdf'], 'DocumentVersion_number_check');
  await db.query(versionSql, [a.user, a.doc, 9, hex('b'), 1, 'Hợp đồng thuê nhà (bản ký).pdf']);
});

test('a document version is an immutable snapshot', async () => {
  const a = await seedUser('a');
  for (const change of [`"sha256" = '${hex('f')}'`, `"byteSize" = 1`, `"number" = 7`]) {
    await rejects(`UPDATE "DocumentVersion" SET ${change} WHERE "id" = $1`, [a.version], /immutable/);
  }
  await db.query(`UPDATE "DocumentVersion" SET "parseState" = 'PROCESSING' WHERE "id" = $1`, [a.version]);
  await rejects(`UPDATE "DocumentVersion" SET "parseState" = 'UNSUPPORTED' WHERE "id" = $1`, [a.version], 'DocumentVersion_parse_error_check');
});

test('file copies: relative keys only, encrypted copies carry a wrapped key and never expire', async () => {
  const a = await seedUser('a');
  const base = (overrides) => {
    const row = { kind: 'ENCRYPTED_COPY', state: 'UPLOADING', key: 'encrypted/a/1', size: 10, sha: null, ref: 'v1.k.x', expires: null, req: null, del: null, ...overrides };
    return [a.user, a.doc, a.version, row.kind, row.state, row.key, row.size, row.sha, row.ref, row.expires, row.req, row.del];
  };
  for (const key of ['/abs/path', 's3://bucket/x', 'https://x/y', 'a/../b', 'a//b', 'C:/x']) {
    await rejects(copySql, base({ key }), 'FileCopy_storageKey_check');
  }
  await rejects(copySql, base({ ref: null }), 'FileCopy_encryption_check');
  await rejects(copySql, base({ expires: new Date() }), 'FileCopy_retention_check');
  await rejects(copySql, base({ state: 'AVAILABLE' }), 'FileCopy_content_check');
  await rejects(copySql, base({ state: 'DELETED', req: new Date() }), 'FileCopy_deletion_check');
  await rejects(copySql, base({ state: 'DELETE_PENDING' }), 'FileCopy_deletion_check');
  await db.query(copySql, base({ state: 'AVAILABLE', sha: hex('c') }));
  await db.query(copySql, base({ kind: 'WEB_SOURCE', key: 'web-source/a/1', ref: null, expires: new Date() }));
});

test('only one live copy per version and kind; deleted copies keep their history', async () => {
  const a = await seedUser('a');
  const row = (key, state, extra = []) => [a.user, a.doc, a.version, 'ENCRYPTED_COPY', state, key, 10, hex('c'), 'v1.k.x', null, ...extra];
  await db.query(copySql, row('encrypted/a/1', 'AVAILABLE', [null, null]));
  await rejects(copySql, row('encrypted/a/2', 'UPLOADING', [null, null]), 'FileCopy_one_live_per_version_kind_key');
  await db.query(`UPDATE "FileCopy" SET "state" = 'DELETED', "deleteRequestedAt" = now(), "deletedAt" = now() WHERE "storageKey" = 'encrypted/a/1'`);
  await db.query(copySql, row('encrypted/a/2', 'UPLOADING', [null, null]));
});

test('jobs: running needs a lease, terminal states need finishedAt, attempts stay within bounds', async () => {
  const a = await seedUser('a');
  const job = (key, columns, values) => db.query(`INSERT INTO "AIJob" ("userId","kind","idempotencyKey"${columns}) VALUES ($1,'PURGE',$2${values})`, [a.user, key]);
  await rejects(`INSERT INTO "AIJob" ("userId","kind","versionId","idempotencyKey") VALUES ($1,'PARSE',$2,'v-only')`, [a.user, a.version], 'AIJob_target_check');
  await rejects(`INSERT INTO "AIJob" ("userId","kind","status","idempotencyKey") VALUES ($1,'PURGE','RUNNING','r')`, [a.user], 'AIJob_lease_check');
  await rejects(`INSERT INTO "AIJob" ("userId","kind","status","idempotencyKey") VALUES ($1,'PURGE','SUCCEEDED','s')`, [a.user], 'AIJob_finished_check');
  await rejects(`INSERT INTO "AIJob" ("userId","kind","finishedAt","idempotencyKey") VALUES ($1,'PURGE',now(),'f')`, [a.user], 'AIJob_finished_check');
  await rejects(`INSERT INTO "AIJob" ("userId","kind","attempts","maxAttempts","idempotencyKey") VALUES ($1,'PURGE',6,5,'n')`, [a.user], 'AIJob_attempts_check');
  await rejects(`INSERT INTO "AIJob" ("userId","kind","payload","idempotencyKey") VALUES ($1,'PURGE','[]','p')`, [a.user], 'AIJob_payload_check');
  await job('ok-running', ',"status","leaseOwner","leaseUntil","attempts"', `,'RUNNING','w1',now() + interval '1 minute',1`);
  await job('ok-done', ',"status","finishedAt"', `,'CANCELLED',now()`);
});

test('at most one waiting purge per user; finished purges do not block a new one', async () => {
  const a = await seedUser('a');
  await db.query(`INSERT INTO "AIJob" ("userId","kind","idempotencyKey") VALUES ($1,'PURGE','p1')`, [a.user]);
  await rejects(`INSERT INTO "AIJob" ("userId","kind","idempotencyKey") VALUES ($1,'PURGE','p2')`, [a.user], 'AIJob_one_waiting_purge_per_user_key');
  await db.query(`UPDATE "AIJob" SET "status" = 'SUCCEEDED', "finishedAt" = now() WHERE "idempotencyKey" = 'p1'`);
  await db.query(`INSERT INTO "AIJob" ("userId","kind","idempotencyKey") VALUES ($1,'PURGE','p2')`, [a.user]);
});

test('parsed text: chunks are non-empty ranges with consistent pages; a parsed version records its parser and size', async () => {
  const a = await seedUser('a');
  const chunk = (ordinal, content, start, end, pageFrom = null, pageTo = null) => db.query(
    `INSERT INTO "DocumentChunk" ("userId","documentId","versionId","ordinal","content","charStart","charEnd","pageFrom","pageTo","chunkerVersion")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'c1')`, [a.user, a.doc, a.version, ordinal, content, start, end, pageFrom, pageTo]);
  await chunk(1, 'Tiền cọc', 30, 38, 1, 2);
  for (const [values, constraint] of [
    [[2, 'x', 5, 5], 'DocumentChunk_range_check'],
    [[2, '', 5, 9], 'DocumentChunk_range_check'],
    [[2, 'quá dài', 0, 3], 'DocumentChunk_range_check'],
    [[2, 'x', -1, 0], 'DocumentChunk_range_check'],
    [[2, 'x', 0, 1, 2, null], 'DocumentChunk_pages_check'],
    [[2, 'x', 0, 1, 3, 2], 'DocumentChunk_pages_check'],
    [[2, 'x', 0, 1, 0, 1], 'DocumentChunk_pages_check'],
  ]) {
    const [ordinal, content, start, end, pageFrom = null, pageTo = null] = values;
    await rejects(`INSERT INTO "DocumentChunk" ("userId","documentId","versionId","ordinal","content","charStart","charEnd","pageFrom","pageTo","chunkerVersion")
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'c1')`, [a.user, a.doc, a.version, ordinal, content, start, end, pageFrom, pageTo], constraint);
  }
  await rejects(`UPDATE "DocumentVersion" SET "parseState" = 'SUCCEEDED' WHERE "id" = $1`, [a.version], 'DocumentVersion_parse_result_check');
  await rejects(`UPDATE "DocumentVersion" SET "parseState" = 'SUCCEEDED', "parserVersion" = 'p1', "charCount" = 10, "parseErrorCode" = 'X' WHERE "id" = $1`,
    [a.version], 'DocumentVersion_parse_result_check');
  await db.query(`UPDATE "DocumentVersion" SET "parseState" = 'SUCCEEDED', "parserVersion" = 'p1', "charCount" = 10, "pageCount" = 2 WHERE "id" = $1`, [a.version]);
  await db.query(`UPDATE "DocumentVersion" SET "parseState" = 'UNSUPPORTED', "parseErrorCode" = 'NO_TEXT_LAYER', "charCount" = NULL WHERE "id" = $1`, [a.version]);
});

test('a document in the trash can be restored but takes no new text or stored copies; a purged one is gone for good', async () => {
  const a = await seedUser('a');
  const live = [a.user, a.doc, a.version, 'ENCRYPTED_COPY', 'AVAILABLE', 'encrypted/a/live', 10, hex('c'), 'v1.k.x', null, null, null];
  await db.query(copySql, live);
  await db.query(`UPDATE "Document" SET "deletedAt" = now() WHERE "id" = $1`, [a.doc]);
  await rejects(`INSERT INTO "DocumentChunk" ("userId","documentId","versionId","ordinal","content","charStart","charEnd","chunkerVersion")
                 VALUES ($1,$2,$3,9,'sống lại?',0,9,'c1')`, [a.user, a.doc, a.version], /text cannot be stored/);
  await rejects(copySql, [a.user, a.doc, a.version, 'WEB_SOURCE', 'UPLOADING', 'web-source/a/new', 10, null, null, new Date(), null, null], /live stored copy/);
  await db.query(`UPDATE "Document" SET "deletedAt" = NULL WHERE "id" = $1`, [a.doc]);
  await rejects(`UPDATE "Document" SET "purgedAt" = now() WHERE "id" = $1`, [a.doc], 'Document_purged_is_deleted_check');
  await db.query(`UPDATE "Document" SET "deletedAt" = now(), "purgedAt" = now() WHERE "id" = $1`, [a.doc]);
  await rejects(`UPDATE "Document" SET "deletedAt" = NULL, "purgedAt" = NULL WHERE "id" = $1`, [a.doc], /permanently deleted/);
  await rejects(`UPDATE "Document" SET "purgedAt" = NULL WHERE "id" = $1`, [a.doc], /permanently deleted/);
  await db.query(`UPDATE "FileCopy" SET "state" = 'DELETE_PENDING', "deleteRequestedAt" = now() WHERE "storageKey" = 'encrypted/a/live'`);
  await rejects(`UPDATE "FileCopy" SET "state" = 'AVAILABLE', "deleteRequestedAt" = NULL WHERE "storageKey" = 'encrypted/a/live'`, [], /live stored copy/);
  await db.query(`UPDATE "Document" SET "title" = 'Đã xóa' WHERE "id" = $1`, [a.doc]);
});

const folder = (user, name, parent = null) => id(`INSERT INTO "Folder" ("userId","name","parentId") VALUES ($1,$2,$3)`, [user, name, parent]);

test('names are compared without case or the position of the Vietnamese tone mark', async () => {
  const key = async (value) => (await one('SELECT docflow_name_key($1) AS key', [value])).key;
  for (const [left, right] of [['Hóa đơn', 'hoá đơn'], ['HÓA ĐƠN', 'hoá đơn'], ['Thuý Kiều', 'THÚY KIỀU'], ['quỵ', 'qụy'], ['  Hợp đồng  ', 'hợp đồng'], ['Hóa đơn', 'Ho\u0301a đơn']]) {
    assert.equal(await key(left), await key(right), `${left} = ${right}`);
  }
  for (const [left, right] of [['Hóa', 'Hòa'], ['Hoa', 'Hóa'], ['Hợp đồng', 'Hợp đồng (2)'], ['Dao', 'Đao'], ['Mua', 'Mưa'], ['hóa đơn', 'hóađơn']]) {
    assert.notEqual(await key(left), await key(right), `${left} ≠ ${right}`);
  }
});

test('folders: sibling names are unique per user; names, purposes and ownership are checked', async () => {
  const a = await seedUser('a');
  const b = await seedUser('b');
  const home = await folder(a.user, 'Nhà Cầu Giấy');
  await rejects(`INSERT INTO "Folder" ("userId","name") VALUES ($1,'NHÀ CẦU GIẤY')`, [a.user], 'Folder_sibling_name_key');
  const bills = await folder(a.user, 'Hóa đơn', home);
  await rejects(`INSERT INTO "Folder" ("userId","name","parentId") VALUES ($1,'hoá đơn',$2)`, [a.user, home], 'Folder_sibling_name_key');
  await folder(a.user, 'Hóa đơn');
  await folder(b.user, 'Nhà Cầu Giấy');
  await rejects(`UPDATE "Folder" SET "name" = 'nhà cầu giấy', "parentId" = NULL WHERE "id" = $1`, [bills], 'Folder_sibling_name_key');
  for (const name of ['', '  ', ' Lề trái', 'a/b', 'a\\b', 'tab\there', 'x'.repeat(101)]) {
    await rejects(`INSERT INTO "Folder" ("userId","name") VALUES ($1,$2)`, [a.user, name], /Folder_name_check|value too long/);
  }
  await rejects(`INSERT INTO "Folder" ("userId","name","purpose") VALUES ($1,'Mục đích rỗng','  ')`, [a.user], 'Folder_purpose_check');
  await db.query(`UPDATE "Folder" SET "purpose" = 'Giấy tờ căn nhà ở Cầu Giấy' WHERE "id" = $1`, [home]);
  await rejects(`INSERT INTO "Folder" ("userId","name","parentId") VALUES ($1,'Của người khác',$2)`, [b.user, home], 'Folder_parentId_userId_fkey');
  await rejects(`UPDATE "Document" SET "folderId" = $1 WHERE "id" = $2`, [home, b.doc], 'Document_folderId_userId_fkey');
  await db.query(`UPDATE "Document" SET "folderId" = $1 WHERE "id" = $2`, [bills, a.doc]);
  await rejects(`DELETE FROM "Folder" WHERE "id" = $1`, [bills], 'Document_folderId_userId_fkey');
  await rejects(`DELETE FROM "Folder" WHERE "id" = $1`, [home], 'Folder_parentId_userId_fkey');
  await db.query(`DELETE FROM "User" WHERE "id" = $1`, [a.user]);
  assert.equal((await one(`SELECT count(*)::int AS count FROM "Folder" WHERE "userId" = $1`, [a.user])).count, 0);
});

test('folders: the tree is at most 5 levels deep and never loops, also when a subtree moves', async () => {
  const a = await seedUser('a');
  const chain = [];
  for (let level = 1; level <= 5; level++) chain.push(await folder(a.user, `Cấp ${level}`, chain.at(-1) ?? null));
  await rejects(`INSERT INTO "Folder" ("userId","name","parentId") VALUES ($1,'Cấp 6',$2)`, [a.user, chain[4]], 'Folder_max_depth');
  await rejects(`UPDATE "Folder" SET "parentId" = "id" WHERE "id" = $1`, [chain[0]], /Folder_not_own_parent_check|Folder_no_cycle/);
  await rejects(`UPDATE "Folder" SET "parentId" = $1 WHERE "id" = $2`, [chain[3], chain[0]], 'Folder_no_cycle');
  const other = await folder(a.user, 'Khác');
  const inner = await folder(a.user, 'Trong', other);
  await rejects(`UPDATE "Folder" SET "parentId" = $1 WHERE "id" = $2`, [chain[3], other], 'Folder_max_depth');
  await rejects(`UPDATE "Folder" SET "parentId" = $1 WHERE "id" = $2`, [inner, chain[1]], 'Folder_max_depth');
  await db.query(`UPDATE "Folder" SET "parentId" = $1 WHERE "id" = $2`, [chain[2], other]);
  await db.query(`UPDATE "Folder" SET "parentId" = NULL WHERE "id" = $1`, [chain[4]]);
  await db.query(`UPDATE "Folder" SET "name" = 'Đổi tên không kiểm tra lại cây' WHERE "id" = $1`, [inner]);
});

test('documents: live titles are unique inside a folder, not across folders, users or deleted documents', async () => {
  const a = await seedUser('a');
  const b = await seedUser('b');
  const insert = `INSERT INTO "Document" ("userId","title","source","folderId") VALUES ($1,$2,'WEB_UPLOAD',$3)`;
  await rejects(insert, [a.user, 'HỢP ĐỒNG THUÊ', null], 'Document_folder_title_key');
  const box = await folder(a.user, 'Hợp đồng');
  const moved = await id(insert, [a.user, 'hợp đồng thuê', box]);
  await rejects(insert, [a.user, 'Hợp đồng thuê', box], 'Document_folder_title_key');
  await rejects(`UPDATE "Document" SET "folderId" = NULL WHERE "id" = $1`, [moved], 'Document_folder_title_key');
  await db.query(`UPDATE "Document" SET "deletedAt" = now() WHERE "id" = $1`, [a.doc]);
  await db.query(`UPDATE "Document" SET "folderId" = NULL WHERE "id" = $1`, [moved]);
  await db.query(insert, [a.user, 'Hợp đồng thuê (2)', null]);
  assert.equal((await one(`SELECT "title" FROM "Document" WHERE "id" = $1`, [b.doc])).title, 'Hợp đồng thuê');
});

test('trash: nothing live sits inside a deleted folder, deleted names are free, and a purged folder is final', async () => {
  const a = await seedUser('a');
  const home = await folder(a.user, 'Nhà');
  const bills = await folder(a.user, 'Hóa đơn', home);
  await db.query(`UPDATE "Document" SET "folderId" = $1 WHERE "id" = $2`, [bills, a.doc]);
  await db.query(`UPDATE "Document" SET "deletedAt" = now() WHERE "id" = $1`, [a.doc]);
  await db.query(`UPDATE "Folder" SET "deletedAt" = now() WHERE "id" IN ($1,$2)`, [home, bills]);
  await rejects(`UPDATE "Document" SET "deletedAt" = NULL WHERE "id" = $1`, [a.doc], 'Document_live_folder');
  await rejects(`INSERT INTO "Document" ("userId","title","source","folderId") VALUES ($1,'Mới','WEB_UPLOAD',$2)`, [a.user, bills], 'Document_live_folder');
  await rejects(`UPDATE "Folder" SET "deletedAt" = NULL WHERE "id" = $1`, [bills], 'Folder_live_parent');
  await rejects(`INSERT INTO "Folder" ("userId","name","parentId") VALUES ($1,'Con',$2)`, [a.user, home], 'Folder_live_parent');
  const twin = await folder(a.user, 'nhà');
  await rejects(`UPDATE "Folder" SET "deletedAt" = NULL WHERE "id" = $1`, [home], 'Folder_sibling_name_key');
  await db.query(`UPDATE "Folder" SET "deletedAt" = NULL, "name" = 'Nhà (2)' WHERE "id" = $1`, [home]);
  await db.query(`UPDATE "Folder" SET "deletedAt" = NULL WHERE "id" = $1`, [bills]);
  await db.query(`UPDATE "Document" SET "deletedAt" = NULL WHERE "id" = $1`, [a.doc]);
  await rejects(`UPDATE "Folder" SET "purgedAt" = now() WHERE "id" = $1`, [twin], 'Folder_purged_is_deleted_check');
  await db.query(`UPDATE "Folder" SET "deletedAt" = now(), "purgedAt" = now() WHERE "id" = $1`, [twin]);
  await rejects(`UPDATE "Folder" SET "deletedAt" = NULL, "purgedAt" = NULL WHERE "id" = $1`, [twin], /permanently deleted/);
});

test('trash batches: a document or folder only points at a trash item while it is in the trash, and loses the link when the item goes', async () => {
  const a = await seedUser('a');
  const box = await folder(a.user, 'Hộp');
  const item = await id(`INSERT INTO "TrashItem" ("userId","kind","folderId","name","expiresAt") VALUES ($1,'FOLDER',$2,'Hộp', now() + interval '30 days')`, [a.user, box]);
  await rejects(`UPDATE "Document" SET "trashedById" = $1 WHERE "id" = $2`, [item, a.doc], 'Document_trashed_by_check');
  await rejects(`UPDATE "Folder" SET "trashedById" = $1 WHERE "id" = $2`, [item, box], 'Folder_trashed_by_check');
  await rejects(`UPDATE "Document" SET "deletedAt" = now(), "trashedById" = gen_random_uuid() WHERE "id" = $1`, [a.doc], 'Document_trashedById_fkey');
  await db.query(`UPDATE "Folder" SET "deletedAt" = now(), "trashedById" = $1 WHERE "id" = $2`, [item, box]);
  await db.query(`UPDATE "Document" SET "deletedAt" = now(), "trashedById" = $1 WHERE "id" = $2`, [item, a.doc]);
  await rejects(`UPDATE "Document" SET "purgedAt" = now() WHERE "id" = $1`, [a.doc], 'Document_trashed_by_check');
  await db.query(`DELETE FROM "TrashItem" WHERE "id" = $1`, [item]);
  assert.equal((await one(`SELECT "trashedById" FROM "Document" WHERE "id" = $1`, [a.doc])).trashedById, null);
  assert.equal((await one(`SELECT "trashedById" FROM "Folder" WHERE "id" = $1`, [box])).trashedById, null);
});

test('trash items: one per target, the right target for each kind, a real expiry, and they go with their target', async () => {
  const a = await seedUser('a');
  const b = await seedUser('b');
  const box = await folder(a.user, 'Hộp');
  const insert = `INSERT INTO "TrashItem" ("userId","kind","documentId","folderId","name","expiresAt") VALUES ($1,$2,$3,$4,'x', now() + interval '30 days')`;
  await rejects(insert, [b.user, 'DOCUMENT', a.doc, null], 'TrashItem_documentId_userId_fkey');
  await rejects(insert, [b.user, 'FOLDER', null, box], 'TrashItem_folderId_userId_fkey');
  await db.query(insert, [a.user, 'DOCUMENT', a.doc, null]);
  await db.query(insert, [a.user, 'ORIGINAL', a.doc, null]);
  await db.query(insert, [a.user, 'FOLDER', null, box]);
  await rejects(insert, [a.user, 'DOCUMENT', a.doc, null], 'TrashItem_document_kind_key');
  await rejects(insert, [a.user, 'FOLDER', null, box], 'TrashItem_folder_key');
  for (const [kind, documentId, folderId] of [['FOLDER', a.doc, null], ['DOCUMENT', null, box], ['ORIGINAL', a.doc, box], ['DOCUMENT', null, null]]) {
    await rejects(insert, [a.user, kind, documentId, folderId], 'TrashItem_target_check');
  }
  await rejects(`INSERT INTO "TrashItem" ("userId","kind","documentId","name","expiresAt") VALUES ($1,'DOCUMENT',$2,'x', now() - interval '1 day')`, [b.user, b.doc], 'TrashItem_expiry_check');
  await rejects(`INSERT INTO "TrashItem" ("userId","kind","documentId","name","expiresAt","documentCount") VALUES ($1,'DOCUMENT',$2,'x', now() + interval '1 day', -1)`, [b.user, b.doc], 'TrashItem_counts_check');
  await db.query(`DELETE FROM "Folder" WHERE "id" = $1`, [box]);
  assert.equal((await one(`SELECT count(*)::int AS count FROM "TrashItem" WHERE "userId" = $1`, [a.user])).count, 2);
  await db.query(`DELETE FROM "User" WHERE "id" = $1`, [a.user]);
  assert.equal((await one(`SELECT count(*)::int AS count FROM "TrashItem"`)).count, 0);
});
