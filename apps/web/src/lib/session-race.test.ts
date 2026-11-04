// Two tabs share one HttpOnly refresh cookie. These tests model the browser jar and a
// server with one-time refresh tokens, and hold responses back to force the ordering
// in which a late response could overwrite a newer cookie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthClient } from './api.ts';
import type { Exclusive, User } from './api.ts';

const user: User = { id: 'u-1', email: 'ban@example.com', displayName: null, timezone: 'Asia/Ho_Chi_Minh', privacyLevel: 'TEXT_AND_EMBEDDINGS' };

/** Same-origin lock shared by every "tab", like navigator.locks. */
function sharedLock(): Exclusive {
  let tail: Promise<unknown> = Promise.resolve();
  return <T,>(run: () => Promise<T>) => {
    const result = tail.then(run);
    tail = result.catch(() => undefined);
    return result;
  };
}

const passthrough: Exclusive = (run) => run();

function browser() {
  let cookie: string | null = null;
  let counter = 0;
  const refresh = new Map<string, { sid: string; active: boolean }>();
  const sessions = new Map<string, boolean>();
  const issue = () => {
    const sid = `s${++counter}`;
    sessions.set(sid, true);
    const token = `r${++counter}`;
    refresh.set(token, { sid, active: true });
    return { sid, token };
  };
  const first = issue();
  cookie = first.token;
  const held = new Map<string, { release: () => void; sent: Promise<void> }>();

  /** Hold the next response for `path` until release() is called. */
  function hold(path: string) {
    let release!: () => void;
    let markSent!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sent = new Promise<void>((resolve) => { markSent = resolve; });
    held.set(path, { release, sent });
    return { release, sent, gate, markSent };
  }
  const gates = new Map<string, ReturnType<typeof hold>>();

  const fetcher: typeof fetch = async (input, init) => {
    const path = String(input).replace(/^\/api/, '');
    const bearer = new Headers(init?.headers).get('Authorization')?.replace('Bearer ', '') ?? null;
    // The server handles the request when it is sent, with the cookie the jar holds now.
    let status = 200;
    let body: unknown = null;
    let setCookie: string | null | undefined;
    if (path === '/auth/refresh') {
      const row = cookie ? refresh.get(cookie) : undefined;
      if (!row?.active || !sessions.get(row.sid)) status = 401;
      else {
        row.active = false;
        const token = `r${++counter}`;
        refresh.set(token, { sid: row.sid, active: true });
        setCookie = token;
        body = { accessToken: `a:${row.sid}`, expiresIn: 900, user };
      }
    } else if (path === '/auth/change-password') {
      const sid = bearer?.slice(2);
      if (!sid || !sessions.get(sid)) status = 401;
      else {
        for (const key of sessions.keys()) sessions.set(key, false);
        const next = issue();
        setCookie = next.token;
        body = { accessToken: `a:${next.sid}`, expiresIn: 900, user };
      }
    } else if (path === '/auth/logout') {
      const sid = bearer?.slice(2);
      if (sid) sessions.set(sid, false);
      setCookie = null;
      status = 204;
    } else {
      const sid = bearer?.slice(2);
      status = sid && sessions.get(sid) ? 200 : 401;
      body = status === 200 ? user : { message: 'Phiên đã hết hạn.' };
    }
    const gate = gates.get(path);
    if (gate) { gates.delete(path); gate.markSent(); await gate.gate; }
    // The browser stores Set-Cookie when the response arrives, before fetch resolves.
    if (setCookie !== undefined) cookie = setCookie;
    return status === 204 ? new Response(null, { status }) : Response.json(body, { status });
  };
  return {
    fetcher,
    hold: (path: string) => { const gate = hold(path); gates.set(path, gate); return gate; },
    cookieIsLive: () => Boolean(cookie && refresh.get(cookie)?.active && sessions.get(refresh.get(cookie)!.sid)),
  };
}

async function lateRefreshDuringPasswordChange(lock: Exclusive) {
  const shared = browser();
  const tabA = new AuthClient(shared.fetcher, lock);
  const tabB = new AuthClient(shared.fetcher, lock);
  await tabA.restore();
  await tabB.restore();
  // Tab B starts a refresh whose response will arrive late.
  const late = shared.hold('/auth/refresh');
  const refreshB = tabB.refresh().catch(() => undefined);
  await late.sent;
  // Tab A changes the password; let any network work it can do finish.
  const change = tabA.changePassword({ currentPassword: 'current secret phrase', newPassword: 'a new secret phrase' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  late.release();
  await refreshB;
  await change;
  // "Reload" tab A: a fresh client can only use the cookie in the jar.
  const reloaded = new AuthClient(shared.fetcher, lock);
  await reloaded.restore();
  return { shared, tabA, reloaded };
}

test('without a cross-tab lock, a late refresh response overwrites the cookie issued by a password change', async () => {
  const { shared, reloaded } = await lateRefreshDuringPasswordChange(passthrough);
  assert.equal(shared.cookieIsLive(), false);
  assert.equal(reloaded.getSnapshot().status, 'anonymous');
});

test('with the session lock, the password-change cookie survives a slow refresh in another tab and a reload stays signed in', async () => {
  const { shared, tabA, reloaded } = await lateRefreshDuringPasswordChange(sharedLock());
  assert.equal(tabA.getSnapshot().status, 'authenticated');
  assert.equal(shared.cookieIsLive(), true);
  assert.equal(reloaded.getSnapshot().status, 'authenticated');
});

test('two tabs restoring at the same time both stay signed in with the session lock', async () => {
  const shared = browser();
  const lock = sharedLock();
  const tabs = [new AuthClient(shared.fetcher, lock), new AuthClient(shared.fetcher, lock)];
  const slow = shared.hold('/auth/refresh');
  const restoring = tabs.map((tab) => tab.restore());
  await slow.sent;
  slow.release();
  await Promise.all(restoring);
  assert.deepEqual(tabs.map((tab) => tab.getSnapshot().status), ['authenticated', 'authenticated']);
  assert.equal(shared.cookieIsLive(), true);
});
