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
const brokenDocx = () => zip([
  { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types/>') },
  { name: 'word/document.xml', data: Buffer.from(`<w:document><w:p>${randomUUID()}`) },
]);
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const docxWith = (paragraphs) => zip([
  { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
  { name: '_rels/.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
  { name: 'word/document.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${paragraphs.map((paragraph) => `<w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`, 'utf8') },
]);

function textPdf(pages) {
  const objects = [];
  const add = (body) => objects.push(body);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const pagesId = 1 + pages.length * 2 + 2;
  const kids = [];
  for (const lines of pages) {
    const ops = lines.length ? `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((line) => `(${line}) Tj T*`).join(' ')} ET` : '';
    add(`<< /Length ${Buffer.byteLength(ops, 'latin1')} >>\nstream\n${ops}\nendstream`);
    const content = objects.length;
    add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 1 0 R >> >> >>`);
    kids.push(objects.length);
  }
  add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const catalog = objects.length;
  add(`<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
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
  ENCRYPTED_QUOTA_MB: '1', WEB_SOURCE_MAX_DAYS: '30', WORKER_POLL_MS: '100', WORKER_MAINTENANCE_MS: '400',
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

async function parsed(user, documentId, timeout = 20_000) {
  let document;
  await eventually(async () => {
    document = (await request(`/api/documents/${documentId}`, { token: user.token })).body;
    return !['PENDING', 'PROCESSING'].includes(document.status);
  }, 'the worker should finish parsing', timeout);
  return document;
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

  test('level 2 keeps only an encrypted temporary copy, and the original cannot be downloaded', async (t) => {
    await stopWorker();
    t.after(() => { if (!worker || worker.exitCode !== null) startWorker(); });
    const content = text();
    const result = await upload(users.a, { name: 'Ghi chú thuê nhà.txt', data: content, type: 'text/plain' });
    assert.equal(result.status, 201);
    assertPrivate(result.body);
    const document = result.body.document;
    assert.equal(result.body.duplicate, false);
    assert.equal(document.title, 'Ghi chú thuê nhà');
    assert.deepEqual(document.file, { name: 'Ghi chú thuê nhà.txt', mimeType: 'text/plain', byteSize: content.length });
    assert.equal(document.privacyLevel, undefined, 'storage levels are internal');
    assert.equal(document.privacyOverride, undefined);
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
    assert.ok(Math.abs(copy.expiresAt.getTime() - (Date.now() + 30 * 86_400_000)) < 60_000, 'kept at most 30 days');
    const stored = await object(copy.storageKey);
    assert.equal(stored.length, Number(copy.byteSize));
    assert.equal(sha256(stored), copy.sha256);
    assert.equal(stored.subarray(0, 4).toString(), 'DFE1');
    assert.equal(stored.includes(content.subarray(0, 24)), false, 'no plaintext in object storage');
    assert.equal((await request(`/api/documents/${document.id}/original`, { token: users.a.token })).status, 404);
    const detail = await request(`/api/documents/${document.id}`, { token: users.a.token });
    assert.deepEqual(detail.body, document);
    startWorker();
    const done = await parsed(users.a, document.id);
    assert.equal(done.status, 'SUCCEEDED');
    assert.equal(done.problem, null);
    const chunks = await db.documentChunk.findMany({ where: { documentId: document.id }, orderBy: { ordinal: 'asc' } });
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].content, content.toString('utf8').trim());
    const after = await db.documentVersion.findUniqueOrThrow({ where: { id: version.id } });
    assert.equal(after.parserVersion, 'p2');
    assert.equal(after.charCount, chunks[0].content.length);
    await eventually(copyDeleted(copy.id), 'the temporary copy goes once the text is kept');
    assert.equal(await objectExists(copy.storageKey), false);
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

  test('B4: PDF, DOCX and TXT are read by the worker; text is kept only from level 2, temporary copies go once processed', async () => {
    const level2 = await createUser('parse-2');
    const level1 = await createUser('parse-1', 'STRUCTURED_ONLY');
    const level3 = await createUser('parse-3', 'ENCRYPTED_COPY');
    const pdfDoc = (await upload(level2, { name: 'thue-nha.pdf', data: textPdf([['Hop dong thue nha so 12', 'Tien coc 16.000.000 VND'], ['Thoi han 12 thang']]) })).body.document;
    const docxDoc = (await upload(level2, { name: 'bao-hanh.docx', data: docxWith(['Phiếu bảo hành', 'Bảo hành 12 tháng kể từ ngày giao hàng.']) })).body.document;
    const privateDoc = (await upload(level1, { name: 'rieng.txt', data: text() })).body.document;
    const originalDoc = (await upload(level3, { name: 'goc.txt', data: text() })).body.document;

    assert.equal((await parsed(level2, pdfDoc.id)).status, 'SUCCEEDED');
    const pdfVersion = await db.documentVersion.findFirstOrThrow({ where: { documentId: pdfDoc.id } });
    assert.equal(pdfVersion.pageCount, 2);
    const pdfChunks = await db.documentChunk.findMany({ where: { documentId: pdfDoc.id }, orderBy: { ordinal: 'asc' } });
    assert.match(pdfChunks.map((chunk) => chunk.content).join(' '), /Tien coc 16\.000\.000 VND[\s\S]*Thoi han 12 thang/);
    assert.equal(pdfChunks[0].pageFrom, 1);
    assert.equal(pdfChunks.at(-1).pageTo, 2);
    const [pdfCopy] = await copiesOf(pdfDoc.id);
    await eventually(copyDeleted(pdfCopy.id), 'level 2: the temporary copy is deleted after parsing');

    assert.equal((await parsed(level2, docxDoc.id)).status, 'SUCCEEDED');
    const docxText = (await db.documentChunk.findMany({ where: { documentId: docxDoc.id } })).map((chunk) => chunk.content).join(' ');
    assert.match(docxText, /Phiếu bảo hành\s+Bảo hành 12 tháng kể từ ngày giao hàng\./);

    assert.equal((await parsed(level1, privateDoc.id)).status, 'SUCCEEDED');
    assert.equal(await db.documentChunk.count({ where: { documentId: privateDoc.id } }), 0, 'level 1 keeps no text');
    assert.ok((await db.documentVersion.findFirstOrThrow({ where: { documentId: privateDoc.id } })).charCount > 0);
    const [privateCopy] = await copiesOf(privateDoc.id);
    assert.equal(privateCopy.state, 'AVAILABLE', 'level 1 keeps the encrypted source for extraction, at most 30 days');

    assert.equal((await parsed(level3, originalDoc.id)).status, 'SUCCEEDED');
    assert.ok(await db.documentChunk.count({ where: { documentId: originalDoc.id } }) > 0);
    const [original] = await copiesOf(originalDoc.id);
    assert.equal(original.kind, 'ENCRYPTED_COPY');
    assert.equal(original.state, 'AVAILABLE');
    assert.equal((await request(`/api/documents/${originalDoc.id}/original`, { token: level3.token })).status, 200);
    assert.equal(await db.aIJob.count({ where: { documentId: { in: [pdfDoc.id, docxDoc.id, privateDoc.id, originalDoc.id] }, kind: 'PARSE', status: { not: 'SUCCEEDED' } } }), 0);
  });

  test('B4: short notes and one-line PDFs are text, and emoji on a chunk boundary are stored intact', async () => {
    const user = await createUser('parse-short');
    const emoji = String.fromCodePoint(0x1F600);
    const cases = [
      ['hen.txt', Buffer.from('Hẹn trả cọc 30/11.', 'utf8'), 'Hẹn trả cọc 30/11.'],
      ['mot-dong.pdf', textPdf([['Hen tra coc 30/11']]), 'Hen tra coc 30/11'],
      ['emoji.txt', Buffer.from(`${'a'.repeat(1_199)}${emoji}${'b'.repeat(600)}`, 'utf8'), `${'a'.repeat(1_199)}${emoji}`],
    ];
    for (const [name, data, expected] of cases) {
      const doc = (await upload(user, { name, data })).body.document;
      const done = await parsed(user, doc.id);
      assert.equal(done.status, 'SUCCEEDED', `${name}: ${done.problem}`);
      const chunks = await db.documentChunk.findMany({ where: { documentId: doc.id }, orderBy: { ordinal: 'asc' } });
      assert.ok(chunks.length > 0, name);
      assert.ok(chunks.map((chunk) => chunk.content).join('').includes(expected.trim()), name);
    }
  });

  test('B4: scans, legacy Vietnamese fonts and damaged files are kept with a reason instead of failing silently', async () => {
    const user = await createUser('parse-bad');
    const tcvn3 = 'Hîp ®ång thuª nhµ sè 12, tiÒn cäc. '.repeat(12);
    const cases = [
      ['scan.pdf', textPdf([[]]), 'NO_TEXT_LAYER'],
      ['tcvn3.txt', Buffer.from(tcvn3, 'utf8'), 'LEGACY_VIETNAMESE_FONT'],
      ['hong.pdf', pdf(4096), 'FILE_DAMAGED'],
    ];
    for (const [name, data, code] of cases) {
      const doc = (await upload(user, { name, data })).body.document;
      const done = await parsed(user, doc.id);
      assert.equal(done.status, 'UNSUPPORTED', name);
      assert.equal(done.problem, code, name);
      assert.equal(await db.documentChunk.count({ where: { documentId: doc.id } }), 0);
      const [copy] = await copiesOf(doc.id);
      await eventually(copyDeleted(copy.id), `${name}: an unusable temporary copy is not kept`);
    }
  });

  test('B4: a newer parser version re-reads files it could not read before, while the stored copy still exists', async () => {
    const user = await createUser('parse-version', 'ENCRYPTED_COPY');
    const doc = (await upload(user, { name: 'scan-cu.pdf', data: textPdf([[]]) })).body.document;
    assert.equal((await parsed(user, doc.id)).status, 'UNSUPPORTED');
    const version = await db.documentVersion.findFirstOrThrow({ where: { documentId: doc.id } });
    assert.equal(version.parserVersion, 'p2');
    await db.documentVersion.update({ where: { id: version.id }, data: { parserVersion: 'p1' } });
    await eventually(async () => (await db.aIJob.count({ where: { versionId: version.id, kind: 'PARSE' } })) === 2, 'an older result is queued again');
    const again = await parsed(user, doc.id);
    assert.equal(again.status, 'UNSUPPORTED');
    assert.equal(again.problem, 'NO_TEXT_LAYER');
    assert.equal((await db.documentVersion.findUniqueOrThrow({ where: { id: version.id } })).parserVersion, 'p2');
    await delay(1_500);
    assert.equal(await db.aIJob.count({ where: { versionId: version.id, kind: 'PARSE' } }), 2, 'a current result is not read again');
  });

  test('B4: documents uploaded before parsing existed are picked up; a lost source fails, and uploading the file again revives it', async (t) => {
    const user = await createUser('parse-backfill');
    await stopWorker();
    t.after(() => { if (!worker || worker.exitCode !== null) startWorker(); });
    const waiting = (await upload(user, { name: 'cu.txt', data: text() })).body.document;
    const lostContent = text();
    const lost = (await upload(user, { name: 'mat.txt', data: lostContent })).body.document;
    await db.aIJob.deleteMany({ where: { documentId: { in: [waiting.id, lost.id] } } });
    const [lostCopy] = await copiesOf(lost.id);
    await db.fileCopy.update({ where: { id: lostCopy.id }, data: { state: 'DELETE_PENDING', deleteRequestedAt: new Date() } });
    await db.documentVersion.updateMany({ where: { documentId: lost.id }, data: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
    startWorker();
    assert.equal((await parsed(user, waiting.id)).status, 'SUCCEEDED', 'housekeeping queues documents that never got a job');
    const failed = await parsed(user, lost.id);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.problem, 'SOURCE_UNAVAILABLE');
    const again = await upload(user, { name: 'mat.txt', data: lostContent });
    assert.equal(again.status, 201);
    assert.equal(again.body.duplicate, false);
    assert.equal(again.body.document.id, lost.id, 'the same document gets its file back');
    assert.equal((await parsed(user, lost.id)).status, 'SUCCEEDED');
    assert.equal(await db.documentVersion.count({ where: { documentId: lost.id } }), 1);
    const duplicate = await upload(user, { name: 'mat.txt', data: lostContent });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.duplicate, true);
  });

  test('B4: a document that failed to parse while its file is still stored is retried by uploading the same file again', async () => {
    const user = await createUser('parse-retry', 'ENCRYPTED_COPY');
    const content = text();
    const doc = (await upload(user, { name: 'thu-lai.txt', data: content })).body.document;
    assert.equal((await parsed(user, doc.id)).status, 'SUCCEEDED');
    await db.documentChunk.deleteMany({ where: { documentId: doc.id } });
    await db.documentVersion.updateMany({ where: { documentId: doc.id }, data: { parseState: 'FAILED', parseErrorCode: 'SOURCE_UNREADABLE' } });
    const failed = (await request(`/api/documents/${doc.id}`, { token: user.token })).body;
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.problem, 'SOURCE_UNREADABLE');
    const again = await upload(user, { name: 'thu-lai.txt', data: content });
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.document.id, doc.id);
    assert.equal(again.body.document.status, 'PENDING');
    assert.equal((await parsed(user, doc.id)).status, 'SUCCEEDED');
    assert.ok(await db.documentChunk.count({ where: { documentId: doc.id } }) > 0);
    assert.equal(await db.fileCopy.count({ where: { documentId: doc.id } }), 1, 'no second copy of the file');
  });

  const deadParseJob = (user, documentId, versionId) => db.aIJob.create({
    data: {
      userId: user.id, kind: 'PARSE', documentId, versionId, status: 'DEAD', attempts: 3, maxAttempts: 3,
      lastErrorCode: 'PARSER_CRASHED', idempotencyKey: `parse:${versionId}:old:${randomUUID()}`,
      createdAt: new Date(Date.now() - 3_600_000), finishedAt: new Date(Date.now() - 3_600_000),
    },
  });

  test('B4 review: an old dead job does not fail a version that a newer parser or a fresh job is re-reading', async () => {
    const user = users.c;
    const doc = (await upload(user, { name: 'scan-chet.pdf', data: textPdf([[]]) })).body.document;
    assert.equal((await parsed(user, doc.id)).status, 'UNSUPPORTED');
    const version = await db.documentVersion.findFirstOrThrow({ where: { documentId: doc.id } });
    await deadParseJob(user, doc.id, version.id);
    await db.documentVersion.update({ where: { id: version.id }, data: { parserVersion: 'p1' } });
    await eventually(async () => (await db.aIJob.count({ where: { versionId: version.id, kind: 'PARSE', status: { not: 'DEAD' } } })) === 2,
      'the older result is queued again');
    const again = await parsed(user, doc.id);
    assert.equal(again.status, 'UNSUPPORTED', 'an old dead job must not turn the re-read into FAILED');
    assert.equal(again.problem, 'NO_TEXT_LAYER');
    assert.equal((await db.documentVersion.findUniqueOrThrow({ where: { id: version.id } })).parserVersion, 'p2');
  });

  test('B4 review: a version whose file is being uploaded again is not failed by an old dead job', async () => {
    const user = users.c;
    const doc = (await upload(user, { name: 'dang-tai.txt', data: text() })).body.document;
    assert.equal((await parsed(user, doc.id)).status, 'SUCCEEDED');
    const version = await db.documentVersion.findFirstOrThrow({ where: { documentId: doc.id } });
    const [copy] = await copiesOf(doc.id);
    await deadParseJob(user, doc.id, version.id);
    await db.fileCopy.update({ where: { id: copy.id }, data: { state: 'UPLOADING', createdAt: new Date() } });
    await db.documentVersion.update({ where: { id: version.id }, data: { parseState: 'PENDING', parseErrorCode: null } });
    await delay(1_500);
    const during = await db.documentVersion.findUniqueOrThrow({ where: { id: version.id } });
    assert.equal(during.parseState, 'PENDING', 'housekeeping waits for the upload instead of reusing the old error');
    await db.documentVersion.update({ where: { id: version.id }, data: { parseState: 'SUCCEEDED' } });
    await db.fileCopy.update({ where: { id: copy.id }, data: { state: 'AVAILABLE' } });
  });

  test('B4 review: uploading a lost file again keeps the document\'s own lower level (no encrypted original, no quota)', async () => {
    const user = users.c;
    const content = text();
    const doc = (await upload(user, { name: 'muc-rieng.txt', data: content })).body.document;
    assert.equal((await parsed(user, doc.id)).status, 'SUCCEEDED');
    const lowered = await request(`/api/documents/${doc.id}/details`, { method: 'DELETE', token: user.token });
    assert.equal(lowered.status, 202);
    const [original] = await copiesOf(doc.id);
    await eventually(copyDeleted(original.id), 'the original is removed when the document goes to level 1');
    await db.documentVersion.updateMany({ where: { documentId: doc.id }, data: { parseState: 'FAILED', parseErrorCode: 'SOURCE_UNAVAILABLE' } });
    const before = (await request('/api/documents/usage', { token: user.token })).body.encryptedBytes;
    const again = await upload(user, { name: 'muc-rieng.txt', data: content });
    assert.equal(again.status, 201);
    assert.equal(again.body.document.id, doc.id);
    assert.equal(again.body.document.detailsDeleted, true);
    assert.equal(again.body.document.originalAvailable, false);
    const revived = (await copiesOf(doc.id)).filter((copy) => copy.id !== original.id);
    assert.equal(revived.length, 1);
    assert.equal(revived[0].kind, 'WEB_SOURCE', 'a level-1 document never gets an encrypted original back');
    assert.equal((await request('/api/documents/usage', { token: user.token })).body.encryptedBytes, before);
    assert.equal((await parsed(user, doc.id)).status, 'SUCCEEDED');
    assert.equal(await db.documentChunk.count({ where: { documentId: doc.id } }), 0);
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

  test('files up to 50 MiB are accepted and stored encrypted', async (t) => {
    await stopWorker();
    t.after(() => { if (!worker || worker.exitCode !== null) startWorker(); });
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
    startWorker();
    const done = await parsed(user, result.body.document.id, 60_000);
    assert.equal(done.status, 'UNSUPPORTED');
    assert.equal(done.problem, 'FILE_DAMAGED');
    await eventually(copyDeleted(copy.id), 'an unreadable temporary copy is not kept', 30_000);
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

  test('B5: deleting a document hides it everywhere, purges its text, extracted data and copies, keeps a tombstone, and the file can be uploaded again', async () => {
    const body = text();
    const doc = (await upload(users.c, { name: 'xoa-tai-lieu.txt', data: body })).body.document;
    assert.equal((await parsed(users.c, doc.id)).status, 'SUCCEEDED');
    const version = await db.documentVersion.findFirstOrThrow({ where: { documentId: doc.id } });
    const [copy] = await copiesOf(doc.id);
    assert.ok(await db.documentChunk.count({ where: { documentId: doc.id } }) > 0);
    const metadata = await db.extractedMetadata.create({ data: {
      userId: users.c.id, documentId: doc.id, versionId: version.id, modelId: 'test', promptVersion: 'p1', schemaVersion: 1,
      summary: 'Hợp đồng thuê nhà.', fields: { deposit: '16000000' }, evidence: { deposit: { quote: 'tiền cọc', charStart: 0, charEnd: 8 } },
    } });
    const extract = await db.aIJob.create({ data: { userId: users.c.id, kind: 'EXTRACT', documentId: doc.id, versionId: version.id, idempotencyKey: `extract:${doc.id}` } });
    const usageBefore = (await request('/api/documents/usage', { token: users.c.token })).body.encryptedBytes;

    assert.equal((await request(`/api/documents/${doc.id}`, { method: 'DELETE', token: users.a.token })).status, 404, 'other users cannot delete it');
    assert.equal((await request(`/api/documents/${doc.id}`, { method: 'DELETE', token: users.c.token, requestOrigin: 'https://evil.example' })).status, 403);
    const removed = await request(`/api/documents/${doc.id}`, { method: 'DELETE', token: users.c.token });
    assert.equal(removed.status, 204);

    for (const [path, method] of [['', 'GET'], ['/original', 'GET'], ['/preview', 'GET'], ['', 'DELETE'], ['/original', 'DELETE']]) {
      assert.equal((await request(`/api/documents/${doc.id}${path}`, { method, token: users.c.token })).status, 404, `${method} ${path || '/'} is locked`);
    }
    const listed = (await request('/api/documents?limit=50', { token: users.c.token })).body.items;
    assert.equal(listed.some((item) => item.id === doc.id), false, 'the list no longer shows it');

    const row = await db.document.findUniqueOrThrow({ where: { id: doc.id } });
    assert.ok(row.deletedAt, 'the record stays, marked deleted');
    assert.equal(await db.documentChunk.count({ where: { documentId: doc.id } }), 0, 'text is purged at once');
    const purged = await db.extractedMetadata.findUniqueOrThrow({ where: { id: metadata.id } });
    assert.equal(purged.summary, null);
    assert.deepEqual(purged.fields, {}, 'deleting everything leaves no extracted data');
    assert.deepEqual(purged.evidence, {});
    assert.equal((await db.aIJob.findUniqueOrThrow({ where: { id: extract.id } })).status, 'CANCELLED');
    assert.notEqual((await db.fileCopy.findUniqueOrThrow({ where: { id: copy.id } })).state, 'AVAILABLE');
    assert.equal((await request('/api/documents/usage', { token: users.c.token })).body.encryptedBytes, usageBefore - Number(copy.byteSize), 'quota is freed at once');
    await eventually(copyDeleted(copy.id), 'the worker should delete the stored copy');
    assert.equal(await objectExists(copy.storageKey), false);
    await assert.rejects(db.documentChunk.create({ data: {
      userId: users.c.id, documentId: doc.id, versionId: version.id, ordinal: 0, content: 'sống lại?', charStart: 0, charEnd: 9, chunkerVersion: 'c1',
    } }), /text cannot be stored/);

    const again = await upload(users.c, { name: 'xoa-tai-lieu.txt', data: body });
    assert.equal(again.status, 201, 'the same file can be uploaded again as a new document');
    assert.notEqual(again.body.document.id, doc.id);
    assert.equal((await parsed(users.c, again.body.document.id)).status, 'SUCCEEDED');
  });

  test('layers: the summary shows pages, summary and update time; deleting the original, then the details, hides each layer', async () => {
    const doc = (await upload(users.c, { name: 'ba-lop.pdf', data: textPdf([['Hop dong thue nha'], [`Tien coc 16.000.000 ${randomUUID()}`]]) })).body.document;
    const read = await parsed(users.c, doc.id);
    assert.equal(read.status, 'SUCCEEDED');
    assert.equal(read.pageCount, 2);
    assert.ok(new Date(read.updatedAt) >= new Date(read.createdAt), 'parsing counts as an update');
    assert.equal(read.summary, null);
    assert.equal(read.detailsDeleted, false);
    const version = await db.documentVersion.findFirstOrThrow({ where: { documentId: doc.id } });
    await db.extractedMetadata.create({ data: {
      userId: users.c.id, documentId: doc.id, versionId: version.id, modelId: 'test', promptVersion: 'p1', schemaVersion: 1,
      summary: 'Hợp đồng thuê 12 tháng, cọc 16 triệu.', fields: { deposit: '16000000' },
    } });
    assert.equal((await request(`/api/documents/${doc.id}`, { token: users.c.token })).body.summary, 'Hợp đồng thuê 12 tháng, cọc 16 triệu.');

    const [copy] = await copiesOf(doc.id);
    const noOriginal = await request(`/api/documents/${doc.id}/original`, { method: 'DELETE', token: users.c.token });
    assert.equal(noOriginal.status, 202);
    assert.equal(noOriginal.body.originalAvailable, false);
    assert.ok(await db.documentChunk.count({ where: { documentId: doc.id } }) > 0, 'text stays after deleting the original');
    assert.ok(new Date(noOriginal.body.updatedAt) > new Date(read.updatedAt), 'deleting a layer moves the update time');
    assert.ok(noOriginal.body.summary, 'summary stays after deleting the original');

    assert.equal((await request(`/api/documents/${doc.id}/details`, { method: 'DELETE', token: users.a.token })).status, 404, 'other users cannot');
    const noDetails = await request(`/api/documents/${doc.id}/details`, { method: 'DELETE', token: users.c.token });
    assert.equal(noDetails.status, 202);
    assert.equal(noDetails.body.detailsDeleted, true);
    assert.equal(noDetails.body.summary, null);
    assert.equal(noDetails.body.problem, null);
    assert.equal(noDetails.body.pageCount, 2, 'the info line stays');
    assert.equal(await db.documentChunk.count({ where: { documentId: doc.id } }), 0);
    const { RetentionService, PrivacyPolicyChangedError } = await compiled('retention/retention.service.js');
    const retention = new RetentionService(db, null, null);
    await assert.rejects(db.$transaction(async (transaction) => {
      await retention.assertMayStore(transaction, users.c.id, doc.id, 'TEXT_AND_EMBEDDINGS');
      await transaction.documentChunk.create({ data: { userId: users.c.id, documentId: doc.id, versionId: version.id, ordinal: 0, content: 'sống lại?', charStart: 0, charEnd: 9, chunkerVersion: 'c1' } });
    }), PrivacyPolicyChangedError, 'a stale worker cannot write the deleted text back');
    assert.equal(await db.documentChunk.count({ where: { documentId: doc.id } }), 0);
    const raise = await request(`/api/documents/${doc.id}`, { method: 'PATCH', token: users.c.token, body: { privacyLevel: null } });
    assert.equal(raise.status, 404, 'there is no API to bring a deleted layer back');
    const metadata = await db.extractedMetadata.findFirstOrThrow({ where: { documentId: doc.id } });
    assert.equal(metadata.summary, null);
    assert.deepEqual(metadata.fields, { deposit: '16000000' }, 'structured info stays');
    await eventually(copyDeleted(copy.id), 'the original blob should be deleted');
    const listed = (await request('/api/documents?limit=50', { token: users.c.token })).body.items;
    assert.ok(listed.some((item) => item.id === doc.id), 'the document stays in the list');
    assert.equal((await request(`/api/documents/${doc.id}/details`, { method: 'DELETE', token: users.c.token })).status, 202, 'repeating is harmless');
  });

  test('layers: deleting the details while the file waits to be read stops the reading and drops the file', async () => {
    const doc = (await upload(users.c, { name: 'chua-doc.txt', data: text() })).body.document;
    const removed = await request(`/api/documents/${doc.id}/details`, { method: 'DELETE', token: users.c.token });
    assert.equal(removed.status, 202);
    assert.equal(removed.body.detailsDeleted, true);
    for (const copy of await copiesOf(doc.id)) await eventually(copyDeleted(copy.id), 'the stored file should be deleted');
    const version = await db.documentVersion.findFirstOrThrow({ where: { documentId: doc.id } });
    assert.ok(['FAILED', 'SUCCEEDED'].includes(version.parseState), version.parseState);
    if (version.parseState === 'FAILED') assert.equal(version.parseErrorCode, 'DETAILS_DELETED');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(await db.documentChunk.count({ where: { documentId: doc.id } }), 0);
    const after = (await request(`/api/documents/${doc.id}`, { token: users.c.token })).body;
    assert.equal(after.problem, null, 'no "could not read" message for a deliberate deletion');
    assert.equal(after.status === 'PENDING' || after.status === 'PROCESSING', false, 'the page stops waiting');
  });

  test('layers: details deleted just after the worker checked its lease never leave the document "being read"', async () => {
    const { JobQueue } = await compiled('jobs/job-queue.service.js');
    const { ParseService } = await compiled('parsing/parse.service.js');
    const { RetentionService } = await compiled('retention/retention.service.js');
    await stopWorker();
    try {
      const doc = (await upload(users.c, { name: 'xoa-luc-bat-dau-doc.txt', data: text() })).body.document;
      const queue = new JobQueue(db);
      const claimed = await queue.claim(['PARSE'], 50);
      const job = claimed.find((entry) => entry.documentId === doc.id);
      assert.ok(job, 'the parse job is claimed');
      await db.aIJob.updateMany({
        where: { id: { in: claimed.filter((entry) => entry !== job).map((entry) => entry.id) } },
        data: { status: 'QUEUED', leaseOwner: null, leaseUntil: null, attempts: { decrement: 1 } },
      });
      const jobs = {
        extend: async (...args) => {
          const held = await queue.extend(...args);
          assert.equal((await request(`/api/documents/${doc.id}/details`, { method: 'DELETE', token: users.c.token })).status, 202);
          return held;
        },
        holds: (...args) => queue.holds(...args),
      };
      const parser = new ParseService(db, null, null, new RetentionService(db, null, null), jobs);
      await assert.rejects(parser.handle(job), /LEASE_LOST/);
      const version = await db.documentVersion.findFirstOrThrow({ where: { documentId: doc.id } });
      assert.equal(version.parseState, 'FAILED', 'the cancelled job must not mark the version as being read');
      assert.equal(version.parseErrorCode, 'DETAILS_DELETED');
      const after = (await request(`/api/documents/${doc.id}`, { token: users.c.token })).body;
      assert.equal(after.detailsDeleted, true);
      assert.equal(after.problem, null);
    } finally {
      startWorker();
    }
  });

  test('layers: deleting everything also clears the extracted info and cancels the obligations', async () => {
    const doc = (await upload(users.c, { name: 'xoa-het.txt', data: text() })).body.document;
    assert.equal((await parsed(users.c, doc.id)).status, 'SUCCEEDED');
    const version = await db.documentVersion.findFirstOrThrow({ where: { documentId: doc.id } });
    const metadata = await db.extractedMetadata.create({ data: {
      userId: users.c.id, documentId: doc.id, versionId: version.id, modelId: 'test', promptVersion: 'p1', schemaVersion: 1,
      status: 'CONFIRMED', summary: 'Tóm tắt.', fields: { rent: '8000000' }, confirmedFields: { rent: '8000000' }, confirmedAt: new Date(),
      evidence: { rent: { quote: 'tiền thuê', charStart: 0, charEnd: 9 } },
    } });
    const obligation = await db.obligation.create({ data: {
      userId: users.c.id, documentId: doc.id, versionId: version.id, metadataId: metadata.id, sourceKey: 'rent.monthly', title: 'Tiền thuê nhà',
    } });
    assert.equal((await request(`/api/documents/${doc.id}`, { method: 'DELETE', token: users.c.token })).status, 204);
    const cleared = await db.extractedMetadata.findUniqueOrThrow({ where: { id: metadata.id } });
    assert.deepEqual(cleared.fields, {});
    assert.deepEqual(cleared.evidence, {});
    assert.equal(cleared.confirmedFields, null);
    assert.equal(cleared.summary, null);
    assert.equal((await db.obligation.findUniqueOrThrow({ where: { id: obligation.id } })).status, 'CANCELLED');
  });

  test('B5: a document deleted while its parse job waits is never parsed back', async () => {
    const doc = (await upload(users.a, { name: 'xoa-khi-dang-doc.txt', data: text() })).body.document;
    assert.equal((await request(`/api/documents/${doc.id}`, { method: 'DELETE', token: users.a.token })).status, 204);
    const jobs = await db.aIJob.findMany({ where: { documentId: doc.id, kind: 'PARSE' } });
    assert.ok(jobs.length > 0);
    for (const job of jobs) assert.ok(['CANCELLED', 'SUCCEEDED'].includes(job.status), `parse job is ${job.status}`);
    for (const copy of await copiesOf(doc.id)) await eventually(copyDeleted(copy.id), 'the temporary copy should be deleted');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(await db.documentChunk.count({ where: { documentId: doc.id } }), 0);
  });

  test('DOCX preview: level 3 owners get escaped HTML under a sandbox policy; other files, levels and users get 404', async () => {
    const docx = (await upload(users.c, { name: 'xem-truoc.docx', data: docxWith(['Hợp đồng thuê nhà', '&lt;script&gt;alert(1)&lt;/script&gt;', randomUUID()]) })).body.document;
    const preview = await request(`/api/documents/${docx.id}/preview`, { token: users.c.token });
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get('content-type'), /^text\/html; charset=utf-8/);
    assert.match(preview.headers.get('content-security-policy'), /default-src 'none'.*sandbox/);
    assert.equal(preview.headers.get('cache-control'), 'private, no-store');
    const html = preview.raw.toString('utf8');
    assert.ok(html.includes('<p>Hợp đồng thuê nhà</p>'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.doesNotMatch(html, /<script/);
    assert.equal((await request(`/api/documents/${docx.id}/preview`, { token: users.a.token })).status, 404, 'other users');
    const txt = (await upload(users.c, { name: 'khong-phai-docx.txt', data: text() })).body.document;
    assert.equal((await request(`/api/documents/${txt.id}/preview`, { token: users.c.token })).status, 404, 'only DOCX');
    const level2 = (await upload(users.a, { name: 'muc-2.docx', data: docxWith(['Mức 2', randomUUID()]) })).body.document;
    assert.equal((await request(`/api/documents/${level2.id}/preview`, { token: users.a.token })).status, 404, 'no original below level 3');
    const broken = (await upload(users.c, { name: 'hong.docx', data: brokenDocx() })).body.document;
    assert.equal((await request(`/api/documents/${broken.id}/preview`, { token: users.c.token })).status, 422);
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

  test('B5 filters: by file type and reading status, combined, paginated and only for the owner', async () => {
    const user = await createUser('filters', 'ENCRYPTED_COPY');
    const ids = {};
    for (const [key, file] of [
      ['pdf', { name: 'doc.pdf', data: textPdf([[`Hop dong ${randomUUID()}`]]) }],
      ['docx', { name: 'doc.docx', data: docxWith([`Hợp đồng ${randomUUID()}`]) }],
      ['txt', { name: 'doc.txt', data: text() }],
      ['broken', { name: 'hong.pdf', data: pdf(4096) }],
    ]) {
      ids[key] = (await upload(user, file)).body.document.id;
      await delay(5);
    }
    for (const id of Object.values(ids)) await parsed(user, id, 30_000);
    assert.equal((await request(`/api/documents/${ids.txt}/details`, { method: 'DELETE', token: user.token })).status, 202);
    const list = async (query) => {
      const response = await request(`/api/documents?${query}`, { token: user.token });
      assert.equal(response.status, 200, query);
      return response.body.items.map((item) => item.id);
    };
    assert.deepEqual(await list('type=pdf'), [ids.broken, ids.pdf]);
    assert.deepEqual(await list('type=docx'), [ids.docx]);
    assert.deepEqual(await list('type=txt'), [ids.txt]);
    assert.deepEqual(await list('status=read'), [ids.docx, ids.pdf]);
    assert.deepEqual(await list('status=problem'), [ids.broken]);
    assert.deepEqual(await list('status=details-deleted'), [ids.txt]);
    assert.deepEqual(await list('status=processing'), []);
    assert.deepEqual(await list('type=pdf&status=read'), [ids.pdf]);
    assert.deepEqual(await list('type=txt&status=read'), [], 'a deleted-details document is not "read"');
    const first = await request('/api/documents?type=pdf&limit=1', { token: user.token });
    assert.deepEqual(first.body.items.map((item) => item.id), [ids.broken]);
    assert.equal(typeof first.body.nextCursor, 'string');
    assert.deepEqual(await list(`type=pdf&limit=1&cursor=${first.body.nextCursor}`), [ids.pdf], 'the cursor keeps the filter');
    for (const query of ['type=png', 'status=done', 'type=PDF']) {
      const response = await request(`/api/documents?${query}`, { token: user.token });
      assert.equal(response.status, 400, query);
      assert.ok(response.body.fieldErrors?.[query.split('=')[0]], query);
    }
    const stopped = (await upload(user, { name: 'dung-doc.txt', data: text() })).body.document.id;
    assert.equal((await request(`/api/documents/${stopped}/details`, { method: 'DELETE', token: user.token })).status, 202);
    assert.deepEqual(await list('status=details-deleted'), [stopped, ids.txt]);
    assert.deepEqual(await list('status=problem'), [ids.broken], 'details deleted before the file was read are not a reading problem');
    assert.deepEqual(await list('status=read'), [ids.docx, ids.pdf]);
    const waiting = await db.document.create({ data: { userId: user.id, title: 'Đang chờ', source: 'WEB_UPLOAD' } });
    await db.documentVersion.create({ data: {
      userId: user.id, documentId: waiting.id, number: 1, sha256: sha256(randomUUID()), byteSize: 1n, mimeType: 'text/plain', originalFilename: 'cho.txt', source: 'WEB_UPLOAD',
    } });
    assert.deepEqual(await list('status=processing'), [waiting.id]);
    assert.deepEqual(await list('status=processing&type=txt'), [waiting.id]);
    assert.deepEqual(await list('status=processing&type=pdf'), []);
    assert.equal((await request(`/api/documents/${ids.pdf}`, { method: 'DELETE', token: user.token })).status, 204);
    assert.deepEqual(await list('type=pdf'), [ids.broken], 'a deleted document leaves every filtered list');
    assert.deepEqual(await list('status=read'), [ids.docx]);
    const others = await request('/api/documents?type=pdf&limit=50', { token: users.b.token });
    assert.equal(others.body.items.some((item) => Object.values(ids).includes(item.id)), false);
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
