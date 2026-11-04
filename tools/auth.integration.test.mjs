// Real HTTP and PostgreSQL checks. The caller migrates a dedicated test database
// and builds apps/api first. A local Mailpit captures SMTP; no external mail is sent.
// No schema is dropped; cleanup is restricted to this run's users/challenges/mail IDs.
// AUTH_TEST_DATABASE_URL=postgresql://... npm run test:auth
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const databaseUrl = process.env.AUTH_TEST_DATABASE_URL;
const root = fileURLToPath(new URL('../', import.meta.url));
const origin = 'http://localhost:5173';
const secret = 'docflow-integration-only-secret-at-least-32-characters';
const mailpitUrl = process.env.AUTH_TEST_MAILPIT_URL ?? 'http://127.0.0.1:8025';
const smtpPort = process.env.AUTH_TEST_SMTP_PORT ?? '1025';
const sender = 'docflow@example.test';
const prefix = `auth-it-${randomUUID()}-`;
const email = `${prefix}owner@example.test`;
// Spaces are intentional: passwords must be hashed exactly as supplied.
const password = ' DocFlow integration secret 2026! ';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
let db;
let server;
let baseUrl;
let registration;
let pendingRegistration;
let registrationMail;
const mailIds = new Set();

function cookieFrom(response) {
  const cookies = response.headers.getSetCookie();
  return cookies.find((cookie) => cookie.startsWith('docflow_refresh=')) ?? null;
}

function cookiePair(cookie) {
  assert.ok(cookie, 'response must set the refresh cookie');
  return cookie.split(';', 1)[0];
}

function rawRefresh(cookie) {
  return cookiePair(cookie).slice('docflow_refresh='.length);
}

function assertPrivateResponse(body) {
  if (body === null || typeof body !== 'object') return;
  for (const [key, value] of Object.entries(body)) {
    assert.doesNotMatch(key, /password|refreshToken|tokenHash/i,
      `sensitive field ${key} must never be returned`);
    assertPrivateResponse(value);
  }
}

function assertAuthResult(result, expectedStatus = 200, expectedEmail = email) {
  assert.equal(result.status, expectedStatus);
  assert.equal(typeof result.body.accessToken, 'string');
  assert.equal(result.body.expiresIn, 900);
  assert.equal(result.body.user.email, expectedEmail);
  assert.ok(result.body.user.id);
  assertPrivateResponse(result.body);
  assert.match(result.cookie ?? '', /;\s*HttpOnly(?:;|$)/i);
  assert.match(result.cookie ?? '', /;\s*Path=\/api\/auth(?:;|$)/i);
  assert.match(result.cookie ?? '', /;\s*SameSite=(?:Lax|Strict)(?:;|$)/i);
  assert.match(rawRefresh(result.cookie), /^[a-zA-Z0-9_-]{43,}$/);
  assert.notEqual(rawRefresh(result.cookie), result.body.accessToken);
}

function assertChallenge(result, status, expectedEmail) {
  assert.equal(result.status, status);
  assert.match(result.body.challengeId, /^[0-9a-f-]{36}$/i);
  assert.equal(result.body.email, expectedEmail);
  assert.equal(result.body.expiresIn, 600);
  assert.equal(result.body.resendAfter, 60);
  assert.equal(typeof result.body.message, 'string');
  assert.equal(result.cookie, null);
  assert.equal(result.body.accessToken, undefined);
  assert.equal(result.body.user, undefined);
  assertPrivateResponse(result.body);
}

// Mailpit's documented API: recipient search -> message Text; delete explicit IDs only.
// https://mailpit.axllent.org/docs/api-v1/
async function mailpit(path, options = {}) {
  const response = await fetch(`${mailpitUrl}${path}`, {
    ...options, signal: AbortSignal.timeout(5_000),
  });
  assert.ok(response.ok, `Local Mailpit ${path.split('?')[0]} returned ${response.status}`);
  if (options.method === 'DELETE') return;
  return response.json();
}

async function recipientMail(address) {
  const result = await mailpit(`/api/v1/search?query=${encodeURIComponent(`to:${address}`)}&limit=100`);
  return (result.messages ?? []).filter((message) =>
    message.To?.some((recipient) => recipient.Address.toLowerCase() === address.toLowerCase()));
}

async function deliveredCode(address, previousIds = []) {
  const prior = new Set(previousIds);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const summary = (await recipientMail(address)).find((message) => !prior.has(message.ID));
    if (summary) {
      mailIds.add(summary.ID);
      const message = await mailpit(`/api/v1/message/${encodeURIComponent(summary.ID)}`);
      const match = message.Text?.match(/\b(\d{6})\b/);
      assert.ok(match, 'SMTP message must contain a six-digit code in its text body');
      assert.equal(message.From.Address.toLowerCase(), sender);
      assert.ok(message.To.some((recipient) => recipient.Address.toLowerCase() === address));
      assert.ok(!message.Text.includes(password), 'email must never contain the password');
      return { code: match[1], id: summary.ID, message };
    }
    await delay(50);
  }
  assert.fail('OTP email was not delivered to local Mailpit within ten seconds');
}

const incorrectCode = (code) => code === '000000' ? '000001' : '000000';

async function pendingAccount(tag) {
  const address = `${prefix}${tag}@example.test`;
  const challenge = await request('/api/auth/register', {
    method: 'POST', body: { email: address, password, displayName: 'Email Test' },
  });
  assertChallenge(challenge, 202, address);
  assert.equal(await db.user.count({ where: { email: address } }), 0);
  const mail = await deliveredCode(address);
  return { address, challengeId: challenge.body.challengeId, mail };
}

async function verify(challengeId, code) {
  return request('/api/auth/verify-email', { method: 'POST', body: { challengeId, code } });
}

async function forgot(address) {
  // Advance only fixture clocks; issuing a new code also observes the real 60s cooldown.
  const previousChallenges = await db.emailChallenge.findMany({
    where: { email: address, purpose: 'RESET_PASSWORD' }, select: { id: true },
  });
  for (const challenge of previousChallenges) await allowResend(challenge.id);
  const before = (await recipientMail(address)).map((message) => message.ID);
  const response = await request('/api/auth/forgot-password', { method: 'POST', body: { email: address } });
  assertChallenge(response, 202, address);
  return { ...response.body, mail: await deliveredCode(address, before) };
}

async function reset(challengeId, code, newPassword) {
  return request('/api/auth/reset-password', {
    method: 'POST', body: { challengeId, code, password: newPassword },
  });
}

async function allowResend(challengeId) {
  const challenge = await db.emailChallenge.findUniqueOrThrow({ where: { id: challengeId } });
  await db.emailChallenge.update({ where: { id: challengeId },
    data: {
      createdAt: new Date(Math.min(challenge.createdAt.getTime(), Date.now() - 61_000)),
      resendAvailableAt: new Date(Math.min(challenge.expiresAt.getTime(), Date.now() - 1_000)),
    } });
}

async function expireChallenge(challengeId) {
  await db.emailChallenge.update({ where: { id: challengeId }, data: {
    createdAt: new Date(Date.now() - 660_000), expiresAt: new Date(Date.now() - 60_000),
    resendAvailableAt: new Date(Date.now() - 600_000),
  } });
}

async function stopApi() {
  if (server && server.exitCode === null && server.signalCode === null && server.pid) {
    const stopped = once(server, 'exit');
    server.kill('SIGTERM');
    const timeout = globalThis.setTimeout(() => server.kill('SIGKILL'), 3_000);
    try { await stopped; }
    finally { clearTimeout(timeout); }
  }
}

async function startApi() {
  const port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  let startupLog = '';
  server = spawn(process.execPath, ['apps/api/dist/main.js'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl,
      PORT: String(port), JWT_SECRET: secret, WEB_ORIGIN: origin, FILE_KEKS: `it:${Buffer.alloc(32, 9).toString('base64')}`,
      SMTP_HOST: '127.0.0.1', SMTP_PORT: smtpPort, SMTP_SECURE: 'false',
      SMTP_USER: '', SMTP_PASS: '', MAIL_FROM: `DocFlow Tests <${sender}>` },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream.on('data', (chunk) => { startupLog = (startupLog + chunk.toString()).slice(-8_000); });
  }
  let spawnError;
  server.on('error', (error) => { spawnError = error; });
  const deadline = Date.now() + 25_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (server.exitCode !== null || server.signalCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) { ready = true; break; }
    } catch { /* The listener is not ready yet. */ }
    await delay(100);
  }
  assert.ok(ready, `API did not start. Build apps/api first.\n${startupLog.replaceAll(secret, '[redacted]')}`);
}

async function restartApi() {
  // Phases use the real production limits; restarting clears only their in-memory buckets.
  await stopApi();
  await startApi();
}

async function request(path, { method = 'GET', body, token, cookie,
  requestOrigin = origin, rawBody, contentType = 'application/json', userAgent } = {}) {
  const headers = {};
  if (requestOrigin !== null) headers.origin = requestOrigin;
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookiePair(cookie);
  if (userAgent) headers['user-agent'] = userAgent;
  if (body !== undefined || rawBody !== undefined) headers['content-type'] = contentType;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); }
    catch { assert.fail(`HTTP ${response.status} ${path} must return JSON`); }
  }
  return { status: response.status, body: parsed, headers: response.headers,
    cookie: cookieFrom(response) };
}

async function login(userAgent) {
  const result = await request('/api/auth/login', {
    method: 'POST', body: { email, password }, userAgent,
  });
  assertAuthResult(result);
  return result;
}

function signClaims(token, patch, key = secret) {
  const [header, payload] = token.split('.');
  const claims = { ...JSON.parse(Buffer.from(payload, 'base64url').toString()), ...patch };
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', key).update(`${header}.${encoded}`).digest('base64url');
  return `${header}.${encoded}.${signature}`;
}

async function unusedPort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

describe('auth over HTTP with PostgreSQL and local SMTP delivery', {
  skip: databaseUrl ? false : 'Set AUTH_TEST_DATABASE_URL to a migrated disposable database, start local Mailpit and build apps/api to run these tests.',
  concurrency: false,
}, () => {
  before(async () => {
    const { PrismaClient } = await import('@prisma/client');
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(mailpitUrl).hostname), 'Mailpit must be local');
    assert.match(smtpPort, /^\d+$/);
    await mailpit('/api/v1/info');
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await db.$connect();
    // Fail early on an unmigrated database before launching the HTTP server.
    await db.emailChallenge.count();
    await startApi();
    pendingRegistration = await request('/api/auth/register', {
      method: 'POST', body: { email: `  ${email.toUpperCase()}  `,
        password, displayName: 'Integration Owner' },
    });
    assertChallenge(pendingRegistration, 202, email);
    assert.equal(await db.user.count({ where: { email } }), 0, 'pending email must not create a user');
    assert.equal((await request('/api/auth/login', { method: 'POST', body: { email, password } })).status, 401);
    registrationMail = await deliveredCode(email);
    const pending = await db.emailChallenge.findUniqueOrThrow({ where: { id: pendingRegistration.body.challengeId } });
    assert.match(pending.passwordHash, /^\$argon2id\$v=19\$/);
    assert.equal(pending.codeHash, createHmac('sha256', secret)
      .update(`${pending.id}:REGISTER:${email}:${registrationMail.code}`).digest('hex'));
    registration = await verify(pendingRegistration.body.challengeId, registrationMail.code);
    assertAuthResult(registration);
  });

  after(async () => {
    await stopApi();
    if (db) {
      try {
        // The unguessable run prefix confines cleanup to fixtures created here.
        await db.emailChallenge.deleteMany({ where: { email: { startsWith: prefix } } });
        await db.user.deleteMany({ where: { email: { startsWith: prefix } } });
      } finally { await db.$disconnect(); }
    }
    if (mailIds.size) await mailpit('/api/v1/messages', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ IDs: [...mailIds] }),
    });
  });

  test('registration normalizes email and creates the user/session only after its delivered OTP is verified', async () => {
    assertChallenge(pendingRegistration, 202, email);
    assertAuthResult(registration);
    assert.equal(registration.body.user.displayName, 'Integration Owner');
    assert.equal(registration.body.user.privacyLevel, 'ENCRYPTED_COPY', 'new accounts start at level 3');
    assert.equal(await db.user.count({ where: { email } }), 1);
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    assert.ok(user.emailVerifiedAt);
    assert.ok((await db.emailChallenge.findUniqueOrThrow({ where: { id: pendingRegistration.body.challengeId } })).consumedAt);
    assert.equal(registration.headers.get('access-control-allow-origin'), origin);
    assert.equal(registration.headers.get('access-control-allow-credentials'), 'true');
  });

  test('duplicate normalized email returns 409 without creating another user or session', async () => {
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const sessionsBefore = await db.session.count({ where: { userId: user.id } });
    const result = await request('/api/auth/register', {
      method: 'POST', body: { email: email.toUpperCase(), password },
    });
    assert.equal(result.status, 409);
    assert.equal(result.cookie, null);
    assert.equal(await db.user.count({ where: { email } }), 1);
    assert.equal(await db.session.count({ where: { userId: user.id } }), sessionsBefore);
  });

  test('registration rejects invalid input before persisting an account', async (t) => {
    const invalidEmail = `${prefix}invalid@example.test`;
    const cases = [
      ['malformed email', { body: { email: 'not-an-email', password } }],
      ['short password', { body: { email: invalidEmail, password: 'short123' } }],
      ['oversized password', { body: { email: invalidEmail, password: 'a'.repeat(129) } }],
      ['missing password', { body: { email: invalidEmail } }],
      ['unknown privilege field', { body: { email: invalidEmail, password, role: 'admin' } }],
      ['display name with the wrong type', { body: { email: invalidEmail, password, displayName: {} } }],
      ['malformed JSON', { rawBody: '{"email":' }],
    ];
    for (const [label, input] of cases) {
      await t.test(label, async () => {
        const result = await request('/api/auth/register', { method: 'POST', ...input });
        assert.equal(result.status, 400);
        assert.equal(result.cookie, null);
        const serialized = JSON.stringify(result.body);
        for (const rejectedPassword of [password, 'short123', 'a'.repeat(129)]) {
          assert.ok(!serialized.includes(rejectedPassword), 'validation must not echo the submitted password');
        }
      });
    }
    assert.equal(await db.user.count({ where: { email: invalidEmail } }), 0);
  });

  test('PostgreSQL contains an Argon2id password hash and only the SHA-256 refresh hash', async () => {
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    assert.match(user.passwordHash, /^\$argon2id\$v=19\$/);
    assert.notEqual(user.passwordHash, password);
    assert.ok(!user.passwordHash.includes(password));
    const raw = rawRefresh(registration.cookie);
    const sessions = await db.session.findMany({ where: { userId: user.id } });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].refreshTokenHash, sha256(raw));
    assert.notEqual(sessions[0].refreshTokenHash, raw);
    assert.ok(sessions[0].expiresAt > new Date());
    assert.equal(sessions[0].revokedAt, null);
  });

  test('login accepts normalized email and the exact password including surrounding spaces', async () => {
    const result = await request('/api/auth/login', {
      method: 'POST', body: { email: ` ${email.toUpperCase()} `, password },
    });
    assertAuthResult(result);
    assert.notEqual(result.cookie, registration.cookie);
  });

  test('wrong passwords and unknown users get the same generic 401 response', async () => {
    const wrong = await request('/api/auth/login', {
      method: 'POST', body: { email, password: password.trim() },
    });
    const missing = await request('/api/auth/login', {
      method: 'POST', body: { email: `${prefix}missing@example.test`, password },
    });
    assert.equal(wrong.status, 401);
    assert.equal(missing.status, 401);
    assert.deepEqual(wrong.body, missing.body);
    assert.equal(wrong.cookie, null);
    assert.equal(missing.cookie, null);
    assertPrivateResponse(wrong.body);
  });

  test('/me requires a Bearer token and returns public user data', async () => {
    const missing = await request('/api/auth/me');
    assert.equal(missing.status, 401);
    const result = await request('/api/auth/me', {
      token: registration.body.accessToken, requestOrigin: null,
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.id, registration.body.user.id);
    assert.equal(result.body.email, email);
    assertPrivateResponse(result.body);
    assert.equal((await request('/api/auth/me', { cookie: registration.cookie })).status, 401);
  });

  test('/me rejects expired, tampered, wrong-audience and wrong-issuer JWTs', async (t) => {
    const token = registration.body.accessToken;
    const [header, payload, signature] = token.split('.');
    const tampered = Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sub: randomUUID(),
    })).toString('base64url');
    const candidates = [
      ['expired', signClaims(token, { exp: Math.floor(Date.now() / 1000) - 120 })],
      ['tampered', `${header}.${tampered}.${signature}`],
      ['wrong audience', signClaims(token, { aud: 'unrelated-app' })],
      ['wrong issuer', signClaims(token, { iss: 'unrelated-issuer' })],
      ['wrong signing key', signClaims(token, {}, 'an-untrusted-signing-key-that-is-long-enough')],
      ['nonexistent session', signClaims(token, { sid: randomUUID() })],
    ];
    for (const [label, candidate] of candidates) {
      await t.test(label, async () => {
        assert.equal((await request('/api/auth/me', { token: candidate })).status, 401);
      });
    }
  });

  test('refresh rotates the opaque token, stores its new hash and denies replay', async () => {
    const session = await login();
    const originalHash = sha256(rawRefresh(session.cookie));
    const stored = await db.session.findUniqueOrThrow({ where: { refreshTokenHash: originalHash } });
    const refreshed = await request('/api/auth/refresh', { method: 'POST', cookie: session.cookie });
    assertAuthResult(refreshed);
    assert.notEqual(rawRefresh(refreshed.cookie), rawRefresh(session.cookie));
    const updated = await db.session.findUniqueOrThrow({ where: { id: stored.id } });
    assert.equal(updated.refreshTokenHash, sha256(rawRefresh(refreshed.cookie)));
    assert.ok(updated.lastUsedAt);
    assert.equal(await db.session.count({ where: { refreshTokenHash: originalHash } }), 0);
    assert.equal((await request('/api/auth/refresh', { method: 'POST', cookie: session.cookie })).status, 401);
    assert.equal((await request('/api/auth/me', { token: refreshed.body.accessToken })).status, 200);
  });

  test('two concurrent refreshes of the same cookie have exactly one winner', async () => {
    const session = await login();
    const results = await Promise.all([
      request('/api/auth/refresh', { method: 'POST', cookie: session.cookie }),
      request('/api/auth/refresh', { method: 'POST', cookie: session.cookie }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 401]);
    const winner = results.find((result) => result.status === 200);
    assertAuthResult(winner);
    assert.equal(await db.session.count({ where: {
      refreshTokenHash: sha256(rawRefresh(winner.cookie)), revokedAt: null,
    } }), 1);
    assert.equal((await request('/api/auth/me', { token: winner.body.accessToken })).status, 200);
  });

  test('missing and unknown refresh cookies are rejected', async () => {
    assert.equal((await request('/api/auth/refresh', { method: 'POST' })).status, 401);
    assert.equal((await request('/api/auth/refresh', {
      method: 'POST', cookie: 'docflow_refresh=' + 'x'.repeat(64),
    })).status, 401);
  });

  test('logout revokes the session immediately and clears the cookie', async () => {
    const session = await login();
    const result = await request('/api/auth/logout', { method: 'POST', token: session.body.accessToken });
    assert.equal(result.status, 204);
    assert.equal(result.body, null);
    assert.equal(cookiePair(result.cookie), 'docflow_refresh=');
    assert.match(result.cookie, /;\s*Path=\/api\/auth(?:;|$)/i);
    assert.ok(/Max-Age=0/i.test(result.cookie) || /Expires=Thu, 01 Jan 1970/i.test(result.cookie));
    assert.equal((await request('/api/auth/me', { token: session.body.accessToken })).status, 401);
    assert.equal((await request('/api/auth/refresh', { method: 'POST', cookie: session.cookie })).status, 401);
    const stored = await db.session.findUniqueOrThrow({ where: {
      refreshTokenHash: sha256(rawRefresh(session.cookie)),
    } });
    assert.ok(stored.revokedAt);
  });

  test('logout also revokes a cookie-only session', async () => {
    const session = await login();
    const result = await request('/api/auth/logout', { method: 'POST', cookie: session.cookie });
    assert.equal(result.status, 204);
    assert.equal((await request('/api/auth/me', { token: session.body.accessToken })).status, 401);
  });

  test('server-side session revocation invalidates both access and refresh tokens', async () => {
    const session = await login();
    await db.session.update({ where: { refreshTokenHash: sha256(rawRefresh(session.cookie)) },
      data: { revokedAt: new Date() } });
    assert.equal((await request('/api/auth/me', { token: session.body.accessToken })).status, 401);
    assert.equal((await request('/api/auth/refresh', { method: 'POST', cookie: session.cookie })).status, 401);
  });

  test('an expired database session invalidates both access and refresh tokens', async () => {
    const session = await login();
    await db.session.update({ where: { refreshTokenHash: sha256(rawRefresh(session.cookie)) },
      data: { createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000) } });
    assert.equal((await request('/api/auth/me', { token: session.body.accessToken })).status, 401);
    assert.equal((await request('/api/auth/refresh', { method: 'POST', cookie: session.cookie })).status, 401);
  });

  test('users can see and revoke their own active sessions without affecting other users or their current session', async () => {
    const current = await login('Browser A');
    const target = await login('Browser B');
    const owner = await db.user.findUniqueOrThrow({ where: { email } });
    const otherEmail = `${prefix}sessions-other@example.test`;
    await db.user.create({
      data: { email: otherEmail, passwordHash: owner.passwordHash, emailVerifiedAt: new Date() },
    });
    const other = await request('/api/auth/login', { method: 'POST', body: { email: otherEmail, password } });
    assertAuthResult(other, 200, otherEmail);
    const ids = await db.session.findMany({
      where: { refreshTokenHash: { in: [current, target, other].map((result) => sha256(rawRefresh(result.cookie))) } },
    });
    const sessionId = (result) => ids.find((row) => row.refreshTokenHash === sha256(rawRefresh(result.cookie))).id;
    const listPath = '/api/auth/sessions';
    const token = current.body.accessToken;
    const revoke = (id, options) => request(`${listPath}/${id}/revoke`, { method: 'POST', token, ...options });

    assert.equal((await request(listPath)).status, 401);
    const list = await request(listPath, { token });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body[0], {
      id: sessionId(current), userAgent: 'Browser A', isCurrent: true,
      createdAt: ids.find((row) => row.id === sessionId(current)).createdAt.toISOString(),
      expiresAt: ids.find((row) => row.id === sessionId(current)).expiresAt.toISOString(),
    });
    assert.equal(list.body.find((session) => session.id === sessionId(target)).isCurrent, false);
    assert.equal(list.body.find((session) => session.id === sessionId(target)).userAgent, 'Browser B');
    assert.ok(list.body.every((session) => session.id !== sessionId(other) && Date.parse(session.expiresAt) > Date.now()));
    assertPrivateResponse(list.body);

    assert.equal((await revoke('invalid')).status, 400);
    assert.equal((await revoke(sessionId(current).toUpperCase())).status, 404);
    assert.equal((await revoke(sessionId(other))).status, 404);
    assert.equal((await revoke(sessionId(target), { requestOrigin: 'https://example.test' })).status, 403);
    assert.equal((await request('/api/auth/me', { token: target.body.accessToken })).status, 200);

    assert.equal((await revoke(sessionId(target))).status, 204);
    assert.equal((await request('/api/auth/me', { token: target.body.accessToken })).status, 401);
    assert.equal((await request('/api/auth/refresh', { method: 'POST', cookie: target.cookie })).status, 401);
    const updated = await request(listPath, { token });
    assert.equal(updated.status, 200);
    assert.ok(updated.body.every((session) => session.id !== sessionId(target)));
    assert.equal((await request('/api/auth/me', { token: other.body.accessToken })).status, 200);
  });

  test('cross-origin mutations are rejected without consuming or revoking a valid session', async () => {
    const forbiddenOrigin = 'https://untrusted.example.test';
    for (const [path, options] of [
      ['/api/auth/register', { body: { email: `${prefix}csrf@example.test`, password } }],
      ['/api/auth/login', { body: { email, password } }],
      ['/api/auth/refresh', { cookie: registration.cookie }],
      ['/api/auth/logout', { cookie: registration.cookie, token: registration.body.accessToken }],
    ]) {
      const result = await request(path, { method: 'POST', requestOrigin: forbiddenOrigin, ...options });
      assert.equal(result.status, 403, path);
      assert.equal(result.cookie, null, `${path} must not mutate cookies`);
      assert.notEqual(result.headers.get('access-control-allow-origin'), forbiddenOrigin);
    }
    assert.equal(await db.user.count({ where: { email: `${prefix}csrf@example.test` } }), 0);
    assert.equal((await request('/api/auth/me', { token: registration.body.accessToken })).status, 200);
  });

  describe('registration email codes delivered through local Mailpit', { concurrency: false }, () => {
    before(restartApi);

    test('a wrong code cannot create an account; the right code works once', async () => {
      const account = await pendingAccount('wrong-code');
      assert.equal((await verify(account.challengeId, incorrectCode(account.mail.code))).status, 400);
      assert.equal(await db.user.count({ where: { email: account.address } }), 0);
      const result = await verify(account.challengeId, account.mail.code);
      assertAuthResult(result, 200, account.address);
      assert.equal((await verify(account.challengeId, account.mail.code)).status, 400);
      const user = await db.user.findUniqueOrThrow({ where: { email: account.address } });
      assert.equal(await db.session.count({ where: { userId: user.id } }), 1);
    });

    test('five wrong registration codes exhaust the challenge even when the next code is correct', async () => {
      const account = await pendingAccount('attempt-limit');
      for (let attempt = 0; attempt < 5; attempt++) {
        assert.equal((await verify(account.challengeId, incorrectCode(account.mail.code))).status, 400);
      }
      assert.equal((await verify(account.challengeId, account.mail.code)).status, 400);
      const stored = await db.emailChallenge.findUniqueOrThrow({ where: { id: account.challengeId } });
      assert.equal(stored.attempts, 5);
      assert.equal(await db.user.count({ where: { email: account.address } }), 0);
      await allowResend(account.challengeId);
      const next = await request('/api/auth/resend-code', { method: 'POST', body: { challengeId: account.challengeId } });
      assertChallenge(next, 200, account.address);
      const mail = await deliveredCode(account.address, [account.mail.id]);
      assertAuthResult(await verify(next.body.challengeId, mail.code), 200, account.address);
    });

    test('expired registration codes cannot be verified, but resend supplies a fresh challenge', async () => {
      const account = await pendingAccount('expired-code');
      await expireChallenge(account.challengeId);
      assert.equal((await verify(account.challengeId, account.mail.code)).status, 400);
      const next = await request('/api/auth/resend-code', {
        method: 'POST', body: { challengeId: account.challengeId },
      });
      assertChallenge(next, 200, account.address);
      await deliveredCode(account.address, [account.mail.id]);
      assert.equal(await db.user.count({ where: { email: account.address } }), 0);
    });

    test('resend enforces cooldown, issues a new challenge and invalidates the previous pair', async () => {
      const account = await pendingAccount('resend-code');
      const cooldown = await request('/api/auth/resend-code', {
        method: 'POST', body: { challengeId: account.challengeId },
      });
      assert.equal(cooldown.status, 429);
      assert.ok(cooldown.body.retryAfter > 0 && cooldown.body.retryAfter <= 60);
      assert.equal((await recipientMail(account.address)).length, 1);
      await allowResend(account.challengeId);
      const next = await request('/api/auth/resend-code', {
        method: 'POST', body: { challengeId: account.challengeId },
      });
      assertChallenge(next, 200, account.address);
      assert.notEqual(next.body.challengeId, account.challengeId);
      const mail = await deliveredCode(account.address, [account.mail.id]);
      assert.ok((await db.emailChallenge.findUniqueOrThrow({ where: { id: account.challengeId } })).consumedAt);
      assert.equal((await verify(account.challengeId, account.mail.code)).status, 400);
      assertAuthResult(await verify(next.body.challengeId, mail.code), 200, account.address);
    });

    test('concurrent verification has one winner and creates exactly one user/session', async () => {
      const account = await pendingAccount('verify-race');
      const results = await Promise.all([
        verify(account.challengeId, account.mail.code), verify(account.challengeId, account.mail.code),
      ]);
      assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
      assertAuthResult(results.find((result) => result.status === 200), 200, account.address);
      assert.equal(await db.user.count({ where: { email: account.address } }), 1);
      const user = await db.user.findUniqueOrThrow({ where: { email: account.address } });
      assert.equal(await db.session.count({ where: { userId: user.id } }), 1);
    });

    test('a registration code cannot be used for password reset', async () => {
      const account = await pendingAccount('purpose-code');
      const result = await reset(account.challengeId, account.mail.code, 'A replacement password 2026!');
      assert.equal(result.status, 400);
      assert.equal(result.cookie, null);
      assert.equal(await db.user.count({ where: { email: account.address } }), 0);
      assertAuthResult(await verify(account.challengeId, account.mail.code), 200, account.address);
    });

    test('concurrent resends issue only one successor and one new email', async () => {
      const account = await pendingAccount('resend-race');
      await allowResend(account.challengeId);
      const results = await Promise.all([
        request('/api/auth/resend-code', { method: 'POST', body: { challengeId: account.challengeId } }),
        request('/api/auth/resend-code', { method: 'POST', body: { challengeId: account.challengeId } }),
      ]);
      assert.equal(results.filter((result) => result.status === 200).length, 1);
      assert.ok(results.some((result) => [400, 429].includes(result.status)));
      const winner = results.find((result) => result.status === 200);
      assertChallenge(winner, 200, account.address);
      const mail = await deliveredCode(account.address, [account.mail.id]);
      assert.equal((await recipientMail(account.address)).length, 2);
      assert.equal((await verify(account.challengeId, account.mail.code)).status, 400);
      assertAuthResult(await verify(winner.body.challengeId, mail.code), 200, account.address);
    });

    test('verification rejects malformed codes and unknown challenges', async () => {
      assert.equal((await verify(randomUUID(), '12345')).status, 400);
      assert.equal((await verify(randomUUID(), '123456')).status, 400);
    });
  });

  describe('password recovery through local SMTP', { concurrency: false }, () => {
    let address;
    let currentPassword = password;
    let initialSession;

    async function recoveryLogin(candidate = currentPassword) {
      return request('/api/auth/login', { method: 'POST', body: { email: address, password: candidate } });
    }

    before(async () => {
      await restartApi();
      const account = await pendingAccount('recovery');
      address = account.address;
      initialSession = await verify(account.challengeId, account.mail.code);
      assertAuthResult(initialSession, 200, address);
    });

    test('known and unknown emails get indistinguishable public challenges; only the owner gets email', async () => {
      const known = await forgot(address);
      const missingAddress = `${prefix}missing-recovery@example.test`;
      const missing = await request('/api/auth/forgot-password', {
        method: 'POST', body: { email: `  ${missingAddress.toUpperCase()}  ` },
      });
      assertChallenge(missing, 202, missingAddress);
      const publicKnown = { ...known };
      delete publicKnown.mail;
      assert.deepEqual(Object.keys(publicKnown).sort(), Object.keys(missing.body).sort());
      assert.equal(known.message, missing.body.message);
      assert.equal(known.expiresIn, missing.body.expiresIn);
      assert.equal(known.resendAfter, missing.body.resendAfter);
      assert.equal((await recipientMail(missingAddress)).length, 0);
      const fake = await db.emailChallenge.findUniqueOrThrow({ where: { id: missing.body.challengeId } });
      assert.equal(fake.userId, null);
      assert.equal((await reset(fake.id, '000000', 'Never created password 2026!')).status, 400);
      await allowResend(fake.id);
      const resent = await request('/api/auth/resend-code', { method: 'POST', body: { challengeId: fake.id } });
      assertChallenge(resent, 200, missingAddress);
      assert.equal((await recipientMail(missingAddress)).length, 0);
      assert.equal(await db.user.count({ where: { email: missingAddress } }), 0);
    });

    test('reset codes are purpose-bound, keyed with HMAC and never exposed in HTTP responses', async () => {
      const challenge = await forgot(address);
      const stored = await db.emailChallenge.findUniqueOrThrow({ where: { id: challenge.challengeId } });
      assert.equal(stored.purpose, 'RESET_PASSWORD');
      assert.equal(stored.codeHash, createHmac('sha256', secret)
        .update(`${stored.id}:RESET_PASSWORD:${address}:${challenge.mail.code}`).digest('hex'));
      assert.notEqual(stored.codeHash, sha256(challenge.mail.code));
      assert.equal((await verify(challenge.challengeId, challenge.mail.code)).status, 400);
      const before = await db.user.findUniqueOrThrow({ where: { email: address } });
      const wrong = await reset(challenge.challengeId, incorrectCode(challenge.mail.code), 'Ignored replacement password 2026!');
      assert.equal(wrong.status, 400);
      assert.equal(wrong.cookie, null);
      assert.equal((await db.user.findUniqueOrThrow({ where: { email: address } })).passwordHash, before.passwordHash);
    });

    test('expired reset codes cannot change the password or revoke an existing session', async () => {
      const challenge = await forgot(address);
      const before = await db.user.findUniqueOrThrow({ where: { email: address } });
      await expireChallenge(challenge.challengeId);
      assert.equal((await reset(challenge.challengeId, challenge.mail.code, 'Expired replacement password 2026!')).status, 400);
      assert.equal((await db.user.findUniqueOrThrow({ where: { email: address } })).passwordHash, before.passwordHash);
      assert.equal((await request('/api/auth/me', { token: initialSession.body.accessToken })).status, 200);
    });

    test('five wrong reset codes exhaust the challenge without changing the password', async () => {
      const challenge = await forgot(address);
      const before = await db.user.findUniqueOrThrow({ where: { email: address } });
      for (let attempt = 0; attempt < 5; attempt++) {
        assert.equal((await reset(challenge.challengeId, incorrectCode(challenge.mail.code), 'Ignored replacement password 2026!')).status, 400);
      }
      assert.equal((await reset(challenge.challengeId, challenge.mail.code, 'Ignored replacement password 2026!')).status, 400);
      assert.equal((await db.emailChallenge.findUniqueOrThrow({ where: { id: challenge.challengeId } })).attempts, 5);
      assert.equal((await db.user.findUniqueOrThrow({ where: { email: address } })).passwordHash, before.passwordHash);
    });

    test('concurrent reset submissions have one winner and only the winning password works', async () => {
      const challenge = await forgot(address);
      const passwords = ['First concurrent password 2026!', 'Second concurrent password 2026!'];
      const results = await Promise.all(passwords.map((candidate) =>
        reset(challenge.challengeId, challenge.mail.code, candidate)));
      assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
      const winningIndex = results.findIndex((result) => result.status === 200);
      currentPassword = passwords[winningIndex];
      assert.equal(results[winningIndex].cookie, null);
      assert.equal(results[winningIndex].body.accessToken, undefined);
      assertAuthResult(await recoveryLogin(), 200, address);
      assert.equal((await recoveryLogin(passwords[1 - winningIndex])).status, 401);
      assert.equal((await reset(challenge.challengeId, challenge.mail.code, 'Replay replacement password 2026!')).status, 400);
    });

    test('resending a reset code invalidates the old pair; success revokes every session and requires login', async () => {
      const firstSession = await recoveryLogin();
      const secondSession = await recoveryLogin();
      assertAuthResult(firstSession, 200, address);
      assertAuthResult(secondSession, 200, address);
      const challenge = await forgot(address);
      const cooldown = await request('/api/auth/resend-code', { method: 'POST', body: { challengeId: challenge.challengeId } });
      assert.equal(cooldown.status, 429);
      await allowResend(challenge.challengeId);
      const previousIds = (await recipientMail(address)).map((message) => message.ID);
      const next = await request('/api/auth/resend-code', { method: 'POST', body: { challengeId: challenge.challengeId } });
      assertChallenge(next, 200, address);
      const newMail = await deliveredCode(address, previousIds);
      const oldPassword = currentPassword;
      const replacement = ' Brand new recovery password 2026! ';
      assert.equal((await reset(challenge.challengeId, challenge.mail.code, replacement)).status, 400);
      const result = await reset(next.body.challengeId, newMail.code, replacement);
      assert.equal(result.status, 200);
      assert.equal(result.cookie, null);
      assert.equal(result.body.accessToken, undefined);
      assert.equal(result.body.user, undefined);
      assertPrivateResponse(result.body);
      const user = await db.user.findUniqueOrThrow({ where: { email: address } });
      assert.ok(user.emailVerifiedAt);
      assert.match(user.passwordHash, /^\$argon2id\$v=19\$/);
      assert.equal(await db.session.count({ where: { userId: user.id, revokedAt: null } }), 0);
      assert.equal(await db.emailChallenge.count({ where: { email: address, purpose: 'RESET_PASSWORD', consumedAt: null } }), 0);
      for (const session of [firstSession, secondSession, initialSession]) {
        assert.equal((await request('/api/auth/me', { token: session.body.accessToken })).status, 401);
        assert.equal((await request('/api/auth/refresh', { method: 'POST', cookie: session.cookie })).status, 401);
      }
      assert.equal((await recoveryLogin(oldPassword)).status, 401);
      assertAuthResult(await recoveryLogin(replacement), 200, address);
      assert.equal((await reset(next.body.challengeId, newMail.code, replacement)).status, 400);
      currentPassword = replacement;
    });
  });

  describe('account settings and password change', { concurrency: false }, () => {
    let address;
    let current;
    const original = ' Account settings password 2026! ';

    before(async () => {
      await restartApi();
      const account = await pendingAccount('settings');
      address = account.address;
      current = await verify(account.challengeId, account.mail.code);
      assertAuthResult(current, 200, address);
    });

    const settingsLogin = (candidate) => request('/api/auth/login', {
      method: 'POST', body: { email: address, password: candidate },
    });

    test('account endpoints require a Bearer token and return only public fields', async () => {
      assert.equal((await request('/api/account')).status, 401);
      assert.equal((await request('/api/account', { method: 'PATCH', body: { timezone: 'Europe/Paris' } })).status, 401);
      const result = await request('/api/account', { token: current.body.accessToken });
      assert.equal(result.status, 200);
      assert.equal(result.body.email, address);
      assert.equal(result.body.timezone, 'Asia/Ho_Chi_Minh');
      assertPrivateResponse(result.body);
      assert.equal(result.headers.get('cache-control'), 'no-store');
    });

    test('PATCH updates time zone and display name for the signed-in user only', async () => {
      const result = await request('/api/account', {
        method: 'PATCH', token: current.body.accessToken, body: { timezone: 'Europe/Paris', displayName: '  Settings User  ' },
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.timezone, 'Europe/Paris');
      assert.equal(result.body.displayName, 'Settings User');
      const stored = await db.user.findUniqueOrThrow({ where: { email: address } });
      assert.equal(stored.timezone, 'Europe/Paris');
      assert.equal(stored.revision, 2n);
      const owner = await db.user.findUniqueOrThrow({ where: { email } });
      assert.equal(owner.timezone, 'Asia/Ho_Chi_Minh');
      assert.equal((await request('/api/auth/me', { token: current.body.accessToken })).body.timezone, 'Europe/Paris');
      const cleared = await request('/api/account', { method: 'PATCH', token: current.body.accessToken, body: { displayName: '' } });
      assert.equal(cleared.body.displayName, null);
    });

    test('PATCH rejects invalid zones, unknown or empty bodies and cross-origin browsers', async (t) => {
      const cases = [
        ['UTC offset', { timezone: '+07:00' }, 'timezone'],
        ['unknown zone', { timezone: 'Mars/Olympus_Mons' }, 'timezone'],
        ['null zone', { timezone: null }, 'timezone'],
        ['unknown privacy level', { privacyLevel: 'EVERYTHING' }, 'privacyLevel'],
        ['email is not editable', { email: 'someone@example.test' }, 'email'],
      ];
      for (const [label, body, field] of cases) {
        await t.test(label, async () => {
          const result = await request('/api/account', { method: 'PATCH', token: current.body.accessToken, body });
          assert.equal(result.status, 400);
          assert.equal(typeof result.body.fieldErrors[field], 'string');
        });
      }
      assert.equal((await request('/api/account', { method: 'PATCH', token: current.body.accessToken, body: {} })).status, 400);
      const foreign = await request('/api/account', {
        method: 'PATCH', token: current.body.accessToken, body: { timezone: 'UTC' }, requestOrigin: 'https://evil.example',
      });
      assert.equal(foreign.status, 403);
      assert.equal((await db.user.findUniqueOrThrow({ where: { email: address } })).timezone, 'Europe/Paris');
    });

    test('CORS preflight allows PATCH from the web origin', async () => {
      const response = await fetch(`${baseUrl}/api/account`, {
        method: 'OPTIONS', signal: AbortSignal.timeout(5_000),
        headers: { origin, 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'authorization,content-type' },
      });
      assert.ok(response.status === 204 || response.status === 200);
      assert.match(response.headers.get('access-control-allow-methods') ?? '', /PATCH/);
    });

    test('a wrong current password is a 400 field error and revokes nothing', async () => {
      const result = await request('/api/auth/change-password', {
        method: 'POST', token: current.body.accessToken,
        body: { currentPassword: 'Not the right password', newPassword: 'Unused replacement 2026!' },
      });
      assert.equal(result.status, 400);
      assert.equal(typeof result.body.fieldErrors.currentPassword, 'string');
      assert.equal(result.cookie, null);
      assert.equal((await request('/api/auth/me', { token: current.body.accessToken })).status, 200);
    });

    test('change password revokes every old session, keeps this device signed in and swaps passwords', async () => {
      const other = await settingsLogin(password);
      assertAuthResult(other, 200, address);
      const result = await request('/api/auth/change-password', {
        method: 'POST', token: current.body.accessToken, cookie: current.cookie,
        body: { currentPassword: password, newPassword: original },
      });
      assertAuthResult(result, 200, address);
      assertPrivateResponse(result.body);
      const user = await db.user.findUniqueOrThrow({ where: { email: address } });
      assert.match(user.passwordHash, /^\$argon2id\$v=19\$/);
      const active = await db.session.findMany({ where: { userId: user.id, revokedAt: null } });
      assert.equal(active.length, 1);
      assert.equal(active[0].refreshTokenHash, sha256(rawRefresh(result.cookie)));
      for (const session of [current, other]) {
        assert.equal((await request('/api/auth/me', { token: session.body.accessToken })).status, 401);
        assert.equal((await request('/api/auth/refresh', { method: 'POST', cookie: session.cookie })).status, 401);
      }
      assert.equal((await request('/api/auth/me', { token: result.body.accessToken })).status, 200);
      assertAuthResult(await request('/api/auth/refresh', { method: 'POST', cookie: result.cookie }), 200, address);
      assert.equal((await settingsLogin(password)).status, 401);
      assertAuthResult(await settingsLogin(original), 200, address);
    });

    test('change password requires authentication and rejects cross-origin browsers', async () => {
      const body = { currentPassword: original, newPassword: 'Yet another password 2026!' };
      assert.equal((await request('/api/auth/change-password', { method: 'POST', body })).status, 401);
      const session = await settingsLogin(original);
      const foreign = await request('/api/auth/change-password', {
        method: 'POST', token: session.body.accessToken, body, requestOrigin: 'https://evil.example',
      });
      assert.equal(foreign.status, 403);
      assert.equal((await request('/api/auth/me', { token: session.body.accessToken })).status, 200);
    });
  });
});
