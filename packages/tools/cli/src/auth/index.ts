export { createCachePlugin } from './cache.js';
export type { CachePluginOptions } from './cache.js';
export {
  AUTH_STATE_FILE,
  DEFAULT_AUTHORITY_HOST,
  DEFAULT_FABRIC_SCOPE,
  DEFAULT_RAYFIN_CLIENT_ID,
  RAYFIN_CONFIG_DIR,
  TOKEN_CACHE_FILE,
  getAuthorityHost,
  getDefaultAuthority,
  getFabricScope,
  getFabricScopes,
  getRayfinClientId,
  getTenantAuthority,
} from './constants.js';
export { RayfinAuth } from './rayfin-auth.js';
export type { RayfinAuthOptions, TokenResult } from './rayfin-auth.js';
export { clearAuthState, loadAuthState, saveAuthState } from './state.js';
export type { AuthState } from './state.js';
export { getCurrentUser, normalizeUsername } from './user-utils.js';
export type { UserInfo } from './user-utils.js';

// ── Singleton helpers ─────────────────────────────────────────────────
// Shared singleton so all callers use the same MSAL instance and cache.
// Uses dynamic import to avoid pulling in native modules at module
// evaluation time, which lets tests mock this file without needing
// native libraries.

import {
  getAmbientTenantId,
  getAmbientToken,
  hasAmbientToken,
} from '../utils/ambient-env.js';

/**
 * Extract the `exp` claim from a JWT without a library.
 * Returns the expiration as a Unix-epoch *millisecond* timestamp,
 * or a fallback of `Date.now() + 1 hour` if the token cannot be decoded
 * (e.g. opaque tokens or API keys that aren't JWTs).
 */
function getTokenExpiration(token: string): number {
  try {
    const payload = token.split('.')[1];
    if (!payload) return Date.now() + 3_600_000;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    // `exp` is seconds since epoch; convert to milliseconds
    return typeof decoded.exp === 'number'
      ? decoded.exp * 1000
      : Date.now() + 3_600_000;
  } catch {
    return Date.now() + 3_600_000;
  }
}

let _authPromise: Promise<
  InstanceType<(typeof import('./rayfin-auth.js'))['RayfinAuth']>
> | null = null;

async function getAuth(options?: import('./rayfin-auth.js').RayfinAuthOptions) {
  // Service principal credentials supplied explicitly — bypass the
  // singleton so each caller gets a fresh CCA instance. Currently
  // no caller exercises this path (login.ts constructs RayfinAuth
  // directly), but it serves as a defensive guard for future callers
  // that may pass SP credentials through getAuthenticatedToken() or
  // ensureAuthenticated().
  if (options?.clientSecret) {
    const { RayfinAuth } = await import('./rayfin-auth.js');
    return new RayfinAuth(options);
  }

  if (!_authPromise) {
    _authPromise = (async () => {
      const { RayfinAuth } = await import('./rayfin-auth.js');
      const { loadAuthState } = await import('./state.js');
      const state = await loadAuthState();

      // Restore a persisted service principal session — re-create the
      // CCA with the stored credentials so subsequent commands can
      // transparently acquire tokens via client credentials flow.
      if (
        state?.identityType === 'service_principal' &&
        state.clientId &&
        state.clientSecret
      ) {
        return new RayfinAuth({
          ...options,
          tenantId: options?.tenantId ?? state.tenantId,
          clientId: state.clientId,
          clientSecret: state.clientSecret,
          encryptionFallbackEnabled: state.encryptionFallbackEnabled,
        });
      }

      // Honour persisted tenant from a previous user login.
      if (!options?.tenantId && state?.tenantId) {
        return new RayfinAuth({
          ...options,
          tenantId: state.tenantId,
          encryptionFallbackEnabled: state.encryptionFallbackEnabled,
        });
      }

      return new RayfinAuth(options);
    })();
  }
  return _authPromise;
}

/**
 * Acquire a Fabric token, trying silent (cached) acquisition first.
 * Falls back to interactive login if no cached account exists or the
 * cached token has expired.
 *
 * When `RAYFIN_TOKEN` is set the ambient token is returned immediately,
 * bypassing MSAL entirely.
 */
export async function getAuthenticatedToken(
  scopes?: string[],
  options?: {
    tenantId?: string;
    encryptionFallbackEnabled?: boolean;
    clientId?: string;
    clientSecret?: string;
  }
): Promise<import('./rayfin-auth.js').TokenResult> {
  if (hasAmbientToken()) {
    const token = getAmbientToken()!;
    console.debug('[rayfin] using ambient token from RAYFIN_TOKEN');
    return {
      token,
      expiresOnTimestamp: getTokenExpiration(token),
      tenantId: options?.tenantId ?? getAmbientTenantId() ?? undefined,
      identityType: 'external',
    };
  }

  const auth = await getAuth(options);
  return auth.acquireToken(scopes);
}

/**
 * Ensure the user is authenticated.
 * Tries silent token acquisition first; if no cached account exists,
 * triggers an interactive login flow automatically.
 *
 * When `RAYFIN_TOKEN` is set the ambient token is returned immediately,
 * bypassing MSAL entirely.
 */
export async function ensureAuthenticated(
  scopes?: string[],
  options?: {
    tenantId?: string;
    encryptionFallbackEnabled?: boolean;
    clientId?: string;
    clientSecret?: string;
    silent?: boolean;
  }
): Promise<import('./rayfin-auth.js').TokenResult> {
  // Destructured out: `silent` is a presentation flag, not part of the
  // auth-provider options bag passed to getAuth()/RayfinAuth.
  const { silent = false, ...authOptions } = options ?? {};
  if (hasAmbientToken()) {
    const token = getAmbientToken()!;
    if (!silent) {
      console.debug('[rayfin] using ambient token from RAYFIN_TOKEN');
    }
    return {
      token,
      expiresOnTimestamp: getTokenExpiration(token),
      tenantId: authOptions.tenantId ?? getAmbientTenantId() ?? undefined,
      identityType: 'external',
    };
  }

  const auth = await getAuth(authOptions);
  const loggedIn = await auth.isLoggedIn();

  if (!loggedIn && !silent) {
    console.log('🔑 No active session found — launching login...');
  }

  // silentOnly: true fails fast with a structured error instead of falling
  // through to interactive browser/device-code login, which writes to
  // stdout and would corrupt --json output.
  return auth.acquireToken(scopes, { silentOnly: silent });
}

/**
 * Check whether the user is currently logged in (has a cached account).
 */
export async function isAuthenticated(): Promise<boolean> {
  const auth = await getAuth();
  return auth.isLoggedIn();
}

/**
 * Return the underlying {@link RayfinAuth} instance for advanced usage.
 */
export async function getRayfinAuth() {
  return getAuth();
}
