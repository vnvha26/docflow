import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, AuthClient, fileNameFrom, StaleSessionError } from './api.ts';
import type { Exclusive, User } from './api.ts';
import { clearChallenge, pendingChallenge, readChallenge, saveChallenge } from './challenge.ts';

const user: User = { id: 'u-1', email: 'ban@example.com', displayName: 'Minh An', timezone: 'Asia/Ho_Chi_Minh', privacyLevel: 'TEXT_AND_EMBEDDINGS' };
const session = (token: string) => Response.json({ accessToken: token, expiresIn: 900, user });
const unauthorized = () => Response.json({ message: 'Phiên đã hết hạn.' }, { status: 401 });
/** One tab's view of navigator.locks: exclusive, FIFO, not re-entrant. */
function tabLock(): Exclusive {
  let tail: Promise<unknown> = Promise.resolve();
  return <T,>(run: () => Promise<T>) => {
    const result = tail.then(run);
    tail = result.catch(() => undefined);
    return result;
  };
}
/** Browser without Web Locks (old browser, or plain HTTP on a non-localhost host). */
const noLocks: Exclusive = (run) => run();
// Explicit locks keep results independent of whether this Node version ships navigator.locks.
const newClient = (fetcher: typeof fetch, lock: Exclusive = tabLock()) => new AuthClient(fetcher, lock);

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

test('registration requests email verification without authenticating; only a correct code creates a session', async () => {
  const challenge = { challengeId: 'registration-1', email: user.email, expiresIn: 600, resendAfter: 60, message: 'Mã xác minh đã được gửi.' };
  let protectedToken: string | null = null;
  const client = newClient(async (url, init) => {
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
  const client = newClient(async (url) => url === '/api/auth/refresh' ? unauthorized() : Response.json({ message: 'Mã chưa đúng.', fieldErrors: { code: 'Mã chưa đúng.' } }, { status: 400 }));
  await client.restore();
  await assert.rejects(client.verifyEmail({ challengeId: 'registration-1', code: '000000' }), (error: unknown) => error instanceof ApiError && error.fieldErrors.code === 'Mã chưa đúng.');
  assert.equal(client.getSnapshot().status, 'anonymous');
});

test('password recovery uses the generic challenge contract, resend replaces the id, and reset never signs in', async () => {
  const seen: [string, unknown][] = [];
  const client = newClient(async (url, init) => {
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
  const client = newClient(async (url, init) => {
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
  const client = newClient(async (url, init) => {
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
  const client = newClient(async (url, init) => {
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
  const client = newClient(async (url) => {
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

test('with Web Locks, logout waits for an in-flight refresh, then revokes the session; the refresh cannot sign back in', async () => {
  const pending = deferred<Response>();
  const logoutTokens: (string | null)[] = [];
  const client = newClient(async (url, init) => {
    if (url === '/api/auth/login') return session('old');
    if (url === '/api/auth/refresh') return pending.promise;
    if (url === '/api/auth/logout') { logoutTokens.push(new Headers(init?.headers).get('Authorization')); return new Response(null, { status: 204 }); }
    throw new Error(`Unexpected ${url}`);
  });
  await client.authenticate('login', { email: user.email, password: 'long-password' });
  const refresh = client.refresh();
  const rejection = assert.rejects(refresh, StaleSessionError);
  const logout = client.logout();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(logoutTokens, [], 'logout must wait for the refresh holding the session lock');
  // The server answers the refresh independently of logout; only then can logout run.
  pending.resolve(session('stale'));
  await rejection;
  await logout;
  assert.deepEqual(logoutTokens, ['Bearer old']);
  assert.equal(client.getSnapshot().status, 'anonymous');
});

test('without Web Locks, a refresh response arriving after logout cannot sign the user back in', async () => {
  const pending = deferred<Response>();
  const client = newClient(async (url) => {
    if (url === '/api/auth/login') return session('old');
    if (url === '/api/auth/refresh') return pending.promise;
    if (url === '/api/auth/logout') return new Response(null, { status: 204 });
    throw new Error(`Unexpected ${url}`);
  }, noLocks);
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
  const client = newClient(async (url, init) => {
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
  const client = newClient(async (url) => {
    if (url === '/api/auth/login') return session('old');
    throw new TypeError('Network unavailable');
  });
  await client.authenticate('login', { email: user.email, password: 'long-password' });
  await assert.rejects(client.logout(), (error: unknown) => error instanceof ApiError && error.status === 0);
  assert.equal(client.getSnapshot().status, 'authenticated');
});

test('protected data arriving after logout is discarded', async () => {
  const pending = deferred<Response>();
  const client = newClient(async (url) => {
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

test('changing the password swaps to the new session token; a wrong current password keeps the old one', async () => {
  const authorizations: (string | null)[] = [];
  const client = newClient(async (url, init) => {
    if (url === '/api/auth/refresh') return session('old-token');
    if (url === '/api/auth/change-password') {
      const body = JSON.parse(String(init?.body));
      if (body.currentPassword !== 'current secret phrase') {
        return Response.json({ message: 'Mật khẩu hiện tại không đúng.', fieldErrors: { currentPassword: 'Mật khẩu hiện tại không đúng.' } }, { status: 400 });
      }
      return session('new-token');
    }
    authorizations.push(new Headers(init?.headers).get('Authorization'));
    return Response.json(user);
  });
  await client.restore();
  await assert.rejects(client.changePassword({ currentPassword: 'wrong phrase', newPassword: 'a new secret phrase' }),
    (error: unknown) => error instanceof ApiError && error.status === 400 && error.fieldErrors.currentPassword === 'Mật khẩu hiện tại không đúng.');
  assert.equal(client.getSnapshot().status, 'authenticated');
  await client.request('/auth/me');
  assert.deepEqual(await client.changePassword({ currentPassword: 'current secret phrase', newPassword: 'a new secret phrase' }), user);
  await client.request('/auth/me');
  assert.deepEqual(authorizations, ['Bearer old-token', 'Bearer new-token']);
});

test('updating the account publishes the saved user to every subscriber', async () => {
  const updated = { ...user, timezone: 'Europe/Paris' };
  const client = newClient(async (url, init) => {
    if (url === '/api/auth/refresh') return session('token');
    assert.equal(url, '/api/account');
    assert.equal(init?.method, 'PATCH');
    assert.deepEqual(JSON.parse(String(init?.body)), { timezone: 'Europe/Paris' });
    return Response.json(updated);
  });
  await client.restore();
  let notified = 0;
  client.subscribe(() => { notified++; });
  await client.updateAccount({ timezone: 'Europe/Paris' });
  assert.equal(client.getSnapshot().user?.timezone, 'Europe/Paris');
  assert.equal(notified, 1);
});

test('a request is never replayed for another account after a shared-cookie refresh switches users', async () => {
  const other: User = { ...user, id: 'u-2', email: 'khac@example.com' };
  const patches: (string | null)[] = [];
  let refreshes = 0;
  const client = newClient(async (url, init) => {
    if (url === '/api/auth/refresh') {
      refreshes++;
      // First refresh restores account A; the second sees the cookie another tab replaced with B.
      return refreshes === 1 ? session('token-a') : Response.json({ accessToken: 'token-b', expiresIn: 900, user: other });
    }
    patches.push(new Headers(init?.headers).get('Authorization'));
    return unauthorized();
  });
  await client.restore();
  await assert.rejects(client.updateAccount({ timezone: 'Europe/Paris' }), StaleSessionError);
  assert.deepEqual(patches, ['Bearer token-a']);
  assert.equal(client.getSnapshot().user?.id, 'u-2');
});

test('logout waits for an in-flight password change and revokes the session it created', async () => {
  const changed = deferred<Response>();
  const calls: [string, string | null][] = [];
  const client = newClient(async (url, init) => {
    calls.push([String(url), new Headers(init?.headers).get('Authorization')]);
    if (url === '/api/auth/refresh') return session('old-token');
    if (url === '/api/auth/change-password') return changed.promise;
    if (url === '/api/auth/logout') return new Response(null, { status: 204 });
    return Response.json(user);
  });
  await client.restore();
  const change = client.changePassword({ currentPassword: 'current secret phrase', newPassword: 'a new secret phrase' });
  const logout = client.logout();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(!calls.some(([url]) => url === '/api/auth/logout'), 'logout must not run before the password change settles');
  changed.resolve(session('new-token'));
  await change;
  await logout;
  assert.deepEqual(calls.find(([url]) => url === '/api/auth/logout'), ['/api/auth/logout', 'Bearer new-token']);
  assert.equal(client.getSnapshot().status, 'anonymous');
});

test('logout still runs when the in-flight password change fails', async () => {
  const changed = deferred<Response>();
  let loggedOutWith: string | null = null;
  const client = newClient(async (url, init) => {
    if (url === '/api/auth/refresh') return session('old-token');
    if (url === '/api/auth/change-password') return changed.promise;
    loggedOutWith = new Headers(init?.headers).get('Authorization');
    return new Response(null, { status: 204 });
  });
  await client.restore();
  const change = client.changePassword({ currentPassword: 'wrong phrase', newPassword: 'a new secret phrase' });
  const logout = client.logout();
  changed.resolve(Response.json({ message: 'Mật khẩu hiện tại không đúng.', fieldErrors: { currentPassword: 'x' } }, { status: 400 }));
  await assert.rejects(change, ApiError);
  await logout;
  assert.equal(loggedOutWith, 'Bearer old-token');
  assert.equal(client.getSnapshot().status, 'anonymous');
});

test('an upload queued for one account is never sent after the tab switches to another account', async () => {
  const other: User = { ...user, id: 'u-2', email: 'khac@example.com' };
  const uploads: (string | null)[] = [];
  let refreshes = 0;
  const client = newClient(async (url, init) => {
    if (url === '/api/auth/refresh') {
      refreshes++;
      return refreshes === 1 ? session('token-a') : Response.json({ accessToken: 'token-b', expiresIn: 900, user: other });
    }
    if (url === '/api/documents') {
      uploads.push(new Headers(init?.headers).get('Authorization'));
      return Response.json({ document: { id: 'd-1' }, duplicate: false }, { status: 201 });
    }
    return unauthorized();
  });
  await client.restore();
  const upload = () => {
    const form = new FormData();
    form.append('file', new Blob(['x']), 'a.txt');
    return client.request('/documents', { method: 'POST', body: form }, { asUser: user.id });
  };
  await upload();
  assert.deepEqual(uploads, ['Bearer token-a']);
  await assert.rejects(client.request('/auth/me'), StaleSessionError);
  assert.equal(client.getSnapshot().user?.id, 'u-2');
  await assert.rejects(upload(), StaleSessionError);
  assert.deepEqual(uploads, ['Bearer token-a'], 'the file chosen under A never reaches B');
});

test('uploads send FormData without a JSON content type; downloads refresh once and read the UTF-8 file name', async () => {
  const seen: { url: string; type: string | null; auth: string | null }[] = [];
  let downloads = 0;
  const client = newClient(async (url, init) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(url), type: headers.get('Content-Type'), auth: headers.get('Authorization') });
    if (url === '/api/auth/refresh') return session(seen.filter((entry) => entry.url === '/api/auth/refresh').length === 1 ? 'first' : 'second');
    if (url === '/api/documents') {
      assert.ok(init?.body instanceof FormData);
      return Response.json({ document: { id: 'd-1' }, duplicate: false }, { status: 201 });
    }
    downloads++;
    if (downloads === 1) return unauthorized();
    return new Response('nội dung', { headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="Bien ban.txt"; filename*=UTF-8''Bi%C3%AAn%20b%E1%BA%A3n.txt`,
    } });
  });
  await client.restore();
  const form = new FormData();
  form.append('file', new Blob(['x']), 'a.txt');
  await client.request('/documents', { method: 'POST', body: form });
  assert.equal(seen.find((entry) => entry.url === '/api/documents')?.type, null, 'the browser sets the multipart boundary');
  const file = await client.download('/documents/d-1/original');
  assert.equal(file.fileName, 'Biên bản.txt');
  assert.equal(await file.blob.text(), 'nội dung');
  assert.deepEqual(seen.filter((entry) => entry.url.endsWith('/original')).map((entry) => entry.auth), ['Bearer first', 'Bearer second']);
});

test('file names fall back to the ASCII form and failed downloads surface the server message', async () => {
  assert.equal(fileNameFrom('attachment; filename="report.pdf"'), 'report.pdf');
  assert.equal(fileNameFrom(`attachment; filename="x.pdf"; filename*=UTF-8''%E0%A4%A`), 'x.pdf');
  assert.equal(fileNameFrom(null), null);
  const client = newClient(async (url) => url === '/api/auth/refresh'
    ? session('token')
    : Response.json({ message: 'Tài liệu này không có bản gốc để tải.' }, { status: 404 }));
  await client.restore();
  await assert.rejects(client.download('/documents/x/original'), (error: unknown) => error instanceof ApiError && error.status === 404 && /bản gốc/.test(error.message));
});
