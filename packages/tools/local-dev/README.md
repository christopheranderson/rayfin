# @microsoft/rayfin-local-dev

Local-development adapters for Rayfin applications.

The package serves a real `rayfin.config.json` during local development and proxies the SDK's well-known backend and Functions routes to the URLs selected by `rayfin dev` — so local dev exercises the same runtime-config code path a deployed app does, instead of falling back to build-time `VITE_*` values.

## Welcome source activity

The Universal App welcome can show workspace source edits through this package:

```ts
rayfinLocalDev({ autoLogin: true, sourceActivity: true });
```

Source activity is disabled by default and is never served in a production build.
For the Universal App workspace layout, the feed watches the frontend, sibling packages, and Rayfin configuration.
It reports edit categories and counts, not file contents or build completion.
Remove `sourceActivity: true` when replacing the welcome; the app does not need to maintain a copied watcher or middleware implementation.

## Vite setup

Register the development-server adapter:

```ts
import { rayfinLocalDev } from '@microsoft/rayfin-local-dev/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [rayfinLocalDev()],
});
```

By default the adapter resolves the local backend URL from the active `rayfin dev` session, then `VITE_RAYFIN_API_URL`. When a backend URL resolves, requests to `/rayfin.config.json` are served real JSON whose `apiUrl` is the dev server's own origin, instead of falling through to Vite's `index.html`, and the SDK's well-known backend routes (`/api`, `/graphql`, `/connector-invoke`, `/connectors`) are proxied to that backend, regardless of its protocol. `publishableKey`, `workspaceId`, `itemId`, `portalUrl`, and `tenantId` are included from the resolved Vite environment when present. When no backend URL resolves, `/rayfin.config.json` falls through to Vite's normal `index.html` handling, and the app falls back to its build-time `VITE_*` defaults, exactly as before.

An explicit `apiUrl` option overrides the resolved URL:

```ts
export default defineConfig({
  plugins: [rayfinLocalDev({ apiUrl: 'http://localhost:5168' })],
});
```

The adapter also finds the nearest `rayfin/rayfin.yml` and reads
`services.staticHosting.assetAccess`.
A protected site signs in automatically during local development, and a
public site does so only when `autoLogin` is enabled below.

```ts
export default defineConfig({
  plugins: [rayfinLocalDev({ autoLogin: true })],
});
```

Automatic local sign-in acquires a delegated Power BI/Fabric
`Item.Execute.All` token via the Rayfin CLI's own authentication module
(`@microsoft/rayfin-cli/auth`) -- the same sign-in state `rayfin login` uses.
If you're already signed in (via `rayfin login` or a prior interactive
sign-in), the cached session is reused silently; otherwise the CLI's usual
interactive browser sign-in (falling back to a device-code prompt in the dev
server console when no browser is available) launches automatically the
first time the endpoint is hit. Run `rayfin login` yourself first if you'd
rather sign in ahead of time or need to switch accounts/tenants.

Once a delegated Entra token is obtained, the adapter exchanges it for a
Rayfin session directly against the resolved local backend's brokered-token
route -- in Node, not the browser -- so the exchange works uniformly whether
that backend is a real HTTPS Fabric dev session or a plain-HTTP local Docker
backend (`signInWithEntraToken()`'s browser-side HTTPS requirement never
applies here). The resulting Rayfin token response is served only through a
loopback, same-origin development endpoint, and is never logged.

`isRayfinLocalAutoLoginEnabled()` and `fetchRayfinLocalSessionToken()` are
dev-only: gate every call behind `import.meta.env.DEV` and reach them through
a dynamic `import()`, so bundlers drop this package from production builds
entirely rather than merely no-op it at runtime.

```ts
if (import.meta.env.DEV) {
  const localDev = await import('@microsoft/rayfin-local-dev');
  if (localDev.isRayfinLocalAutoLoginEnabled()) {
    const sessionToken = await localDev.fetchRayfinLocalSessionToken();
    // Install it with signInWithBrokeredToken() from
    // @microsoft/rayfin-auth-provider-fabric.
  }
}
```

The backend requires `services.auth.fabric.externalEntraExchange: true` in
`rayfin/rayfin.yml` for this exchange to succeed.

With `rayfin.config.json` served, `RayfinClient` needs no local-dev-specific
wiring — construct it the same way you would for a deployed app:

```ts
import { RayfinClient, resolveRayfinConfig } from '@microsoft/rayfin-client';

const resolved = await resolveRayfinConfig({
  apiUrl: import.meta.env.VITE_RAYFIN_API_URL,
  publishableKey: import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY,
});
const client = new RayfinClient({
  baseUrl: resolved.baseUrl,
  publishableKey: resolved.publishableKey,
  runtimeConfig: resolved.runtimeConfig,
});
```

While `rayfin dev` runs local Functions, the plugin forwards `/functions/<name>/invoke` to the exact Functions URL emitted in `VITE_RAYFIN_FUNCTIONS_URL`.
If the local Functions host is unavailable, the proxy returns HTTP 502 instead of invoking deployed function code.
Production builds do not receive any of this behavior and continue to use the deployed Rayfin config and Functions route.

### Debug logging

Set Node's `NODE_DEBUG` environment variable to the plugin namespace to log
resolved configuration and request routing:

```sh
NODE_DEBUG=rayfin-local-dev npm run dev
```

The output includes the configured backend and Functions URLs, enabled proxy
contexts, incoming and outgoing proxy requests, middleware responses, and
brokered-token exchange status. Authentication tokens, authorization headers,
and response bodies are never logged.

### Explicit `functionsBaseUrl` override

A caller that still needs to pass `functionsBaseUrl` explicitly (for example, a non-Vite framework, or code written before `rayfin.config.json` was served locally) can use the browser-safe helper instead:

```ts
import { RayfinClient } from '@microsoft/rayfin-client';
import { resolveRayfinFunctionsBaseUrl } from '@microsoft/rayfin-local-dev';

const client = new RayfinClient({
  baseUrl: import.meta.env.VITE_RAYFIN_API_URL,
  publishableKey: import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY,
  functionsBaseUrl: resolveRayfinFunctionsBaseUrl(),
});
```

This forwards `/.rayfin/api/<name>` to the same local Functions host, separately from the default `/functions` route above.
The helper returns an absolute URL on the current browser origin, so a non-empty backend `baseUrl` cannot capture the request.

## Network scope

The proxy is reachable wherever the Vite development server is reachable.
Keep Vite bound to loopback unless other devices need access, and configure Vite's `host` and `allowedHosts` settings for the trusted development network.

## Other frameworks

Non-Vite applications can pass their framework-projected local Functions URL directly as `functionsBaseUrl` during development.
