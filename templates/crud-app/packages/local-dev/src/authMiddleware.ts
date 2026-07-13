/**
 * @packageDocumentation
 * Dev-server glue that turns a {@link FabricAuthBroker} into the four HTTP
 * routes of the Fabric auth proxy, plus the browser "bridge" micro-app served
 * into the system browser.
 *
 * Route map (all relative to `authBasePath`, default `/.rayfin-local/auth/fabric-proxy`):
 *
 * | Method | Path        | Purpose                                                        |
 * | ------ | ----------- | -------------------------------------------------------------- |
 * | GET    | `/`         | Return a cached/refreshed token, else launch login and block.  |
 * | GET    | `/bridge`   | Serve the system-browser micro-app that performs the login.    |
 * | POST   | `/callback` | Bridge deposits `{ state, tokenResponse, publishableKey }`.     |
 * | POST   | `/logout`   | Evict the cached session.                                      |
 *
 * The bridge runs the *unmodified* SDK `initiateFabricLogin` in a real browser
 * tab (where passkeys / broker SSO work) and captures the raw `TokenResponse` by
 * wrapping the public `auth.getAuthApi().exchangeVerificationCode` — no SDK
 * changes, no reimplementation of the login. It then POSTs the token back here.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ViteDevServer } from 'vite';

import type { FabricAuthBroker, TokenResponse } from './authBroker.js';
import {
  RAYFIN_AUTH_BRIDGE_SUBPATH,
  RAYFIN_AUTH_BRIDGE_VIRTUAL_ID,
  RAYFIN_AUTH_CALLBACK_SUBPATH,
  RAYFIN_AUTH_LOGOUT_SUBPATH,
} from './constants.js';

/** Opens `url` in the OS default browser. Injectable for tests. */
export type OpenBrowser = (url: string, log?: (m: string) => void) => void;

/** Wiring the middleware needs from the plugin. */
export interface RegisterFabricAuthProxyOptions {
  /** The broker instance that owns cache + rendezvous + refresh. */
  broker: FabricAuthBroker;
  /**
   * Same-origin base path the routes are mounted under
   * (e.g. `/.rayfin-local/auth/fabric-proxy`).
   */
  authBasePath: string;
  /**
   * Proxy prefix the bridge's `RayfinClient` should use as its `baseUrl` so its
   * token exchange stays same-origin and is forwarded by the request proxy
   * (e.g. `/.rayfin`). Keeps the browser leg CORS-free.
   */
  proxyPrefix: string;
  /**
   * Absolute backend base URL used for *server-side* token refresh (Node has no
   * proxy and no CORS). Same value the request-forwarding proxy targets.
   */
  apiUrl: string;
  /** Publishable key for refresh, when the bridge doesn't supply one. */
  publishableKey: string;
  /** Browser launcher. Defaults to {@link defaultOpenBrowser}. */
  openBrowser?: OpenBrowser;
  /** Optional debug logger. */
  log?: (message: string) => void;
}

/** Launch `url` in the OS default browser, detached from the dev server. */
export const defaultOpenBrowser: OpenBrowser = (url, log) => {
  const platform = process.platform;
  let command: string;
  let args: string[];
  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    // `start` is a cmd builtin; the empty "" is the window title arg so a URL
    // with spaces/quotes isn't mistaken for the title.
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) =>
      log?.(`failed to open system browser: ${err.message}`)
    );
    child.unref();
  } catch (err) {
    log?.(`failed to spawn system browser: ${(err as Error).message}`);
  }
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  // Dev-only, same-origin loopback; never cache token material.
  res.setHeader('Cache-Control', 'no-store');
  res.end(payload);
}

function readJsonBody(
  req: IncomingMessage,
  limitBytes = 1_000_000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      data += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data) as Record<string, unknown>);
      } catch (err) {
        reject(err as Error);
      }
    });
    req.on('error', reject);
  });
}

/** Reconstruct the dev-server origin for the absolute bridge URL. */
function requestOrigin(req: IncomingMessage): string {
  const encrypted = (req.socket as { encrypted?: boolean }).encrypted === true;
  const proto = encrypted ? 'https' : 'http';
  const host = req.headers.host ?? 'localhost';
  return `${proto}://${host}`;
}

/**
 * Register the Fabric auth-proxy routes on a Vite dev server. A single
 * middleware mounted at `authBasePath` dispatches on the stripped remainder.
 */
export function registerFabricAuthProxy(
  server: ViteDevServer,
  options: RegisterFabricAuthProxyOptions
): void {
  const { broker, authBasePath, proxyPrefix, apiUrl, publishableKey, log } =
    options;
  const openBrowser = options.openBrowser ?? defaultOpenBrowser;

  server.middlewares.use(authBasePath, (req, res, next) => {
    // connect strips authBasePath, leaving the sub-route (e.g. '/', '/bridge').
    const rawUrl = req.url ?? '/';
    let sub: string;
    let search: URLSearchParams;
    try {
      const parsed = new URL(rawUrl, 'http://localhost');
      sub = parsed.pathname;
      search = parsed.searchParams;
    } catch {
      sendJson(res, 400, { error: 'BAD_REQUEST' });
      return;
    }
    const method = req.method ?? 'GET';

    // GET /bridge — the system-browser micro-app.
    if (sub === RAYFIN_AUTH_BRIDGE_SUBPATH) {
      if (method !== 'GET')
        return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      server
        .transformIndexHtml(
          `${authBasePath}${RAYFIN_AUTH_BRIDGE_SUBPATH}`,
          BRIDGE_HTML
        )
        .then((html) => {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(html);
        })
        .catch((err: Error) => {
          log?.(`bridge html transform failed: ${err.message}`);
          sendJson(res, 500, { error: 'BRIDGE_TRANSFORM_FAILED' });
        });
      return;
    }

    // POST /callback — bridge deposits the captured token (or an error).
    if (sub === RAYFIN_AUTH_CALLBACK_SUBPATH) {
      if (method !== 'POST')
        return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      readJsonBody(req)
        .then((body) => {
          const state = typeof body.state === 'string' ? body.state : '';
          if (typeof body.error === 'string' && body.error) {
            broker.failLogin(state, body.error);
            log?.(`bridge reported error for state=${state}: ${body.error}`);
            return sendJson(res, 200, { ok: true });
          }
          const tokenResponse = body.tokenResponse as TokenResponse | undefined;
          if (
            !tokenResponse ||
            typeof tokenResponse.accessToken !== 'string' ||
            typeof tokenResponse.expiresIn !== 'number'
          ) {
            return sendJson(res, 400, { error: 'INVALID_TOKEN_RESPONSE' });
          }
          const key =
            typeof body.publishableKey === 'string' && body.publishableKey
              ? body.publishableKey
              : publishableKey;
          const matched = broker.completeLogin(state, tokenResponse, {
            apiUrl,
            publishableKey: key,
          });
          log?.(
            `token deposited for state=${state} (${matched ? 'resolved waiter' : 'cached only'})`
          );
          sendJson(res, 200, { ok: true });
        })
        .catch((err: Error) => {
          log?.(`callback body parse failed: ${err.message}`);
          sendJson(res, 400, { error: 'BAD_REQUEST' });
        });
      return;
    }

    // POST /logout — evict the cached session.
    if (sub === RAYFIN_AUTH_LOGOUT_SUBPATH) {
      if (method !== 'POST')
        return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      broker.logout();
      return sendJson(res, 200, { ok: true });
    }

    // GET / — the main endpoint the WebView app calls.
    if (sub === '/' || sub === '') {
      if (method !== 'GET')
        return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      handleMain(req, res, {
        broker,
        authBasePath,
        proxyPrefix,
        openBrowser,
        search,
        log,
      });
      return;
    }

    // Unknown sub-route under the auth base — let other middleware try.
    next();
  });
}

interface HandleMainDeps {
  broker: FabricAuthBroker;
  authBasePath: string;
  proxyPrefix: string;
  openBrowser: OpenBrowser;
  search: URLSearchParams;
  log?: (message: string) => void;
}

/**
 * Serve a token to the WebView: cache hit / silent refresh when possible,
 * otherwise open the system-browser bridge and block until it deposits a token.
 * With `?mode=silent`, a cache miss returns 204 and never opens the browser —
 * used to detect an existing session on page load without forcing a login.
 */
function handleMain(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandleMainDeps
): void {
  const { broker, authBasePath, proxyPrefix, openBrowser, search, log } = deps;

  // Silent peek: callers (e.g. an app bootstrapping on page load / reload) can
  // ask for a cached-or-refreshable token WITHOUT triggering an interactive
  // login. On a cache miss we return 204 instead of opening the system browser.
  const silent = search.get('mode') === 'silent';

  broker
    .getValidToken()
    .then((cached) => {
      if (cached) {
        log?.(`serving token from cache${silent ? ' (silent)' : ''}`);
        return sendJson(res, 200, cached);
      }

      if (silent) {
        log?.('silent peek: no valid cached session (204)');
        res.statusCode = 204;
        res.setHeader('Cache-Control', 'no-store');
        res.end();
        return;
      }

      const state = randomUUID();
      const origin = requestOrigin(req);
      const bridgeUrl = buildBridgeUrl({
        origin,
        authBasePath,
        proxyPrefix,
        state,
        // Pass the webview's Fabric config through to the bridge; each falls
        // back to import.meta.env in the bridge when absent.
        workspaceId: search.get('workspaceId'),
        projectId: search.get('projectId'),
        portalUrl: search.get('portalUrl'),
        publishableKey: search.get('publishableKey'),
      });

      log?.(
        `no valid cache; opening system browser for login (state=${state})`
      );
      openBrowser(bridgeUrl, log);

      broker
        .beginLogin(state)
        .then((token) => sendJson(res, 200, token))
        .catch((err: Error & { code?: string }) => {
          log?.(`login failed (state=${state}): ${err.message}`);
          sendJson(res, 504, {
            error: err.code ?? 'FABRIC_AUTH_FAILED',
            message: err.message,
          });
        });
    })
    .catch((err: Error) => {
      log?.(`getValidToken threw: ${err.message}`);
      sendJson(res, 500, { error: 'AUTH_PROXY_ERROR', message: err.message });
    });
}

interface BuildBridgeUrlParams {
  origin: string;
  authBasePath: string;
  proxyPrefix: string;
  state: string;
  workspaceId: string | null;
  projectId: string | null;
  portalUrl: string | null;
  publishableKey: string | null;
}

/** Build the absolute `/bridge` URL (with config) for the system browser. */
export function buildBridgeUrl(params: BuildBridgeUrlParams): string {
  const url = new URL(
    `${params.authBasePath}${RAYFIN_AUTH_BRIDGE_SUBPATH}`,
    params.origin
  );
  url.searchParams.set('state', params.state);
  url.searchParams.set('prefix', params.proxyPrefix);
  url.searchParams.set(
    'callback',
    `${params.authBasePath}${RAYFIN_AUTH_CALLBACK_SUBPATH}`
  );
  if (params.workspaceId)
    url.searchParams.set('workspaceId', params.workspaceId);
  if (params.projectId) url.searchParams.set('projectId', params.projectId);
  if (params.portalUrl) url.searchParams.set('portalUrl', params.portalUrl);
  if (params.publishableKey)
    url.searchParams.set('publishableKey', params.publishableKey);
  return url.href;
}

// ---------------------------------------------------------------------------
// Bridge micro-app (served into the system browser)
// ---------------------------------------------------------------------------

/**
 * Browser source for the bridge, returned from the plugin's `load` hook for
 * {@link RAYFIN_AUTH_BRIDGE_VIRTUAL_ID}. Written as plain JS (no TS syntax) so it
 * needs no type-stripping; Vite still resolves the bare SDK imports and inlines
 * `import.meta.env`.
 *
 * It reuses the real, unmodified `initiateFabricLogin`, wrapping the public
 * `exchangeVerificationCode` to capture the raw token pair the SDK obtains, then
 * POSTs it to the callback. Config comes from the URL query (webview-provided),
 * falling back to `import.meta.env` (the app's standard Fabric env vars).
 */
export const BRIDGE_MODULE_CODE = /* js */ `
import { RayfinClient } from '@microsoft/rayfin-client';
import { initiateFabricLogin } from '@microsoft/rayfin-auth-provider-fabric';

const params = new URLSearchParams(location.search);
const env = (import.meta && import.meta.env) || {};

const state = params.get('state') || '';
const prefix = params.get('prefix') || '/.rayfin';
const callback = params.get('callback') || '/.rayfin-local/auth/fabric-proxy/callback';
const workspaceId = params.get('workspaceId') || env.VITE_FABRIC_WORKSPACE_ID || '';
const projectId = params.get('projectId') || env.VITE_FABRIC_ITEM_ID || '';
const portalUrl = params.get('portalUrl') || env.VITE_FABRIC_PORTAL_URL || '';
const publishableKey = params.get('publishableKey') || env.VITE_RAYFIN_PUBLISHABLE_KEY || '';

const statusEl = document.getElementById('status');
const buttonEl = document.getElementById('signin');

function setStatus(text, isError) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = isError ? 'error' : '';
}

async function report(payload) {
  try {
    await fetch(callback, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Best-effort; the originating request will time out if this never lands.
    console.warn('[rayfin-auth-bridge] failed to POST callback', err);
  }
}

async function run() {
  if (buttonEl) buttonEl.disabled = true;
  if (!workspaceId || !projectId || !portalUrl) {
    setStatus('Missing Fabric configuration (workspaceId / projectId / portalUrl).', true);
    if (buttonEl) buttonEl.disabled = false;
    await report({ state, error: 'MISSING_FABRIC_CONFIG' });
    return;
  }

  setStatus('Opening Fabric sign-in…');
  const client = new RayfinClient({ baseUrl: prefix, publishableKey });
  const api = client.auth.getAuthApi();

  // Capture the raw TokenResponse the SDK obtains, without altering the flow.
  const originalExchange = api.exchangeVerificationCode.bind(api);
  let capturedToken = null;
  api.exchangeVerificationCode = async (args) => {
    const tokenResponse = await originalExchange(args);
    capturedToken = tokenResponse;
    return tokenResponse;
  };

  try {
    await initiateFabricLogin(client.auth, {
      workspaceId,
      projectId,
      fabricPortalUrl: portalUrl,
      returnOrigin: location.origin,
    });
    if (!capturedToken) {
      throw new Error('Login completed but no token was captured.');
    }
    await report({ state, tokenResponse: capturedToken, publishableKey });
    setStatus('Signed in. You can close this window.');
    setTimeout(() => window.close(), 1200);
  } catch (err) {
    const message = (err && err.message) ? err.message : String(err);
    setStatus('Sign-in failed: ' + message, true);
    await report({ state, error: (err && err.code) || 'FABRIC_AUTH_FAILED' });
    if (buttonEl) buttonEl.disabled = false;
  }
}

if (buttonEl) buttonEl.addEventListener('click', run);
setStatus('Click “Sign in to Fabric” to continue.');
`;

/** HTML shell for the bridge; loads {@link BRIDGE_MODULE_CODE} as a module. */
export const BRIDGE_HTML = /* html */ `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Rayfin — Fabric sign-in</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        display: grid; place-items: center; min-height: 100vh; margin: 0;
        background: #f5f5f7; color: #1d1d1f;
      }
      main {
        background: #fff; padding: 2.5rem 3rem; border-radius: 14px;
        box-shadow: 0 10px 40px rgba(0,0,0,.08); text-align: center; max-width: 26rem;
      }
      h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
      p.lead { color: #6e6e73; margin: 0 0 1.5rem; font-size: .9rem; }
      button {
        font-size: 1rem; padding: .7rem 1.4rem; border: 0; border-radius: 8px;
        background: #0078d4; color: #fff; cursor: pointer;
      }
      button:disabled { opacity: .5; cursor: default; }
      #status { margin-top: 1.25rem; font-size: .85rem; color: #6e6e73; min-height: 1.2em; }
      #status.error { color: #d13438; }
    </style>
  </head>
  <body>
    <main>
      <h1>Sign in to Fabric</h1>
      <p class="lead">
        This window completes sign-in in your system browser, then returns your
        session to the app. You can close it when done.
      </p>
      <button id="signin" type="button">Sign in to Fabric</button>
      <p id="status"></p>
    </main>
    <script type="module" src="/@id/${RAYFIN_AUTH_BRIDGE_VIRTUAL_ID}"></script>
  </body>
</html>
`;
