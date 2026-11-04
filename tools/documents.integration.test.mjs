import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

const databaseUrl = process.env.DOCS_TEST_DATABASE_URL;
const root = fileURLToPath(new URL('../', import.meta.url));
const origin = 'http://localhost:5173';
const s3 = {
  endpoint: process.env.DOCS_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
  accessKeyId: process.env.DOCS_TEST_S3_ACCESS_KEY ?? 'docflow',
  secretAccessKey: process.env.DOCS_TEST_S3_SECRET_KEY ?? 'docflow_local_only',
  bucket: process.env.DOCS_TEST_S3_BUCKET ?? 'docflow-it',
};
const prefix = `docs-it-${randomUUID()}-`;
const password = 'Documents integration password 2026!';
const kekId = 'it';
const MiB = 1024 * 1024;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
let db;
let storage;
let S3;
let server;
let baseUrl;
const users = {};

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const docx = () => zip([
  { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types/>') },
  { name: 'word/document.xml', data: Buffer.from(`<w:document>${randomUUID()}</w:document>`) },
]);
const pdf = (bytes = 2048) => Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(bytes), Buffer.from('\n%%EOF\n')]);
const text = (body = `Hợp đồng thuê nhà — tiền cọc 16.000.000 VNĐ. ${randomUUID()}\n`) => Buffer.from(body, 'utf8');

function assertPrivate(body) {
  if (body === null || typeof body !== 'object') return;
  for (const [key, value] of Object.entries(body)) {
    assert.doesNotMatch(key, /storageKey|encryptionKeyRef|sha256|passwordHash|dek/i, `field ${key} must not be returned`);
    assertPrivate(value);
  }
}

async function unusedPort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const keks = { [kekId]: Buffer.alloc(32, 5).toString('base64'), it2: Buffer.alloc(32, 6).toString('base64') };
let fileKeks = `${kekId}:${keks[kekId]}`;
let worker;

const childEnv = (port) => ({
  ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl, ...(port ? { PORT: String(port) } : {}), WEB_ORIGIN: origin,
  JWT_SECRET: 'docflow-documents-integration-secret-32-chars', FILE_KEKS: fileKeks,
  S3_ENDPOINT: s3.endpoint, S3_ACCESS_KEY: s3.accessKeyId, S3_SECRET_KEY: s3.secretAccessKey, S3_BUCKET: s3.bucket,
  ENCRYPTED_QUOTA_MB: '1', WEB_SOURCE_TTL_HOURS: '24', WORKER_POLL_MS: '100', WORKER_MAINTENANCE_MS: '400',
});

function startWorker() {
  worker = spawn(process.execPath, ['apps/api/dist/worker.js'], { cwd: root, env: childEnv(null), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  for (const stream of [worker.stdout, worker.stderr]) stream.on('data', (chunk) => { log = (log + chunk).slice(-4_000); });
  worker.once('exit', (code, signal) => {
    if (signal !== 'SIGTERM' && code !== 0) console.error(`Worker exited unexpectedly (${code ?? signal}).\n${log}`);
  });
}

async function stopWorker() {
  if (worker && worker.exitCode === null) {
    const stopped = once(worker, 'exit');
    worker.kill('SIGTERM');
    const timer = setTimeout(() => worker.kill('SIGKILL'), 3_000);
    await stopped.finally(() => clearTimeout(timer));
  }
}

async function eventually(check, message, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  assert.fail(message);
}

async function startApi() {
  const port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  let log = '';
  server = spawn(process.execPath, ['apps/api/dist/main.js'], {
    cwd: root,
    env: childEnv(port),
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => { log = (log + chunk).slice(-8_000); });
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) break;
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch {}
    await delay(100);
  }
  assert.fail(`API did not start. Build apps/api first.\n${log}`);
}

async function stopApi() {
  if (server && server.exitCode === null) {
    const stopped = once(server, 'exit');
    server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 3_000);
    await stopped.finally(() => clearTimeout(timer));
  }
}

async function request(path, { method = 'GET', token, body, form, requestOrigin = origin } = {}) {
  const headers = {};
  if (requestOrigin) headers.origin = requestOrigin;
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)), signal: AbortSignal.timeout(30_000),
  });
  const raw = Buffer.from(await response.arrayBuffer());
  let json = null;
  if (raw.length && (response.headers.get('content-type') ?? '').includes('json')) json = JSON.parse(raw.toString('utf8'));
  return { status: response.status, body: json, raw, headers: response.headers };
}

function upload(user, files, { title, requestOrigin } = {}) {
  const form = new FormData();
  for (const { name, data, type = 'application/octet-stream' } of [files].flat()) form.append('file', new Blob([data], { type }), name);
  if (title !== undefined) form.append('title', title);
  return request('/api/documents', { method: 'POST', token: user?.token, form, requestOrigin });
}

async function createUser(tag, privacyLevel = 'TEXT_AND_EMBEDDINGS') {
  const argon2 = await import('argon2');
  const email = `${prefix}${tag}@example.test`;
  const user = await db.user.create({
    data: { email, passwordHash: await argon2.hash(password, { type: argon2.argon2id }), emailVerifiedAt: new Date(), privacyLevel },
  });
  const login = await request('/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(login.status, 200);
  return { id: user.id, email, token: login.body.accessToken };
}

const copiesOf = (documentId) => db.fileCopy.findMany({ where: { documentId }, orderBy: { createdAt: 'asc' } });
const documentCount = (user) => db.document.count({ where: { userId: user.id } });

async function object(key) {
  const result = await storage.send(new S3.GetObjectCommand({ Bucket: s3.bucket, Key: key }));
  return Buffer.from(await result.Body.transformToByteArray());
}

async function objectExists(key) {
  try { await storage.send(new S3.HeadObjectCommand({ Bucket: s3.bucket, Key: key })); return true; }
  catch (error) { if (error.$metadata?.httpStatusCode === 404) return false; throw error; }
}

const copyDeleted = (id) => async () => (await db.fileCopy.findUniqueOrThrow({ where: { id } })).state === 'DELETED';
const compiled = (path) => import(new URL(`../apps/api/dist/${path}`, import.meta.url).href);

describe('documents over HTTP with PostgreSQL and S3 storage', {
  skip: databaseUrl ? false : 'Set DOCS_TEST_DATABASE_URL to a migrated disposable database, start MinIO (docker compose up -d minio) and build apps/api.',
  concurrency: false,
}, () => {
  before(async () => {
    const { PrismaClient } = await import('@prisma/client');
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await db.$connect();
    await db.fileCopy.count();
    S3 = await import('@aws-sdk/client-s3');
    storage = new S3.S3Client({
      region: 'us-east-1', endpoint: s3.endpoint, forcePathStyle: true,
      credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    });
    await startApi();
    startWorker();
    users.a = await createUser('a');
    users.b = await createUser('b');
    users.c = await createUser('c', 'ENCRYPTED_COPY');
    users.d = await createUser('d', 'ENCRYPTED_COPY');
    users.e = await createUser('e');
  });

  after(async () => {
    await stopWorker();
    await stopApi();
    if (!db) return;
    try {
      const ids = (await db.user.findMany({ where: { email: { startsWith: prefix } }, select: { id: true } })).map((user) => user.id);
      const copies = await db.fileCopy.findMany({ where: { userId: { in: ids } }, select: { storageKey: true } });
      for (const { storageKey } of copies) {
        await storage.send(new S3.DeleteObjectCommand({ Bucket: s3.bucket, Key: storageKey })).catch(() => undefined);
      }
      await db.fileCopy.deleteMany({ where: { userId: { in: ids } } });
      await db.user.deleteMany({ where: { id: { in: ids } } });
    } finally {
      await db.$disconnect();
      storage?.destroy();
    }
  });

  test('uploads require a session and the web origin', async () => {
    assert.equal((await upload(null, { name: 'a.txt', data: text() })).status, 401);
    assert.equal((await upload(users.a, { name: 'a.txt', data: text() }, { requestOrigin: 'https://evil.example' })).status, 403);
    assert.equal(await documentCount(users.a), 0);
  });

  test('level 2 keeps only an encrypted temporary copy, and the original cannot be downloaded', async () => {
    const content = text();
    const result = await upload(users.a, { name: 'Ghi chú thuê nhà.txt', data: content, type: 'text/plain' });
    assert.equal(result.status, 201);
    assertPrivate(result.body);
    const document = result.body.document;
    assert.equal(result.body.duplicate, false);
    assert.equal(document.title, 'Ghi chú thuê nhà');
    assert.deepEqual(document.file, { name: 'Ghi chú thuê nhà.txt', mimeType: 'text/plain', byteSize: content.length });
    assert.equal(document.privacyLevel, 'TEXT_AND_EMBEDDINGS');
    assert.equal(document.status, 'PENDING');
    assert.equal(document.originalAvailable, false);
    const version = await db.documentVersion.findFirstOrThrow({ where: { documentId: document.id } });
    assert.equal(version.sha256, sha256(content));
    const [copy, ...others] = await copiesOf(document.id);
    assert.equal(others.length, 0);
    assert.equal(copy.kind, 'WEB_SOURCE');
    assert.equal(copy.state, 'AVAILABLE');
    assert.match(copy.storageKey, new RegExp(`^web-source/${users.a.id}/[0-9a-f-]{36}$`));
    assert.match(copy.encryptionKeyRef, new RegExp(`^w1\\.${kekId}\\.`));
    assert.ok(Math.abs(copy.expiresAt.getTime() - (Date.now() + 24 * 3_600_000)) < 60_000, 'expires in about 24 hours');
    const stored = await object(copy.storageKey);
    assert.equal(stored.length, Number(copy.byteSize));
    assert.equal(sha256(stored), copy.sha256);
    assert.equal(stored.subarray(0, 4).toString(), 'DFE1');
    assert.equal(stored.includes(content.subarray(0, 24)), false, 'no plaintext in object storage');
    assert.equal((await request(`/api/documents/${document.id}/original`, { token: users.a.token })).status, 404);
    const detail = await request(`/api/documents/${document.id}`, { token: users.a.token });
    assert.deepEqual(detail.body, document);
  });

  test('identical content is deduplicated per user, including concurrent uploads', async () => {
    const content = text();
    const first = await upload(users.a, { name: 'one.txt', data: content });
    assert.equal(first.status, 201);
    const again = await upload(users.a, { name: 'renamed copy.txt', data: content });
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.document.id, first.body.document.id);
    assert.equal(again.body.document.file.name, 'one.txt');
    const fresh = text();
    const race = await Promise.all([upload(users.a, { name: 'race.txt', data: fresh }), upload(users.a, { name: 'race.txt', data: fresh })]);
    assert.deepEqual(race.map((result) => result.status).sort(), [200, 201]);
    assert.equal(race[0].body.document.id, race[1].body.document.id);
    assert.equal(await db.documentVersion.count({ where: { userId: users.a.id, sha256: sha256(fresh) } }), 1);
    assert.equal(await db.fileCopy.count({ where: { documentId: race[0].body.document.id } }), 1);
    const other = await upload(users.b, { name: 'one.txt', data: content });
    assert.equal(other.status, 201, 'another user gets their own document');
    assert.notEqual(other.body.document.id, first.body.document.id);
  });

  test('an identical upload still storing its blob is waited for, never reported as saved before it is', async () => {
    const user = await createUser('in-flight');
    const inFlight = async (content, createdAt = new Date()) => {
      const document = await db.document.create({ data: { userId: user.id, title: 'Đang tải', source: 'WEB_UPLOAD' } });
      const version = await db.documentVersion.create({ data: { userId: user.id, documentId: document.id, number: 1, sha256: sha256(content), byteSize: BigInt(content.length), mimeType: 'text/plain', originalFilename: 'dang-tai.txt', source: 'WEB_UPLOAD' } });
      const copy = await db.fileCopy.create({ data: { userId: user.id, documentId: document.id, versionId: version.id, kind: 'WEB_SOURCE', state: 'UPLOADING', storageKey: `web-source/${user.id}/${randomUUID()}`, contentType: 'application/octet-stream', byteSize: 7n, encryptionKeyRef: 'w1.it.x', createdAt } });
      return { document, version, copy };
    };
    const track = (promise) => { const state = { done: false }; promise.finally(() => { state.done = true; }); return state; };

    const stored = text();
    const first = await inFlight(stored);
    const waiting = upload(user, { name: 'lan-hai.txt', data: stored });
    const progress = track(waiting);
    await delay(600);
    assert.equal(progress.done, false, 'must not answer while the first upload is unfinished');
    await db.fileCopy.update({ where: { id: first.copy.id }, data: { state: 'AVAILABLE', sha256: sha256('ciphertext') } });
    const duplicate = await waiting;
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(duplicate.body.document.id, first.document.id);

    const lost = text();
    const failed = await inFlight(lost);
    const retry = upload(user, { name: 'lan-hai.txt', data: lost });
    await delay(600);
    await db.fileCopy.delete({ where: { id: failed.copy.id } });
    await db.documentVersion.delete({ where: { id: failed.version.id } });
    await db.document.delete({ where: { id: failed.document.id } });
    const saved = await retry;
    assert.equal(saved.status, 201);
    assert.notEqual(saved.body.document.id, failed.document.id);
    const [copy] = await copiesOf(saved.body.document.id);
    assert.equal(copy.state, 'AVAILABLE');
    assert.equal(await objectExists(copy.storageKey), true, 'the file really is stored');

    const crashed = text();
    const stale = await inFlight(crashed, new Date(Date.now() - 10 * 60_000));
    const started = Date.now();
    const fresh = await upload(user, { name: 'thu-lai.txt', data: crashed });
    assert.equal(fresh.status, 201);
    assert.notEqual(fresh.body.document.id, stale.document.id);
    assert.ok(Date.now() - started < 5_000, 'no waiting on an abandoned upload');
  });

  test('the type comes from the bytes; size, emptiness and the multipart shape are enforced', async (t) => {
    const before = await documentCount(users.b);
    const invalid = [
      ['PNG named .pdf', { name: 'scan.pdf', data: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex') }, 415],
      ['legacy-encoded text', { name: 'ghi-chu.txt', data: Buffer.from([0x48, 0xe4, 0x20, 0xf5, 0x6f, 0xff]) }, 415],
      ['UTF-8 text with another extension', { name: 'notes.md', data: text() }, 415],
      ['ZIP that is not a Word document', { name: 'fake.docx', data: zip([{ name: 'a.txt', data: Buffer.from('x') }]) }, 415],
      ['text with NUL bytes', { name: 'bin.txt', data: Buffer.from('abc\u0000def') }, 415],
      ['empty file', { name: 'empty.txt', data: Buffer.alloc(0) }, 400],
      ['50 MiB + 1 byte', { name: 'big.pdf', data: Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(50 * MiB + 1 - 9)]) }, 413],
    ];
    for (const [label, file, status] of invalid) {
      await t.test(label, async () => {
        const result = await upload(users.b, file);
        assert.equal(result.status, status);
        assert.equal(typeof result.body.message, 'string');
        assert.doesNotMatch(result.body.message, /File too large|Unexpected|Multipart/);
      });
    }
    await t.test('two files', async () => {
      const result = await upload(users.b, [{ name: 'a.txt', data: text() }, { name: 'b.txt', data: text() }]);
      assert.equal(result.status, 400);
      assert.doesNotMatch(result.body.message, /Too many/);
    });
    await t.test('no file field', async () => {
      const form = new FormData();
      form.append('title', 'Không có tệp');
      const result = await request('/api/documents', { method: 'POST', token: users.b.token, form });
      assert.equal(result.status, 400);
      assert.equal(typeof result.body.fieldErrors.file, 'string');
    });
    assert.equal(await documentCount(users.b), before, 'rejected uploads create nothing');
    const word = await upload(users.b, { name: 'Hợp đồng.docx', data: docx() }, { title: '  Hợp đồng lao động  ' });
    assert.equal(word.status, 201);
    assert.equal(word.body.document.file.mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(word.body.document.title, 'Hợp đồng lao động');
    const junkFirst = await upload(users.b, { name: 'no-extension', data: Buffer.concat([Buffer.from('junk\n'), pdf()]) });
    assert.equal(junkFirst.status, 201);
    assert.equal(junkFirst.body.document.file.name, 'no-extension.pdf');
  });

  test('level 3 keeps an encrypted original that only its owner can download, byte for byte', async () => {
    const content = pdf(200 * 1024);
    const name = 'Hợp đồng (bản ký) 05/2026.pdf';
    const result = await upload(users.c, { name, data: content, type: 'application/pdf' });
    assert.equal(result.status, 201);
    const document = result.body.document;
    assert.equal(document.privacyLevel, 'ENCRYPTED_COPY');
    assert.equal(document.originalAvailable, true);
    assert.equal(document.file.name, '2026.pdf', 'only the last path segment of a client name is kept');
    const [copy, ...others] = await copiesOf(document.id);
    assert.equal(others.length, 0);
    assert.equal(copy.kind, 'ENCRYPTED_COPY');
    assert.equal(copy.expiresAt, null);
    assert.match(copy.storageKey, new RegExp(`^encrypted/${users.c.id}/`));
    const stored = await object(copy.storageKey);
    assert.notEqual(sha256(stored), sha256(content));
    assert.equal(stored.includes(content.subarray(100, 164)), false);
    const download = await request(`/api/documents/${document.id}/original`, { token: users.c.token });
    assert.equal(download.status, 200);
    assert.equal(sha256(download.raw), sha256(content));
    assert.equal(download.headers.get('content-type'), 'application/pdf');
    assert.equal(download.headers.get('content-length'), String(content.length));
    assert.match(download.headers.get('content-disposition'), /^attachment; filename="2026\.pdf"; filename\*=UTF-8''2026\.pdf$/);
    assert.match(download.headers.get('cache-control'), /no-store/);
    for (const path of [`/api/documents/${document.id}`, `/api/documents/${document.id}/original`]) {
      assert.equal((await request(path, { token: users.a.token })).status, 404, `${path} is hidden from other users`);
    }
    const list = await request('/api/documents', { token: users.a.token });
    assert.equal(list.body.items.some((item) => item.id === document.id), false);
    const unicode = await upload(users.c, { name: 'Biên bản bàn giao.txt', data: text() });
    const disposition = (await request(`/api/documents/${unicode.body.document.id}/original`, { token: users.c.token })).headers.get('content-disposition');
    assert.match(disposition, /filename="Bien ban ban giao\.txt"; filename\*=UTF-8''Bi%C3%AAn%20b%E1%BA%A3n%20b%C3%A0n%20giao\.txt/);
  });

  test('files up to 50 MiB are accepted and stored encrypted', async () => {
    const user = await createUser('large');
    const content = pdf(50 * MiB - 64);
    const result = await upload(user, { name: 'lon.pdf', data: content, type: 'application/pdf' });
    assert.equal(result.status, 201);
    assert.equal(result.body.document.file.byteSize, content.length);
    const [copy] = await copiesOf(result.body.document.id);
    assert.equal(copy.state, 'AVAILABLE');
    const stored = await object(copy.storageKey);
    assert.ok(stored.length > content.length, 'ciphertext with header and tags');
    assert.equal(stored.includes(content.subarray(1_000_000, 1_000_064)), false);
  });

  test('tampered ciphertext and swapped key references never yield plaintext', async () => {
    const first = text();
    const second = text();
    const x = (await upload(users.c, { name: 'x.txt', data: first })).body.document;
    const y = (await upload(users.c, { name: 'y.txt', data: second })).body.document;
    const [copyX] = await copiesOf(x.id);
    const [copyY] = await copiesOf(y.id);
    const original = await object(copyX.storageKey);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 20] ^= 0x01;
    await storage.send(new S3.PutObjectCommand({ Bucket: s3.bucket, Key: copyX.storageKey, Body: tampered }));
    let leaked = null;
    try {
      const response = await fetch(`${baseUrl}/api/documents/${x.id}/original`, { headers: { authorization: `Bearer ${users.c.token}` } });
      if (response.status === 200) leaked = Buffer.from(await response.arrayBuffer());
    } catch {}
    assert.ok(leaked === null || !leaked.equals(first), 'a tampered file is never delivered complete');
    await storage.send(new S3.PutObjectCommand({ Bucket: s3.bucket, Key: copyX.storageKey, Body: original }));
    assert.equal(sha256((await request(`/api/documents/${x.id}/original`, { token: users.c.token })).raw), sha256(first));
    await db.$transaction([
      db.fileCopy.update({ where: { id: copyX.id }, data: { encryptionKeyRef: copyY.encryptionKeyRef } }),
      db.fileCopy.update({ where: { id: copyY.id }, data: { encryptionKeyRef: copyX.encryptionKeyRef } }),
    ]);
    const swapped = await request(`/api/documents/${x.id}/original`, { token: users.c.token });
    assert.equal(swapped.status, 503);
    assert.equal(swapped.raw.includes(second), false);
    await db.$transaction([
      db.fileCopy.update({ where: { id: copyX.id }, data: { encryptionKeyRef: copyX.encryptionKeyRef } }),
      db.fileCopy.update({ where: { id: copyY.id }, data: { encryptionKeyRef: copyY.encryptionKeyRef } }),
    ]);
  });

  test('encrypted originals count against the quota, and usage is reported', async () => {
    const accepted = await upload(users.d, { name: 'a.pdf', data: pdf(600 * 1024) });
    assert.equal(accepted.status, 201);
    const usage = await request('/api/documents/usage', { token: users.d.token });
    const [copy] = await copiesOf(accepted.body.document.id);
    assert.deepEqual(usage.body, { encryptedBytes: Number(copy.byteSize), quotaBytes: MiB });
    const before = await documentCount(users.d);
    const refused = await upload(users.d, { name: 'b.pdf', data: pdf(600 * 1024) });
    assert.equal(refused.status, 413);
    assert.match(refused.body.fieldErrors.file, /hạn mức/);
    assert.equal(await documentCount(users.d), before);
    assert.equal((await upload(users.d, { name: 'small.txt', data: text() })).status, 201);
    const level2 = await request('/api/documents/usage', { token: users.a.token });
    assert.equal(level2.body.encryptedBytes, 0, 'temporary copies do not use the level-3 quota');
  });

  test('P5: deleting an original keeps the document; the worker removes the blob and frees the quota', async () => {
    const doc = (await upload(users.c, { name: 'xoa-ban-goc.pdf', data: pdf(40 * 1024) })).body.document;
    const [copy] = await copiesOf(doc.id);
    const before = (await request('/api/documents/usage', { token: users.c.token })).body.encryptedBytes;
    assert.equal((await request(`/api/documents/${doc.id}/original`, { method: 'DELETE', token: users.a.token })).status, 404, 'other users cannot delete it');
    const result = await request(`/api/documents/${doc.id}/original`, { method: 'DELETE', token: users.c.token });
    assert.equal(result.status, 202);
    assert.equal(result.body.originalAvailable, false);
    assert.equal((await request('/api/documents/usage', { token: users.c.token })).body.encryptedBytes, before - Number(copy.byteSize));
    assert.equal((await request(`/api/documents/${doc.id}/original`, { token: users.c.token })).status, 404);
    await eventually(copyDeleted(copy.id), 'the worker should delete the blob');
    assert.equal(await objectExists(copy.storageKey), false);
    const after = await db.fileCopy.findUniqueOrThrow({ where: { id: copy.id } });
    assert.ok(after.deleteRequestedAt && after.deletedAt);
    assert.equal((await request(`/api/documents/${doc.id}`, { token: users.c.token })).status, 200, 'the document stays');
    assert.equal((await request(`/api/documents/${doc.id}/original`, { method: 'DELETE', token: users.c.token })).status, 404);
  });

  test('P6 3→2: lowering the account level drops every original in the same request; the worker deletes the blobs', async () => {
    const user = await createUser('downgrade3', 'ENCRYPTED_COPY');
    const docs = [];
    for (const name of ['a.txt', 'b.txt']) docs.push((await upload(user, { name, data: text() })).body.document);
    const copies = (await Promise.all(docs.map((doc) => copiesOf(doc.id)))).flat();
    const changed = await request('/api/account', { method: 'PATCH', token: user.token, body: { privacyLevel: 'TEXT_AND_EMBEDDINGS' } });
    assert.equal(changed.status, 200);
    for (const copy of copies) assert.notEqual((await db.fileCopy.findUniqueOrThrow({ where: { id: copy.id } })).state, 'AVAILABLE');
    for (const doc of docs) {
      const detail = (await request(`/api/documents/${doc.id}`, { token: user.token })).body;
      assert.equal(detail.originalAvailable, false);
      assert.equal(detail.privacyLevel, 'TEXT_AND_EMBEDDINGS');
    }
    for (const copy of copies) await eventually(copyDeleted(copy.id), 'originals should be purged');
    for (const copy of copies) assert.equal(await objectExists(copy.storageKey), false);
    const purge = await db.aIJob.findFirst({ where: { userId: user.id, kind: 'PURGE' }, orderBy: { createdAt: 'desc' } });
    await eventually(async () => (await db.aIJob.findUniqueOrThrow({ where: { id: purge.id } })).status === 'SUCCEEDED', 'purge job should succeed');
    const next = await upload(user, { name: 'sau-khi-ha.txt', data: text() });
    assert.equal((await copiesOf(next.body.document.id))[0].kind, 'WEB_SOURCE');
  });

  test('P6 2→1: text is purged at once, text jobs are cancelled, and a stale worker cannot write it back', async () => {
    const user = await createUser('downgrade2');
    const doc = (await upload(user, { name: 'hop-dong.txt', data: text() })).body.document;
    const version = await db.documentVersion.findFirstOrThrow({ where: { documentId: doc.id } });
    await db.documentChunk.create({ data: { userId: user.id, documentId: doc.id, versionId: version.id, ordinal: 0, content: 'Tiền cọc 16.000.000', charStart: 0, charEnd: 19, chunkerVersion: 'v1' } });
    const metadata = await db.extractedMetadata.create({ data: {
      userId: user.id, documentId: doc.id, versionId: version.id, modelId: 'test', promptVersion: 'p1', schemaVersion: 1,
      summary: 'Hợp đồng thuê nhà 12 tháng.', fields: { deposit: '16000000' },
      evidence: { deposit: { quote: 'Tiền cọc 16.000.000', charStart: 0, charEnd: 19 } },
    } });
    const job = await db.aIJob.create({ data: { userId: user.id, kind: 'SUMMARIZE', documentId: doc.id, versionId: version.id, idempotencyKey: `summarize:${doc.id}` } });
    const changed = await request('/api/account', { method: 'PATCH', token: user.token, body: { privacyLevel: 'STRUCTURED_ONLY' } });
    assert.equal(changed.status, 200);
    assert.equal(await db.documentChunk.count({ where: { documentId: doc.id } }), 0);
    const purged = await db.extractedMetadata.findUniqueOrThrow({ where: { id: metadata.id } });
    assert.equal(purged.summary, null);
    assert.deepEqual(purged.evidence, { deposit: { charStart: 0, charEnd: 19 } }, 'offsets stay, the quote goes');
    assert.deepEqual(purged.fields, { deposit: '16000000' }, 'structured data stays');
    assert.equal((await db.aIJob.findUniqueOrThrow({ where: { id: job.id } })).status, 'CANCELLED');
    const { RetentionService, PrivacyPolicyChangedError } = await compiled('retention/retention.service.js');
    const retention = new RetentionService(db, null, null);
    await assert.rejects(db.$transaction(async (transaction) => {
      await retention.assertMayStore(transaction, user.id, doc.id, 'TEXT_AND_EMBEDDINGS');
      await transaction.documentChunk.create({ data: { userId: user.id, documentId: doc.id, versionId: version.id, ordinal: 0, content: 'sống lại?', charStart: 0, charEnd: 9, chunkerVersion: 'v1' } });
    }), PrivacyPolicyChangedError);
    assert.equal(await db.documentChunk.count({ where: { documentId: doc.id } }), 0, 'purged text never comes back');
    await db.$transaction((transaction) => retention.assertMayStore(transaction, user.id, doc.id, 'STRUCTURED_ONLY'));
  });

  test('P2: a document can lower its own level (never above the account); null follows the account again', async () => {
    const user = await createUser('per-document', 'ENCRYPTED_COPY');
    const doc = (await upload(user, { name: 'rieng.txt', data: text() })).body.document;
    const [copy] = await copiesOf(doc.id);
    const lowered = await request(`/api/documents/${doc.id}`, { method: 'PATCH', token: user.token, body: { privacyLevel: 'TEXT_AND_EMBEDDINGS' } });
    assert.equal(lowered.status, 200);
    assert.equal(lowered.body.privacyOverride, 'TEXT_AND_EMBEDDINGS');
    assert.equal(lowered.body.privacyLevel, 'TEXT_AND_EMBEDDINGS');
    assert.equal(lowered.body.originalAvailable, false);
    await eventually(copyDeleted(copy.id), 'the document original should be purged');
    const other = (await upload(user, { name: 'khac.txt', data: text() })).body.document;
    assert.equal(other.originalAvailable, true, 'other documents keep the account level');
    assert.equal((await request(`/api/documents/${doc.id}`, { method: 'PATCH', token: user.token, body: {} })).status, 400);
    assert.equal((await request(`/api/documents/${doc.id}`, { method: 'PATCH', token: users.a.token, body: { privacyLevel: null } })).status, 404);
    const reset = await request(`/api/documents/${doc.id}`, { method: 'PATCH', token: user.token, body: { privacyLevel: null } });
    assert.equal(reset.body.privacyOverride, null);
    assert.equal(reset.body.privacyLevel, 'ENCRYPTED_COPY');
    assert.equal(reset.body.originalAvailable, false, 'a purged original is not restored by raising the level');
    await request('/api/account', { method: 'PATCH', token: user.token, body: { privacyLevel: 'TEXT_AND_EMBEDDINGS' } });
    const tooHigh = await request(`/api/documents/${doc.id}`, { method: 'PATCH', token: user.token, body: { privacyLevel: 'ENCRYPTED_COPY' } });
    assert.equal(tooHigh.status, 409);
  });

  test('housekeeping: expired temporary copies and abandoned uploads are cleaned up', async () => {
    const user = await createUser('housekeeping');
    const doc = (await upload(user, { name: 'tam.txt', data: text() })).body.document;
    const [temporary] = await copiesOf(doc.id);
    await db.fileCopy.update({ where: { id: temporary.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    await eventually(copyDeleted(temporary.id), 'expired WEB_SOURCE should be deleted');
    assert.equal(await objectExists(temporary.storageKey), false);
    const abandoned = await db.document.create({ data: { userId: user.id, title: 'Bỏ dở', source: 'WEB_UPLOAD' } });
    const version = await db.documentVersion.create({ data: { userId: user.id, documentId: abandoned.id, number: 1, sha256: sha256('x'), byteSize: 1n, mimeType: 'text/plain', originalFilename: 'bo-do.txt', source: 'WEB_UPLOAD' } });
    const key = `web-source/${user.id}/${randomUUID()}`;
    await storage.send(new S3.PutObjectCommand({ Bucket: s3.bucket, Key: key, Body: Buffer.from('partial') }));
    await db.fileCopy.create({ data: { userId: user.id, documentId: abandoned.id, versionId: version.id, kind: 'WEB_SOURCE', state: 'UPLOADING', storageKey: key, contentType: 'application/octet-stream', byteSize: 7n, encryptionKeyRef: 'w1.it.x', createdAt: new Date(Date.now() - 2 * 3_600_000) } });
    await eventually(async () => (await db.document.count({ where: { id: abandoned.id } })) === 0, 'abandoned upload should be swept');
    assert.equal(await objectExists(key), false);
  });

  test('jobs: concurrent claims never share a job; retries back off; expired leases are fenced', async () => {
    const { JobQueue } = await compiled('jobs/job-queue.service.js');
    const user = await createUser('jobs');
    const ids = [];
    for (let index = 0; index < 8; index++) {
      ids.push((await db.aIJob.create({ data: { userId: user.id, kind: 'EMBED', idempotencyKey: `embed:${user.id}:${index}`, maxAttempts: 2 } })).id);
    }
    const one = new JobQueue(db);
    const two = new JobQueue(db);
    const [first, second] = await Promise.all([one.claim(['EMBED'], 8), two.claim(['EMBED'], 8)]);
    const claimed = [...first, ...second].map((job) => job.id).filter((id) => ids.includes(id));
    assert.equal(claimed.length, 8);
    assert.equal(new Set(claimed).size, 8, 'no job is claimed twice');
    const job = [...first, ...second].find((entry) => entry.id === ids[0]);
    const holder = first.includes(job) ? one : two;
    assert.equal(await holder.fail(job, 'TEST_FAILURE'), 'retry');
    const retried = await db.aIJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(retried.status, 'FAILED');
    assert.ok(retried.availableAt > new Date(), 'a failed job waits before retrying');
    await db.aIJob.update({ where: { id: job.id }, data: { availableAt: new Date() } });
    const [again] = await one.claim(['EMBED'], 1);
    assert.equal(again.id, job.id);
    assert.equal(again.attempts, 2);
    assert.equal(await one.fail(again, 'TEST_FAILURE'), 'dead', 'the last attempt goes to DEAD');
    const leased = [...first, ...second].find((entry) => entry.id === ids[1]);
    const owner = first.includes(leased) ? one : two;
    await db.aIJob.update({ where: { id: leased.id }, data: { leaseUntil: new Date(Date.now() - 1_000) } });
    const thief = new JobQueue(db);
    const [taken] = await thief.claim(['EMBED'], 1);
    assert.equal(taken.id, leased.id, 'an expired lease is claimed again');
    assert.equal(await owner.complete(leased), false, 'the old owner can no longer complete it');
    assert.equal(await thief.complete(taken), true);
    await db.aIJob.deleteMany({ where: { userId: user.id } });
  });

  test('key rotation: the worker re-wraps data keys under the new KEK and originals still download', async () => {
    const content = text();
    const doc = (await upload(users.c, { name: 'xoay-khoa.txt', data: content })).body.document;
    const [copy] = await copiesOf(doc.id);
    assert.match(copy.encryptionKeyRef, /^w1\.it\./);
    await stopWorker();
    await stopApi();
    fileKeks = `it2:${keks.it2},${kekId}:${keks[kekId]}`;
    await startApi();
    startWorker();
    users.c.token = (await request('/api/auth/login', { method: 'POST', body: { email: users.c.email, password } })).body.accessToken;
    await eventually(async () => (await db.fileCopy.findUniqueOrThrow({ where: { id: copy.id } })).encryptionKeyRef.startsWith('w1.it2.'), 'keys should be re-wrapped');
    const rewrapped = await db.fileCopy.findUniqueOrThrow({ where: { id: copy.id } });
    assert.equal(rewrapped.sha256, copy.sha256, 'the stored file itself is untouched');
    const download = await request(`/api/documents/${doc.id}/original`, { token: users.c.token });
    assert.equal(sha256(download.raw), sha256(content));
  });

  test('listing is per user, newest first, with cursor pagination', async () => {
    const ids = [];
    for (let index = 0; index < 3; index++) {
      ids.push((await upload(users.e, { name: `note-${index}.txt`, data: text() })).body.document.id);
      await delay(5);
    }
    const first = await request('/api/documents?limit=2', { token: users.e.token });
    assert.equal(first.status, 200);
    assertPrivate(first.body);
    assert.deepEqual(first.body.items.map((item) => item.id), [ids[2], ids[1]]);
    assert.equal(typeof first.body.nextCursor, 'string');
    const second = await request(`/api/documents?limit=2&cursor=${first.body.nextCursor}`, { token: users.e.token });
    assert.deepEqual(second.body.items.map((item) => item.id), [ids[0]]);
    assert.equal(second.body.nextCursor, null);
    assert.equal((await request('/api/documents?cursor=not*valid', { token: users.e.token })).status, 400);
    assert.equal((await request('/api/documents?limit=0', { token: users.e.token })).status, 400);
    assert.equal((await request(`/api/documents?cursor=${Buffer.from('x|y').toString('base64url')}`, { token: users.e.token })).status, 400);
    for (const raw of [`2026-11-04T00:00:00.000Z|${'-'.repeat(36)}`, `2026-11-04T00:00:00.000Z|${'g'.repeat(36)}`, `2026-11-31T00:00:00.000Z|${randomUUID()}`, `2026-11-04|${randomUUID()}`]) {
      const response = await request(`/api/documents?cursor=${Buffer.from(raw).toString('base64url')}`, { token: users.e.token });
      assert.equal(response.status, 400, raw);
      assert.ok(response.body.fieldErrors?.cursor, raw);
    }
    const others = await request('/api/documents?limit=50', { token: users.b.token });
    assert.equal(others.body.items.some((item) => ids.includes(item.id)), false);
  });
});
