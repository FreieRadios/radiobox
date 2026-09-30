/**
 * A read-only device login at eve.
 *
 * `POST /auth/login` gives an access token (15 min) and a refresh token
 * (7 days, single use); `POST /auth/refresh` trades the refresh token for a
 * fresh pair. A refresh token that was used already, or is too old, is a 401
 * — then studiobox signs in again. Nothing here ever writes to eve.
 */

/** The part of `fetch` this uses, so tests can hand in their own. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Why a request failed, in the terms the page needs: eve unreachable, or
 *  the credentials no longer let us in (nothing a retry will fix). */
export class EveError extends Error {
  constructor(
    message: string,
    readonly kind: 'offline' | 'denied',
    readonly status?: number
  ) {
    super(message);
  }
}

export interface EveSessionOptions {
  url: string;
  username: string;
  password: string;
  fetch?: FetchLike;
  now?: () => number;
  /** Per-request timeout, ms. */
  timeoutMs?: number;
}

/** Renew this long before the access token runs out, so a request never
 *  goes out with a token that expires on the way. */
const RENEW_BEFORE_MS = 60_000;

/** Expiry of a JWT from its `exp` claim, ms; null when it has none. */
export function jwtExpiryMs(token: string): number | null {
  try {
    const payload = token.split('.')[1] ?? '';
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

export class EveSession {
  private readonly base: string;
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private access: string | null = null;
  private accessUntil = 0;
  private refreshToken: string | null = null;
  /** One sign-in at a time: concurrent requests wait for the same one. */
  private pending: Promise<string> | null = null;

  constructor(private opts: EveSessionOptions) {
    this.base = opts.url.replace(/\/+$/, '');
    this.fetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  get url(): string {
    return this.base;
  }

  /** A current access token: the one we have, a refreshed one, or a new
   *  login — in that order. */
  token(): Promise<string> {
    if (this.access && this.now() < this.accessUntil - RENEW_BEFORE_MS) {
      return Promise.resolve(this.access);
    }
    this.pending ??= this.renew().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** Forget the access token (eve said 401 to it), keep the refresh token. */
  invalidate(): void {
    this.access = null;
    this.accessUntil = 0;
  }

  /** GET a JSON document with the token; a 401 renews the token once. */
  async get(pathAndQuery: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.token();
      const res = await this.request(pathAndQuery, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status === 401 && attempt === 0) {
        this.invalidate();
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new EveError(`${pathAndQuery}: ${res.status}`, 'denied', res.status);
      }
      if (!res.ok) throw new EveError(`${pathAndQuery}: HTTP ${res.status}`, 'offline', res.status);
      return res.json();
    }
  }

  private async renew(): Promise<string> {
    if (this.refreshToken) {
      const res = await this.request('/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: this.refreshToken }),
      });
      // Either way the refresh token is spent now.
      this.refreshToken = null;
      if (res.ok) return this.accept(await res.json());
      if (res.status !== 401 && res.status !== 400) {
        throw new EveError(`/auth/refresh: HTTP ${res.status}`, 'offline', res.status);
      }
      // `invalid-session`: sign in again below.
    }
    const res = await this.request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: this.opts.username, password: this.opts.password }),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new EveError(`sign-in as "${this.opts.username}" refused`, 'denied', res.status);
    }
    if (!res.ok) throw new EveError(`/auth/login: HTTP ${res.status}`, 'offline', res.status);
    return this.accept(await res.json());
  }

  private accept(body: unknown): string {
    const b = (body ?? {}) as { token?: unknown; refreshToken?: unknown };
    if (typeof b.token !== 'string' || !b.token) {
      throw new EveError('sign-in answered without a token', 'offline');
    }
    this.access = b.token;
    // Without an `exp` claim, assume the documented 15 minutes.
    this.accessUntil = jwtExpiryMs(b.token) ?? this.now() + 15 * 60_000;
    this.refreshToken = typeof b.refreshToken === 'string' ? b.refreshToken : null;
    return b.token;
  }

  private async request(
    pathAndQuery: string,
    init: { method?: string; headers?: Record<string, string>; body?: string }
  ) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      return await this.fetch(this.base + pathAndQuery, {
        ...init,
        headers: {
          accept: 'application/json',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
        signal: ctl.signal,
      });
    } catch (err) {
      throw new EveError(`${pathAndQuery}: ${(err as Error).message}`, 'offline');
    } finally {
      clearTimeout(timer);
    }
  }
}
