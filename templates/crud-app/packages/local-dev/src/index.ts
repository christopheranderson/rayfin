/// <reference types="vite/client" />

/**
 * @packageDocumentation
 * Browser-side entry point for the Rayfin local-development helpers.
 *
 * The single job of this module is to answer one question for the frontend:
 * *what `baseUrl` should the `RayfinClient` be constructed with?* The answer
 * differs between a local Vite dev server and a production build:
 *
 * - **Local dev** (`vite`): return the same-origin proxy prefix (`/.rayfin`).
 *   Requests stay on the dev-server origin and are forwarded by the Vite plugin
 *   (`./vite`), which also transparently reroutes function calls to a
 *   locally-running Azure Functions host when one is detected. Keeping requests
 *   same-origin sidesteps CORS entirely.
 * - **Production build** (`vite build`): return the absolute backend URL from
 *   `VITE_RAYFIN_API_URL`, i.e. the existing mechanism. Nothing about the
 *   deployed app changes.
 *
 * Dev vs. production is decided by `import.meta.env.DEV`, which Vite sets to
 * `true` only while the dev server is running and `false` in any build output.
 */

import type { TokenResponse } from './authBroker.js';
import { RAYFIN_PROXY_PREFIX, RAYFIN_AUTH_PROXY_PATH } from './constants.js';

export {
  RAYFIN_PROXY_PREFIX,
  RAYFIN_AUTH_PROXY_PATH,
  FUNCTIONS_INVOKE_PREFIX,
  DEFAULT_FUNCTIONS_HOST,
  DEFAULT_FUNCTIONS_PORT,
} from './constants.js';

export type { TokenResponse } from './authBroker.js';

/**
 * The subset of `RayfinClient` configuration this helper resolves. Spread it
 * into the client constructor:
 *
 * ```ts
 * const client = new RayfinClient<Schema, FnSchema>(resolveRayfinConfig());
 * ```
 */
export interface ResolvedRayfinConfig {
  /**
   * Backend base URL for the `RayfinClient`. `/.rayfin` in local dev (same
   * origin, proxied) or the absolute `VITE_RAYFIN_API_URL` in a production
   * build.
   */
  baseUrl: string;
  /** Publishable key from `VITE_RAYFIN_PUBLISHABLE_KEY`. */
  publishableKey: string;
}

/**
 * `true` when running under the Vite dev server, `false` in a production build.
 *
 * Thin wrapper over `import.meta.env.DEV` so callers don't have to reach into
 * `import.meta` themselves and so the dev-detection rule lives in exactly one
 * place.
 */
export function isLocalDev(): boolean {
  return import.meta.env.DEV === true;
}

/**
 * Resolve the `RayfinClient` base configuration for the current runtime.
 *
 * In local dev the returned `baseUrl` routes through the same-origin
 * {@link RAYFIN_PROXY_PREFIX} proxy; in a production build it is the absolute
 * backend URL, exactly as before. Function invocations are intentionally left
 * on the SDK's default path (`${baseUrl}/functions/<name>/invoke`) so the
 * client code path is identical in both environments — the dev-only decision
 * of whether a function runs locally or remotely is made entirely by the proxy.
 */
export function resolveRayfinConfig(): ResolvedRayfinConfig {
  const publishableKey = import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY ?? '';

  if (isLocalDev()) {
    return { baseUrl: RAYFIN_PROXY_PREFIX, publishableKey };
  }

  return {
    baseUrl: import.meta.env.VITE_RAYFIN_API_URL ?? '',
    publishableKey,
  };
}

// ---------------------------------------------------------------------------
// Fabric auth proxy — WebView helpers
// ---------------------------------------------------------------------------

/**
 * Fabric config the app forwards to the auth proxy so it can drive the
 * system-browser login. Every field is optional here: when omitted, the bridge
 * falls back to the app's standard `VITE_FABRIC_*` / `VITE_RAYFIN_*` env vars.
 */
export interface FabricProxyOptions {
  /** Fabric workspace id (`VITE_FABRIC_WORKSPACE_ID`). */
  workspaceId?: string;
  /** Fabric item/project id (`VITE_FABRIC_ITEM_ID`). */
  projectId?: string;
  /** Fabric portal origin (`VITE_FABRIC_PORTAL_URL`). */
  portalUrl?: string;
  /** Publishable key (`VITE_RAYFIN_PUBLISHABLE_KEY`). */
  publishableKey?: string;
  /** Override the auth-proxy base path. Defaults to {@link RAYFIN_AUTH_PROXY_PATH}. */
  path?: string;
  /**
   * Silent mode: ask only for a cached/refreshable token and never trigger an
   * interactive system-browser login. On a cache miss the proxy responds `204`
   * and {@link fetchFabricProxyToken} returns `null`. Prefer {@link peekFabricProxyToken}.
   */
  silent?: boolean;
  /** Optional `AbortSignal` to cancel the (potentially long) request. */
  signal?: AbortSignal;
}

/**
 * Hydrator callback: hands a raw {@link TokenResponse} to whatever will
 * establish the SDK session. Kept as a callback so this dev-only package never
 * imports the Rayfin SDK — the app supplies the supported hydrator (see
 * {@link hydrateFabricSessionFromProxy}).
 */
type SessionHydrator = (token: TokenResponse) => unknown | Promise<unknown>;

function buildProxyUrl(options: FabricProxyOptions): string {
  const base = options.path ?? RAYFIN_AUTH_PROXY_PATH;
  const params = new URLSearchParams();
  if (options.workspaceId) params.set('workspaceId', options.workspaceId);
  if (options.projectId) params.set('projectId', options.projectId);
  if (options.portalUrl) params.set('portalUrl', options.portalUrl);
  if (options.publishableKey)
    params.set('publishableKey', options.publishableKey);
  if (options.silent) params.set('mode', 'silent');
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

/**
 * Ask the dev-server auth proxy for a Rayfin session, triggering a
 * system-browser login when there is no cached/refreshable token.
 *
 * Intended for WebView hosts (GitHub Copilot desktop, Electron, VS Code
 * webviews) where an in-WebView Fabric login can't complete. The returned raw
 * {@link TokenResponse} is what the SDK needs to authenticate its own backend
 * requests — hydrate a client with {@link hydrateFabricSessionFromProxy}.
 *
 * The request blocks until the browser login finishes (up to the proxy's login
 * timeout), so give the user a clear "signing in…" affordance while it runs.
 *
 * @throws When the proxy is disabled/unreachable or the login fails or times
 *   out (non-2xx response).
 */
export async function fetchFabricProxyToken(
  options: FabricProxyOptions = {}
): Promise<TokenResponse> {
  const res = await fetch(buildProxyUrl(options), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: options.signal,
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      /* ignore */
    }
    throw new Error(
      `Fabric auth proxy request failed: HTTP ${res.status}${detail ? ` ${detail}` : ''}`
    );
  }
  return (await res.json()) as TokenResponse;
}

/**
 * Silently ask the dev-server auth proxy for an existing cached (or silently
 * refreshable) token WITHOUT ever opening a system browser. Returns the raw
 * {@link TokenResponse} on a cache hit, or `null` when there is no session yet
 * (the proxy replies `204`).
 *
 * Call this on app bootstrap / page reload to restore a session established in a
 * previous interactive login, so a refresh doesn't force the user through the
 * browser flow again. When it returns `null`, show your login affordance and let
 * the user trigger {@link fetchFabricProxyToken} explicitly.
 *
 * @throws When the proxy is disabled/unreachable or errors (non-2xx, non-204).
 */
export async function peekFabricProxyToken(
  options: FabricProxyOptions = {}
): Promise<TokenResponse | null> {
  const res = await fetch(buildProxyUrl({ ...options, silent: true }), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: options.signal,
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      /* ignore */
    }
    throw new Error(
      `Fabric auth proxy peek failed: HTTP ${res.status}${detail ? ` ${detail}` : ''}`
    );
  }
  return (await res.json()) as TokenResponse;
}

/**
 * Fetch a token via {@link fetchFabricProxyToken} and hydrate an SDK session
 * with it. Pass the SDK's supported companion hydrator so this dev-only package
 * stays SDK-free:
 *
 * ```ts
 * import { createSessionFromTokenResponse } from '@microsoft/rayfin-auth/_internal';
 * await hydrateFabricSessionFromProxy(
 *   (token) => createSessionFromTokenResponse(client.auth, token),
 *   getFabricProxyOptions()
 * );
 * ```
 */
export async function hydrateFabricSessionFromProxy(
  hydrate: SessionHydrator,
  options: FabricProxyOptions = {}
): Promise<TokenResponse> {
  const token = await fetchFabricProxyToken(options);
  await hydrate(token);
  return token;
}

/**
 * Silently restore an SDK session from a cached proxy token if one exists,
 * without opening a browser. Returns the hydrated {@link TokenResponse}, or
 * `null` when there is no cached session (caller should then show login).
 *
 * ```ts
 * import { createSessionFromTokenResponse } from '@microsoft/rayfin-auth/_internal';
 * const restored = await hydrateFabricSessionFromProxyIfCached(
 *   (token) => createSessionFromTokenResponse(client.auth, token),
 *   getFabricProxyOptions()
 * );
 * setAuthenticated(restored !== null);
 * ```
 */
export async function hydrateFabricSessionFromProxyIfCached(
  hydrate: SessionHydrator,
  options: FabricProxyOptions = {}
): Promise<TokenResponse | null> {
  const token = await peekFabricProxyToken(options);
  if (!token) return null;
  await hydrate(token);
  return token;
}

/** Evict the auth proxy's cached session (e.g. on sign-out). */
export async function fabricProxyLogout(path?: string): Promise<void> {
  const base = path ?? RAYFIN_AUTH_PROXY_PATH;
  await fetch(`${base}/logout`, { method: 'POST' });
}
