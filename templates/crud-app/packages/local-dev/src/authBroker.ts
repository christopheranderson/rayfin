/**
 * @packageDocumentation
 * Node-side session broker behind the Fabric auth proxy.
 *
 * Owns three concerns, all environment-agnostic so they can be unit-tested
 * without a running Vite server:
 *
 * - **Cache** — the most recent Rayfin {@link TokenResponse} plus the context
 *   ({@link RefreshContext}) needed to refresh it. Kept in memory only; the
 *   dev-server process is the trust boundary and lifetime.
 * - **Refresh** — when a cached access token is near expiry the broker silently
 *   trades the refresh token for a new pair against the remote backend, so a
 *   WebView reload never forces a fresh interactive login.
 * - **Rendezvous** — a `state`-keyed registry of in-flight logins. The
 *   `GET /.rayfin-local/auth/fabric-proxy` handler awaits {@link beginLogin}; the
 *   `POST .../callback` handler resolves it via {@link completeLogin} when the
 *   system-browser bridge deposits the captured token.
 *
 * The broker never touches `http`/`vite`/`child_process` — the middleware layer
 * (`authMiddleware`) adapts it to the dev server. `now` and `fetchImpl`
 * are injectable purely so tests can drive time and the network deterministically.
 */

import {
  DEFAULT_AUTH_LOGIN_TIMEOUT_MS,
  DEFAULT_AUTH_REFRESH_SKEW_MS,
} from './constants.js';

/** Rayfin token pair as returned by `POST /api/auth/v1/token`. */
export interface TokenResponse {
  /** The JWT access token. */
  accessToken: string;
  /** The token type; always `"Bearer"`. */
  tokenType: string;
  /** Access token lifetime in seconds (not milliseconds). */
  expiresIn: number;
  /** The revolving refresh token, when issued. */
  refreshToken?: string | null;
}

/** What the broker needs to refresh a cached token against the backend. */
export interface RefreshContext {
  /**
   * Absolute backend base URL the token was minted against (the same value the
   * SDK is configured with — in Fabric mode the long `pbidedicated` URL ending
   * in `/appbackends/<id>/`). `/api/auth/v1/token` is appended to it.
   */
  apiUrl: string;
  /** Publishable key sent as `X-Publishable-Key` on the refresh request. */
  publishableKey: string;
}

/** A cached session and everything required to keep it alive. */
interface CachedSession {
  tokenResponse: TokenResponse;
  /** `now()` at which `tokenResponse` was obtained/refreshed. */
  obtainedAt: number;
  refresh: RefreshContext;
}

interface PendingLogin {
  resolve: (token: TokenResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Options for {@link FabricAuthBroker}. */
export interface FabricAuthBrokerOptions {
  /** Max ms a pending login waits for the bridge deposit. */
  loginTimeoutMs?: number;
  /** Refresh this many ms before the access token actually expires. */
  refreshSkewMs?: number;
  /** Clock source (ms). Injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** `fetch` implementation. Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Optional structured logger. */
  log?: (message: string) => void;
}

/**
 * Join an absolute backend base URL with the token endpoint path, collapsing
 * the seam so a base that already carries a path prefix keeps it. Mirrors the
 * join logic the request-forwarding proxy uses, so the resolved token URL lines
 * up exactly with what the SDK would call.
 */
export function resolveTokenUrl(apiUrl: string): string {
  const base = new URL(apiUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  return new URL(`${basePath}/api/auth/v1/token`, base.origin).href;
}

/** Error thrown when a pending login times out or is aborted. */
export class FabricAuthLoginError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = 'FabricAuthLoginError';
  }
}

export class FabricAuthBroker {
  private cache: CachedSession | null = null;
  private readonly pending = new Map<string, PendingLogin>();

  private readonly loginTimeoutMs: number;
  private readonly refreshSkewMs: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (message: string) => void;

  constructor(options: FabricAuthBrokerOptions = {}) {
    this.loginTimeoutMs =
      options.loginTimeoutMs ?? DEFAULT_AUTH_LOGIN_TIMEOUT_MS;
    this.refreshSkewMs = options.refreshSkewMs ?? DEFAULT_AUTH_REFRESH_SKEW_MS;
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? (() => {});
  }

  /** Is there any cached session (fresh or stale)? */
  hasSession(): boolean {
    return this.cache !== null;
  }

  /** Is a login with this `state` currently awaiting a deposit? */
  hasPending(state: string): boolean {
    return this.pending.has(state);
  }

  /**
   * Return a usable token without launching an interactive login: the cached
   * token when still fresh, a silently-refreshed token when it has (nearly)
   * expired but a refresh token is available, or `null` when neither applies.
   */
  async getValidToken(): Promise<TokenResponse | null> {
    if (!this.cache) return null;
    if (this.isFresh(this.cache)) return this.cache.tokenResponse;

    if (this.cache.tokenResponse.refreshToken) {
      const refreshed = await this.refresh(this.cache);
      if (refreshed) return refreshed;
    }

    // Expired and unrefreshable — drop it so the caller starts a fresh login.
    this.log('cached session expired and could not be refreshed; evicting');
    this.cache = null;
    return null;
  }

  /**
   * Register an in-flight login keyed by `state` and return a promise that
   * resolves when {@link completeLogin} deposits a matching token, or rejects on
   * timeout. Caller is responsible for actually launching the system browser.
   */
  beginLogin(state: string): Promise<TokenResponse> {
    // Replace any prior pending login for the same state (shouldn't happen with
    // random state, but keep the map single-valued and leak-free).
    this.abortPending(state, 'superseded by a newer login request');

    return new Promise<TokenResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(state);
        this.log(
          `login timed out after ${this.loginTimeoutMs}ms (state=${state})`
        );
        reject(
          new FabricAuthLoginError(
            `Fabric login timed out after ${Math.round(
              this.loginTimeoutMs / 1000
            )}s.`,
            'FABRIC_AUTH_TIMEOUT'
          )
        );
      }, this.loginTimeoutMs);
      // Don't keep the dev server alive just for a pending login.
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
      this.pending.set(state, { resolve, reject, timer });
    });
  }

  /**
   * Deposit the token captured by the bridge. Always caches (so a reload can be
   * served from cache even if the original request already timed out), and
   * resolves the matching pending login when one is still waiting.
   *
   * @returns `true` when a pending login was resolved, `false` when the token
   *   was only cached (no matching waiter).
   */
  completeLogin(
    state: string,
    tokenResponse: TokenResponse,
    refresh: RefreshContext
  ): boolean {
    this.cache = { tokenResponse, obtainedAt: this.now(), refresh };

    const waiter = this.pending.get(state);
    if (!waiter) {
      this.log(`deposit for unknown/expired state=${state}; cached only`);
      return false;
    }
    clearTimeout(waiter.timer);
    this.pending.delete(state);
    waiter.resolve(tokenResponse);
    return true;
  }

  /** Reject a pending login (e.g. the bridge reported a failure). */
  failLogin(state: string, message: string, code = 'FABRIC_AUTH_FAILED'): void {
    this.abortPending(state, message, code);
  }

  /** Evict the cached session. Does not disturb in-flight logins. */
  logout(): void {
    this.cache = null;
    this.log('session evicted via logout');
  }

  private abortPending(
    state: string,
    message: string,
    code = 'FABRIC_AUTH_ABORTED'
  ) {
    const waiter = this.pending.get(state);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.pending.delete(state);
    waiter.reject(new FabricAuthLoginError(message, code));
  }

  private isFresh(session: CachedSession): boolean {
    const expiresAt =
      session.obtainedAt + session.tokenResponse.expiresIn * 1000;
    return this.now() < expiresAt - this.refreshSkewMs;
  }

  private async refresh(session: CachedSession): Promise<TokenResponse | null> {
    const refreshToken = session.tokenResponse.refreshToken;
    if (!refreshToken) return null;

    const url = resolveTokenUrl(session.refresh.apiUrl);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Publishable-Key': session.refresh.publishableKey,
        },
        body: JSON.stringify({
          grantType: 'refresh_token',
          refreshToken,
        }),
      });
      if (!res.ok) {
        this.log(`refresh failed: HTTP ${res.status} from ${url}`);
        return null;
      }
      const body = (await res.json()) as Partial<TokenResponse>;
      if (!body || typeof body.accessToken !== 'string') {
        this.log('refresh response missing accessToken');
        return null;
      }
      const next: TokenResponse = {
        accessToken: body.accessToken,
        tokenType: body.tokenType ?? 'Bearer',
        expiresIn: typeof body.expiresIn === 'number' ? body.expiresIn : 900,
        // Refresh tokens rotate; fall back to the prior one if none returned.
        refreshToken: body.refreshToken ?? refreshToken,
      };
      this.cache = {
        tokenResponse: next,
        obtainedAt: this.now(),
        refresh: session.refresh,
      };
      this.log('access token refreshed');
      return next;
    } catch (err) {
      this.log(`refresh threw: ${(err as Error).message}`);
      return null;
    }
  }
}
