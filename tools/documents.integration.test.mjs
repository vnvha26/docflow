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
      const document = await db.document.create({ data: { userId: user.id, title: `Đang tải ${randomUUID()}`, source: 'WEB_UPLOAD' } });
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
    await db.document.update({ where: { id: doc.id }, data: { privacyLevel: 'STRUCTURED_ONLY' } });
    const [original] = await copiesOf(doc.id);
    await db.fileCopy.update({ where: { id: original.id }, data: { state: 'DELETE_PENDING', deleteRequestedAt: new Date() } });
    await eventually(copyDeleted(original.id), 'the original is removed when the document goes to level 1');
    await db.documentVersion.updateMany({ where: { documentId: doc.id }, data: { parseState: 'FAILED', parseErrorCode: 'SOURCE_UNAVAILABLE' } });
    const before = (await request('/api/documents/usage', { token: user.token })).body.encryptedBytes;
    const again = await upload(user, { name: 'muc-rieng.txt', data: content });
    assert.equal(again.status, 201);
    assert.equal(again.body.document.id, doc.id);
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
    assert.match(refused.body.fieldErrors.file, /thùng rác/, 'the hint points at the trash, where deleted files still count');
    assert.equal((await request(`/api/documents/${accepted.body.document.id}`, { method: 'DELETE', token: users.d.token })).status, 204);
    assert.equal((await upload(users.d, { name: 'b.pdf', data: pdf(600 * 1024) })).status, 413, 'a file in the trash still uses its space');
    const binned = (await request('/api/trash', { token: users.d.token })).body.items.find((entry) => entry.documentId === accepted.body.document.id);
    assert.equal((await request(`/api/trash/${binned.id}/restore`, { method: 'POST', token: users.d.token })).status, 200);
    assert.equal(await documentCount(users.d), before);
    assert.equal((await upload(users.d, { name: 'small.txt', data: text() })).status, 201);
    const level2 = await request('/api/documents/usage', { token: users.a.token });
    assert.equal(level2.body.encryptedBytes, 0, 'temporary copies do not use the level-3 quota');
  });

  const trashOf = async (user) => (await request('/api/trash', { token: user.token })).body.items;
  const trashItem = async (user, kind, name) => {
    const item = (await trashOf(user)).find((entry) => entry.kind === kind && entry.name === name);
    assert.ok(item, `${kind} "${name}" should be in the trash`);
    return item;
  };
  const gone = (documentId) => async () => (await db.document.count({ where: { id: documentId } })) === 0;

  test('trash: a deleted document leaves every list but keeps everything, and restoring brings it back intact', async () => {
    const body = text();
    const doc = (await upload(users.c, { name: 'vao-thung-rac.txt', data: body })).body.document;
    assert.equal((await parsed(users.c, doc.id)).status, 'SUCCEEDED');
    const version = await db.documentVersion.findFirstOrThrow({ where: { documentId: doc.id } });
    const [copy] = await copiesOf(doc.id);
    const chunks = await db.documentChunk.count({ where: { documentId: doc.id } });
    assert.ok(chunks > 0);
    const metadata = await db.extractedMetadata.create({ data: {
      userId: users.c.id, documentId: doc.id, versionId: version.id, modelId: 'test', promptVersion: 'p1', schemaVersion: 1,
      summary: 'Hợp đồng thuê nhà.', fields: { deposit: '16000000' }, evidence: { deposit: { quote: 'tiền cọc', charStart: 0, charEnd: 8 } },
    } });
    const obligation = await db.obligation.create({ data: {
      userId: users.c.id, documentId: doc.id, versionId: version.id, metadataId: metadata.id, sourceKey: 'rent.monthly', title: 'Tiền thuê nhà',
    } });
    const usage = (await request('/api/documents/usage', { token: users.c.token })).body.encryptedBytes;

    assert.equal((await request(`/api/documents/${doc.id}`, { method: 'DELETE', token: users.a.token })).status, 404, 'other users cannot delete it');
    assert.equal((await request(`/api/documents/${doc.id}`, { method: 'DELETE', token: users.c.token, requestOrigin: 'https://evil.example' })).status, 403);
    assert.equal((await request(`/api/documents/${doc.id}`, { method: 'DELETE', token: users.c.token })).status, 204);
    for (const [path, method, payload] of [['', 'GET'], ['/original', 'GET'], ['/preview', 'GET'], ['', 'DELETE'], ['/original', 'DELETE'], ['', 'PATCH', { title: 'Sống lại' }]]) {
      assert.equal((await request(`/api/documents/${doc.id}${path}`, { method, token: users.c.token, body: payload })).status, 404, `${method} ${path || '/'} is locked`);
    }
    assert.equal((await request('/api/documents?limit=50', { token: users.c.token })).body.items.some((item) => item.id === doc.id), false);
    assert.equal((await request('/api/documents/usage', { token: users.c.token })).body.encryptedBytes, usage, 'the trash still counts against the quota');
    assert.equal((await db.fileCopy.findUniqueOrThrow({ where: { id: copy.id } })).state, 'AVAILABLE');
    assert.equal(await db.documentChunk.count({ where: { documentId: doc.id } }), chunks, 'text is kept for a restore');
    await assert.rejects(db.documentChunk.create({ data: {
      userId: users.c.id, documentId: doc.id, versionId: version.id, ordinal: 999, content: 'trong thùng rác', charStart: 0, charEnd: 15, chunkerVersion: 'c1',
    } }), /text cannot be stored/, 'nothing is processed while in the trash');

    const item = await trashItem(users.c, 'DOCUMENT', 'vao-thung-rac');
    assertPrivate(item);
    assert.equal(item.location, null);
    const days = (new Date(item.expiresAt) - new Date(item.deletedAt)) / 86_400_000;
    assert.ok(Math.abs(days - 30) < 0.01, `kept 30 days, got ${days}`);
    assert.equal((await trashOf(users.a)).some((entry) => entry.id === item.id), false, 'the trash is per user');
    assert.equal((await request(`/api/trash/${item.id}/restore`, { method: 'POST', token: users.a.token })).status, 404);
    assert.equal((await request(`/api/trash/${item.id}`, { method: 'DELETE', token: users.a.token })).status, 404);
    assert.equal((await request('/api/trash')).status, 401);
    assert.equal((await request(`/api/trash/${item.id}/restore`, { method: 'POST', token: users.c.token, requestOrigin: 'https://evil.example' })).status, 403);

    const again = await upload(users.c, { name: 'vao-thung-rac.txt', data: body });
    assert.equal(again.status, 201, 'the same file uploads as a new document while the old one is in the trash');
    assert.notEqual(again.body.document.id, doc.id);

    const restored = await request(`/api/trash/${item.id}/restore`, { method: 'POST', token: users.c.token });
    assert.equal(restored.status, 200);
    assert.deepEqual([restored.body.kind, restored.body.name, restored.body.renamed, restored.body.moved], ['DOCUMENT', 'vao-thung-rac (2)', true, false], 'its old name was taken meanwhile');
    assert.equal((await request(`/api/trash/${item.id}/restore`, { method: 'POST', token: users.c.token })).status, 404);
    assert.equal((await trashOf(users.c)).some((entry) => entry.id === item.id), false);
    const back = (await request(`/api/documents/${doc.id}`, { token: users.c.token })).body;
    assert.deepEqual([back.title, back.status, back.originalAvailable, back.summary], ['vao-thung-rac (2)', 'SUCCEEDED', true, 'Hợp đồng thuê nhà.']);
    assert.equal(sha256((await request(`/api/documents/${doc.id}/original`, { token: users.c.token })).raw), sha256(body));
    assert.equal(await db.documentChunk.count({ where: { documentId: doc.id } }), chunks);
    assert.deepEqual((await db.extractedMetadata.findUniqueOrThrow({ where: { id: metadata.id } })).fields, { deposit: '16000000' });
    assert.equal((await db.obligation.findUniqueOrThrow({ where: { id: obligation.id } })).status, 'ACTIVE');
  });

  test('trash: a deleted original cannot be opened but restores at once; purging it keeps the document without file or text', async () => {
    const body = text();
    const doc = (await upload(users.c, { name: 'ban-goc.txt', data: body })).body.document;
    const remove = (token = users.c.token) => request(`/api/documents/${doc.id}/original`, { method: 'DELETE', token });
    await db.documentVersion.updateMany({ where: { documentId: doc.id, parseState: { in: ['PENDING', 'PROCESSING'] } }, data: { parseState: 'PROCESSING' } });
    const early = await remove();
    if ((await db.documentVersion.findFirstOrThrow({ where: { documentId: doc.id } })).parseState === 'PROCESSING') {
      assert.equal(early.status, 409, 'the original stays until the document is processed');
      await db.documentVersion.updateMany({ where: { documentId: doc.id, parseState: 'PROCESSING' }, data: { parseState: 'PENDING' } });
    }
    assert.equal((await parsed(users.c, doc.id, 30_000)).status, 'SUCCEEDED');
    if (early.status === 202) await request(`/api/trash/${(await trashItem(users.c, 'ORIGINAL', 'ban-goc')).id}/restore`, { method: 'POST', token: users.c.token });
    const version = await db.documentVersion.findFirstOrThrow({ where: { documentId: doc.id } });
    await db.extractedMetadata.create({ data: {
      userId: users.c.id, documentId: doc.id, versionId: version.id, modelId: 'test', promptVersion: 'p1', schemaVersion: 1,
      summary: 'Tóm tắt còn lại.', fields: { rent: '8000000' },
    } });
    const [copy] = await copiesOf(doc.id);
    const chunks = await db.documentChunk.count({ where: { documentId: doc.id } });
    const usage = (await request('/api/documents/usage', { token: users.c.token })).body.encryptedBytes;

    assert.equal((await remove(users.a.token)).status, 404, 'other users cannot delete it');
    const removed = await remove();
    assert.equal(removed.status, 202);
    assert.deepEqual([removed.body.originalAvailable, removed.body.originalInTrash, removed.body.summary], [false, true, 'Tóm tắt còn lại.']);
    assert.ok(new Date(removed.body.updatedAt) > new Date(doc.updatedAt));
    assert.equal((await request(`/api/documents/${doc.id}/original`, { token: users.c.token })).status, 404);
    assert.equal((await remove()).status, 404, 'it is already in the trash');
    assert.equal((await request('/api/documents/usage', { token: users.c.token })).body.encryptedBytes, usage, 'still counted until purged');
    assert.equal((await request(`/api/documents/${doc.id}`, { token: users.c.token })).status, 200, 'the document itself stays');

    const item = await trashItem(users.c, 'ORIGINAL', 'ban-goc');
    const restored = await request(`/api/trash/${item.id}/restore`, { method: 'POST', token: users.c.token });
    assert.deepEqual([restored.status, restored.body.kind, restored.body.name], [200, 'ORIGINAL', 'ban-goc']);
    assert.equal(sha256((await request(`/api/documents/${doc.id}/original`, { token: users.c.token })).raw), sha256(body), 'the file is back without re-uploading');
    assert.equal(await db.documentChunk.count({ where: { documentId: doc.id } }), chunks, 'and so is the text, without re-reading');

    assert.equal((await remove()).status, 202);
    const second = await trashItem(users.c, 'ORIGINAL', 'ban-goc');
    assert.equal((await request(`/api/trash/${second.id}`, { method: 'DELETE', token: users.c.token })).status, 204);
    assert.equal((await request(`/api/trash/${second.id}/restore`, { method: 'POST', token: users.c.token })).status, 404, 'a purged original cannot come back');
    assert.equal((await request('/api/documents/usage', { token: users.c.token })).body.encryptedBytes, usage - Number(copy.byteSize), 'quota is freed at once');
    assert.equal(await db.documentChunk.count({ where: { documentId: doc.id } }), 0, 'the full text goes with the original');
    await eventually(copyDeleted(copy.id), 'the worker should delete the blob');
    assert.equal(await objectExists(copy.storageKey), false);
    const after = (await request(`/api/documents/${doc.id}`, { token: users.c.token })).body;
    assert.deepEqual([after.originalAvailable, after.originalInTrash, after.summary, after.title], [false, false, 'Tóm tắt còn lại.', 'ban-goc']);
    assert.deepEqual((await db.extractedMetadata.findFirstOrThrow({ where: { documentId: doc.id } })).fields, { rent: '8000000' }, 'extracted info stays');
    assert.equal((await remove()).status, 404);
  });

  test('trash: a folder goes in as one item and comes back with exactly what went in with it; earlier deletes stay in the trash, like Windows', async () => {
    const user = await createUser('trash-folders', 'ENCRYPTED_COPY');
    const folder = async (name, parentId = null) => (await request('/api/folders', { method: 'POST', token: user.token, body: { name, parentId } })).body.folder.id;
    const put = async (folderId, name) => {
      const form = new FormData();
      form.append('file', new Blob([text()], { type: 'text/plain' }), name);
      if (folderId) form.append('folderId', folderId);
      const response = await request('/api/documents', { method: 'POST', token: user.token, form });
      assert.equal(response.status, 201, name);
      return response.body.document.id;
    };
    const home = await folder('Nhà');
    const bills = await folder('Hóa đơn', home);
    const y2026 = await folder('2026', bills);
    const old = await folder('Cũ', home);
    const docs = { contract: await put(home, 'Hợp đồng.txt'), power: await put(bills, 'Điện.txt'), water: await put(y2026, 'Nước.txt'), junk: await put(bills, 'Nháp.txt'), loose: await put(null, 'Ngoài.txt') };
    for (const id of Object.values(docs)) await parsed(user, id, 30_000);

    assert.equal((await request(`/api/documents/${docs.junk}`, { method: 'DELETE', token: user.token })).status, 204);
    assert.equal((await request(`/api/documents/${docs.power}/original`, { method: 'DELETE', token: user.token })).status, 202);
    assert.deepEqual((await request(`/api/folders/${old}`, { method: 'DELETE', token: user.token })).body, { documentCount: 0, folderCount: 0 });
    assert.equal((await trashItem(user, 'DOCUMENT', 'Nháp')).location, 'Nhà › Hóa đơn');

    assert.equal((await request(`/api/folders/${home}`, { method: 'DELETE', token: users.a.token })).status, 404, 'other users cannot delete it');
    assert.equal((await request(`/api/folders/${home}`, { method: 'DELETE', token: user.token, requestOrigin: 'https://evil.example' })).status, 403);
    const removed = await request(`/api/folders/${home}`, { method: 'DELETE', token: user.token });
    assert.deepEqual([removed.status, removed.body], [200, { documentCount: 3, folderCount: 2 }], 'counts what was still live inside');
    assert.equal((await request(`/api/folders/${home}`, { method: 'DELETE', token: user.token })).status, 404);
    const item = await trashItem(user, 'FOLDER', 'Nhà');
    assert.deepEqual([item.documentCount, item.folderCount, item.location], [3, 2, null]);

    const tree = (await request('/api/folders', { token: user.token })).body;
    assert.deepEqual([tree.folders.length, tree.totalCount, tree.unfiledCount], [0, 1, 1]);
    assert.deepEqual((await request('/api/documents?limit=50', { token: user.token })).body.items.map((entry) => entry.id), [docs.loose]);
    assert.equal((await request(`/api/documents/${docs.contract}`, { token: user.token })).status, 404);
    for (const [path, method, payload] of [[`/api/folders/${bills}`, 'PATCH', { name: 'Đổi' }], ['/api/folders', 'POST', { name: 'Con', parentId: home }], [`/api/documents/${docs.loose}`, 'PATCH', { folderId: bills }]]) {
      assert.equal((await request(path, { method, token: user.token, body: payload })).status, 404, `${method} ${path} must not reach into the trash`);
    }
    const form = new FormData();
    form.append('file', new Blob([text()], { type: 'text/plain' }), 'vao-thu-muc-da-xoa.txt');
    form.append('folderId', home);
    assert.equal((await request('/api/documents', { method: 'POST', token: user.token, form })).status, 404);
    await assert.rejects(db.document.update({ where: { id: docs.loose }, data: { folderId: home } }), /deleted folder/);

    const twin = await folder('nhà');
    assert.equal((await request('/api/folders', { token: user.token })).body.folders[0].name, 'nhà', 'the name of a deleted folder is free');

    const child = await trashItem(user, 'DOCUMENT', 'Nháp');
    const lifted = await request(`/api/trash/${child.id}/restore`, { method: 'POST', token: user.token });
    assert.deepEqual([lifted.status, lifted.body.moved, lifted.body.folderId, lifted.body.location], [200, true, null, null], 'its folder is in the trash, so it lands outside');
    assert.equal((await request(`/api/documents/${docs.junk}`, { token: user.token })).body.folderId, null);

    const restored = await request(`/api/trash/${item.id}/restore`, { method: 'POST', token: user.token });
    assert.deepEqual([restored.status, restored.body.kind, restored.body.name, restored.body.renamed, restored.body.moved], [200, 'FOLDER', 'Nhà (2)', true, false]);
    const after = (await request('/api/folders', { token: user.token })).body;
    const byId = Object.fromEntries(after.folders.map((entry) => [entry.id, entry]));
    assert.deepEqual([byId[home].name, byId[home].parentId, byId[bills].parentId, byId[y2026].parentId], ['Nhà (2)', null, home, bills], 'the tree deleted with the folder is back');
    assert.equal(byId[old], undefined, 'a subfolder deleted before the folder stays in the trash');
    assert.deepEqual([byId[home].documentCount, byId[bills].documentCount, byId[y2026].documentCount, byId[twin].documentCount], [1, 1, 1, 0]);
    const power = (await request(`/api/documents/${docs.power}`, { token: user.token })).body;
    assert.deepEqual([power.folderId, power.originalAvailable, power.originalInTrash], [bills, false, true], 'an original deleted before stays in the trash');
    assert.deepEqual((await trashOf(user)).map((entry) => `${entry.kind}:${entry.name}`).sort(), ['FOLDER:Cũ', 'ORIGINAL:Điện'], 'each earlier delete keeps its own trash item');
    assert.equal((await request(`/api/documents/${docs.water}/original`, { token: user.token })).status, 200);

    const subfolder = await request(`/api/trash/${(await trashItem(user, 'FOLDER', 'Cũ')).id}/restore`, { method: 'POST', token: user.token });
    assert.deepEqual([subfolder.status, subfolder.body.moved, subfolder.body.folderId, subfolder.body.location], [200, false, old, 'Nhà (2)'], 'restored on its own, it goes back into its folder');
    const original = await request(`/api/trash/${(await trashItem(user, 'ORIGINAL', 'Điện')).id}/restore`, { method: 'POST', token: user.token });
    assert.equal(original.status, 200);
    assert.equal((await request(`/api/documents/${docs.power}`, { token: user.token })).body.originalAvailable, true);
    assert.deepEqual(await trashOf(user), []);

    const box = await folder('Tạm');
    const note = await put(box, 'Ghi chú.txt');
    const memo = await put(box, 'Bản nháp.txt');
    for (const id of [note, memo]) await parsed(user, id, 30_000);
    assert.equal((await request(`/api/documents/${note}`, { method: 'DELETE', token: user.token })).status, 204);
    assert.deepEqual((await request(`/api/folders/${box}`, { method: 'DELETE', token: user.token })).body, { documentCount: 1, folderCount: 0 });
    const undo = await request(`/api/trash/${(await trashItem(user, 'FOLDER', 'Tạm')).id}/restore`, { method: 'POST', token: user.token });
    assert.equal(undo.status, 200, 'undo is a restore of the item just created');
    assert.equal((await request(`/api/documents/${memo}`, { token: user.token })).body.folderId, box);
    assert.equal((await request(`/api/documents/${note}`, { token: user.token })).status, 404, 'undoing the folder delete does not bring back the note deleted before');
    assert.deepEqual((await trashOf(user)).map((entry) => `${entry.kind}:${entry.name}`), ['DOCUMENT:Ghi chú']);

    assert.equal((await request(`/api/folders/${box}`, { method: 'DELETE', token: user.token })).status, 200);
    assert.equal((await request(`/api/trash/${(await trashItem(user, 'FOLDER', 'Tạm')).id}`, { method: 'DELETE', token: user.token })).status, 204);
    await eventually(gone(memo), 'purging the folder removes what went in with it');
    const orphan = await request(`/api/trash/${(await trashItem(user, 'DOCUMENT', 'Ghi chú')).id}/restore`, { method: 'POST', token: user.token });
    assert.deepEqual([orphan.status, orphan.body.moved, orphan.body.folderId], [200, true, null], 'a document deleted before survives the purge of its folder and lands at the nearest live level');
    assert.equal((await request(`/api/documents/${note}`, { token: user.token })).body.folderId, null);
    await eventually(async () => (await db.folder.count({ where: { id: box } })) === 0, 'the purged folder row goes once nothing points into it');
  });

  test('trash: permanent delete removes every row and stored file; expired items and "empty trash" go the same way', async () => {
    const user = await createUser('trash-purge', 'ENCRYPTED_COPY');
    const body = text();
    const first = (await upload(user, { name: 'xoa-han.txt', data: body })).body.document;
    assert.equal((await parsed(user, first.id)).status, 'SUCCEEDED');
    const version = await db.documentVersion.findFirstOrThrow({ where: { documentId: first.id } });
    const [copy] = await copiesOf(first.id);
    const metadata = await db.extractedMetadata.create({ data: {
      userId: user.id, documentId: first.id, versionId: version.id, modelId: 'test', promptVersion: 'p1', schemaVersion: 1,
      status: 'CONFIRMED', summary: 'Tóm tắt.', fields: { rent: '8000000' }, confirmedFields: { rent: '8000000' }, confirmedAt: new Date(),
    } });
    const obligation = await db.obligation.create({ data: {
      userId: user.id, documentId: first.id, versionId: version.id, metadataId: metadata.id, sourceKey: 'rent.monthly', title: 'Tiền thuê nhà',
    } });
    assert.equal((await request(`/api/documents/${first.id}`, { method: 'DELETE', token: user.token })).status, 204);
    const item = await trashItem(user, 'DOCUMENT', 'xoa-han');
    assert.equal((await request(`/api/trash/${item.id}`, { method: 'DELETE', token: user.token, requestOrigin: 'https://evil.example' })).status, 403);
    assert.equal((await request(`/api/trash/${item.id}`, { method: 'DELETE', token: user.token })).status, 204);
    assert.equal((await request(`/api/trash/${item.id}/restore`, { method: 'POST', token: user.token })).status, 404, 'permanent means permanent');
    assert.equal((await request('/api/documents/usage', { token: user.token })).body.encryptedBytes, 0, 'quota is freed at once');
    assert.equal(await db.documentChunk.count({ where: { documentId: first.id } }), 0);
    await db.document.update({ where: { id: first.id }, data: { deletedAt: null } }).then(() => assert.fail('a purged document must not be restorable'), (error) => assert.match(String(error), /permanently deleted|P2025|not found/i));
    await eventually(gone(first.id), 'the document row should be deleted once its file is gone');
    assert.equal(await objectExists(copy.storageKey), false);
    assert.deepEqual([
      await db.fileCopy.count({ where: { id: copy.id } }), await db.documentVersion.count({ where: { sha256: sha256(body), userId: user.id } }),
      await db.extractedMetadata.count({ where: { id: metadata.id } }), await db.obligation.count({ where: { id: obligation.id } }),
      await db.aIJob.count({ where: { documentId: first.id } }),
    ], [0, 0, 0, 0, 0], 'no copy, hash, extracted data, obligation or job is left');
    const again = await upload(user, { name: 'xoa-han.txt', data: body });
    assert.deepEqual([again.status, again.body.duplicate, again.body.document.title], [201, false, 'xoa-han'], 'the file is unknown again');

    assert.equal((await request(`/api/documents/${again.body.document.id}`, { method: 'DELETE', token: user.token })).status, 204);
    const expiring = await trashItem(user, 'DOCUMENT', 'xoa-han');
    await db.trashItem.update({ where: { id: expiring.id }, data: { deletedAt: new Date(Date.now() - 31 * 86_400_000), expiresAt: new Date(Date.now() - 86_400_000) } });
    await eventually(gone(again.body.document.id), 'the worker should purge an item older than 30 days');
    assert.deepEqual(await trashOf(user), []);

    const box = (await request('/api/folders', { method: 'POST', token: user.token, body: { name: 'Hộp' } })).body.folder.id;
    const inner = (await request('/api/folders', { method: 'POST', token: user.token, body: { name: 'Trong', parentId: box } })).body.folder.id;
    const form = new FormData();
    form.append('file', new Blob([text()], { type: 'text/plain' }), 'trong-hop.txt');
    form.append('folderId', inner);
    const inside = (await request('/api/documents', { method: 'POST', token: user.token, form })).body.document.id;
    const outside = (await upload(user, { name: 'ngoai-hop.txt', data: text() })).body.document.id;
    const kept = (await upload(user, { name: 'giu-lai.txt', data: text() })).body.document.id;
    for (const id of [inside, outside, kept]) await parsed(user, id);
    assert.equal((await request(`/api/documents/${inside}`, { method: 'DELETE', token: user.token })).status, 204);
    assert.equal((await request(`/api/folders/${box}`, { method: 'DELETE', token: user.token })).status, 200);
    assert.equal((await request(`/api/documents/${outside}`, { method: 'DELETE', token: user.token })).status, 204);
    assert.equal((await request(`/api/documents/${kept}/original`, { method: 'DELETE', token: user.token })).status, 202);
    assert.equal((await trashOf(user)).length, 4);
    assert.equal((await request('/api/trash', { method: 'DELETE', token: users.a.token })).body.purged, 0, 'emptying is per user');
    const emptied = await request('/api/trash', { method: 'DELETE', token: user.token });
    assert.equal(emptied.status, 200);
    assert.ok(emptied.body.purged >= 3, `purged ${emptied.body.purged}`);
    assert.deepEqual(await trashOf(user), []);
    await eventually(async () => (await db.folder.count({ where: { userId: user.id } })) === 0 && (await db.document.count({ where: { userId: user.id } })) === 1,
      'folders, the documents inside and the deleted document should all be removed');
    const survivor = (await request(`/api/documents/${kept}`, { token: user.token })).body;
    assert.deepEqual([survivor.originalAvailable, survivor.originalInTrash], [false, false]);
    assert.equal(await db.fileCopy.count({ where: { userId: user.id, state: { not: 'DELETED' } } }), 0);
    assert.equal((await request('/api/documents/usage', { token: user.token })).body.encryptedBytes, 0);
  });

  test('trash: a job cancelled just after the worker checked its lease never leaves the document "being read"', async () => {
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
          assert.equal((await request(`/api/documents/${doc.id}`, { method: 'DELETE', token: users.c.token })).status, 204);
          return held;
        },
        holds: (...args) => queue.holds(...args),
      };
      const parser = new ParseService(db, null, null, new RetentionService(db, null), jobs);
      await assert.rejects(parser.handle(job), /LEASE_LOST/);
      const version = await db.documentVersion.findFirstOrThrow({ where: { documentId: doc.id } });
      assert.equal(version.parseState, 'PENDING', 'the cancelled job must not mark the version as being read');
      assert.equal((await db.aIJob.findUniqueOrThrow({ where: { id: job.id } })).status, 'CANCELLED');
      users.c.waiting = doc.id;
    } finally {
      startWorker();
    }
  });

  test('trash: a document deleted before it was read is not read in the trash, and is read once restored', async () => {
    const id = users.c.waiting;
    await delay(1_200);
    assert.equal(await db.documentChunk.count({ where: { documentId: id } }), 0, 'nothing is read while in the trash');
    assert.equal((await db.documentVersion.findFirstOrThrow({ where: { documentId: id } })).parseState, 'PENDING');
    const item = await trashItem(users.c, 'DOCUMENT', 'xoa-luc-bat-dau-doc');
    assert.equal((await request(`/api/trash/${item.id}/restore`, { method: 'POST', token: users.c.token })).status, 200);
    assert.equal((await parsed(users.c, id, 30_000)).status, 'SUCCEEDED', 'reading resumes after the restore');
    assert.ok(await db.documentChunk.count({ where: { documentId: id } }) > 0);
  });

  test('duplicates: the server is asked first by hash, and an upload carries the choice: new, supplement the original, or nothing', async () => {
    const user = await createUser('duplicates', 'ENCRYPTED_COPY');
    users.dup = user;
    const folder = async (name) => (await request('/api/folders', { method: 'POST', token: user.token, body: { name } })).body.folder.id;
    const here = await folder('Hợp đồng');
    const there = await folder('Khác');
    const body = text();
    const hash = sha256(body);
    const check = async (folderId, token = user.token, extra = {}) => request('/api/documents/check', { method: 'POST', token, body: { sha256: hash, size: body.length, folderId, ...extra } });
    const put = async (folderId, fields = {}, name = 'thue-nha.txt') => {
      const form = new FormData();
      form.append('file', new Blob([body], { type: 'text/plain' }), name);
      if (folderId) form.append('folderId', folderId);
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
      return request('/api/documents', { method: 'POST', token: user.token, form });
    };
    const count = () => db.document.count({ where: { userId: user.id } });
    const dropOriginal = async (documentId, purge) => {
      assert.equal((await request(`/api/documents/${documentId}/original`, { method: 'DELETE', token: user.token })).status, 202);
      const item = (await trashOf(user)).find((entry) => entry.kind === 'ORIGINAL' && entry.documentId === documentId);
      if (purge) assert.equal((await request(`/api/trash/${item.id}`, { method: 'DELETE', token: user.token })).status, 204);
      return item;
    };

    assert.equal((await request('/api/documents/check', { method: 'POST', body: { sha256: hash, size: 1 } })).status, 401);
    for (const [bad, field] of [[{ sha256: 'xyz' }, 'sha256'], [{ sha256: hash.toUpperCase() }, 'sha256'], [{ size: 0 }, 'size'], [{ size: 51 * MiB }, 'size'], [{ folderId: 'root' }, 'folderId']]) {
      const response = await check(null, user.token, bad);
      assert.equal(response.status, 400, JSON.stringify(bad));
      assert.ok(response.body.fieldErrors?.[field], JSON.stringify(bad));
    }
    assert.deepEqual((await check(here)).body, { situation: 'new', primary: null, matches: [], options: [] });

    const first = await put(here);
    assert.deepEqual([first.status, first.body.duplicate, first.body.supplemented, first.body.document.title], [201, false, false, 'thue-nha']);
    const doc = first.body.document.id;
    assert.equal((await parsed(user, doc)).status, 'SUCCEEDED');
    const version = await db.documentVersion.findFirstOrThrow({ where: { documentId: doc } });
    await db.extractedMetadata.create({ data: {
      userId: user.id, documentId: doc, versionId: version.id, modelId: 'test', promptVersion: 'p1', schemaVersion: 1, summary: 'Tóm tắt giữ nguyên.', fields: { rent: '8000000' },
    } });

    const same = (await check(here)).body;
    assertPrivate(same);
    assert.deepEqual([same.situation, same.options, same.matches.length], ['ask', ['new', 'skip'], 1]);
    assert.deepEqual(same.primary, { documentId: doc, title: 'thue-nha', folderId: here, location: 'Hợp đồng', state: 'full', sameFolder: true, trashId: null, trashFolder: null });
    const elsewhere = (await check(there)).body;
    assert.deepEqual([elsewhere.situation, elsewhere.primary.sameFolder, elsewhere.primary.location, elsewhere.options], ['ask', false, 'Hợp đồng', ['new', 'skip']]);
    assert.equal((await check(null, users.a.token)).body.situation, 'new', 'another user never learns the file exists');
    assert.equal((await check(here, user.token, { size: body.length + 1 })).body.situation, 'new', 'the size must match too');

    const before = await count();
    const blind = await put(there);
    assert.deepEqual([blind.status, blind.body.duplicate, blind.body.document.id, blind.body.conflict.situation, blind.body.conflict.options], [200, true, doc, 'ask', ['new', 'skip']],
      'an upload without a choice stores nothing and says what it found');
    assert.equal(await count(), before);

    const copy = await put(here, { onDuplicate: 'new' });
    assert.deepEqual([copy.status, copy.body.duplicate, copy.body.supplemented, copy.body.document.title, copy.body.renamed], [201, false, false, 'thue-nha (2)', true], '"upload as new" saves a second document with a suffix');
    const twin = copy.body.document.id;
    assert.notEqual(twin, doc);
    assert.equal((await check(here)).body.matches.length, 2, 'every place that has the file is listed');
    for (const fields of [{ onDuplicate: 'replace' }, { onDuplicate: 'supplement' }, { onDuplicate: 'supplement', targetId: 'abc' }, { targetId: 'abc' }]) {
      const response = await put(here, fields);
      assert.equal(response.status, 400, JSON.stringify(fields));
      assert.ok(response.body.fieldErrors?.onDuplicate || response.body.fieldErrors?.targetId, JSON.stringify(fields));
    }
    const wrongTarget = await put(here, { onDuplicate: 'supplement', targetId: twin });
    assert.deepEqual([wrongTarget.status, wrongTarget.body.duplicate, wrongTarget.body.conflict.situation], [200, true, 'ask'], 'a document that still has its original cannot be supplemented');
    assert.equal((await put(here, { onDuplicate: 'supplement', targetId: randomUUID() })).body.duplicate, true);

    const kept = await dropOriginal(doc, false);
    const waiting = (await check(here)).body;
    assert.deepEqual([waiting.primary.documentId, waiting.primary.state, waiting.primary.trashId, waiting.options], [doc, 'original-trashed', kept.id, ['restore', 'new', 'skip']],
      'an original in the trash suggests restoring it');
    assert.equal((await put(here)).body.duplicate, true, 'and is not replaced silently');
    assert.equal((await request(`/api/trash/${kept.id}`, { method: 'DELETE', token: user.token })).status, 204);
    const usage = async () => (await request('/api/documents/usage', { token: user.token })).body.encryptedBytes;
    const usedBefore = await usage();

    const lost = (await check(here)).body;
    assert.deepEqual([lost.situation, lost.primary.documentId, lost.primary.state, lost.options], ['auto-supplement', doc, 'no-original', []], 'in the same folder a missing original needs no question');
    const far = (await check(there)).body;
    assert.deepEqual([far.situation, far.primary.documentId, far.options], ['ask', doc, ['supplement', 'new', 'skip']], 'from another folder the user chooses');
    const asked = await put(there);
    assert.deepEqual([asked.status, asked.body.duplicate, asked.body.conflict.options], [200, true, ['supplement', 'new', 'skip']]);
    assert.equal(await usage(), usedBefore);

    const supplemented = await put(there, { onDuplicate: 'supplement', targetId: doc }, 'ten-khac.txt');
    assert.deepEqual([supplemented.status, supplemented.body.duplicate, supplemented.body.supplemented, supplemented.body.document.id, supplemented.body.document.folderId, supplemented.body.document.title],
      [201, false, true, doc, here, 'thue-nha'], 'the original goes to the existing document, which stays where it is');
    assert.equal(supplemented.body.document.originalAvailable, true);
    assert.ok(await usage() > usedBefore, 'the new original counts against the quota');
    assert.equal(await count(), before + 1, 'no document is created');
    const reread = await parsed(user, doc, 30_000);
    assert.deepEqual([reread.status, reread.summary], ['SUCCEEDED', 'Tóm tắt giữ nguyên.'], 'the text is read again and the summary is kept');
    assert.ok(await db.documentChunk.count({ where: { documentId: doc } }) > 0);
    assert.deepEqual((await db.extractedMetadata.findFirstOrThrow({ where: { documentId: doc } })).fields, { rent: '8000000' });
    assert.equal(sha256((await request(`/api/documents/${doc}/original`, { token: user.token })).raw), hash);
    assert.equal((await put(there, { onDuplicate: 'supplement', targetId: doc })).body.duplicate, true, 'once it has an original it cannot be supplemented again');

    await dropOriginal(doc, true);
    const auto = await put(here);
    assert.deepEqual([auto.status, auto.body.duplicate, auto.body.supplemented, auto.body.document.id], [201, false, true, doc], 'same folder: supplemented without a question');
    assert.equal((await parsed(user, doc, 30_000)).status, 'SUCCEEDED');

    assert.equal((await request(`/api/documents/${twin}`, { method: 'DELETE', token: user.token })).status, 204);
    assert.equal((await request(`/api/documents/${doc}`, { method: 'DELETE', token: user.token })).status, 204);
    const binned = (await check(here)).body;
    assert.deepEqual([binned.situation, binned.options, binned.matches.map((match) => match.state)], ['ask', ['restore', 'new', 'skip'], ['trashed', 'trashed']]);
    assert.ok(binned.primary.trashId);
    const fresh = await put(here);
    assert.deepEqual([fresh.status, fresh.body.duplicate, fresh.body.document.title], [201, false, 'thue-nha'], 'the trash never blocks an upload; restoring is only offered before sending');
    assert.equal((await request(`/api/trash/${binned.primary.trashId}/restore`, { method: 'POST', token: user.token })).status, 200);
  });

  test('review: restoring an original whose document is itself in the trash says so, and the document comes back whole afterwards', async () => {
    const user = users.c;
    const doc = (await upload(user, { name: 'goc-truoc-tai-lieu-sau.txt', data: text() })).body.document;
    await parsed(user, doc.id, 30_000);
    assert.equal((await request(`/api/documents/${doc.id}/original`, { method: 'DELETE', token: user.token })).status, 202);
    assert.equal((await request(`/api/documents/${doc.id}`, { method: 'DELETE', token: user.token })).status, 204);
    const original = await request(`/api/trash/${(await trashItem(user, 'ORIGINAL', 'goc-truoc-tai-lieu-sau')).id}/restore`, { method: 'POST', token: user.token });
    assert.deepEqual([original.status, original.body.kind, original.body.inTrash], [200, 'ORIGINAL', true]);
    assert.equal((await request(`/api/documents/${doc.id}`, { token: user.token })).status, 404, 'the document itself is still in the trash');
    assert.equal((await request(`/api/documents/${doc.id}/original`, { token: user.token })).status, 404);
    const whole = await request(`/api/trash/${(await trashItem(user, 'DOCUMENT', 'goc-truoc-tai-lieu-sau')).id}/restore`, { method: 'POST', token: user.token });
    assert.deepEqual([whole.status, whole.body.kind, whole.body.inTrash], [200, 'DOCUMENT', undefined]);
    const back = (await request(`/api/documents/${doc.id}`, { token: user.token })).body;
    assert.deepEqual([back.originalAvailable, back.originalInTrash], [true, false]);
    assert.equal((await request(`/api/documents/${doc.id}/original`, { token: user.token })).status, 200);

    const other = (await upload(user, { name: 'goc-binh-thuong.txt', data: text() })).body.document;
    await parsed(user, other.id, 30_000);
    assert.equal((await request(`/api/documents/${other.id}/original`, { method: 'DELETE', token: user.token })).status, 202);
    const plain = await request(`/api/trash/${(await trashItem(user, 'ORIGINAL', 'goc-binh-thuong')).id}/restore`, { method: 'POST', token: user.token });
    assert.deepEqual([plain.status, plain.body.inTrash], [200, false]);
  });

  test('review: a file that went into the trash with its folder is still recognised, and the offer is to restore that folder', async () => {
    const user = users.dup;
    const data = Buffer.from(`Biên bản bàn giao nhà ${randomUUID()}`);
    const ask = (folderId) => request('/api/documents/check', { method: 'POST', token: user.token, body: { sha256: createHash('sha256').update(data).digest('hex'), size: data.length, folderId } });
    const box = (await request('/api/folders', { method: 'POST', token: user.token, body: { name: 'Nhà cũ', parentId: null } })).body.folder.id;
    const doc = (await upload(user, { name: 'ban-giao.txt', data })).body.document.id;
    assert.equal((await request(`/api/documents/${doc}`, { method: 'PATCH', token: user.token, body: { folderId: box } })).status, 200);
    await parsed(user, doc, 30_000);
    assert.equal((await request(`/api/folders/${box}`, { method: 'DELETE', token: user.token })).status, 200);
    const item = await trashItem(user, 'FOLDER', 'Nhà cũ');
    const found = (await ask(null)).body;
    assert.deepEqual([found.situation, found.options, found.primary.state, found.primary.trashId, found.primary.trashFolder],
      ['ask', ['restore', 'new', 'skip'], 'trashed', item.id, 'Nhà cũ']);
    assert.equal((await request(`/api/trash/${item.id}/restore`, { method: 'POST', token: user.token })).status, 200);
    const back = (await ask(box)).body;
    assert.deepEqual([back.primary.documentId, back.primary.state, back.primary.sameFolder, back.primary.trashFolder], [doc, 'full', true, null]);
  });

  test('review: a document deleted and restored twice before it was read is still read', async () => {
    const { MaintenanceService } = await compiled('retention/maintenance.service.js');
    const maintenance = Object.assign(Object.create(MaintenanceService.prototype), { prisma: db });
    await stopWorker();
    try {
      const doc = (await upload(users.c, { name: 'xoa-hai-lan.txt', data: text() })).body.document;
      const version = await db.documentVersion.findFirstOrThrow({ where: { documentId: doc.id } });
      const waiting = () => db.aIJob.count({ where: { versionId: version.id, kind: 'PARSE', status: 'QUEUED' } });
      for (const round of [1, 2, 3]) {
        assert.equal((await request(`/api/documents/${doc.id}`, { method: 'DELETE', token: users.c.token })).status, 204);
        assert.equal(await waiting(), 0, 'the job is cancelled while the document is in the trash');
        const item = await trashItem(users.c, 'DOCUMENT', 'xoa-hai-lan');
        assert.equal((await request(`/api/trash/${item.id}/restore`, { method: 'POST', token: users.c.token })).status, 200);
        await maintenance.resumeParsing();
        assert.equal(await waiting(), 1, `restore ${round} queues the read again`);
        await maintenance.resumeParsing();
        assert.equal(await waiting(), 1, 'and never twice');
      }
      users.c.twice = doc.id;
    } finally {
      startWorker();
    }
    assert.equal((await parsed(users.c, users.c.twice, 30_000)).status, 'SUCCEEDED');
  });

  test('review: rows of permanently deleted documents go even when the purge job itself never finished', async () => {
    const user = users.c;
    const doc = (await upload(user, { name: 'xoa-han-khi-job-chet.txt', data: text() })).body.document;
    await parsed(user, doc.id, 30_000);
    await stopWorker();
    try {
      assert.equal((await request(`/api/documents/${doc.id}`, { method: 'DELETE', token: user.token })).status, 204);
      const item = await trashItem(user, 'DOCUMENT', 'xoa-han-khi-job-chet');
      assert.equal((await request(`/api/trash/${item.id}`, { method: 'DELETE', token: user.token })).status, 204);
      const dead = await db.aIJob.updateMany({ where: { userId: user.id, kind: 'PURGE', status: 'QUEUED' }, data: { status: 'DEAD', finishedAt: new Date(), lastErrorCode: 'BLOB_DELETE_FAILED' } });
      assert.ok(dead.count > 0, 'the purge job is given up on');
    } finally {
      startWorker();
    }
    await eventually(gone(doc.id), 'housekeeping removes the rows once the stored files are gone', 15_000);
  });

  test('review: moving a folder counts subfolders still in the trash, and says so instead of failing', async () => {
    const user = users.dup;
    const make = async (name, parentId = null) => (await request('/api/folders', { method: 'POST', token: user.token, body: { name, parentId } })).body.folder.id;
    const tall = await make('Cao');
    const a = await make('a', tall);
    const b = await make('b', a);
    await make('c', b);
    const deep = await make('Q', await make('P'));
    assert.equal((await request(`/api/folders/${a}`, { method: 'DELETE', token: user.token })).status, 200);
    const move = () => request(`/api/folders/${tall}`, { method: 'PATCH', token: user.token, body: { parentId: deep } });
    const refused = await move();
    assert.equal(refused.status, 400, 'not a server error');
    assert.match(refused.body.fieldErrors.parentId, /thùng rác/);
    const item = await trashItem(user, 'FOLDER', 'a');
    assert.equal((await request(`/api/trash/${item.id}`, { method: 'DELETE', token: user.token })).status, 204);
    await eventually(async () => (await db.folder.count({ where: { id: a } })) === 0, 'the purged subfolders are removed');
    const moved = await move();
    assert.deepEqual([moved.status, moved.body.folder.parentId], [200, deep]);
  });

  test('duplicates: a failed supplement leaves the document as it was', async () => {
    const user = users.dup;
    const body = Buffer.concat([text(), randomBytes(400 * 1024).map((byte) => 97 + (byte % 26))]);
    const doc = (await upload(user, { name: 'lon.txt', data: body })).body.document.id;
    assert.equal((await parsed(user, doc, 30_000)).status, 'SUCCEEDED');
    assert.equal((await request(`/api/documents/${doc}/original`, { method: 'DELETE', token: user.token })).status, 202);
    const item = (await trashOf(user)).find((entry) => entry.kind === 'ORIGINAL');
    assert.equal((await request(`/api/trash/${item.id}`, { method: 'DELETE', token: user.token })).status, 204);
    for (const name of ['day-1.txt', 'day-2.txt']) {
      const filler = Buffer.concat([text(), randomBytes(330 * 1024).map((byte) => 97 + (byte % 26))]);
      assert.equal((await upload(user, { name, data: filler })).status, 201);
    }
    const full = await upload(user, { name: 'lon.txt', data: body });
    assert.equal(full.status, 413, 'supplementing an original needs room in the quota');
    const after = (await request(`/api/documents/${doc}`, { token: user.token })).body;
    assert.deepEqual([after.status, after.originalAvailable, after.problem], ['SUCCEEDED', false, null], 'the document is not turned into a failed one');
    assert.equal(await db.fileCopy.count({ where: { documentId: doc, state: { in: ['UPLOADING', 'AVAILABLE'] } } }), 0);
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
    const user = users.b;
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

  test('B5 filters: by file type, paginated and only for the owner; there is no status filter', async () => {
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
    const list = async (query) => {
      const response = await request(`/api/documents?${query}`, { token: user.token });
      assert.equal(response.status, 200, query);
      return response.body.items.map((item) => item.id);
    };
    assert.deepEqual(await list('type=pdf'), [ids.broken, ids.pdf]);
    assert.deepEqual(await list('type=docx'), [ids.docx]);
    assert.deepEqual(await list('type=txt'), [ids.txt]);
    const first = await request('/api/documents?type=pdf&limit=1', { token: user.token });
    assert.deepEqual(first.body.items.map((item) => item.id), [ids.broken]);
    assert.equal(typeof first.body.nextCursor, 'string');
    assert.deepEqual(await list(`type=pdf&limit=1&cursor=${first.body.nextCursor}`), [ids.pdf], 'the cursor keeps the filter');
    for (const query of ['type=png', 'status=read', 'type=PDF']) {
      const response = await request(`/api/documents?${query}`, { token: user.token });
      assert.equal(response.status, 400, query);
      assert.ok(response.body.fieldErrors?.[query.split('=')[0]], query);
    }
    assert.equal((await request(`/api/documents/${ids.pdf}`, { method: 'DELETE', token: user.token })).status, 204);
    assert.deepEqual(await list('type=pdf'), [ids.broken], 'a deleted document leaves every filtered list');
    const others = await request('/api/documents?type=pdf&limit=50', { token: users.b.token });
    assert.equal(others.body.items.some((item) => Object.values(ids).includes(item.id)), false);
  });

  test('folders: create, rename and move keep sibling names unique, the tree within 5 levels, and stay per user', async () => {
    const user = await createUser('folders', 'ENCRYPTED_COPY');
    users.f = user;
    const api = (path, method, body, token = user.token) => request(`/api/folders${path}`, { method, token, body });
    assert.equal((await request('/api/folders')).status, 401);
    assert.equal((await request('/api/folders', { method: 'POST', token: user.token, body: { name: 'Sai nguồn' }, requestOrigin: 'https://evil.example' })).status, 403);

    const home = await api('', 'POST', { name: '  Nhà Cầu Giấy ', purpose: ' Giấy tờ căn nhà ở Cầu Giấy ' });
    assert.equal(home.status, 201);
    assert.deepEqual([home.body.folder.name, home.body.folder.purpose, home.body.folder.parentId, home.body.renamed], ['Nhà Cầu Giấy', 'Giấy tờ căn nhà ở Cầu Giấy', null, false]);
    assertPrivate(home.body);
    const twin = await api('', 'POST', { name: 'NHÀ CẦU GIẤY' });
    assert.deepEqual([twin.body.folder.name, twin.body.renamed], ['NHÀ CẦU GIẤY (2)', true], 'a sibling with the same name gets a suffix');
    const third = await api('', 'POST', { name: 'nhà cầu giấy' });
    assert.equal(third.body.folder.name, 'nhà cầu giấy (3)');
    const bills = await api('', 'POST', { name: 'Hóa đơn', parentId: home.body.folder.id });
    assert.deepEqual([bills.body.folder.name, bills.body.folder.parentId], ['Hóa đơn', home.body.folder.id]);
    assert.equal((await api('', 'POST', { name: 'hoá đơn', parentId: home.body.folder.id })).body.folder.name, 'hoá đơn (2)', 'the tone position does not make a new name');
    assert.equal((await api('', 'POST', { name: 'Hóa đơn' })).body.renamed, false, 'the same name is free one level up');

    for (const name of ['', '   ', 'a/b', 'a\\b', 'x'.repeat(101), 42]) {
      const bad = await api('', 'POST', { name });
      assert.equal(bad.status, 400, String(name));
      assert.ok(bad.body.fieldErrors?.name, String(name));
    }
    assert.ok((await api('', 'POST', { name: 'Dài', purpose: 'x'.repeat(501) })).body.fieldErrors?.purpose);
    assert.equal((await api('', 'POST', { name: 'Thừa trường', color: 'red' })).status, 400);
    assert.equal((await api('', 'POST', { name: 'Cha sai', parentId: 'not-a-uuid' })).status, 400);
    const foreign = await api('', 'POST', { name: 'Trong thư mục người khác', parentId: home.body.folder.id }, users.b.token);
    assert.equal(foreign.status, 404);
    assert.ok(foreign.body.fieldErrors?.parentId);

    const chain = [home.body.folder.id, bills.body.folder.id];
    for (let level = 3; level <= 5; level++) {
      const next = await api('', 'POST', { name: `Cấp ${level}`, parentId: chain.at(-1) });
      assert.equal(next.status, 201, `level ${level}`);
      chain.push(next.body.folder.id);
    }
    const sixth = await api('', 'POST', { name: 'Cấp 6', parentId: chain[4] });
    assert.equal(sixth.status, 400);
    assert.match(sixth.body.fieldErrors.parentId, /5 cấp/);

    const renamed = await api(`/${twin.body.folder.id}`, 'PATCH', { name: 'Xe máy', purpose: 'Đăng ký, bảo hiểm xe' });
    assert.deepEqual([renamed.status, renamed.body.folder.name, renamed.body.folder.purpose, renamed.body.renamed], [200, 'Xe máy', 'Đăng ký, bảo hiểm xe', false]);
    assert.equal((await api(`/${twin.body.folder.id}`, 'PATCH', { name: 'xe máy' })).body.folder.name, 'xe máy', 'changing only the case of its own name needs no suffix');
    assert.equal((await api(`/${twin.body.folder.id}`, 'PATCH', { purpose: null })).body.folder.purpose, null);
    assert.equal((await api(`/${twin.body.folder.id}`, 'PATCH', { purpose: '' })).body.folder.name, 'xe máy');
    const clash = await api(`/${third.body.folder.id}`, 'PATCH', { name: 'Xe Máy' });
    assert.deepEqual([clash.body.folder.name, clash.body.renamed], ['Xe Máy (2)', true]);
    assert.equal((await api(`/${twin.body.folder.id}`, 'PATCH', {})).status, 400);
    assert.equal((await api(`/${twin.body.folder.id}`, 'PATCH', { name: 'a/b' })).status, 400);
    assert.equal((await api(`/${twin.body.folder.id}`, 'PATCH', { name: 'Của tôi' }, users.b.token)).status, 404, 'other users cannot rename it');
    assert.equal((await api(`/${randomUUID()}`, 'PATCH', { name: 'Không có' })).status, 404);

    for (const target of [home.body.folder.id, chain[4]]) {
      const loop = await api(`/${home.body.folder.id}`, 'PATCH', { parentId: target });
      assert.equal(loop.status, 400);
      assert.match(loop.body.fieldErrors.parentId, /chính nó/);
    }
    const tooDeep = await api(`/${home.body.folder.id}`, 'PATCH', { parentId: twin.body.folder.id });
    assert.equal(tooDeep.status, 400, 'a 5-level subtree cannot go under another folder');
    assert.match(tooDeep.body.fieldErrors.parentId, /5 cấp/);
    assert.equal((await api(`/${twin.body.folder.id}`, 'PATCH', { parentId: chain[4] })).status, 400);
    assert.equal((await api(`/${twin.body.folder.id}`, 'PATCH', { parentId: randomUUID() })).status, 404);
    const moved = await api(`/${twin.body.folder.id}`, 'PATCH', { parentId: chain[3] });
    assert.deepEqual([moved.status, moved.body.folder.parentId], [200, chain[3]]);
    const lifted = await api(`/${chain[4]}`, 'PATCH', { parentId: null });
    assert.deepEqual([lifted.status, lifted.body.folder.parentId, lifted.body.folder.name], [200, null, 'Cấp 5']);
    const sameName = await api('', 'POST', { name: 'Cấp 5', parentId: home.body.folder.id });
    const collided = await api(`/${sameName.body.folder.id}`, 'PATCH', { parentId: null });
    assert.deepEqual([collided.body.folder.name, collided.body.renamed], ['Cấp 5 (2)', true], 'moving next to a folder with the same name adds a suffix');

    const tree = await api('', 'GET');
    assert.equal(tree.status, 200);
    assert.equal(tree.body.folders.length, 10);
    assert.ok(tree.body.folders.every((folder) => folder.documentCount === 0));
    assert.deepEqual([tree.body.unfiledCount, tree.body.totalCount], [0, 0]);
    assert.equal((await api('', 'GET', undefined, users.b.token)).body.folders.some((folder) => tree.body.folders.some((mine) => mine.id === folder.id)), false);
    users.f.folders = { home: home.body.folder.id, bills: bills.body.folder.id };
  });

  test('folders: documents upload into, move between and are listed by folder; names stay unique inside each folder', async () => {
    const user = users.f;
    const { home, bills } = user.folders;
    const patch = (id, body, token = user.token) => request(`/api/documents/${id}`, { method: 'PATCH', token, body });
    const uploadTo = (folderId, name, token = user) => {
      const form = new FormData();
      form.append('file', new Blob([text()], { type: 'text/plain' }), name);
      if (folderId) form.append('folderId', folderId);
      return request('/api/documents', { method: 'POST', token: token.token, form });
    };

    const first = await uploadTo(bills, 'Tiền điện.txt');
    assert.deepEqual([first.status, first.body.document.title, first.body.document.folderId, first.body.renamed], [201, 'Tiền điện', bills, false]);
    const second = await uploadTo(bills, 'tiền điện.txt');
    assert.deepEqual([second.status, second.body.document.title, second.body.renamed], [201, 'tiền điện (2)', true], 'same name, different content: saved with a suffix');
    const elsewhere = await uploadTo(home, 'Tiền điện.txt');
    assert.deepEqual([elsewhere.body.document.title, elsewhere.body.renamed], ['Tiền điện', false], 'the name is free in another folder');
    const loose = await uploadTo(null, 'Tiền điện.txt');
    assert.deepEqual([loose.body.document.title, loose.body.document.folderId], ['Tiền điện', null]);

    const before = await documentCount(user);
    const stolen = await uploadTo(bills, 'cua-nguoi-khac.txt', users.b);
    assert.equal(stolen.status, 404, 'uploading into another user\'s folder');
    assert.ok(stolen.body.fieldErrors?.folderId);
    assert.equal((await uploadTo(randomUUID(), 'khong-co-thu-muc.txt')).status, 404);
    assert.equal((await uploadTo('not-a-uuid', 'sai.txt')).status, 400);
    assert.equal(await documentCount(user), before);
    assert.equal(await db.fileCopy.count({ where: { userId: users.b.id, state: 'UPLOADING' } }), 0);

    const same = await Promise.all(Array.from({ length: 4 }, () => uploadTo(home, 'Biên bản.txt')));
    assert.deepEqual(same.map((result) => result.status), [201, 201, 201, 201]);
    assert.deepEqual(same.map((result) => result.body.document.title).sort(), ['Biên bản', 'Biên bản (2)', 'Biên bản (3)', 'Biên bản (4)'], 'concurrent uploads never share a name');

    const ids = async (query) => {
      const response = await request(`/api/documents?limit=50&${query}`, { token: user.token });
      assert.equal(response.status, 200, query);
      return response.body.items.map((item) => item.id).sort();
    };
    assert.deepEqual(await ids(`folder=${bills}`), [first.body.document.id, second.body.document.id].sort());
    assert.deepEqual(await ids('folder=none'), [loose.body.document.id]);
    assert.deepEqual(await ids(`folder=${bills}&type=pdf`), []);
    assert.deepEqual(await ids(`folder=${bills.toUpperCase()}&type=txt`), [first.body.document.id, second.body.document.id].sort());
    assert.equal((await ids('type=txt')).length, 8, 'without a folder every document is listed');
    assert.deepEqual(await ids(`folder=${randomUUID()}`), []);
    const badFolder = await request('/api/documents?folder=root', { token: user.token });
    assert.equal(badFolder.status, 400);
    assert.ok(badFolder.body.fieldErrors?.folder);
    assert.equal((await request(`/api/documents?folder=${bills}`, { token: users.b.token })).body.items.length, 0, 'another user sees nothing in it');

    const renamed = await patch(first.body.document.id, { title: '  Hóa đơn điện tháng 10  ' });
    assert.deepEqual([renamed.status, renamed.body.document.title, renamed.body.renamed], [200, 'Hóa đơn điện tháng 10', false]);
    assert.equal(renamed.body.document.file.name, 'Tiền điện.txt', 'the uploaded file name is kept');
    assert.ok(new Date(renamed.body.document.updatedAt) > new Date(first.body.document.updatedAt));
    assertPrivate(renamed.body);
    const clash = await patch(second.body.document.id, { title: 'HOÁ ĐƠN ĐIỆN THÁNG 10' });
    assert.deepEqual([clash.body.document.title, clash.body.renamed], ['HOÁ ĐƠN ĐIỆN THÁNG 10 (2)', true]);
    assert.equal((await patch(first.body.document.id, { title: 'hóa đơn điện tháng 10' })).body.renamed, false, 'its own name in another case is not a clash');
    for (const body of [{ title: '   ' }, { title: 'x'.repeat(256) }, { title: 5 }, {}, { folderId: 'none' }, { privacyLevel: 'ENCRYPTED_COPY' }]) {
      assert.equal((await patch(first.body.document.id, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await patch(first.body.document.id, { title: 'Của tôi' }, users.b.token)).status, 404, 'other users cannot rename it');
    assert.equal((await patch(first.body.document.id, { folderId: randomUUID() })).status, 404);
    const otherFolder = (await request('/api/folders', { method: 'POST', token: users.b.token, body: { name: 'Của B' } })).body.folder.id;
    assert.equal((await patch(first.body.document.id, { folderId: otherFolder })).status, 404, 'a document cannot move into another user\'s folder');

    const download = await request(`/api/documents/${first.body.document.id}/original`, { token: user.token });
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), new RegExp(encodeURIComponent('hóa đơn điện tháng 10.txt')), 'the download is named after the display name');

    const moved = await patch(elsewhere.body.document.id, { folderId: null });
    assert.deepEqual([moved.status, moved.body.document.folderId, moved.body.document.title, moved.body.renamed], [200, null, 'Tiền điện (2)', true], 'moving next to a document with the same name adds a suffix');
    const back = await patch(elsewhere.body.document.id, { folderId: bills, title: 'Tiền nước' });
    assert.deepEqual([back.body.document.folderId, back.body.document.title, back.body.renamed], [bills, 'Tiền nước', false]);

    const tree = (await request('/api/folders', { token: user.token })).body;
    const count = (id) => tree.folders.find((folder) => folder.id === id).documentCount;
    assert.deepEqual([count(bills), count(home), tree.unfiledCount, tree.totalCount], [3, 4, 1, 8]);
    assert.equal((await request(`/api/documents/${second.body.document.id}`, { method: 'DELETE', token: user.token })).status, 204);
    const after = (await request('/api/folders', { token: user.token })).body;
    assert.equal(after.folders.find((folder) => folder.id === bills).documentCount, 2, 'deleted documents are not counted');
    const reuse = await patch(first.body.document.id, { title: 'HOÁ ĐƠN ĐIỆN THÁNG 10 (2)' });
    assert.equal(reuse.body.renamed, false, 'the name of a deleted document is free again');
  });

  test('sorting: by upload time, update time or name, each with its own cursor pagination', async () => {
    const user = users.f;
    const folder = (await request('/api/folders', { method: 'POST', token: user.token, body: { name: 'Sắp xếp' } })).body.folder.id;
    const ids = {};
    for (const name of ['Chuối', 'an', 'Bưởi', 'Ăn', 'cam']) {
      const form = new FormData();
      form.append('file', new Blob([text()], { type: 'text/plain' }), `${name}.txt`);
      form.append('folderId', folder);
      ids[name] = (await request('/api/documents', { method: 'POST', token: user.token, form })).body.document.id;
      await delay(5);
    }
    for (const id of Object.values(ids)) await parsed(user, id);
    await delay(20);
    assert.equal((await request(`/api/documents/${ids.an}`, { method: 'PATCH', token: user.token, body: { title: 'An' } })).status, 200);
    const names = Object.fromEntries(Object.entries(ids).map(([name, id]) => [id, name]));
    const pages = async (sort, limit = 2) => {
      const seen = [];
      let cursor = null;
      do {
        const response = await request(`/api/documents?folder=${folder}&limit=${limit}${sort ? `&sort=${sort}` : ''}${cursor ? `&cursor=${cursor}` : ''}`, { token: user.token });
        assert.equal(response.status, 200, `${sort} ${cursor}`);
        assert.ok(response.body.items.length <= limit);
        seen.push(...response.body.items.map((item) => names[item.id]));
        cursor = response.body.nextCursor;
      } while (cursor);
      return seen;
    };
    assert.deepEqual(await pages(undefined), ['cam', 'Ăn', 'Bưởi', 'an', 'Chuối']);
    assert.deepEqual(await pages('created'), ['cam', 'Ăn', 'Bưởi', 'an', 'Chuối']);
    assert.equal((await pages('updated'))[0], 'an', 'the renamed document was updated last');
    assert.equal((await pages('updated')).length, 5);
    const byName = await pages('name');
    assert.deepEqual([...byName].sort(), ['an', 'Bưởi', 'Chuối', 'cam', 'Ăn'].sort(), 'every document appears exactly once across pages');
    assert.equal(byName.length, 5);
    assert.ok(byName.indexOf('Bưởi') < byName.indexOf('cam') && byName.indexOf('cam') < byName.indexOf('Chuối'), byName.join(','));
    assert.deepEqual(await pages('name-desc'), [...byName].reverse());
    assert.deepEqual(await pages('name', 1), byName, 'one per page gives the same order');
    const first = await request(`/api/documents?folder=${folder}&limit=2&sort=name`, { token: user.token });
    for (const query of ['sort=size', `sort=created&cursor=${first.body.nextCursor}`, `sort=name&cursor=${Buffer.from(`!!|${randomUUID()}`).toString('base64url')}`]) {
      const bad = await request(`/api/documents?folder=${folder}&${query}`, { token: user.token });
      assert.equal(bad.status, 400, query);
      assert.ok(bad.body.fieldErrors?.sort || bad.body.fieldErrors?.cursor, query);
    }
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
