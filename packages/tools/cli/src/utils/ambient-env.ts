/**
 * Helpers for reading ambient configuration from environment variables.
 *
 * These env vars let any caller — a developer setting them in `.env`,
 * a CI runner, or an external platform that pre-provisions a sandbox
 * (e.g. a "vibe-coding" environment that hands the user a ready-to-go
 * workspace and credentials) — supply credentials and Fabric context
 * up front so the CLI can skip interactive MSAL login, etc.
 *
 * | Variable              | Purpose                                        |
 * | --------------------- | ---------------------------------------------- |
 * | `RAYFIN_TOKEN`        | Bearer token — bypasses MSAL auth              |
 * | `RAYFIN_WORKSPACE_ID` | Fabric workspace ID — skips selection UI       |
 * | `RAYFIN_TENANT_ID`    | Entra ID tenant — used for portal URLs / ctid  |
 */

/** Returns `true` when a token has been supplied via `RAYFIN_TOKEN`. */
export function hasAmbientToken(): boolean {
  return !!process.env['RAYFIN_TOKEN'];
}

/**
 * Returns the Bearer token supplied via `RAYFIN_TOKEN`, or `null` if not
 * set. Strips an optional "Bearer " prefix so callers always get a raw
 * token.
 */
export function getAmbientToken(): string | null {
  const raw = process.env['RAYFIN_TOKEN'];
  if (!raw) return null;
  return raw.replace(/^Bearer\s+/i, '');
}

/** Returns the workspace ID supplied via `RAYFIN_WORKSPACE_ID`, or `null`. */
export function getAmbientWorkspaceId(): string | null {
  return process.env['RAYFIN_WORKSPACE_ID'] || null;
}

/** Returns the tenant ID supplied via `RAYFIN_TENANT_ID`, or `null`. */
export function getAmbientTenantId(): string | null {
  return process.env['RAYFIN_TENANT_ID'] || null;
}
