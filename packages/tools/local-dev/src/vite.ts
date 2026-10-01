import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { debuglog } from 'node:util';

import { getAuthenticatedToken } from '@microsoft/rayfin-cli/auth';
import { loadEnv, type Plugin, type ProxyOptions } from 'vite';

import { readStaticAccess } from './posture.js';
import { attachSourceActivity } from './source-activity-vite.js';

import { RAYFIN_LOCAL_FUNCTIONS_BASE_URL } from './index.js';
import type { RayfinLocalSessionToken } from './index.js';

const debugLog = debuglog('rayfin-local-dev');

/** A delegated Entra access token cached with its expiry timestamp. */
interface CachedEntraToken {
  accessToken: string;
  expiresAt: number;
}

const SESSION_API_URL_ENV = 'RAYFIN_PUBLIC_API_URL';
const VITE_API_URL_ENV = 'VITE_RAYFIN_API_URL';
const SESSION_FUNCTIONS_URL_ENV = 'RAYFIN_PUBLIC_FUNCTIONS_URL';
const VITE_FUNCTIONS_URL_ENV = 'VITE_RAYFIN_FUNCTIONS_URL';
const VITE_PUBLISHABLE_KEY_ENV = 'VITE_RAYFIN_PUBLISHABLE_KEY';
const VITE_WORKSPACE_ID_ENV = 'VITE_FABRIC_WORKSPACE_ID';
const VITE_ITEM_ID_ENV = 'VITE_FABRIC_ITEM_ID';
const VITE_PORTAL_URL_ENV = 'VITE_FABRIC_PORTAL_URL';
const VITE_TENANT_ID_ENV = 'VITE_FABRIC_TENANT_ID';
const LOCAL_FUNCTIONS_DEFINE = '__RAYFIN_LOCAL_FUNCTIONS_PROXY__';
const LOCAL_STATIC_ACCESS_DEFINE = '__RAYFIN_LOCAL_STATIC_ACCESS__';
const LOCAL_AUTO_LOGIN_DEFINE = '__RAYFIN_LOCAL_AUTO_LOGIN__';
const LOCAL_FUNCTIONS_PROXY_CONTEXT = '^/\\.rayfin/api(?:/|$)';
// The default (unconfigured `functionsBaseUrl`) route a `RayfinClient`
// invokes functions against, matching the deployed `FUNCTIONS_BASE_PATH`
// convention (`${apiUrl}/functions/<name>/invoke`) rather than the
// `/.rayfin`-prefixed route above, which only serves callers that pass an
// explicit `functionsBaseUrl` override.
const DEFAULT_FUNCTIONS_PROXY_CONTEXT = '^/functions(?:/|$)';
// Well-known backend route roots the SDK issues requests against (see
// `packages/typescript-sdk/lib/src/constants.ts`). Proxying by prefix --
// rather than a catch-all -- keeps ordinary client-side SPA routes falling
// through to Vite's `index.html`.
const BACKEND_PROXY_CONTEXT =
  '^/(?:api|graphql|connector-invoke|connectors)(?:/|$)';
const RAYFIN_CONFIG_PATH = '/rayfin.config.json';
const LOCAL_SESSION_TOKEN_PATH = '/.rayfin/dev/session-token';
const BROKERED_AUTH_SCOPE =
  'https://analysis.windows.net/powerbi/api/Item.Execute.All';
// `ApiClient.requestIsolated()`'s own request contract (see
// `packages/typescript-sdk/lib/src/ApiClient.ts`'s `prepareHeaders()`)
// always sends these alongside `Authorization` -- the backend's brokered
// exchange route expects the full request shape, not just the bearer token.
const PUBLISHABLE_KEY_HEADER = 'X-Publishable-Key';
const WORKLOAD_MONIKER_HEADER = 'x-ms-workload-resource-moniker';
// The backend route `signInWithEntraToken()`/`signInWithBrokeredToken()`
// exchange a delegated Entra token against (see
// `@microsoft/rayfin-auth-provider-fabric`'s `signInWithEntraToken.ts`).
// Performed here, in Node, rather than in the browser, so it can reach a
// plain-HTTP local backend (e.g. Docker dev mode) that
// `signInWithEntraToken()`'s browser-side HTTPS requirement would reject.
const BROKERED_TOKEN_PATH = '/api/auth/v1/brokered/token';
const TOKEN_CACHE_SKEW_MS = 2 * 60 * 1000;
const PROXY_ERROR_BODY = JSON.stringify({
  error: 'The local Rayfin Functions host is unavailable.',
});
const BACKEND_PROXY_ERROR_BODY = JSON.stringify({
  error: 'The local Rayfin backend is unavailable.',
});

/** Optional fields projected into the served `rayfin.config.json`. */
interface LocalRuntimeConfig {
  publishableKey?: string;
  workspaceId?: string;
  itemId?: string;
  portalUrl?: string;
  tenantId?: string;
}

/** Options for {@link rayfinLocalDev}. */
export interface RayfinLocalDevOptions {
  /**
   * Local backend (BaaS) URL. By default the plugin uses the resolved Vite
   * environment's `VITE_RAYFIN_API_URL`. When resolved, the plugin serves a
   * real `rayfin.config.json` (pointing at the same-origin proxy below)
   * instead of letting the request fall through to Vite's `index.html`.
   */
  apiUrl?: string;

  /**
   * Local Functions host URL. By default the plugin uses the URL inherited
   * from the active `rayfin dev` session, then the resolved Vite environment.
   */
  functionsUrl?: string;

  /**
   * Seed local authentication from the Rayfin CLI's own signed-in session
   * for a public site. Protected sites always enable local automatic
   * sign-in.
   */
  autoLogin?: boolean;

  /**
   * Report local workspace source edits to the Universal App welcome.
   * Disabled by default; inactive in production builds.
   */
  sourceActivity?: boolean;
}

/**
 * Add same-origin local backend, data, and Functions routing to a Vite
 * development server.
 *
 * When a local backend URL resolves (`apiUrl` option, `VITE_RAYFIN_API_URL`,
 * or the active `rayfin dev` session), the plugin serves a real
 * `rayfin.config.json` whose `apiUrl` is the dev server's own origin, and
 * proxies the SDK's well-known backend routes (`/api`, `/graphql`,
 * `/connector-invoke`, `/connectors`, `/functions`) to that backend and to
 * the resolved local Functions host -- so local dev exercises the exact same
 * runtime-config code path a deployed app does, rather than the build-time
 * `VITE_*` fallback. When no backend URL resolves, the plugin does not
 * intercept `rayfin.config.json`, and the SDK falls back to that mechanism
 * as before.
 *
 * A caller may still pass an explicit `functionsBaseUrl` (e.g. via
 * {@link resolveRayfinFunctionsBaseUrl}) to reach the local Functions host
 * through the legacy `/.rayfin/api` route instead of the default
 * `/functions` route above. If that runtime is unavailable, both proxies
 * return HTTP 502 and never fall through to deployed function code.
 *
 * The adapter also reads `services.staticHosting.assetAccess` from the nearest
 * `rayfin/rayfin.yml`. Protected sites automatically expose a loopback-only
 * endpoint that obtains a delegated Entra token via the Rayfin CLI's own
 * authentication module, then exchanges it against the resolved local
 * backend for a Rayfin token response -- here, in Node, rather than in the
 * browser, so the exchange can reach a plain-HTTP local backend (e.g.
 * Docker dev mode) that `signInWithEntraToken()`'s browser-side HTTPS
 * requirement would reject.
 * Public sites expose that endpoint only when `autoLogin` is enabled. The
 * plugin is inactive in production builds.
 *
 * @param options - Optional explicit local runtime URLs.
 * @returns A Vite development-server plugin.
 *
 * @example
 * ```ts
 * import { rayfinLocalDev } from '@microsoft/rayfin-local-dev/vite';
 * import { defineConfig } from 'vite';
 *
 * export default defineConfig({
 *   plugins: [rayfinLocalDev()],
 * });
 * ```
 */
export function rayfinLocalDev(options: RayfinLocalDevOptions = {}): Plugin {
  let autoLoginActive = false;
  let cachedToken: CachedEntraToken | undefined;
  let runtimeConfig: LocalRuntimeConfig | undefined;
  let resolvedApiUrl: string | undefined;
  let disposeSourceActivity: (() => void) | undefined;

  return {
    name: 'rayfin-local-dev',
    apply: 'serve',
    config(config, env) {
      const root = resolve(process.cwd(), config.root ?? '.');
      const envDir = config.envDir ? resolve(root, config.envDir) : root;
      const staticAccess = readStaticAccess(root);
      const viteEnv = loadEnv(env.mode, envDir, 'VITE_');
      const functionsUrl =
        options.functionsUrl ??
        process.env[SESSION_FUNCTIONS_URL_ENV] ??
        viteEnv[VITE_FUNCTIONS_URL_ENV];
      const apiUrl =
        options.apiUrl ??
        process.env[SESSION_API_URL_ENV] ??
        viteEnv[VITE_API_URL_ENV];
      const resolvedFunctionsUrl = functionsUrl?.trim()
        ? functionsUrl
        : undefined;
      resolvedApiUrl = apiUrl?.trim() ? apiUrl : undefined;

      // The brokered-token exchange happens here, in Node, against
      // `resolvedApiUrl` directly -- not through the same-origin proxy below
      // -- so automatic sign-in only needs a resolved backend, regardless of
      // its protocol.
      autoLoginActive =
        (staticAccess === 'protected' || options.autoLogin === true) &&
        resolvedApiUrl !== undefined;

      const legacyFunctionsProxy = resolvedFunctionsUrl
        ? createFunctionsProxy(
            resolvedFunctionsUrl,
            RAYFIN_LOCAL_FUNCTIONS_BASE_URL
          )
        : undefined;

      runtimeConfig = apiUrl?.trim()
        ? {
            publishableKey: viteEnv[VITE_PUBLISHABLE_KEY_ENV],
            workspaceId: viteEnv[VITE_WORKSPACE_ID_ENV],
            itemId: viteEnv[VITE_ITEM_ID_ENV],
            portalUrl: viteEnv[VITE_PORTAL_URL_ENV],
            tenantId: viteEnv[VITE_TENANT_ID_ENV],
          }
        : undefined;

      const proxy: Record<string, ProxyOptions> = {};
      if (legacyFunctionsProxy) {
        proxy[LOCAL_FUNCTIONS_PROXY_CONTEXT] = legacyFunctionsProxy;
        proxy[DEFAULT_FUNCTIONS_PROXY_CONTEXT] = createDefaultFunctionsProxy(
          resolvedFunctionsUrl!
        );
      }
      if (runtimeConfig) {
        proxy[BACKEND_PROXY_CONTEXT] = createBackendProxy(apiUrl!);
      }

      debugLog('config options: %o', {
        apiUrl: options.apiUrl,
        functionsUrl: options.functionsUrl,
        autoLogin: options.autoLogin,
      });
      debugLog('resolved config: %o', {
        root,
        mode: env.mode,
        apiUrl: resolvedApiUrl,
        functionsUrl: resolvedFunctionsUrl,
        staticAccess,
        autoLoginActive,
        proxyContexts: Object.keys(proxy),
      });

      return {
        define: {
          [LOCAL_FUNCTIONS_DEFINE]: String(legacyFunctionsProxy !== undefined),
          [LOCAL_STATIC_ACCESS_DEFINE]: staticAccess
            ? JSON.stringify(staticAccess)
            : 'undefined',
          [LOCAL_AUTO_LOGIN_DEFINE]: String(autoLoginActive),
        },
        server: Object.keys(proxy).length > 0 ? { proxy } : undefined,
      };
    },
    configureServer(server) {
      if (options.sourceActivity) {
        disposeSourceActivity?.();
        disposeSourceActivity = attachSourceActivity(server);
      }
      server.middlewares.use(RAYFIN_CONFIG_PATH, (request, response, next) => {
        debugMiddlewareRequest(RAYFIN_CONFIG_PATH, request, response);
        if (!runtimeConfig || request.method !== 'GET') {
          next();
          return;
        }
        const protocol = (request.socket as { encrypted?: boolean }).encrypted
          ? 'https:'
          : 'http:';
        const origin = request.headers.host
          ? `${protocol}//${request.headers.host}`
          : undefined;
        if (!origin) {
          next();
          return;
        }
        response.setHeader('content-type', 'application/json');
        response.setHeader('cache-control', 'no-store');
        response.end(
          JSON.stringify({
            apiUrl: origin,
            ...(runtimeConfig.publishableKey
              ? { publishableKey: runtimeConfig.publishableKey }
              : {}),
            ...(runtimeConfig.workspaceId
              ? { workspaceId: runtimeConfig.workspaceId }
              : {}),
            ...(runtimeConfig.itemId ? { itemId: runtimeConfig.itemId } : {}),
            ...(runtimeConfig.portalUrl
              ? { portalUrl: runtimeConfig.portalUrl }
              : {}),
            ...(runtimeConfig.tenantId
              ? { tenantId: runtimeConfig.tenantId }
              : {}),
          })
        );
      });

      if (!autoLoginActive || !resolvedApiUrl) return;
      const backendApiUrl = resolvedApiUrl;
      server.middlewares.use(
        LOCAL_SESSION_TOKEN_PATH,
        createSessionTokenMiddleware(
          async () => {
            if (
              cachedToken &&
              cachedToken.expiresAt > Date.now() + TOKEN_CACHE_SKEW_MS
            ) {
              return cachedToken;
            }
            cachedToken = await acquireEntraToken(runtimeConfig?.tenantId);
            return cachedToken;
          },
          backendApiUrl,
          {
            publishableKey: runtimeConfig?.publishableKey,
            moniker: runtimeConfig?.itemId,
          }
        )
      );
    },
    closeBundle() {
      disposeSourceActivity?.();
      disposeSourceActivity = undefined;
    },
  };
}

interface TokenErrorBody {
  error: string;
  hint: string;
}

/** Additional request-routing headers the backend's brokered exchange expects. */
interface BrokeredExchangeRequestHeaders {
  /** Rayfin publishable key, sent as `X-Publishable-Key`. */
  publishableKey?: string;
  /** Fabric item ID (or other resolved moniker), sent as `x-ms-workload-resource-moniker`. */
  moniker?: string;
}

/**
 * Serves an already-exchanged Rayfin token response ({@link RayfinLocalSessionToken})
 * from the loopback-only local sign-in endpoint.
 *
 * Acquires the delegated Entra token (`getToken`), then performs the
 * brokered-token exchange itself against `apiUrl` -- in Node, not the
 * browser -- so it can reach a plain-HTTP local backend that
 * `signInWithEntraToken()`'s browser-side HTTPS requirement would reject.
 */
function createSessionTokenMiddleware(
  getToken: () => Promise<CachedEntraToken>,
  apiUrl: string,
  requestHeaders: BrokeredExchangeRequestHeaders
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    debugMiddlewareRequest(LOCAL_SESSION_TOKEN_PATH, request, response);
    response.setHeader('content-type', 'application/json');
    response.setHeader('cache-control', 'no-store');

    if (request.method !== 'GET') {
      response.statusCode = 405;
      response.setHeader('allow', 'GET');
      response.end(JSON.stringify({ error: 'Method not allowed.' }));
      return;
    }
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      response.statusCode = 403;
      response.end(
        JSON.stringify({
          error: 'Local sign-in is only available from the Vite host.',
        })
      );
      return;
    }
    if (!isSameOriginRequest(request)) {
      response.statusCode = 403;
      response.end(
        JSON.stringify({
          error: 'Cross-origin local sign-in requests are not allowed.',
        })
      );
      return;
    }

    let entraToken: string;
    try {
      entraToken = (await getToken()).accessToken;
    } catch (error) {
      const body = describeTokenError(error);
      response.statusCode = 503;
      response.end(JSON.stringify(body));
      return;
    }

    try {
      const sessionToken = await exchangeBrokeredToken(
        apiUrl,
        entraToken,
        requestHeaders
      );
      response.statusCode = 200;
      response.end(JSON.stringify(sessionToken));
    } catch (error) {
      const body = describeBrokeredExchangeError(error);
      response.statusCode = 502;
      response.end(JSON.stringify(body));
    }
  };
}

/**
 * Exchanges a delegated Entra token for a Rayfin token response by calling
 * the backend's brokered-token route directly, mirroring
 * `signInWithEntraToken()` in `@microsoft/rayfin-auth-provider-fabric` --
 * except run here in Node so it can reach a plain-HTTP local backend.
 *
 * Sends the same `X-Publishable-Key` and `x-ms-workload-resource-moniker`
 * headers `ApiClient.requestIsolated()` always includes alongside
 * `Authorization` -- omitting them changes the request contract the backend
 * expects, even though only the bearer token is strictly required for this
 * specific route today.
 */
async function exchangeBrokeredToken(
  apiUrl: string,
  entraToken: string,
  requestHeaders: BrokeredExchangeRequestHeaders
): Promise<RayfinLocalSessionToken> {
  const url = joinBackendPath(apiUrl, BROKERED_TOKEN_PATH);
  const headers: Record<string, string> = {
    authorization: `Bearer ${entraToken}`,
  };
  if (requestHeaders.publishableKey) {
    headers[PUBLISHABLE_KEY_HEADER] = requestHeaders.publishableKey;
  }
  // Mirrors `ApiClient.prepareHeaders()`'s own fallback: prefer an explicitly
  // resolved moniker (the Fabric item ID) over guessing from the backend
  // URL's trailing GUID.
  const moniker = requestHeaders.moniker ?? extractLastGuid(apiUrl);
  if (moniker) {
    headers[WORKLOAD_MONIKER_HEADER] = moniker;
  }
  let response: Response;
  debugLog('request out [brokered-token]: POST %s', url);
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      redirect: 'error',
    });
  } catch (cause) {
    debugLog(
      'request failed [brokered-token]: POST %s: %s',
      url,
      cause instanceof Error ? cause.message : String(cause)
    );
    throw new BrokeredExchangeError(undefined, cause);
  }
  debugLog('response in [brokered-token]: POST %s -> %d', url, response.status);
  if (response.redirected || !response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new BrokeredExchangeError(response.status);
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch (cause) {
    throw new BrokeredExchangeError(undefined, cause);
  }
  return validateSessionToken(value);
}

function validateSessionToken(value: unknown): RayfinLocalSessionToken {
  if (!value || typeof value !== 'object') {
    throw new BrokeredExchangeError();
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.accessToken !== 'string' ||
    !record.accessToken.trim() ||
    typeof record.tokenType !== 'string' ||
    record.tokenType.toLowerCase() !== 'bearer' ||
    typeof record.expiresIn !== 'number' ||
    !Number.isFinite(record.expiresIn) ||
    record.expiresIn <= 0 ||
    (record.refreshToken != null && typeof record.refreshToken !== 'string') ||
    (record.scope != null && typeof record.scope !== 'string')
  ) {
    throw new BrokeredExchangeError();
  }
  return {
    accessToken: record.accessToken,
    tokenType: record.tokenType,
    expiresIn: record.expiresIn,
    refreshToken:
      typeof record.refreshToken === 'string' ? record.refreshToken : undefined,
    scope: typeof record.scope === 'string' ? record.scope : undefined,
  };
}

/** Joins a service-relative path onto a backend URL, preserving its path. */
function joinBackendPath(apiUrl: string, path: string): string {
  const base = apiUrl.endsWith('/') ? apiUrl.slice(0, -1) : apiUrl;
  const relativePath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${relativePath}`;
}

/**
 * Extracts the last GUID from a URL, mirroring `ApiClient`'s own
 * `extractLastGuid()` fallback for resolving `x-ms-workload-resource-moniker`
 * when no explicit moniker (Fabric item ID) is configured.
 */
function extractLastGuid(url: string): string | undefined {
  const guidPattern =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const matches = url.match(guidPattern);
  return matches ? matches[matches.length - 1] : undefined;
}

/** Thrown when the brokered-token exchange with the local backend fails. */
class BrokeredExchangeError extends Error {
  public constructor(
    public readonly status?: number,
    public override readonly cause?: unknown
  ) {
    super('Entra token exchange failed.');
  }
}

function describeBrokeredExchangeError(error: unknown): TokenErrorBody {
  const status =
    error instanceof BrokeredExchangeError ? error.status : undefined;
  switch (status) {
    case 400:
      return {
        error: 'External Entra exchange is not enabled.',
        hint: 'Set `services.auth.fabric.externalEntraExchange: true` in `rayfin/rayfin.yml`, then redeploy.',
      };
    case 401:
      return {
        error: 'Entra authentication failed.',
        hint: 'Run `rayfin login` with a user that can access the Fabric item, or retry the Microsoft sign-in prompt.',
      };
    case 403:
      return {
        error: 'Item Execute permission is required.',
        hint: 'Sign in with an account that has Execute access to the Fabric item.',
      };
    case 404:
      return {
        error: 'External Entra exchange is not available.',
        hint: 'Confirm the local backend URL points at a Fabric AppBackend with brokered auth enabled.',
      };
    default:
      return {
        error: 'Entra token exchange failed.',
        hint: 'Confirm the local backend is reachable, then retry.',
      };
  }
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address === '::1' ||
    address === '0:0:0:0:0:0:0:1' ||
    /^127(?:\.\d{1,3}){3}$/.test(address) ||
    /^::ffff:127(?:\.\d{1,3}){3}$/i.test(address)
  );
}

function isSameOriginRequest(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  const host = request.headers.host;
  if (!host) return false;

  try {
    const protocol = (request.socket as { encrypted?: boolean }).encrypted
      ? 'https:'
      : 'http:';
    return new URL(origin).origin === `${protocol}//${host}`;
  } catch {
    return false;
  }
}

/**
 * Acquire a delegated Entra token for the local sign-in endpoint by
 * delegating to the Rayfin CLI's own authentication module. This reuses
 * whatever session the developer already has (or triggers the CLI's usual
 * interactive/device-code sign-in if none exists) instead of requiring a
 * separate, redundant `az login`.
 */
async function acquireEntraToken(
  tenantId: string | undefined
): Promise<CachedEntraToken> {
  try {
    const result = await getAuthenticatedToken([BROKERED_AUTH_SCOPE], {
      tenantId,
    });
    return { accessToken: result.token, expiresAt: result.expiresOnTimestamp };
  } catch (cause) {
    throw new EntraTokenError(cause);
  }
}

/** Thrown when the Rayfin CLI could not provide a delegated Entra token. */
class EntraTokenError extends Error {
  public constructor(public override readonly cause?: unknown) {
    super('Failed to acquire a delegated Entra token via the Rayfin CLI.');
  }
}

function describeTokenError(error: unknown): TokenErrorBody {
  const causeMessage =
    error instanceof EntraTokenError && error.cause instanceof Error
      ? error.cause.message
      : undefined;
  return {
    error: 'Could not sign you in automatically for local development.',
    hint: causeMessage
      ? `Run \`rayfin login\`, then retry. (${causeMessage})`
      : 'Run `rayfin login`, then retry.',
  };
}

/**
 * Proxy for callers that pass an explicit `functionsBaseUrl` override (see
 * {@link RAYFIN_LOCAL_FUNCTIONS_BASE_URL}), e.g. `/.rayfin/api/<name>`.
 * Rewrites to the Azure Functions Core Tools convention
 * `${targetBasePath}/api/<name>`.
 */
function createFunctionsProxy(
  functionsUrl: string,
  stripPrefix: string
): ProxyOptions {
  const targetBasePath = parseFunctionsTargetBasePath(functionsUrl);
  return {
    target: parseFunctionsTargetOrigin(functionsUrl),
    changeOrigin: true,
    rewrite(path) {
      const requestPath =
        stripPrefix && path.startsWith(stripPrefix)
          ? path.slice(stripPrefix.length)
          : path;
      return `${targetBasePath}${requestPath.startsWith('/') ? requestPath : `/${requestPath}`}`;
    },
    configure(proxy) {
      configureProxyDebug(proxy, 'legacy-functions', PROXY_ERROR_BODY);
    },
  };
}

/**
 * Proxy for the SDK's default (unconfigured `functionsBaseUrl`) route,
 * `/functions/<name>/invoke`. Rewrites to the Azure Functions Core Tools
 * convention `${targetBasePath}/api/<name>`, matching
 * {@link createFunctionsProxy}'s target shape without requiring the app to
 * ever set `functionsBaseUrl` explicitly.
 */
function createDefaultFunctionsProxy(functionsUrl: string): ProxyOptions {
  const targetBasePath = parseFunctionsTargetBasePath(functionsUrl);
  return {
    target: parseFunctionsTargetOrigin(functionsUrl),
    changeOrigin: true,
    rewrite(path) {
      const match = /^\/functions\/([^/]+)\/invoke\/?$/.exec(path);
      return match ? `${targetBasePath}/api/${match[1]}` : path;
    },
    configure(proxy) {
      configureProxyDebug(proxy, 'default-functions', PROXY_ERROR_BODY);
    },
  };
}

function parseFunctionsTargetOrigin(functionsUrl: string): string {
  return parseFunctionsTarget(functionsUrl).origin;
}

function parseFunctionsTargetBasePath(functionsUrl: string): string {
  return parseFunctionsTarget(functionsUrl).pathname.replace(/\/+$/, '');
}

function parseFunctionsTarget(functionsUrl: string): URL {
  let target: URL;
  try {
    target = new URL(functionsUrl);
  } catch {
    throw new Error(`Invalid local Rayfin Functions URL: ${functionsUrl}`);
  }
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    target.search ||
    target.hash
  ) {
    throw new Error(`Invalid local Rayfin Functions URL: ${functionsUrl}`);
  }
  return target;
}

function createBackendProxy(apiUrl: string): ProxyOptions {
  let target: URL;
  try {
    target = new URL(apiUrl);
  } catch {
    throw new Error(`Invalid local Rayfin backend URL: ${apiUrl}`);
  }
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    target.search ||
    target.hash
  ) {
    throw new Error(`Invalid local Rayfin backend URL: ${apiUrl}`);
  }

  const targetBasePath = target.pathname.replace(/\/+$/, '');
  return {
    target: target.origin,
    changeOrigin: true,
    rewrite(path) {
      return `${targetBasePath}${path.startsWith('/') ? path : `/${path}`}`;
    },
    configure(proxy) {
      configureProxyDebug(proxy, 'backend', BACKEND_PROXY_ERROR_BODY);
    },
  };
}

function debugMiddlewareRequest(
  route: string,
  request: IncomingMessage,
  response: ServerResponse
): void {
  const method = request.method ?? 'UNKNOWN';
  const url = request.url ?? route;
  debugLog('request in [%s]: %s %s', route, method, url);
  if (typeof response.once === 'function') {
    response.once('finish', () => {
      debugLog(
        'response out [%s]: %s %s -> %d',
        route,
        method,
        url,
        response.statusCode
      );
    });
  }
}

function configureProxyDebug(
  proxy: Parameters<NonNullable<ProxyOptions['configure']>>[0],
  route: string,
  errorBody: string
): void {
  proxy.on('proxyReq', (proxyRequest, request) => {
    debugLog(
      'request in/out [%s]: %s %s -> %s',
      route,
      request.method ?? 'UNKNOWN',
      request.url ?? '/',
      proxyRequest.path
    );
  });
  proxy.on('proxyRes', (proxyResponse, request) => {
    debugLog(
      'response in/out [%s]: %s %s -> %d',
      route,
      request.method ?? 'UNKNOWN',
      request.url ?? '/',
      proxyResponse.statusCode ?? 0
    );
  });
  proxy.on('error', (error, request, response) => {
    debugLog(
      'proxy error [%s]: %s %s: %s',
      route,
      request.method ?? 'UNKNOWN',
      request.url ?? '/',
      error.message
    );
    if (!('writeHead' in response)) {
      response.destroy();
      return;
    }
    if (!response.headersSent) {
      response.writeHead(502, { 'content-type': 'application/json' });
    }
    if (!response.writableEnded) response.end(errorBody);
  });
}

export default rayfinLocalDev;
