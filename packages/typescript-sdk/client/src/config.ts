/**
 * Runtime configuration loading for Rayfin SPAs.
 *
 * Instead of baking environment-specific values into the bundle at build time
 * (via `import.meta.env.VITE_*`), the SPA fetches a `rayfin.config.json` file
 * at startup. This allows the same compiled bundle to work across all
 * environments — only the config file changes per stage.
 *
 * The file is a deploy-time artifact: `rayfin up` emits it into the static
 * build so it is bundled and served alongside the app, then removes it from the
 * working tree afterward. In local development the file is intentionally absent
 * — `rayfin dev` relies on build-time `VITE_*` values instead — so
 * `loadRayfinConfig` returns `null` and the SPA falls back to those values.
 */

/**
 * Error thrown when runtime configuration loading fails.
 */
export class RayfinConfigError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'RayfinConfigError';
    this.code = code;
  }
}

/**
 * Runtime configuration shape for a Rayfin SPA.
 * Loaded from `rayfin.config.json` at startup — contains only
 * deployment-specific values that change per environment.
 * Service mode (mock / rayfin / fabric) is controlled separately
 * via `VITE_SERVICE_MODE` and is not part of this config.
 */
export interface RayfinConfig {
  /** Base URL of the Rayfin backend API. */
  apiUrl: string;
  /** Publishable key for service-level authentication. */
  publishableKey?: string;
  /** Fabric workspace ID (present in Fabric deployments). */
  workspaceId?: string;
  /** Fabric item ID (present in Fabric deployments). */
  itemId?: string;
  /** Fabric portal URL (present in Fabric deployments). */
  portalUrl?: string;
  /** Fabric tenant ID (present in Fabric deployments). */
  tenantId?: string;
}

/** Default path for the runtime config file (served from `public/`). */
const DEFAULT_CONFIG_PATH = '/rayfin.config.json';

/**
 * Loads the Rayfin runtime configuration from the well-known config file.
 *
 * @param path - Override the config file URL (defaults to `/rayfin.config.json`).
 * @returns The validated runtime configuration, or `null` if the config is
 *   genuinely absent (HTTP 404, an HTML SPA fallback body, or — in a
 *   non-browser runtime with no explicit `configUrl` — a relative path with
 *   no origin to resolve against). Throws {@link RayfinConfigError} if the
 *   file could not be loaded for any other reason (`CONFIG_LOAD_FAILED`,
 *   e.g. a 5xx or 401/403 response, or a fetch-level failure such as a
 *   network error — these are real failures, not absence, and are not
 *   silently swallowed), or if the file is present but malformed or
 *   incomplete (`CONFIG_PARSE_FAILED`, `CONFIG_INVALID`, `CONFIG_INCOMPLETE`).
 *
 * Not part of the public API — {@link resolveRayfinConfig} calls this
 * internally. Prefer that over calling this directly.
 */
export async function loadRayfinConfig(
  path: string = DEFAULT_CONFIG_PATH
): Promise<RayfinConfig | null> {
  if (typeof window === 'undefined' && path === DEFAULT_CONFIG_PATH) {
    // Non-browser runtime with no explicit configUrl: a relative fetch has
    // no origin to resolve against and would always reject. Skip it rather
    // than triggering (and swallowing) that rejection — callers that want
    // remote config outside the browser must pass an absolute configUrl.
    return null;
  }

  let response: Response;
  try {
    response = await fetch(path);
  } catch (err) {
    // A fetch-level failure (offline, DNS, CORS, a transient network error)
    // is a real failure, not absence — local-dev absence is identified below
    // via 404 / the SPA HTML fallback, once a response is actually received.
    // Swallowing this would let a promoted Prod bundle silently keep using
    // its compiled Dev endpoint and key.
    throw new RayfinConfigError(
      `Failed to load Rayfin config from "${path}": ` +
        `${err instanceof Error ? err.message : String(err)}.`,
      'CONFIG_LOAD_FAILED'
    );
  }

  if (!response.ok) {
    if (response.status === 404) {
      // Genuinely absent (e.g. local dev, where no config was emitted).
      return null;
    }
    // Any other non-2xx (5xx, 401/403, etc.) is a real load failure, not
    // absence. Treating it as "absent" would silently fall back to the
    // build-time source-stage values, which in a deployed stage can mean
    // sending users to the wrong backend. Fail closed instead.
    throw new RayfinConfigError(
      `Failed to load Rayfin config from "${path}": ` +
        `${response.status} ${response.statusText}.`,
      'CONFIG_LOAD_FAILED'
    );
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const text = await response.text();
  const trimmed = text.trimStart();

  // A missing /rayfin.config.json is not always a 404: Vite's dev server and
  // SPA static hosts serve index.html (200) for unknown paths. An HTML response
  // therefore means "no config file" (e.g. local dev, where `rayfin dev` relies
  // on build-time VITE_* values) — treat it as absent rather than a malformed
  // config. Check the declared content type first, then fall back to sniffing
  // the body for hosts that mislabel the fallback.
  if (contentType.includes('html') || trimmed.startsWith('<')) {
    return null;
  }

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    throw new RayfinConfigError(
      `Rayfin config at "${path}" is not valid JSON.`,
      'CONFIG_PARSE_FAILED'
    );
  }

  return validateConfig(json, path);
}

function validateConfig(json: unknown, path: string): RayfinConfig {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new RayfinConfigError(
      `Rayfin config at "${path}" must be a JSON object.`,
      'CONFIG_INVALID'
    );
  }

  const obj = json as Record<string, unknown>;
  const missing: string[] = [];

  if (!obj.apiUrl || typeof obj.apiUrl !== 'string') {
    missing.push('apiUrl');
  }

  if (missing.length > 0) {
    throw new RayfinConfigError(
      `Rayfin config at "${path}" is incomplete. ` +
        `Missing required fields: ${missing.join(', ')}.`,
      'CONFIG_INCOMPLETE'
    );
  }

  const rawApiUrl = obj.apiUrl as string;
  const publishableKey = readOptionalStringField(obj, 'publishableKey', path);
  const workspaceId = readOptionalStringField(obj, 'workspaceId', path);
  const portalUrl = readOptionalStringField(obj, 'portalUrl', path);
  const itemId = readOptionalStringField(obj, 'itemId', path);
  const tenantId = readOptionalStringField(obj, 'tenantId', path);

  const config: RayfinConfig = {
    apiUrl: rawApiUrl.endsWith('/') ? rawApiUrl : `${rawApiUrl}/`,
    ...(publishableKey ? { publishableKey } : {}),
  };

  if (workspaceId) {
    config.workspaceId = workspaceId;
  }

  if (portalUrl) {
    config.portalUrl = portalUrl;
  }

  if (itemId) {
    config.itemId = itemId;
  }

  if (tenantId) {
    config.tenantId = tenantId;
  }

  return config;
}

/**
 * Reads an optional string field from a parsed config object.
 *
 * A missing, `null`, or empty-string value is treated as absent
 * (`undefined`). A present value of any other type is a malformed config —
 * rather than silently dropping it via an unchecked cast, this throws so the
 * caller finds out immediately instead of the SDK crashing later with an
 * untyped error (e.g. a numeric `publishableKey` reaching `.trim()`).
 */
function readOptionalStringField(
  obj: Record<string, unknown>,
  field: string,
  path: string
): string | undefined {
  const value = obj[field];
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new RayfinConfigError(
      `Rayfin config at "${path}" has an invalid "${field}" field: ` +
        `expected a string.`,
      'CONFIG_INVALID'
    );
  }

  return value;
}

/**
 * Options controlling how {@link resolveRayfinConfig} fetches remote runtime
 * configuration. To skip remote loading entirely, don't call it — construct
 * the client directly from your own values instead.
 */
export interface ResolveRayfinConfigOptions {
  /**
   * Absolute URL to fetch the runtime config from, overriding the default
   * relative `/rayfin.config.json`.
   *
   * The default relative path only resolves in a browser, where `fetch`
   * implicitly uses the page's document origin. Non-browser runtimes (e.g.
   * `RayfinServerClient` in Node.js) have no such origin, so omitting
   * `configUrl` there skips the fetch entirely and falls back to
   * caller-supplied values, rather than attempting a relative fetch that
   * would always reject. Pass an absolute `configUrl` (e.g.
   * `${process.env.RAYFIN_API_URL}/rayfin.config.json`) to enable remote
   * config loading outside the browser — once set (or in the browser, where
   * a fetch is always attempted), a fetch failure (unreachable host,
   * DNS/TLS error, offline, etc.) throws {@link RayfinConfigError}
   * (`CONFIG_LOAD_FAILED`) rather than silently falling back, since it's a
   * real failure, not evidence of absence.
   */
  configUrl?: string;
}

/**
 * All `rayfin.config.json` values as a single optional-field bag — every
 * field is optional because neither the remote config nor a caller-supplied
 * set of defaults is guaranteed to provide it. Used both as the defaults
 * shape (typically build-time `VITE_*` values) and as the resolved shape
 * returned by {@link resolveRayfinConfig}.
 */
export interface RayfinRuntimeConfig {
  /** Base URL of the Rayfin backend API. */
  apiUrl?: string;
  /** Publishable key for service-level authentication. */
  publishableKey?: string;
  /** Fabric workspace ID (present in Fabric deployments). */
  workspaceId?: string;
  /** Fabric item ID (present in Fabric deployments). */
  itemId?: string;
  /** Fabric portal URL (present in Fabric deployments). */
  portalUrl?: string;
  /** Fabric tenant ID (present in Fabric deployments). */
  tenantId?: string;
}

/**
 * Resolves the config a `RayfinClient` / `RayfinServerClient` should be
 * constructed with: loads the remote `rayfin.config.json` (unless the caller
 * skips calling this function entirely), overlays it over the supplied
 * `defaults` per-field, and returns the merged `baseUrl` / `publishableKey` /
 * `runtimeConfig`. Construction itself is a plain, synchronous
 * `new RayfinClient(...)` call — this function only resolves values.
 *
 * @example
 * ```typescript
 * import { RayfinClient, resolveRayfinConfig } from '@microsoft/rayfin-client';
 *
 * const resolved = await resolveRayfinConfig({ baseUrl, publishableKey });
 * const client = new RayfinClient({ ...resolved, authStorage: true });
 * ```
 */
export async function resolveRayfinConfig(
  defaults: Pick<RayfinRuntimeConfig, 'apiUrl' | 'publishableKey'> &
    Partial<RayfinRuntimeConfig>,
  options: ResolveRayfinConfigOptions = {}
): Promise<{
  baseUrl?: string;
  publishableKey?: string;
  runtimeConfig: RayfinRuntimeConfig;
}> {
  const remote = await loadRayfinConfig(options.configUrl);

  const baseUrl = remote?.apiUrl ?? defaults.apiUrl;
  const publishableKey = remote?.publishableKey ?? defaults.publishableKey;

  return {
    baseUrl,
    publishableKey,
    runtimeConfig: {
      apiUrl: baseUrl,
      publishableKey,
      workspaceId: remote?.workspaceId ?? defaults.workspaceId,
      itemId: remote?.itemId ?? defaults.itemId,
      portalUrl: remote?.portalUrl ?? defaults.portalUrl,
      tenantId: remote?.tenantId ?? defaults.tenantId,
    },
  };
}
