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

  constructor(fetcher: Fetcher = globalThis.fetch.bind(globalThis)) { this.#fetch = fetcher; }

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
        const response = await this.#raw('/auth/refresh', { method: 'POST' });
        if (epoch !== this.#epoch) throw new StaleSessionError();
        const session = await this.#decode<SessionResponse>(response);
        if (epoch !== this.#epoch) throw new StaleSessionError();
        this.#token = session.accessToken;
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
    const response = await this.#raw(path, { method: 'POST', body: JSON.stringify(input) });
    if (epoch !== this.#epoch) throw new StaleSessionError();
    const session = await this.#decode<SessionResponse>(response);
    if (epoch !== this.#epoch) throw new StaleSessionError();
    this.#token = session.accessToken;
    this.#publish(session.user);
    return session.user;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (this.#loggingOut) throw new StaleSessionError();
    const epoch = this.#epoch;
    const token = this.#token;
    let response = await this.#raw(path, init, token);
    if (epoch !== this.#epoch) throw new StaleSessionError();
    if (response.status === 401) {
      if (token === this.#token) await this.refresh();
      if (epoch !== this.#epoch) throw new StaleSessionError();
      response = await this.#raw(path, init, this.#token);
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

  async logout(): Promise<void> {
    if (this.#loggingOut) return;
    this.#loggingOut = true;
    ++this.#epoch; // Discard any request or refresh that began before logout.
    try {
      let response = await this.#raw('/auth/logout', { method: 'POST' }, this.#token);
      if (response.status === 401) {
        const refresh = await this.#raw('/auth/refresh', { method: 'POST' });
        if (refresh.status === 401) {
          this.#token = null;
          this.#publish(null);
          return;
        }
        const session = await this.#decode<SessionResponse>(refresh);
        this.#token = session.accessToken;
        response = await this.#raw('/auth/logout', { method: 'POST' }, this.#token);
      }
      await this.#decode<void>(response);
      this.#token = null;
      this.#publish(null);
    } finally {
      this.#loggingOut = false;
    }
  }
}

export const authClient = new AuthClient();
