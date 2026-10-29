import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, AuthClient, StaleSessionError } from './api.ts';
import type { User } from './api.ts';
import { clearChallenge, pendingChallenge, readChallenge, saveChallenge } from './challenge.ts';

const user: User = { id: 'u-1', email: 'ban@example.com', displayName: 'Minh An', timezone: 'Asia/Ho_Chi_Minh', privacyLevel: 'TEXT_AND_EMBEDDINGS' };
const session = (token: string) => Response.json({ accessToken: token, expiresIn: 900, user });
const unauthorized = () => Response.json({ message: 'Phiên đã hết hạn.' }, { status: 401 });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

test('registration requests email verification without authenticating; only a correct code creates a session', async () => {
  const challenge = { challengeId: 'registration-1', email: user.email, expiresIn: 600, resendAfter: 60, message: 'Mã xác minh đã được gửi.' };
  let protectedToken: string | null = null;
  const client = new AuthClient(async (url, init) => {
    assert.equal(init?.credentials, 'include');
    if (url === '/api/auth/refresh') return unauthorized();
    if (url === '/api/auth/register') {
      assert.deepEqual(JSON.parse(String(init?.body)), { email: user.email, password: 'a long secret phrase', displayName: 'Minh An' });
      return Response.json(challenge, { status: 202 });
    }
    if (url === '/api/auth/verify-email') {
      assert.deepEqual(JSON.parse(String(init?.body)), { challengeId: 'registration-1', code: '123456' });
      return session('verified-token');
    }
    protectedToken = new Headers(init?.headers).get('Authorization');
    return Response.json(user);
  });
  await client.restore();
  assert.deepEqual(await client.startRegistration({ email: user.email, password: 'a long secret phrase', displayName: 'Minh An' }), challenge);
  assert.equal(client.getSnapshot().status, 'anonymous');
  assert.deepEqual(await client.verifyEmail({ challengeId: challenge.challengeId, code: '123456' }), user);
  assert.equal(client.getSnapshot().status, 'authenticated');
  await client.request('/auth/me');
  assert.equal(protectedToken, 'Bearer verified-token');
});

test('wrong email code reports an inline field error and never authenticates', async () => {
  const client = new AuthClient(async (url) => url === '/api/auth/refresh' ? unauthorized() : Response.json({ message: 'Mã chưa đúng.', fieldErrors: { code: 'Mã chưa đúng.' } }, { status: 400 }));
  await client.restore();
  await assert.rejects(client.verifyEmail({ challengeId: 'registration-1', code: '000000' }), (error: unknown) => error instanceof ApiError && error.fieldErrors.code === 'Mã chưa đúng.');
  assert.equal(client.getSnapshot().status, 'anonymous');
});

test('password recovery uses the generic challenge contract, resend replaces the id, and reset never signs in', async () => {
  const seen: [string, unknown][] = [];
  const client = new AuthClient(async (url, init) => {
    if (url === '/api/auth/refresh') return unauthorized();
    seen.push([String(url), JSON.parse(String(init?.body))]);
    if (url === '/api/auth/reset-password') return Response.json({ message: 'Mật khẩu đã được đặt lại.' });
    return Response.json({ challengeId: url === '/api/auth/resend-code' ? 'reset-2' : 'reset-1', email: user.email, expiresIn: 600, resendAfter: 60, message: 'Nếu email thuộc một tài khoản, mã sẽ được gửi.' }, { status: url === '/api/auth/forgot-password' ? 202 : 200 });
  });
  await client.restore();
  const first = await client.forgotPassword(user.email);
  const replacement = await client.resendCode(first.challengeId);
  assert.equal(replacement.challengeId, 'reset-2');
  await client.resetPassword({ challengeId: replacement.challengeId, code: '123456', password: 'a new long password' });
  assert.deepEqual(seen, [
    ['/api/auth/forgot-password', { email: user.email }],
    ['/api/auth/resend-code', { challengeId: 'reset-1' }],
    ['/api/auth/reset-password', { challengeId: 'reset-2', code: '123456', password: 'a new long password' }],
  ]);
  assert.equal(client.getSnapshot().status, 'anonymous');
});

test('challenge storage resumes expiry and cooldown without persisting passwords, codes or tokens', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) } });
  try {
    const challenge = pendingChallenge({ challengeId: 'pending', email: user.email, expiresIn: 600, resendAfter: 60, message: 'Sent' }, 'registration', 1000);
    saveChallenge({ ...challenge, password: 'not for storage', code: '123456', accessToken: 'not for storage' } as typeof challenge);
    const serialized = stored.get('docflow.challenge.registration')!;
    assert.deepEqual(JSON.parse(serialized), { challengeId: 'pending', email: user.email, purpose: 'registration', expiresAt: 601000, resendAt: 61000 });
    assert.deepEqual(readChallenge('registration'), challenge);
    assert.equal(readChallenge('password-reset'), null);
    clearChallenge('registration');
    assert.equal(readChallenge('registration'), null);
    assert.equal(stored.size, 0);
  } finally {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});

test('restoring twice shares one refresh and keeps credentials in the HttpOnly-cookie flow', async () => {
  let calls = 0;
  const pending = deferred<Response>();
  const client = new AuthClient(async (url, init) => {
    assert.equal(url, '/api/auth/refresh');
    assert.equal(init?.credentials, 'include');
    assert.equal(new Headers(init?.headers).get('Authorization'), null);
    calls++;
    return pending.promise;
  });
  const first = client.restore();
  const second = client.restore();
  assert.equal(first, second);
  pending.resolve(session('restored-token'));
  await first;
  assert.equal(calls, 1);
  assert.deepEqual(client.getSnapshot().user, user);
});

test('concurrent expired protected requests rotate refresh once and retry with the new token', async () => {
  let refreshCalls = 0;
  const refreshResponse = deferred<Response>();
  const requests: string[] = [];
  const client = new AuthClient(async (url, init) => {
    if (url === '/api/auth/login') return session('expired');
    if (url === '/api/auth/refresh') { refreshCalls++; return refreshResponse.promise; }
    const authorization = new Headers(init?.headers).get('Authorization')!;
    requests.push(authorization);
    return authorization === 'Bearer expired' ? unauthorized() : Response.json(user);
  });
  await client.authenticate('login', { email: user.email, password: 'long-password' });
  const first = client.request<User>('/auth/me');
  const second = client.request<User>('/auth/me');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(refreshCalls, 1);
  refreshResponse.resolve(session('fresh'));
  assert.deepEqual(await Promise.all([first, second]), [user, user]);
  assert.deepEqual(requests, ['Bearer expired', 'Bearer expired', 'Bearer fresh', 'Bearer fresh']);
});

test('an old 401 arriving after another request refreshed does not rotate again', async () => {
  let protectedCalls = 0;
  let refreshCalls = 0;
  const late401 = deferred<Response>();
  const client = new AuthClient(async (url, init) => {
    if (url === '/api/auth/login') return session('old');
    if (url === '/api/auth/refresh') { refreshCalls++; return session('new'); }
    protectedCalls++;
    if (protectedCalls === 1) return late401.promise;
    return new Headers(init?.headers).get('Authorization') === 'Bearer old' ? unauthorized() : Response.json(user);
  });
  await client.authenticate('login', { email: user.email, password: 'long-password' });
  const late = client.request<User>('/auth/me');
  assert.deepEqual(await client.request<User>('/auth/me'), user);
  late401.resolve(unauthorized());
  assert.deepEqual(await late, user);
  assert.equal(refreshCalls, 1);
});

test('a rejected retry ends the session without an infinite refresh loop', async () => {
  let refreshCalls = 0;
  let protectedCalls = 0;
  const client = new AuthClient(async (url) => {
    if (url === '/api/auth/login') return session('old');
    if (url === '/api/auth/refresh') { refreshCalls++; return session('new'); }
    protectedCalls++; return unauthorized();
  });
  await client.authenticate('login', { email: user.email, password: 'long-password' });
  await assert.rejects(client.request('/auth/me'), (error: unknown) => error instanceof ApiError && error.status === 401);
  assert.equal(refreshCalls, 1);
  assert.equal(protectedCalls, 2);
  assert.deepEqual(client.getSnapshot(), { status: 'anonymous', user: null, expired: true });
});

test('a refresh in progress cannot sign a user back in after logout', async () => {
  const pending = deferred<Response>();
  const client = new AuthClient(async (url) => {
    if (url === '/api/auth/login') return session('old');
    if (url === '/api/auth/refresh') return pending.promise;
    if (url === '/api/auth/logout') return new Response(null, { status: 204 });
    throw new Error(`Unexpected ${url}`);
  });
  await client.authenticate('login', { email: user.email, password: 'long-password' });
  const refresh = client.refresh();
  const rejection = assert.rejects(refresh, StaleSessionError);
  await client.logout();
  pending.resolve(session('stale'));
  await rejection;
  assert.equal(client.getSnapshot().status, 'anonymous');
});

test('logout refreshes an expired access token before revoking the session', async () => {
  const calls: string[] = [];
  const client = new AuthClient(async (url, init) => {
    if (url === '/api/auth/login') return session('old');
    calls.push(`${url} ${new Headers(init?.headers).get('Authorization') || ''}`.trim());
    if (url === '/api/auth/refresh') return session('new');
    if (url === '/api/auth/logout') return new Headers(init?.headers).get('Authorization') === 'Bearer old' ? unauthorized() : new Response(null, { status: 204 });
    throw new Error('Unexpected call');
  });
  await client.authenticate('login', { email: user.email, password: 'long-password' });
  await client.logout();
  assert.deepEqual(calls, ['/api/auth/logout Bearer old', '/api/auth/refresh', '/api/auth/logout Bearer new']);
  assert.equal(client.getSnapshot().status, 'anonymous');
});

test('a network error does not claim server-side logout succeeded', async () => {
  const client = new AuthClient(async (url) => {
    if (url === '/api/auth/login') return session('old');
    throw new TypeError('Network unavailable');
  });
  await client.authenticate('login', { email: user.email, password: 'long-password' });
  await assert.rejects(client.logout(), (error: unknown) => error instanceof ApiError && error.status === 0);
  assert.equal(client.getSnapshot().status, 'authenticated');
});

test('protected data arriving after logout is discarded', async () => {
  const pending = deferred<Response>();
  const client = new AuthClient(async (url) => {
    if (url === '/api/auth/login') return session('old');
    if (url === '/api/auth/logout') return new Response(null, { status: 204 });
    return pending.promise;
  });
  await client.authenticate('login', { email: user.email, password: 'long-password' });
  const profile = client.request('/auth/me');
  const rejection = assert.rejects(profile, StaleSessionError);
  await client.logout();
  pending.resolve(Response.json(user));
  await rejection;
});
