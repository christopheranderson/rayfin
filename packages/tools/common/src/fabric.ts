/** Header that identifies the Rayfin item for workload routing. */
export const MONIKER_HEADER = 'X-Ms-Workload-Resource-Moniker';

export const DEFAULT_FABRIC_SETTINGS = {
  /** Base URL for the Fabric REST API */
  fabricApiBaseUrl: 'https://api.fabric.microsoft.com/v1',

  /** Fabric Portal URL */
  fabricPortalUrl: 'https://app.fabric.microsoft.com/',

  /** Rayfin workload ID in Fabric */
  workloadId: 'BaaS',

  /** Rayfin item type in Fabric */
  itemType: 'AppBackend',
} as const;

/** Resolved Fabric settings (mutable copy of the defaults after env overrides). */
export type FabricSettings = {
  [K in keyof typeof DEFAULT_FABRIC_SETTINGS]: string;
};

/**
 * Domain suffix shared by every Fabric host (production and any
 * environment-specific subdomain). Used to recognize whether a given
 * URL points at the canonical Fabric API surface vs. a third-party
 * proxy or custom environment.
 */
const FABRIC_DOMAIN_SUFFIX = '.fabric.microsoft.com';

/**
 * `true` when `host` is a Fabric host (`*.fabric.microsoft.com`),
 * matched case-insensitively. A trailing dot (root-anchored FQDN like
 * `api.fabric.microsoft.com.`) is stripped before the suffix check so a
 * real Fabric host isn't mis-routed through the path-preserving branch.
 * The bare suffix on its own (i.e. an empty subdomain) does not count.
 */
export function isFabricHost(host: string): boolean {
  const lower = host.toLowerCase().replace(/\.$/, '');
  return lower.endsWith(FABRIC_DOMAIN_SUFFIX) && lower !== FABRIC_DOMAIN_SUFFIX;
}

/**
 * Domain suffix for the Power BI portal (`*.powerbi.com`). The portal still
 * serves the workspace list at `https://{env}.powerbi.com/groups/{id}/list`,
 * and that is the URL both the Fabric portal address bar and our own docs
 * hand a user, so workspace URIs are accepted on it and mapped onto the
 * matching Fabric environment.
 */
const POWERBI_PORTAL_DOMAIN_SUFFIX = '.powerbi.com';

/**
 * `true` when `host` is a Power BI portal host (`*.powerbi.com`), matched
 * case-insensitively. Mirrors {@link isFabricHost}: a trailing dot is
 * stripped first, and the bare suffix (empty subdomain) does not count.
 */
export function isPowerBiPortalHost(host: string): boolean {
  const lower = host.toLowerCase().replace(/\.$/, '');
  return (
    lower.endsWith(POWERBI_PORTAL_DOMAIN_SUFFIX) &&
    lower !== POWERBI_PORTAL_DOMAIN_SUFFIX
  );
}

/**
 * The recognized domain suffix `host` ends with, or `undefined` when the
 * host is neither a Fabric nor a Power BI portal host.
 */
function workspaceHostSuffix(host: string): string | undefined {
  if (isFabricHost(host)) return FABRIC_DOMAIN_SUFFIX;
  if (isPowerBiPortalHost(host)) return POWERBI_PORTAL_DOMAIN_SUFFIX;
  return undefined;
}

/**
 * Returns Fabric settings with environment variable overrides applied.
 *
 * Override host-specific URLs via environment variables to target a
 * different Fabric environment. Non-URL settings (`workloadId`, `itemType`)
 * are the same across all environments and cannot be overridden.
 *
 * | Environment variable          | Overrides          |
 * | ----------------------------- | ------------------ |
 * | `RAYFIN_FABRIC_API_URL`       | `fabricApiBaseUrl`  |
 * | `RAYFIN_FABRIC_PORTAL_URL`    | `fabricPortalUrl`   |
 *
 * `RAYFIN_FABRIC_API_URL` may be either:
 *
 * - a bare origin or `<origin>/v1` for a canonical Fabric host (e.g.
 *   `https://api.fabric.microsoft.com` or `https://dxtapi.fabric.microsoft.com/v1`);
 *   the result is normalized to `<origin>/v1`. Extra path segments on
 *   Fabric hosts are stripped to preserve the historical shape and avoid
 *   accidental double-pathed URLs.
 * - any non-Fabric origin with an optional path prefix (e.g.
 *   `https://my-proxy.example.com/cli-proxy/fabric/<conn_id>`); the path
 *   is preserved verbatim and `/v1` is appended only when the resolved
 *   path does not already end in `/v1`. This lets callers route through
 *   reverse proxies mounted under a sub-path while keeping the existing
 *   bare-origin and `<origin>/v1` shapes working unchanged.
 *
 * See {@link normalizeFabricApiUrl} for the full contract.
 *
 * As a convenience, callers can instead pass the CLI flag
 * `--workspace-uri <url>` (e.g. to `rayfin up` or `rayfin init`) with a
 * Fabric portal workspace URL. The CLI parses the URL with
 * {@link parseWorkspaceUri} and applies its API URL plus its portal URL when
 * no explicit portal override exists via {@link applyWorkspaceUriOverrides},
 * so subsequent calls to {@link getFabricSettings} pick up the selected
 * environment.
 *
 * When no variable is set the defaults from {@link DEFAULT_FABRIC_SETTINGS}
 * are used.
 *
 * @param env - Optional environment record to read overrides from.
 *              Defaults to `process.env` when running in Node.js.
 */
export function getFabricSettings(
  env?: Record<string, string | undefined>
): FabricSettings {
  const resolved =
    env ?? (typeof process !== 'undefined' ? process.env : undefined);

  const rawApiUrl =
    resolved?.RAYFIN_FABRIC_API_URL || DEFAULT_FABRIC_SETTINGS.fabricApiBaseUrl;

  return {
    fabricApiBaseUrl: normalizeFabricApiUrl(rawApiUrl),
    fabricPortalUrl:
      resolved?.RAYFIN_FABRIC_PORTAL_URL ||
      DEFAULT_FABRIC_SETTINGS.fabricPortalUrl,
    workloadId: DEFAULT_FABRIC_SETTINGS.workloadId,
    itemType: DEFAULT_FABRIC_SETTINGS.itemType,
  };
}

/** Inputs used to select the Fabric portal for a resolved deployment. */
export interface ResolveFabricPortalUrlOptions {
  /** Portal supplied explicitly or derived from workspace configuration. */
  configuredPortalUrl?: string;
  /** Resolved Rayfin workload endpoint. */
  backendUrl?: string;
  /** Resolved static-hosting endpoint. */
  hostingUrl?: string;
}

const MSIT_FABRIC_PORTAL_URL = 'https://msit.powerbi.com/';
const MSIT_BACKEND_DOMAIN = 'pbidedicated.windows.net';
const MSIT_BACKEND_LABEL_SUFFIX = '-msit';
const MSIT_HOSTING_DOMAIN = 'msit.fabricapps.net';

function isMsitDeploymentEndpoint(url: string | undefined): boolean {
  if (!url) return false;

  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const host = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
    const firstDot = host.indexOf('.');
    if (firstDot <= 0) return false;

    const serviceLabel = host.slice(0, firstDot);
    const parentDomain = host.slice(firstDot + 1);
    return (
      (parentDomain === MSIT_BACKEND_DOMAIN &&
        serviceLabel.endsWith(MSIT_BACKEND_LABEL_SUFFIX) &&
        serviceLabel.length > MSIT_BACKEND_LABEL_SUFFIX.length) ||
      parentDomain === MSIT_HOSTING_DOMAIN
    );
  } catch {
    return false;
  }
}

/**
 * Selects the Fabric portal URL for a resolved deployment.
 *
 * A configured portal takes precedence over endpoint inference. MSIT is
 * inferred from its workload or static-hosting host; all other endpoint
 * shapes retain the commercial default.
 */
export function resolveFabricPortalUrl({
  configuredPortalUrl,
  backendUrl,
  hostingUrl,
}: ResolveFabricPortalUrlOptions): string {
  if (configuredPortalUrl) return configuredPortalUrl;
  if (
    isMsitDeploymentEndpoint(backendUrl) ||
    isMsitDeploymentEndpoint(hostingUrl)
  ) {
    return MSIT_FABRIC_PORTAL_URL;
  }
  return DEFAULT_FABRIC_SETTINGS.fabricPortalUrl;
}

/**
 * Default base URL for the classic Power BI `myorg` REST API (used by the
 * `executeQueries` DAX endpoint), when no Fabric environment override is
 * active.
 */
export const DEFAULT_POWERBI_API_BASE_URL = 'https://api.powerbi.com';

/**
 * Base URL for the classic Power BI `myorg` REST API. Defaults to
 * {@link DEFAULT_POWERBI_API_BASE_URL}; reuses the resolved Fabric API
 * origin instead when {@link getFabricSettings} reflects a non-default
 * environment (e.g. PPE), so callers reach the matching classic API host
 * rather than always hitting production.
 */
export function getPowerBiApiBaseUrl(): string {
  const { fabricApiBaseUrl } = getFabricSettings();
  const isDefaultFabricHost =
    new URL(fabricApiBaseUrl).host ===
    new URL(DEFAULT_FABRIC_SETTINGS.fabricApiBaseUrl).host;
  return isDefaultFabricHost
    ? DEFAULT_POWERBI_API_BASE_URL
    : new URL(fabricApiBaseUrl).origin;
}

/**
 * Normalize a Fabric API base URL so callers can append `/workspaces/...`
 * (and similar) without worrying about trailing slashes or whether the
 * caller-supplied URL ends in `/v1`.
 *
 * Two behaviors based on host:
 *
 * - **Canonical Fabric hosts** (`*.fabric.microsoft.com`): the origin is
 *   honored verbatim and the path is replaced with `/v1`. This preserves
 *   back-compat with the historical normalizer, which silently truncated
 *   shapes like `https://api.fabric.microsoft.com/v1/workspaces/<id>`
 *   back to `<origin>/v1`. We know the canonical Fabric API shape, so any
 *   extra path supplied here is treated as accidental and discarded.
 *
 * - **Non-Fabric hosts** (proxies, custom environments): the path is
 *   preserved verbatim with trailing slash(es) stripped, and `/v1` is
 *   appended only when the resulting path does not already end in `/v1`.
 *   A bare origin therefore becomes `<origin>/v1`, while a proxy URL like
 *   `https://my-proxy.example.com/cli-proxy/fabric/<id>` becomes
 *   `https://my-proxy.example.com/cli-proxy/fabric/<id>/v1`.
 *
 * The `/v1` check is a literal-suffix test (`endsWith('/v1')`), so a
 * proxy path of `/foo/v1bar` would still get `/v1` appended (becoming
 * `/foo/v1bar/v1`). Proxy operators choose their own paths, so this
 * is a documented contract rather than a heuristic to defend against.
 *
 * Query strings and fragments are dropped — Fabric API base URLs do not
 * use them, and preserving them would interact badly with path
 * concatenation at the call site.
 *
 * If the URL does not parse, the input is returned unchanged so the
 * failure surfaces at the call site rather than here.
 */
export function normalizeFabricApiUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (isFabricHost(parsed.hostname)) {
    return `${parsed.origin}/v1`;
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  return cleanPath.endsWith('/v1')
    ? parsed.origin + cleanPath
    : parsed.origin + cleanPath + '/v1';
}

/**
 * Result of parsing a Fabric portal workspace URL via
 * {@link parseWorkspaceUri}.
 */
export interface ParsedWorkspaceUri {
  /**
   * The workspace GUID extracted from the `/groups/<guid>/...` path, or
   * `undefined` when the URL targets the user's personal "My workspace"
   * (path segment `/groups/me/...`). When `undefined`, callers should fall
   * back to their default "My workspace" resolution path.
   */
  workspaceId: string | undefined;
  /**
   * `true` when the URL targets the user's personal "My workspace"
   * (`/groups/me/...`). Mutually exclusive with a defined `workspaceId`.
   */
  isMyWorkspace: boolean;
  /**
   * The Fabric environment name derived from the host subdomain
   * (the leftmost label of the `*.fabric.microsoft.com` host).
   */
  environment: string;
  /** Fabric REST API base URL (`<origin>/v1`) for the parsed environment. */
  fabricApiBaseUrl: string;
  /** Fabric portal URL (trailing slash) for the parsed environment. */
  fabricPortalUrl: string;
}

/** GUID (8-4-4-4-12 hex) validation for the workspace ID path segment. */
const GUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parses a Fabric portal workspace URL and returns the workspace GUID plus
 * the Fabric environment URLs derived from the host subdomain.
 *
 * Accepts URLs of the form:
 *
 *   `https://{env}.fabric.microsoft.com/groups/{workspaceId}/{rest?}[?query]`
 *   `https://{env}.powerbi.com/groups/{workspaceId}/{rest?}[?query]`
 *
 * Both portals label environments identically, so `dxt.powerbi.com` and
 * `dxt.fabric.microsoft.com` resolve to the same environment and derived API
 * URL. Power BI hosts are accepted because that is the URL the portal address
 * bar (and our own onboarding docs) hand the user. MSIT is the portal-origin
 * exception: both accepted host forms resolve to `https://msit.powerbi.com/`.
 *
 * The `{workspaceId}` segment may either be a GUID or the literal string
 * `me`, which the Fabric portal uses for the current user's personal
 * "My workspace". When `me` is supplied, the returned `workspaceId` is
 * `undefined` and `isMyWorkspace` is `true`; callers should fall back to
 * their default "My workspace" resolution path.
 *
 * The leftmost subdomain label is treated as the environment name and is
 * used to construct the API host by appending `api` to it; the portal host
 * is the subdomain unchanged. No validation is performed on the subdomain
 * itself — any recognized host is accepted. This is a convenience flag that
 * trades some resilience for brevity; a URL with a bogus subdomain will
 * simply fail at the downstream Fabric API call.
 *
 * @throws if the URL is unparseable, the host is neither
 *         `*.fabric.microsoft.com` nor `*.powerbi.com`, the path does not
 *         contain `/groups/<guid>`, or the GUID is invalid.
 */
export function parseWorkspaceUri(uri: string): ParsedWorkspaceUri {
  if (typeof uri !== 'string' || uri.trim() === '') {
    throw new Error('Workspace URI must be a non-empty string');
  }

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Invalid workspace URI: ${uri}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(
      `Invalid workspace URI protocol (expected http/https): ${parsed.protocol}`
    );
  }

  // Normalize once: lowercase, and drop the trailing dot of a
  // root-anchored FQDN so the suffix slice below cannot over-trim.
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const domainSuffix = workspaceHostSuffix(host);
  if (!domainSuffix) {
    throw new Error(
      `Workspace URI host must be *.fabric.microsoft.com or *.powerbi.com, got: ${parsed.hostname}`
    );
  }
  // Take the leftmost subdomain label (e.g. the "env" portion from
  // "env.fabric.microsoft.com"). Nested subdomains like
  // "foo.bar.fabric.microsoft.com" would yield "foo". A Power BI portal
  // host uses the same environment label as its Fabric counterpart, so
  // "dxt.powerbi.com" and "dxt.fabric.microsoft.com" both yield "dxt".
  const subdomain = host.slice(0, -domainSuffix.length).split('.')[0];

  if (!subdomain) {
    throw new Error(
      `Workspace URI host must include an environment subdomain: ${parsed.hostname}`
    );
  }

  // Extract the workspace GUID from /groups/<guid>/...
  const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
  const groupsIdx = segments.indexOf('groups');
  if (groupsIdx === -1 || groupsIdx + 1 >= segments.length) {
    throw new Error(
      `Workspace URI must contain a '/groups/<workspaceId>' path segment: ${uri}`
    );
  }
  const workspaceSegment = segments[groupsIdx + 1];
  // The portal uses the literal path segment `me` for the user's personal
  // "My workspace" — surface this as a distinct result so callers can fall
  // back to their default resolution path rather than treating it as a GUID.
  const isMyWorkspace = workspaceSegment.toLowerCase() === 'me';
  if (!isMyWorkspace && !GUID_REGEX.test(workspaceSegment)) {
    throw new Error(
      `Workspace URI contains an invalid workspace ID (expected GUID or 'me'): ${workspaceSegment}`
    );
  }

  // Construct URLs from the subdomain via string templating. The
  // production portal uses "app.fabric.microsoft.com" while its API
  // lives at "api.fabric.microsoft.com" (not "appapi"), so we
  // special-case the "app" subdomain.
  const apiPrefix = subdomain === 'app' ? '' : subdomain;
  return {
    workspaceId: isMyWorkspace ? undefined : workspaceSegment,
    isMyWorkspace,
    environment: subdomain,
    fabricApiBaseUrl: `https://${apiPrefix}api.fabric.microsoft.com/v1`,
    fabricPortalUrl:
      subdomain === 'msit'
        ? MSIT_FABRIC_PORTAL_URL
        : `https://${subdomain}.fabric.microsoft.com/`,
  };
}

/**
 * Applies Fabric environment overrides derived from a portal workspace URI
 * to the given environment record (by default `process.env`).
 *
 * Sets `RAYFIN_FABRIC_API_URL` so subsequent calls to
 * {@link getFabricSettings} use the URI-derived API environment. Also sets
 * `RAYFIN_FABRIC_PORTAL_URL` when no portal override already exists, preserving
 * the portal-selection precedence where an explicit override wins over the
 * environment supplied by a workspace URI.
 *
 * @returns the parsed workspace URI for callers that also need the workspace ID.
 */
export function applyWorkspaceUriOverrides(
  uri: string,
  env: Record<string, string | undefined> = typeof process !== 'undefined'
    ? (process.env as Record<string, string | undefined>)
    : {}
): ParsedWorkspaceUri {
  const parsed = parseWorkspaceUri(uri);
  env.RAYFIN_FABRIC_API_URL = parsed.fabricApiBaseUrl;
  env.RAYFIN_FABRIC_PORTAL_URL ||= parsed.fabricPortalUrl;
  return parsed;
}

/**
 * Result of {@link applyBaseApiUrlOverride}: the normalized API base URL
 * and, when derivable, the matching Fabric portal URL.
 */
export interface AppliedBaseApiUrlOverride {
  /**
   * Normalized Fabric API base URL. The exact shape depends on the host:
   *
   * - Canonical Fabric hosts (`*.fabric.microsoft.com`): always
   *   `<origin>/v1` — extra path segments on the input are dropped.
   * - Non-Fabric hosts (proxies, custom envs): `<origin><path>` with
   *   `/v1` appended only when `<path>` does not already end in `/v1`.
   *
   * See {@link normalizeFabricApiUrl} for the full contract. Always present.
   */
  fabricApiBaseUrl: string;
  /**
   * Fabric portal URL derived from the API host, when the host follows
   * the `*.fabric.microsoft.com` `<env>api` convention (or the `api`
   * production host). `undefined` for non-Fabric or non-conforming hosts;
   * callers should fall back to the existing `RAYFIN_FABRIC_PORTAL_URL`
   * or {@link DEFAULT_FABRIC_SETTINGS.fabricPortalUrl} in that case.
   */
  fabricPortalUrl?: string;
}

/**
 * Derive the Fabric portal URL from a Fabric API host using the inverse
 * of the convention applied by {@link parseWorkspaceUri}:
 *
 *  - `api.fabric.microsoft.com`     → `https://app.fabric.microsoft.com/`
 *  - `<env>api.fabric.microsoft.com` → `https://<env>.fabric.microsoft.com/`
 *
 * Returns `undefined` for hosts that do not match `*.fabric.microsoft.com`
 * or whose leftmost subdomain does not end in `api`.
 */
function derivePortalUrlFromApiHost(host: string): string | undefined {
  const lower = host.toLowerCase();
  if (!isFabricHost(lower)) {
    return undefined;
  }
  const subdomain = lower.slice(0, -FABRIC_DOMAIN_SUFFIX.length).split('.')[0];
  if (!subdomain || !subdomain.endsWith('api')) {
    return undefined;
  }
  // Inverse of parseWorkspaceUri: production "app" portal maps to "api",
  // any other "<env>api" host maps back to "<env>".
  const portalSubdomain =
    subdomain === 'api' ? 'app' : subdomain.slice(0, -'api'.length);
  if (!portalSubdomain) {
    return undefined;
  }
  return `https://${portalSubdomain}.fabric.microsoft.com/`;
}

/**
 * Applies a Fabric API base URL override (typically from a CLI
 * `--base-api-url` flag) to the given environment record (by default
 * `process.env`).
 *
 * Sets `RAYFIN_FABRIC_API_URL` so subsequent calls to
 * {@link getFabricSettings} observe the supplied value. When the host
 * follows the `*.fabric.microsoft.com` `<env>api` convention (e.g.
 * `<env>api.fabric.microsoft.com` or the production `api` host), the
 * matching portal URL is derived and `RAYFIN_FABRIC_PORTAL_URL` is set
 * as well so deep links and `RAYFIN_PUBLIC_PORTAL_URL` target the same
 * Fabric environment as the API. Both overrides are unconditional —
 * caller-supplied values take precedence over any pre-existing env vars.
 *
 * The URL is validated and normalized via {@link normalizeFabricApiUrl}
 * so callers may pass any of:
 *
 * - a bare origin (e.g. `https://api.fabric.microsoft.com`) — `/v1` is
 *   appended;
 * - a fully qualified API base URL (e.g.
 *   `https://api.fabric.microsoft.com/v1`) — preserved as-is;
 * - a Fabric URL with an extra path (e.g.
 *   `https://api.fabric.microsoft.com/v1/workspaces/<id>`) — truncated
 *   back to `<origin>/v1` since Fabric hosts have a known shape;
 * - a non-Fabric origin with a path prefix (e.g.
 *   `https://my-proxy.example.com/cli-proxy/fabric/<conn_id>`) — the
 *   prefix is preserved verbatim and `/v1` is appended.
 *
 * @returns the normalized API URL plus, when derivable, the matching
 *          portal URL written to the env record.
 * @throws if the URL is unparseable or uses a non-http(s) protocol.
 */
export function applyBaseApiUrlOverride(
  url: string,
  env: Record<string, string | undefined> = typeof process !== 'undefined'
    ? (process.env as Record<string, string | undefined>)
    : {}
): AppliedBaseApiUrlOverride {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error('Base API URL must be a non-empty string');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid base API URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(
      `Invalid base API URL protocol (expected http/https): ${parsed.protocol}`
    );
  }
  const normalized = normalizeFabricApiUrl(url);
  env.RAYFIN_FABRIC_API_URL = normalized;

  const portalUrl = derivePortalUrlFromApiHost(parsed.hostname);
  if (portalUrl) {
    env.RAYFIN_FABRIC_PORTAL_URL = portalUrl;
  }

  return { fabricApiBaseUrl: normalized, fabricPortalUrl: portalUrl };
}
