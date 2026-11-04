export interface User {
  id: string;
  email: string;
  displayName: string | null;
  timezone: string;
  privacyLevel: 'STRUCTURED_ONLY' | 'TEXT_AND_EMBEDDINGS' | 'ENCRYPTED_COPY';
}

interface SessionResponse {
  accessToken: string;
  expiresIn: number;
  user: User;
}

export interface ChallengeResponse {
  challengeId: string;
  email: string;
  expiresIn: number;
  resendAfter: number;
  message: string;
}

export interface AuthSnapshot {
  status: 'restoring' | 'authenticated' | 'anonymous';
  user: User | null;
  expired: boolean;
}

export class ApiError extends Error {
  status: number;
  fieldErrors: Record<string, string>;

  constructor(message: string, status = 0, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

export class StaleSessionError extends Error {
  constructor() { super('Phiên đã thay đổi. Vui lòng thử lại.'); }
}

type Fetcher = typeof fetch;

/** Runs `run` while holding a lock shared by every tab of this origin. */
export type Exclusive = <T>(run: () => Promise<T>) => Promise<T>;

const SESSION_LOCK = 'docflow-auth-session';
const SESSION_CALL_TIMEOUT_MS = 15_000;

/**
 * Every tab shares one HttpOnly refresh cookie. Calls that rotate or replace it
 * (refresh, login, verify-email, change-password, logout) must not overlap across
 * tabs: a late response would overwrite a newer cookie with a revoked one, and two
 * tabs refreshing the same one-time token would sign one of them out.
 * Web Locks are not re-entrant, so a locked section never calls another locked one.
 */
export function browserExclusive<T>(run: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  return locks ? locks.request(SESSION_LOCK, run) as Promise<T> : run();
}

/** Credentials remain in memory; the browser owns the HttpOnly refresh cookie. */
export class AuthClient {
  #fetch: Fetcher;
  #token: string | null = null;
  #epoch = 0;
  #listeners = new Set<() => void>();
  #snapshot: AuthSnapshot = { status: 'restoring', user: null, expired: false };
  #refreshFlight: { epoch: number; promise: Promise<User> } | null = null;
  #restorePromise: Promise<void> | null = null;
  #loggingOut = false;
  #passwordChange: Promise<User> | null = null;

  #exclusive: Exclusive;

  constructor(fetcher: Fetcher = globalThis.fetch.bind(globalThis), exclusive: Exclusive = browserExclusive) {
    this.#fetch = fetcher;
    this.#exclusive = exclusive;
  }

  getSnapshot = (): AuthSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #publish(user: User | null, expired = false) {
    this.#snapshot = { status: user ? 'authenticated' : 'anonymous', user, expired };
    this.#listeners.forEach((listener) => listener());
  }

  async #raw(path: string, init: RequestInit = {}, token?: string | null): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.body) headers.set('Content-Type', 'application/json');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    try {
      return await this.#fetch(`/api${path}`, { ...init, headers, credentials: 'include' });
    } catch {
      throw new ApiError('Không thể kết nối đến DocFlow. Kiểm tra kết nối rồi thử lại.');
    }
  }

  /** Bounded so a stalled request cannot hold the cross-tab lock indefinitely. */
  #timed(init: RequestInit): RequestInit {
    return { ...init, signal: AbortSignal.timeout(SESSION_CALL_TIMEOUT_MS) };
  }

  #exclusiveRaw(path: string, init: RequestInit = {}, token?: string | null): Promise<Response> {
    return this.#exclusive(() => this.#raw(path, this.#timed(init), token));
  }

  async #decode<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const fallback: Record<number, string> = {
        400: 'Thông tin chưa hợp lệ. Vui lòng kiểm tra lại.',
        401: 'Email hoặc mật khẩu chưa đúng.',
        409: 'Email này đã được sử dụng. Bạn có thể đăng nhập bằng tài khoản hiện có.',
        429: 'Bạn đã thử quá nhiều lần. Vui lòng đợi một chút rồi thử lại.',
      };
      const message = typeof data.message === 'string' ? data.message : fallback[response.status];
      const fields: Record<string, string> = {};
      if (data.fieldErrors && typeof data.fieldErrors === 'object') {
        for (const [field, value] of Object.entries(data.fieldErrors)) {
          if (typeof value === 'string') fields[field] = value;
        }
      }
      throw new ApiError(message || 'DocFlow đang gặp sự cố. Vui lòng thử lại sau.', response.status, fields);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  restore(): Promise<void> {
    if (!this.#restorePromise) {
      this.#restorePromise = this.refresh().then(() => undefined).catch(() => {
        if (this.#snapshot.status === 'restoring') this.#publish(null);
      });
    }
    return this.#restorePromise;
  }

  refresh(): Promise<User> {
    if (this.#loggingOut) return Promise.reject(new StaleSessionError());
    const epoch = this.#epoch;
    if (this.#refreshFlight?.epoch === epoch) return this.#refreshFlight.promise;
    const promise = (async () => {
      try {
        const response = await this.#exclusiveRaw('/auth/refresh', { method: 'POST' });
        if (epoch !== this.#epoch) throw new StaleSessionError();
        const session = await this.#decode<SessionResponse>(response);
        if (epoch !== this.#epoch) throw new StaleSessionError();
        const previous = this.#snapshot.user?.id;
        this.#token = session.accessToken;
        // The refresh cookie is shared by every tab. If another tab signed in as a
        // different account, nothing started for the previous account may continue.
        if (previous && previous !== session.user.id) ++this.#epoch;
        this.#publish(session.user);
        return session.user;
      } catch (error) {
        if (epoch === this.#epoch && error instanceof ApiError && error.status === 401) {
          const expired = this.#snapshot.status === 'authenticated';
          this.#token = null;
          this.#publish(null, expired);
        }
        throw error;
      } finally {
        if (this.#refreshFlight?.epoch === epoch) this.#refreshFlight = null;
      }
    })();
    this.#refreshFlight = { epoch, promise };
    return promise;
  }

  async #post<T>(path: string, input: object): Promise<T> {
    const epoch = this.#epoch;
    const response = await this.#raw(path, { method: 'POST', body: JSON.stringify(input) });
    if (epoch !== this.#epoch) throw new StaleSessionError();
    const result = await this.#decode<T>(response);
    if (epoch !== this.#epoch) throw new StaleSessionError();
    return result;
  }

  startRegistration(input: { email: string; password: string; displayName?: string }): Promise<ChallengeResponse> {
    ++this.#epoch;
    return this.#post<ChallengeResponse>('/auth/register', input);
  }

  forgotPassword(email: string): Promise<ChallengeResponse> {
    ++this.#epoch;
    return this.#post<ChallengeResponse>('/auth/forgot-password', { email });
  }

  resendCode(challengeId: string): Promise<ChallengeResponse> {
    return this.#post<ChallengeResponse>('/auth/resend-code', { challengeId });
  }

  resetPassword(input: { challengeId: string; code: string; password: string }): Promise<{ message: string }> {
    return this.#post<{ message: string }>('/auth/reset-password', input);
  }

  authenticate(kind: 'login', input: { email: string; password: string }): Promise<User> {
    return this.#createSession(`/auth/${kind}`, input);
  }

  verifyEmail(input: { challengeId: string; code: string }): Promise<User> {
    return this.#createSession('/auth/verify-email', input);
  }

  async #createSession(path: string, input: object): Promise<User> {
    const epoch = ++this.#epoch;
    const response = await this.#exclusiveRaw(path, { method: 'POST', body: JSON.stringify(input) });
    if (epoch !== this.#epoch) throw new StaleSessionError();
    const session = await this.#decode<SessionResponse>(response);
    if (epoch !== this.#epoch) throw new StaleSessionError();
    this.#token = session.accessToken;
    this.#publish(session.user);
    return session.user;
  }

  async request<T>(path: string, init: RequestInit = {}, options: { exclusive?: boolean } = {}): Promise<T> {
    if (this.#loggingOut) throw new StaleSessionError();
    // Only the network call is locked; refresh() below takes the lock itself.
    const send = (bearer: string | null) => options.exclusive ? this.#exclusiveRaw(path, init, bearer) : this.#raw(path, init, bearer);
    const epoch = this.#epoch;
    const token = this.#token;
    const owner = this.#snapshot.user?.id ?? null;
    let response = await send(token);
    if (epoch !== this.#epoch) throw new StaleSessionError();
    if (response.status === 401) {
      if (token === this.#token) await this.refresh();
      if (epoch !== this.#epoch) throw new StaleSessionError();
      // Defence in depth for the epoch check above: a retry must use a session of the
      // same account, or a save meant for account A would be written to account B.
      if (owner !== null && this.#snapshot.user?.id !== owner) throw new StaleSessionError();
      response = await send(this.#token);
      if (epoch !== this.#epoch) throw new StaleSessionError();
      if (response.status === 401) {
        this.#token = null;
        this.#publish(null, true);
      }
    }
    const result = await this.#decode<T>(response);
    if (epoch !== this.#epoch) throw new StaleSessionError();
    return result;
  }

  /** Keep the shared session snapshot in sync after the user edits their account. */
  async updateAccount(input: { displayName?: string; timezone?: string }): Promise<User> {
    const user = await this.request<User>('/account', { method: 'PATCH', body: JSON.stringify(input) });
    this.#publish(user);
    return user;
  }

  /**
   * The server revokes every old session (this one included) and returns a new one.
   * Bumping the epoch first stops a concurrent refresh with the old cookie from
   * signing this tab out when its now-revoked token is rejected.
   */
  changePassword(input: { currentPassword: string; newPassword: string }): Promise<User> {
    if (this.#passwordChange) return Promise.reject(new StaleSessionError());
    const run = (async () => {
      ++this.#epoch;
      const session = await this.request<SessionResponse>('/auth/change-password', { method: 'POST', body: JSON.stringify(input) }, { exclusive: true });
      this.#token = session.accessToken;
      this.#publish(session.user);
      return session.user;
    })();
    const tracked = run.finally(() => { if (this.#passwordChange === tracked) this.#passwordChange = null; });
    this.#passwordChange = tracked;
    return tracked;
  }

  async logout(): Promise<void> {
    if (this.#loggingOut) return;
    this.#loggingOut = true;
    try {
      // A password change in flight is about to replace the refresh cookie. If logout
      // ran first, that new session would survive and a reload would sign back in.
      // Let it finish (success or failure), then revoke whatever session is current.
      await this.#passwordChange?.catch(() => undefined);
      ++this.#epoch; // Discard any request or refresh that began before logout.
      await this.#exclusive(async () => {
        let response = await this.#raw('/auth/logout', this.#timed({ method: 'POST' }), this.#token);
        if (response.status === 401) {
          const refresh = await this.#raw('/auth/refresh', this.#timed({ method: 'POST' }));
          if (refresh.status === 401) {
            this.#token = null;
            this.#publish(null);
            return;
          }
          const session = await this.#decode<SessionResponse>(refresh);
          this.#token = session.accessToken;
          response = await this.#raw('/auth/logout', this.#timed({ method: 'POST' }), this.#token);
        }
        await this.#decode<void>(response);
        this.#token = null;
        this.#publish(null);
      });
    } finally {
      this.#loggingOut = false;
    }
  }
}

export const authClient = new AuthClient();
