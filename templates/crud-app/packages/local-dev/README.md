# @workspace-todo-app/local-dev

Local-development helpers for a Rayfin frontend. **Prototype** of a possible
first-party `@microsoft/rayfin-local-dev` package — it lives inside the sample so
the Functions local-dev flow can be exercised end to end without publishing.

Two concerns, one prototype: **(1)** let the frontend talk to a same-origin
`/.rayfin/` path in local dev and transparently run functions locally when a
Functions host is up, and **(2)** let a WebView-hosted app complete a Fabric SSO
login it otherwise couldn't, by brokering the login through the system browser.

## Why

In production the app calls its deployed backend directly. In local dev we want
to iterate on **functions** without redeploying, while data/auth/storage keep
hitting the real (remote) backend. Rather than teach the app about localhost
ports and CORS, the frontend keeps talking to a single **same-origin** prefix
(`/.rayfin`) and a Vite dev-server proxy decides, per request, where it goes.

Because the proxy is same-origin there is **no CORS** in the loop, and because
the client code path is identical in dev and prod, "works locally" implies
"works deployed".

## What it does

```text
browser ──▶ /.rayfin/api/v1/token            ─▶ remote backend  (VITE_RAYFIN_API_URL)
browser ──▶ /.rayfin/functions/hi/invoke      ─┬ func up?  ─▶ http://127.0.0.1:7071/api/hi
                                               └ func down ─▶ remote backend /functions/hi/invoke
```

- **`func` running?** The proxy detects a local Azure Functions host with a
  cached TCP probe and reroutes `/.rayfin/functions/<name>/invoke` to
  `POST /api/<name>` on it. Start/stop `func start` any time — it's picked up
  within a couple of requests.
- **`func` not running?** The same call falls through to the remote backend, so
  the deployed function is used. No config toggles.

The proxy only **routes**. It never starts the Functions host and never calls
the Rayfin CLI.

## Usage

**Vite config** — mount the proxy:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { rayfinLocalDev } from '@workspace-todo-app/local-dev/vite';

export default defineConfig({
  plugins: [react(), rayfinLocalDev()],
});
```

**Client** — pick the right base URL for dev vs. build:

```ts
import { RayfinClient } from '@microsoft/rayfin-client';
import { resolveRayfinConfig } from '@workspace-todo-app/local-dev';

// dev  → { baseUrl: '/.rayfin', ... }         (same-origin, proxied)
// build→ { baseUrl: VITE_RAYFIN_API_URL, ... } (existing mechanism)
const client = new RayfinClient(resolveRayfinConfig());

// Identical call in both environments; the proxy decides local vs remote in dev.
await client.functions.healthCheck.invoke({});
```

## API

### `resolveRayfinConfig(): { baseUrl, publishableKey }`

Returns `/.rayfin` as `baseUrl` under the Vite dev server (`import.meta.env.DEV`),
or the absolute `VITE_RAYFIN_API_URL` in a production build. `publishableKey`
comes from `VITE_RAYFIN_PUBLISHABLE_KEY`.

### `isLocalDev(): boolean`

`true` under the dev server, `false` in a build.

### Fabric auth proxy helpers

- `fetchFabricProxyToken(options?): Promise<TokenResponse>` — GET the auth proxy;
  returns raw Rayfin tokens, blocking through the system-browser login on a cache
  miss.
- `peekFabricProxyToken(options?): Promise<TokenResponse | null>` — silent GET
  (`?mode=silent`): returns a cached/refreshable token or `null` on a miss, and
  **never opens a browser**. Call it on app bootstrap / page reload so a refresh
  reuses the existing session instead of forcing a new login.
- `hydrateFabricSessionFromProxy(hydrate, options?): Promise<TokenResponse>` — the
  above (`fetchFabricProxyToken`), then hands the token to your `hydrate` callback.
  Pass the SDK's supported companion hydrator so this dev-only package stays SDK-free:
  `hydrateFabricSessionFromProxy((token) => createSessionFromTokenResponse(client.auth, token))`
  (`createSessionFromTokenResponse` comes from `@microsoft/rayfin-auth/_internal`).
- `hydrateFabricSessionFromProxyIfCached(hydrate, options?): Promise<TokenResponse | null>`
  — silent variant built on `peekFabricProxyToken`: hydrates only when a cached
  token exists, returning `null` otherwise (caller then shows the login page).
- `fabricProxyLogout(path?): Promise<void>` — evict the proxy's cached session.

See [Fabric auth proxy](#fabric-auth-proxy-webview-login) for the full flow.

### `rayfinLocalDev(options?): Plugin`

The Vite plugin. Options:

| option | default | meaning |
| --- | --- | --- |
| `apiUrl` | `VITE_RAYFIN_API_URL` ⇒ `http://localhost:5168` | remote backend for non-local requests |
| `prefix` | `/.rayfin` | same-origin prefix the proxy claims |
| `functions.enabled` | `true` | reroute function calls to a local host when detected |
| `functions.host` / `functions.port` | `127.0.0.1` / `7071` | local Azure Functions host |
| `probeTtlMs` | `2000` | how long a probe result is cached |
| `auth.enabled` | `false` | expose the Fabric auth proxy (see below) |
| `auth.publishableKey` | `VITE_RAYFIN_PUBLISHABLE_KEY` | key used for server-side token refresh |
| `auth.loginTimeoutMs` | `300000` | how long a pending login waits for the browser |
| `auth.refreshSkewMs` | `60000` | refresh a cached token this long before expiry |

## Fabric auth proxy (WebView login)

**Status: POC, opt-in (`auth.enabled: true`), dev-server only.**

### Why

Embedded WebViews — the GitHub Copilot desktop app, Electron shells, VS Code
webviews — can't complete a Fabric SSO login. Passkeys/WebAuthn and broker SSO
are gated to first-party browsers, and the SDK's `initiateFabricLogin` relies on
`window.open` + `postMessage` opener mechanics that a WebView-spawned browser has
no relationship to. So the login simply can't finish inside the WebView.

The fix: relocate the **real, unmodified** Fabric login into the **system
browser**, capture the resulting raw Rayfin tokens, and hand them back to the
WebView app over same-origin loopback. The dev server caches and refreshes the
tokens so a reload doesn't force another interactive login.

### Flow

```text
WebView app ──▶ GET /.rayfin-local/auth/fabric-proxy
   cache valid    → returns cached TokenResponse
   cache expired  → server refreshes via refresh_token → returns fresh token
   cache miss     → opens SYSTEM browser ─▶ /.rayfin-local/auth/fabric-proxy/bridge
                       bridge runs initiateFabricLogin (passkeys work here),
                       captures the raw TokenResponse, and
                       POSTs it ─▶ /.rayfin-local/auth/fabric-proxy/callback
                    ← server caches + resolves the pending GET → returns token
WebView app: await client.auth.createSessionFromTokenResponse(token)  // SDK now authed
```

Routes (under `auth` base path `/.rayfin-local/auth/fabric-proxy`):

| Method | Path            | Purpose                                              |
| ------ | --------------- | ---------------------------------------------------- |
| GET    | `/`             | return cached/refreshed token, else launch login     |
| GET    | `/?mode=silent` | return cached/refreshed token, else `204` (no login) |
| GET    | `/bridge`       | the system-browser micro-app that performs the login |
| POST   | `/callback`     | bridge deposits `{ state, tokenResponse }`           |
| POST   | `/logout`       | evict the cached session                             |

### How the token is captured (no SDK changes)

The bridge constructs a `RayfinClient`, then wraps the **public**
`client.auth.getAuthApi().exchangeVerificationCode` to record its return value
before running the ordinary `initiateFabricLogin`. Because `getAuthApi()` returns
a stable instance, the wrapped method is the one the login calls internally, so
the raw `TokenResponse` (access + refresh) is captured without patching or
forking any SDK code.

### Raw tokens by design

The proxy returns **raw Rayfin tokens** to the WebView — it does not inject
`Authorization` headers on the app's behalf. The SDK needs the tokens to craft
its own backend requests, so the app hydrates its session with
`client.auth.createSessionFromTokenResponse(token)` and everything downstream
works exactly as if the user had logged in normally.

### Security posture

Dev-only and off by default. The hop is same-origin `localhost`. Tokens live in
the dev-server process memory only (no disk persistence). A random `state` nonce
pairs each browser login with the request that started it. This is a local
inner-loop convenience, **not** a production auth path.

### Usage

```ts
// vite.config.ts — opt in
rayfinLocalDev({ auth: { enabled: true } });
```

```ts
// WebView app — trigger login + hydrate the SDK session
import { hydrateFabricSessionFromProxy } from '@workspace-todo-app/local-dev';
// Supported SDK companion entry point for handing a raw token back to Auth:
import { createSessionFromTokenResponse } from '@microsoft/rayfin-auth/_internal';

// Fabric params default to VITE_FABRIC_* / VITE_RAYFIN_* env vars when omitted.
await hydrateFabricSessionFromProxy(
  (token) => createSessionFromTokenResponse(client.auth, token),
  { workspaceId, projectId, portalUrl, publishableKey }
);
// client is now authenticated; call the backend as usual.
```

Client helpers exported from the package root:

- `fetchFabricProxyToken(options?)` — GET the proxy; returns a raw `TokenResponse`
  (blocks through the browser login on a cache miss).
- `hydrateFabricSessionFromProxy(hydrate, options?)` — the above, then hands the
  token to your `hydrate` callback (keeps this package SDK-free).
- `fabricProxyLogout()` — evict the cached session.

### Manual test

1. `rayfinLocalDev({ auth: { enabled: true } })`, start the dev server, ensure
   `VITE_FABRIC_WORKSPACE_ID` / `VITE_FABRIC_ITEM_ID` / `VITE_FABRIC_PORTAL_URL`
   are set (or pass them to the helper).
2. `curl -i http://localhost:<port>/.rayfin-local/auth/fabric-proxy` — a system-browser
   tab opens to the bridge.
3. Click **Sign in to Fabric**, complete the login; the tab reports success and
   the `curl` returns the `TokenResponse` JSON.
4. Re-run the `curl` — it returns from cache immediately (no browser).
5. `curl -X POST http://localhost:<port>/.rayfin-local/auth/fabric-proxy/logout`, then
   re-run step 2 — a fresh login is triggered again.

### Graduation

Swap the browser-bridge leg for the proposed `POST /api/auth/v1/brokered/token`
endpoint (`docs/rfc/external-entra-brokered-auth.md`) + `az`/MSAL once it lands;
the cache/refresh layer stays identical.

## How local function calls line up with the SDK

The SDK's `FunctionClient` posts to `${baseUrl}/functions/<name>/invoke` by
default and expects the Rayfin invoke envelope (`{ status, output, errors, ... }`)
back. When a `functionsBaseUrl` is configured it instead posts to
`${functionsBaseUrl}/api/<name>` — the Azure Functions Core Tools convention —
and expects the **same** envelope. This proxy performs exactly that
`/functions/<name>/invoke → /api/<name>` mapping on the wire, so the client
never has to know whether a function ran locally or remotely.

## Scope

Functions local dev, plus an **opt-in POC** Fabric auth proxy for WebView hosts
(`auth.enabled`, off by default). A semantic-model proxy remains out of scope for
this prototype.
