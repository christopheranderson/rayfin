import { homedir } from 'os';
import { join } from 'path';

/**
 * Built-in default Entra ID (AAD) application client ID for the Rayfin
 * CLI when no override is supplied.
 *
 * Used by {@link getRayfinClientId} as the fallback when
 * `process.env.RAYFIN_CLIENT_ID` is not set.
 */
export const DEFAULT_RAYFIN_CLIENT_ID = '2f844663-8e82-4a34-8b65-09d9d14b0fb6';

/**
 * Built-in default Entra ID authority host (no trailing slash, no
 * tenant segment) when no override is supplied.
 *
 * Used by {@link getAuthorityHost} as the fallback when
 * `process.env.RAYFIN_AUTHORITY_HOST` is not set. Combined with a tenant
 * segment by {@link getDefaultAuthority} and {@link getTenantAuthority}.
 */
export const DEFAULT_AUTHORITY_HOST = 'https://login.microsoftonline.com';

/**
 * Built-in default Fabric OAuth scope used when acquiring tokens, when
 * no override is supplied.
 *
 * Used by {@link getFabricScope} as the fallback when
 * `process.env.RAYFIN_FABRIC_SCOPE` is not set.
 */
export const DEFAULT_FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';

/**
 * Resolve the Entra ID (AAD) application client ID for MSAL.
 *
 * Reads `process.env.RAYFIN_CLIENT_ID` and falls back to
 * {@link DEFAULT_RAYFIN_CLIENT_ID} when unset or empty.
 *
 * The env var is hydrated from the user's persisted environment
 * configuration at process startup by `bootstrapEnvironmentConfig()` in
 * `auth/index.ts`, so a one-time `RAYFIN_CLIENT_ID=<id> rayfin login`
 * survives across CLI invocations.
 */
export function getRayfinClientId(): string {
  const fromEnv = process.env['RAYFIN_CLIENT_ID'];
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_RAYFIN_CLIENT_ID;
}

/**
 * Resolve the Entra ID authority host (no trailing slash, no tenant
 * segment) used to build MSAL authority URLs.
 *
 * Reads `process.env.RAYFIN_AUTHORITY_HOST` and falls back to
 * {@link DEFAULT_AUTHORITY_HOST} when unset or empty. Any trailing
 * slashes are stripped so callers can safely concatenate `/<tenant>`.
 *
 * The env var is hydrated from the user's persisted environment
 * configuration at process startup by `bootstrapEnvironmentConfig()` in
 * `auth/index.ts`, so a one-time `RAYFIN_AUTHORITY_HOST=<url> rayfin login`
 * survives across CLI invocations.
 */
export function getAuthorityHost(): string {
  const fromEnv = process.env['RAYFIN_AUTHORITY_HOST'];
  const raw = fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_AUTHORITY_HOST;
  return raw.replace(/\/+$/, '');
}

/**
 * Resolve the OAuth scope used when acquiring Fabric tokens.
 *
 * Reads `process.env.RAYFIN_FABRIC_SCOPE` and falls back to
 * {@link DEFAULT_FABRIC_SCOPE} when unset or empty.
 *
 * The env var is hydrated from the user's persisted environment
 * configuration at process startup by `bootstrapEnvironmentConfig()` in
 * `auth/index.ts`, so a one-time `RAYFIN_FABRIC_SCOPE=<scope> rayfin login`
 * survives across CLI invocations.
 */
export function getFabricScope(): string {
  const fromEnv = process.env['RAYFIN_FABRIC_SCOPE'];
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_FABRIC_SCOPE;
}

/**
 * MSAL multi-tenant authority URL (`<authority-host>/common`).
 *
 * Resolved from {@link getAuthorityHost} on every call so that env
 * mutations take effect immediately.
 */
export function getDefaultAuthority(): string {
  return `${getAuthorityHost()}/common`;
}

/** Build a tenant-specific authority URL. */
export function getTenantAuthority(tenantId: string): string {
  return `${getAuthorityHost()}/${tenantId}`;
}

/**
 * Convenience array form of the resolved Fabric scope, for callers that
 * pass scopes to MSAL `acquireToken*` methods. Resolved on every access
 * so env mutations are honoured.
 */
export function getFabricScopes(): string[] {
  return [getFabricScope()];
}

/** Directory for persisted auth state and token cache */
export const RAYFIN_CONFIG_DIR =
  process.env['RAYFIN_CONFIG_DIR'] || join(homedir(), '.rayfin');

/** Auth metadata file (identity type, tenant ID, user info) */
export const AUTH_STATE_FILE = 'auth.json';

/** MSAL serialized token cache (encrypted) */
export const TOKEN_CACHE_FILE = 'cache.bin';
