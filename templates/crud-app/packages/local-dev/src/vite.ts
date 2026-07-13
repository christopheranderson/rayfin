/**
 * @packageDocumentation
 * Vite dev-server plugin for Rayfin local development.
 *
 * The plugin installs a single middleware that owns every request under the
 * same-origin {@link RAYFIN_PROXY_PREFIX} (`/.rayfin`) prefix and forwards it on:
 *
 * - **Function invocations** (`/.rayfin/functions/<name>/invoke`) are routed to
 *   a locally-running Azure Functions host (`func start`, default `:7071`) as
 *   `POST /api/<name>` **when that host is detected as up**. This is the local
 *   inner-loop: edit a function, hit it from the app, no redeploy. When no local
 *   host is running, the same call falls through to the remote backend so the
 *   deployed function is used instead.
 * - **Everything else** (`/.rayfin/api/...`, auth, data, storage) is forwarded
 *   verbatim to the remote backend.
 *
 * Local-host availability is discovered with a cached TCP probe, so starting or
 * stopping `func start` is picked up live without a per-request cost and without
 * the plugin ever having to start or manage the host itself.
 *
 * Scope note: this plugin only *routes*. It never spawns the Functions host and
 * never shells out to the Rayfin CLI — those remain the developer's (or a future
 * package's) responsibility.
 */

import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect, type Socket } from 'node:net';

import type { Plugin, ResolvedConfig } from 'vite';

import {
  FabricAuthBroker,
  type FabricAuthBrokerOptions,
} from './authBroker.js';
import {
  BRIDGE_MODULE_CODE,
  defaultOpenBrowser,
  registerFabricAuthProxy,
  type OpenBrowser,
} from './authMiddleware.js';
import {
  RAYFIN_PROXY_PREFIX,
  RAYFIN_AUTH_PROXY_PATH,
  RAYFIN_AUTH_BRIDGE_VIRTUAL_ID,
  FUNCTIONS_INVOKE_PREFIX,
  DEFAULT_FUNCTIONS_HOST,
  DEFAULT_FUNCTIONS_PORT,
  DEFAULT_PROBE_TTL_MS,
} from './constants.js';

/** Options for {@link rayfinLocalDev}. */
export interface RayfinLocalDevOptions {
  /**
   * Absolute base URL of the remote Rayfin backend that non-local requests are
   * forwarded to. Defaults to `VITE_RAYFIN_API_URL` from the resolved Vite env
   * (populated by `rayfin env`), falling back to `http://localhost:5168`.
   */
  apiUrl?: string;
  /**
   * Same-origin prefix the middleware claims. Defaults to
   * {@link RAYFIN_PROXY_PREFIX}. Must match what the client sends (the client
   * helper uses the same constant).
   */
  prefix?: string;
  /** Local Azure Functions host settings. */
  functions?: {
    /** Enable local-functions rerouting. Defaults to `true`. */
    enabled?: boolean;
    /** Host the local `func` process listens on. Defaults to `127.0.0.1`. */
    host?: string;
    /** Port the local `func` process listens on. Defaults to `7071`. */
    port?: number;
  };
  /** TTL (ms) for the cached local-host availability probe. */
  probeTtlMs?: number;
  /**
   * Fabric auth proxy — a system-browser login broker for WebView hosts.
   *
   * Embedded WebViews (GitHub Copilot desktop, Electron, VS Code webviews)
   * can't complete a Fabric SSO/passkey login. When enabled, the plugin exposes
   * {@link RAYFIN_AUTH_PROXY_PATH} so a WebView app can trigger the login in the
   * real system browser and receive the resulting raw Rayfin tokens back over
   * loopback. Disabled by default — opt in explicitly for dev.
   */
  auth?: {
    /** Enable the Fabric auth proxy routes. Defaults to `false`. */
    enabled?: boolean;
    /**
     * Publishable key used for *server-side* token refresh. Defaults to
     * `VITE_RAYFIN_PUBLISHABLE_KEY` from the resolved Vite env. The bridge may
     * also supply one per-login, which takes precedence.
     */
    publishableKey?: string;
    /** Max ms a pending login waits for the browser bridge. */
    loginTimeoutMs?: number;
    /** Refresh a cached token this many ms before it expires. */
    refreshSkewMs?: number;
    /** Override the system-browser launcher (mainly for testing). */
    openBrowser?: OpenBrowser;
  };
  /**
   * Emit per-request debug logging (routing decisions, the fully-resolved
   * upstream URL, and upstream response status). Defaults to `true` while this
   * remains a POC; set to `false` to quiet the dev-server output. Can also be
   * forced off with `VITE_RAYFIN_LOCAL_DEBUG=0`.
   */
  debug?: boolean;
}

const LOG_PREFIX = '[rayfin-local]';

/** Minimal structured logger the middleware threads into request handling. */
type DebugLog = (message: string) => void;

/**
 * Map a production function-invoke path to the Azure Functions Core Tools path.
 *
 * `/functions/<name>/invoke` → `/api/<name>`. Returns `null` when `path` is not
 * a function-invoke path, so callers can fall back to forwarding it unchanged.
 *
 * Exported for unit testing; it is the one piece of routing logic worth pinning
 * down independently of the live proxy.
 */
export function mapFunctionsInvokePath(path: string): string | null {
  // Strip any query string before matching, re-append it afterwards.
  const queryIndex = path.indexOf('?');
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : path.slice(queryIndex);

  const match = new RegExp(
    `^${FUNCTIONS_INVOKE_PREFIX}/([^/]+)/invoke/?$`
  ).exec(pathname);
  if (!match) return null;

  return `/api/${match[1]}${query}`;
}

/** Is `path` (already stripped of the proxy prefix) a function invocation? */
function isFunctionsPath(path: string): boolean {
  return (
    path === FUNCTIONS_INVOKE_PREFIX ||
    path.startsWith(`${FUNCTIONS_INVOKE_PREFIX}/`)
  );
}

/**
 * Resolve `apiUrl` at request time from an explicit option or the resolved Vite
 * env, with a localhost fallback so the plugin is never left without a target.
 */
function resolveApiUrl(
  options: RayfinLocalDevOptions,
  config: ResolvedConfig | undefined
): string {
  return (
    options.apiUrl ??
    config?.env?.VITE_RAYFIN_API_URL ??
    'http://localhost:5168'
  );
}

/**
 * TCP-connect probe with a short timeout: resolves `true` when something is
 * accepting connections on `host:port`, `false` otherwise. Never rejects.
 */
function probePort(
  host: string,
  port: number,
  timeoutMs = 300
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket: Socket = connect({ host, port });
    const done = (up: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** A TTL-cached wrapper around {@link probePort}. */
function createCachedProbe(host: string, port: number, ttlMs: number) {
  let cached: { value: boolean; expires: number } | null = null;
  let inFlight: Promise<boolean> | null = null;

  return async function isUp(): Promise<boolean> {
    const now = Date.now();
    if (cached && cached.expires > now) return cached.value;
    if (inFlight) return inFlight;

    inFlight = probePort(host, port).then((value) => {
      cached = { value, expires: Date.now() + ttlMs };
      inFlight = null;
      return value;
    });
    return inFlight;
  };
}

/**
 * Forward an incoming dev-server request to `targetBase + targetPath`, piping
 * the request body through and streaming the response back. Body-preserving and
 * method-agnostic (works for the POST that function invocation uses).
 *
 * `log`, when provided, receives the fully-resolved upstream URL and the
 * upstream response status so a failing proxy hop can be diagnosed from the
 * dev-server console.
 */
function forward(
  req: IncomingMessage,
  res: ServerResponse,
  targetBase: string,
  targetPath: string,
  log?: DebugLog
): void {
  let target: URL;
  try {
    // Resolve by *appending* the request path onto the backend base path, not
    // by `new URL(targetPath, base)`. Because `targetPath` is origin-absolute
    // (e.g. `/api/auth/v1/token`), plain URL resolution would resolve it against
    // the base *origin only* and silently discard any path prefix the backend
    // carries (e.g. `/webapi/.../appbackends/<id>`), producing a 404. Joining
    // the two paths and collapsing the seam keeps the full backend route.
    const base = new URL(targetBase);
    const basePath = base.pathname.replace(/\/+$/, '');
    const joinedPath = `${basePath}/${targetPath.replace(/^\/+/, '')}`;
    target = new URL(joinedPath, base.origin);
  } catch {
    log?.(`✗ invalid proxy target: base=${targetBase} path=${targetPath}`);
    res.statusCode = 500;
    res.end(`${LOG_PREFIX} invalid proxy target: ${targetBase}${targetPath}`);
    return;
  }

  if (log) {
    log(`→ ${req.method ?? 'GET'} ${target.href}`);
    log(`  base=${targetBase}`);
    log(`  path=${targetPath}`);
  }

  const isHttps = target.protocol === 'https:';
  const requestFn = isHttps ? httpsRequest : httpRequest;

  // Copy headers, but point Host at the upstream so virtual-hosted backends and
  // TLS SNI resolve correctly. Drop hop-by-hop headers Node will re-derive.
  const headers = { ...req.headers, host: target.host };
  delete headers['connection'];

  const proxyReq = requestFn(
    target,
    { method: req.method, headers },
    (proxyRes) => {
      log?.(
        `← ${proxyRes.statusCode ?? '???'} ${req.method ?? 'GET'} ${target.href}`
      );
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err: Error) => {
    log?.(`✗ upstream error for ${target.href}: ${err.message}`);
    if (!res.headersSent) res.statusCode = 502;
    res.end(`${LOG_PREFIX} upstream error: ${err.message}`);
  });

  req.pipe(proxyReq);
}

/**
 * Rayfin local-development Vite plugin.
 *
 * ```ts
 * // vite.config.ts
 * import { rayfinLocalDev } from '@workspace-todo-app/local-dev/vite';
 * export default defineConfig({ plugins: [react(), rayfinLocalDev()] });
 * ```
 */
export function rayfinLocalDev(options: RayfinLocalDevOptions = {}): Plugin {
  const prefix = options.prefix ?? RAYFIN_PROXY_PREFIX;
  const functionsEnabled = options.functions?.enabled ?? true;
  const functionsHost = options.functions?.host ?? DEFAULT_FUNCTIONS_HOST;
  const functionsPort = options.functions?.port ?? DEFAULT_FUNCTIONS_PORT;
  const probeTtlMs = options.probeTtlMs ?? DEFAULT_PROBE_TTL_MS;
  const debugEnabled =
    (options.debug ?? true) &&
    // Allow an env override to silence logging without touching config.
    process.env.VITE_RAYFIN_LOCAL_DEBUG !== '0' &&
    process.env.VITE_RAYFIN_LOCAL_DEBUG !== 'false';

  const functionsBase = `http://${functionsHost}:${functionsPort}`;
  const isFunctionsUp = createCachedProbe(
    functionsHost,
    functionsPort,
    probeTtlMs
  );

  const authEnabled = options.auth?.enabled ?? false;

  let resolvedConfig: ResolvedConfig | undefined;

  return {
    name: 'rayfin-local-dev',
    // Dev-server-only concern; a production build must never carry this proxy.
    apply: 'serve',

    configResolved(config) {
      resolvedConfig = config;
    },

    // Back the bridge micro-app with a virtual module so its browser source is
    // never part of the app's real module graph or a production build.
    resolveId(id) {
      if (authEnabled && id === RAYFIN_AUTH_BRIDGE_VIRTUAL_ID) {
        return RAYFIN_AUTH_BRIDGE_VIRTUAL_ID;
      }
      return null;
    },

    load(id) {
      if (authEnabled && id === RAYFIN_AUTH_BRIDGE_VIRTUAL_ID) {
        return BRIDGE_MODULE_CODE;
      }
      return null;
    },

    configureServer(server) {
      const apiUrl = resolveApiUrl(options, resolvedConfig);
      const log: DebugLog | undefined = debugEnabled
        ? (message) => server.config.logger.info(`${LOG_PREFIX} ${message}`)
        : undefined;

      server.config.logger.info(
        `${LOG_PREFIX} proxying ${prefix}/* → ${apiUrl}` +
          (functionsEnabled
            ? ` (functions auto-detect on ${functionsBase})`
            : ' (functions rerouting disabled)') +
          (authEnabled
            ? ` [fabric auth proxy on ${RAYFIN_AUTH_PROXY_PATH}]`
            : '') +
          (debugEnabled ? ' [debug logging on]' : '')
      );

      if (authEnabled) {
        const publishableKey =
          options.auth?.publishableKey ??
          resolvedConfig?.env?.VITE_RAYFIN_PUBLISHABLE_KEY ??
          '';
        const brokerOptions: FabricAuthBrokerOptions = {
          loginTimeoutMs: options.auth?.loginTimeoutMs,
          refreshSkewMs: options.auth?.refreshSkewMs,
          log,
        };
        const broker = new FabricAuthBroker(brokerOptions);
        registerFabricAuthProxy(server, {
          broker,
          authBasePath: RAYFIN_AUTH_PROXY_PATH,
          proxyPrefix: prefix,
          apiUrl,
          publishableKey,
          openBrowser: options.auth?.openBrowser ?? defaultOpenBrowser,
          log,
        });
      }

      server.middlewares.use(prefix, async (req, res) => {
        // connect strips the mount prefix, so req.url is the remainder
        // (e.g. '/functions/healthCheck/invoke' or '/api/v1/token').
        const rest = req.url ?? '/';

        log?.(`${req.method ?? 'GET'} ${prefix}${rest}`);

        // Function invocation → local host when it's up, otherwise remote.
        if (functionsEnabled && isFunctionsPath(rest)) {
          const localPath = mapFunctionsInvokePath(rest);
          if (localPath && (await isFunctionsUp())) {
            log?.(`functions → local ${functionsBase}${localPath}`);
            forward(req, res, functionsBase, localPath, log);
            return;
          }
          log?.(`functions → remote (local host down) ${apiUrl}`);
        }

        forward(req, res, apiUrl, rest, log);
      });
    },
  };
}

export default rayfinLocalDev;
