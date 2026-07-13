/**
 * Shared constants for the Rayfin local-development helpers.
 *
 * These are imported by both the browser-side client helper (`./index`)
 * and the Node-side Vite plugin (`./vite`), so this module must stay free
 * of any environment-specific imports.
 */

/**
 * Same-origin path prefix the frontend uses to reach the Rayfin backend during
 * local development. The Vite dev-server proxy claims every request under this
 * prefix and forwards it on — either to the remote backend or, for function
 * calls, to a locally-running Azure Functions host.
 *
 * A dotted prefix (`/.rayfin`) keeps the namespace out of the way of app routes
 * and mirrors the reserved-path convention used by other local-dev proxies
 * (`/.netlify`, `/.auth`).
 */
export const RAYFIN_PROXY_PREFIX = '/.rayfin';

/**
 * Path segment (relative to the backend root) that the SDK posts function
 * invocations to in production: `${baseUrl}/functions/<name>/invoke`, served by
 * the Fabric `InvokeController`.
 */
export const FUNCTIONS_INVOKE_PREFIX = '/functions';

/**
 * Default host/port for a locally-running Azure Functions Core Tools host.
 * Matches the `func start` default and the Rayfin CLI's `DEFAULT_FUNC_PORT`.
 */
export const DEFAULT_FUNCTIONS_HOST = '127.0.0.1';
export const DEFAULT_FUNCTIONS_PORT = 7071;

/**
 * How long (ms) a local-functions-host availability probe result is cached
 * before the proxy re-checks. Small enough that starting/stopping `func start`
 * is picked up within a couple of requests; large enough to avoid probing on
 * every single request.
 */
export const DEFAULT_PROBE_TTL_MS = 2000;

// ---------------------------------------------------------------------------
// Fabric auth proxy (system-browser login broker)
// ---------------------------------------------------------------------------

/**
 * Same-origin path the dev server exposes so a WebView-hosted app can obtain a
 * Rayfin session without doing the Fabric login inside the WebView itself.
 *
 * Embedded WebViews (GitHub Copilot desktop, Electron, VS Code webviews) can't
 * complete a Fabric SSO/passkey login: WebAuthn and broker SSO are gated to
 * first-party browsers, and the SDK's `initiateFabricLogin` relies on
 * `window.open` + `postMessage` opener mechanics a WebView-spawned browser has
 * no relationship to. This endpoint relocates the login into the real system
 * browser and hands the resulting tokens back to the WebView.
 *
 * Sub-routes (relative to this base):
 * - `/` (root)    — GET: return a cached/refreshed session, or launch the
 *                   system-browser login and block until it completes.
 * - `/callback`   — POST: the bridge micro-app deposits the captured token
 *                   response (with state, apiUrl, publishableKey) here.
 * - `/logout`     — POST: evict the cached session.
 * - `/bridge`     — GET: the micro-app (served in the system browser) that runs
 *                   the real Fabric login and posts the result to `/callback`.
 */
export const RAYFIN_AUTH_PROXY_PATH = '/.rayfin-local/auth/fabric-proxy';

/** POST sub-path where the bridge deposits the captured token response. */
export const RAYFIN_AUTH_CALLBACK_SUBPATH = '/callback';

/** POST sub-path that evicts the cached session. */
export const RAYFIN_AUTH_LOGOUT_SUBPATH = '/logout';

/** GET sub-path that serves the system-browser login micro-app. */
export const RAYFIN_AUTH_BRIDGE_SUBPATH = '/bridge';

/**
 * Virtual module id (Vite `resolveId`/`load`) backing the bridge micro-app's
 * browser script. Kept out of the app's real module graph so it never ships in
 * a production build.
 */
export const RAYFIN_AUTH_BRIDGE_VIRTUAL_ID = 'virtual:rayfin-auth-bridge';

/**
 * How long (ms) a pending `GET /.rayfin-local/auth/fabric-proxy` waits for the bridge to
 * deposit a token before giving up. Matches the SDK's 5-minute broker handoff
 * TTL so both legs time out together.
 */
export const DEFAULT_AUTH_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Refresh a cached access token this many ms *before* it actually expires, so a
 * request never races the expiry boundary.
 */
export const DEFAULT_AUTH_REFRESH_SKEW_MS = 60 * 1000;
