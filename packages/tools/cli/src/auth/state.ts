import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { join } from 'path';

import type { EnvironmentConfig } from '@microsoft/rayfin-tools-common/_internal/env-config';

import {
  AUTH_STATE_FILE,
  RAYFIN_CONFIG_DIR,
  TOKEN_CACHE_FILE,
} from './constants.js';

/**
 * Persisted authentication metadata (written to ~/.rayfin/auth.json).
 *
 * The file is written with mode `0o600` and the parent directory with
 * mode `0o700`. Unknown top-level fields are ignored on read so the
 * schema is forward-compatible.
 */
export interface AuthState {
  identityType: 'user' | 'service_principal';
  tenantId?: string;
  clientId?: string;
  /**
   * Persisted client secret for service principal sessions. Stored
   * alongside the MSAL token cache so subsequent CLI invocations can
   * transparently re-acquire tokens via the client credentials flow
   * without requiring the user to re-supply the secret.
   *
   * The file is written with mode `0o600` (owner-only) for
   * defense-in-depth. This mirrors how Azure CLI persists SP
   * credentials after `az login --service-principal`.
   */
  clientSecret?: string;
  /**
   * When `true`, the user explicitly opted into plaintext token storage
   * (via `--encryption-fallback-enabled` or the env var). Persisted so
   * subsequent commands can restore the cache plugin without requiring
   * the flag again.
   */
  encryptionFallbackEnabled?: boolean;
  userPrincipalName?: string;
  userName?: string;
  /**
   * Optional user-supplied environment configuration. Absent when the
   * user has only ever signed into the built-in PROD environment.
   */
  environmentConfig?: EnvironmentConfig;
}

/**
 * Load the persisted auth state from ~/.rayfin/auth.json.
 *
 * Returns `null` if the file does not exist or is invalid. Unknown
 * fields (including unknown `environmentConfig` sub-fields) are
 * tolerated by `JSON.parse` and surface untouched on the returned
 * object — callers that read known fields are unaffected.
 */
export async function loadAuthState(): Promise<AuthState | null> {
  try {
    const filePath = join(RAYFIN_CONFIG_DIR, AUTH_STATE_FILE);
    const data = await readFile(filePath, 'utf8');
    return JSON.parse(data) as AuthState;
  } catch {
    return null;
  }
}

/**
 * Persist auth state to ~/.rayfin/auth.json.
 */
export async function saveAuthState(state: AuthState): Promise<void> {
  // 0o700 = owner-only read/write/execute on the directory
  await mkdir(RAYFIN_CONFIG_DIR, { recursive: true, mode: 0o700 });
  const filePath = join(RAYFIN_CONFIG_DIR, AUTH_STATE_FILE);
  await writeFile(filePath, JSON.stringify(state, null, 2), {
    encoding: 'utf8',
    mode: 0o600, // owner-only read/write on the file
  });
}

/**
 * Delete all persisted auth state (auth.json and token cache).
 */
export async function clearAuthState(): Promise<void> {
  const authFile = join(RAYFIN_CONFIG_DIR, AUTH_STATE_FILE);
  const cacheFile = join(RAYFIN_CONFIG_DIR, TOKEN_CACHE_FILE);

  await Promise.all([
    unlink(authFile).catch(() => {}),
    unlink(cacheFile).catch(() => {}),
  ]);
}
