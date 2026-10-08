# Runtime Configuration for Fabric Apps ALM

> Status: implemented (PR #1477, in review). Adoption is opt-in — see
> [Migration](#migration) below.
> Scope: **static-hosted (SPA) Rayfin apps only.** Functions, secrets, and
> source-code movement are out of scope for this round. The design is
> intentionally framework-agnostic — it must work for Vite today and React or
> any other build tool tomorrow.

## Problem

A Rayfin SPA needs environment-specific values to talk to its backend:
`apiUrl` and `publishableKey` — and, for apps that drive their own Fabric auth
flow against the secure-embed broker, Fabric coordinates (`workspaceId`,
`itemId`, `portalUrl`) as well. Today these come from `.env.local` as
`VITE_RAYFIN_*` / `VITE_FABRIC_*` variables, and **Vite inlines their values
into the compiled JavaScript at build time**:

```ts
// today — values are baked into the bundle at build time
const client = new RayfinClient({
  baseUrl: import.meta.env.VITE_RAYFIN_API_URL,        // -> "https://dev-.../appbackends/<dev-item>"
  publishableKey: import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY,
});
```

Deployment Pipelines promote the **same compiled artifact** from one workspace
to another — they do not rebuild. So a bundle promoted Dev → Prod still points
at Dev's API URL and key, and the promoted app is broken.

You cannot fix this by find-and-replacing in the bundle: the build inlines the
*value*, not a named token, so there is no reliable string to swap. (A
placeholder-token build trick exists, but it couples us to the build system —
exactly what we want to avoid.)

## Approach

Move these values out of the bundle and into a Rayfin-controlled config
**asset**, `rayfin.config.json`, that the SDK loads at runtime. The compiled JS
contains no environment-specific values; only the asset changes per
environment, and on promotion the asset is regenerated for the target.

```ts
// values are fetched at runtime, bundle is environment-agnostic
import { RayfinClient, resolveRayfinConfig } from '@microsoft/rayfin-client';

// remote config overlays the defaults you pass in, field by field;
// when the file is absent entirely, your defaults win unchanged
const resolved = await resolveRayfinConfig({ apiUrl, publishableKey });
const client = new RayfinClient<MySchema>({ ...resolved, authStorage: true });
```

Because loading is a plain `fetch` of a config file, this also **decouples
Rayfin from Vite** — the CLI/SDK no longer care how the app was built.

### Config file shape

```json
{
  "apiUrl": "https://<capacity>/.../workspaces/<ws-id>/appbackends/<item-id>/",
  "publishableKey": "pk-...",
  "workspaceId": "...",
  "itemId": "...",
  "portalUrl": "...",
  "tenantId": "..."
}
```

One required field (`apiUrl`) plus an optional `publishableKey` and optional
Fabric metadata (`workspaceId`, `itemId`, `portalUrl`, `tenantId`), present for
apps that drive their own Fabric auth flow. Service mode (`mock` / `rayfin` /
`fabric`) has always been an app-level concern controlled by
`VITE_SERVICE_MODE`; it is orthogonal to this file and is never read or
written by the SDK or CLI.

### SDK shape change (`@microsoft/rayfin-client`)

- `loadRayfinConfig(configUrl?)` — fetches and validates `rayfin.config.json`
  (defaults to the relative `/rayfin.config.json`, which only resolves in a
  browser; caller must supply an absolute `configUrl` to fetch outside one,
  e.g. from `RayfinServerClient` in Node.js). Returns `null` only when the
  config is genuinely absent — an HTTP 404 or an HTML SPA-fallback body, the
  local-dev case. A fetch-level failure (offline, DNS, CORS, a transient
  network error) is **not** treated as absence: it throws `RayfinConfigError`
  (`CONFIG_LOAD_FAILED`), same as any other non-2xx response (5xx, 401/403) or
  a malformed/incomplete file (`CONFIG_PARSE_FAILED`, `CONFIG_INVALID`,
  `CONFIG_INCOMPLETE`) — a promoted Prod bundle must not silently keep using
  its compiled Dev endpoint and key just because the fetch itself failed.
- `resolveRayfinConfig(defaults, options?)` — loads `rayfin.config.json` via
  `loadRayfinConfig(options.configUrl)`, overlays it over `defaults`
  (typically your `VITE_*` values) **per field** — `apiUrl`, `publishableKey`,
  `workspaceId`, `itemId`, `portalUrl`, `tenantId` — and returns
  `{ baseUrl, publishableKey, runtimeConfig }` for direct use in
  `new RayfinClient({ ...resolved, authStorage: true })`; construction itself
  stays a plain, synchronous constructor call. A single call resolves
  **every** field, including the Fabric coordinates — there is no separate
  call needed for apps that drive their own Fabric auth flow; read them off
  `client.runtimeConfig` after construction. See
  [Fabric auth coordinates](../../packages/guide/assets/docs/app-backend/deployment-pipelines.md#fabric-auth-coordinates-need-clientruntimeconfig)
  in the guide.
- `RayfinRuntimeConfig` — the optional-field bag shape above, used both as the
  `defaults` argument and as `resolveRayfinConfig()`'s resolved
  `runtimeConfig` output, and exposed as `client.runtimeConfig`.
- `RayfinConfigError` with typed codes: `CONFIG_LOAD_FAILED`,
  `CONFIG_INCOMPLETE`, `CONFIG_INVALID`, `CONFIG_PARSE_FAILED`.
- `apiUrl` normalised at validation time (trailing slash added if absent).
- The `x-ms-workload-resource-moniker` header now resolves from
  `runtimeConfig.itemId` when present, instead of only guessing from the
  trailing GUID in the base URL — so it follows the promoted item, not the
  build-time one.

### What the user has to do

- **New apps:** call `await resolveRayfinConfig({ apiUrl, publishableKey })`
  at startup, then construct `new RayfinClient({ ...resolved, authStorage: true })`.
  Scaffolding templates do this by default. Pass your existing
  `VITE_RAYFIN_*` values in as `defaults` — they still belong in your app,
  `rayfin dev` depends on them — just don't use them to construct the client
  directly.
- **Apps with their own Fabric auth flow:** pass `workspaceId`/`itemId`/
  `portalUrl` (typically from `VITE_FABRIC_*`) into `resolveRayfinConfig()`'s
  `defaults` alongside `apiUrl`/`publishableKey` — one call resolves all of
  it — then read the resolved coordinates off `client.runtimeConfig` after
  construction, rather than reading `VITE_FABRIC_*` directly.
- **Don't** construct `RayfinClient`/`RayfinServerClient` directly from
  `import.meta.env.VITE_RAYFIN_*` / `VITE_FABRIC_*` anymore — always resolve
  through `resolveRayfinConfig()` first. Non-Rayfin `VITE_*` usage (analytics,
  feature flags) is unaffected.
- The CLI generates the config file for you — you never hand-edit endpoint
  values per environment.

### Flow across environments

| Stage | Who writes `rayfin.config.json` |
|-------|----------------------------------|
| Local dev (`rayfin dev`) | Not written — local dev falls back to build-time `VITE_*` values (`loadRayfinConfig` returns `null`) |
| Deploy to Dev (`rayfin up`) | CLI writes into the static-hosting build root — resolved via `config.root`/`config.path` the same way static-hosting resolves its own build/validate root, so nested frontend layouts (`root: frontend`, `folder: dist`) get the file too — before build, so it's included in the compiled output and uploaded to `StaticAssets/`, then removed from the working tree afterward. A preexisting file at that path is left in place (not overwritten) and diffed field-by-field against what this run would have written; callers warn only when there's an actual mismatch. |
| Promote to Prod (Deployment Pipeline) | BaaS Import handler regenerates with the target workspace's values |

On promotion the exported definition **excludes** `rayfin.config.json`; Import
regenerates it for the target:

```text
Dev StaticAssets/          Prod StaticAssets/
  index.html         ═══►   index.html          (same)
  assets/main.js     ═══►   assets/main.js      (same)
  rayfin.config.json  ✗     rayfin.config.json   (regenerated for Prod)
```

### What moves in a Deployment Pipeline

A Deployment Pipeline promotes the AppBackend item's **definition** from one
workspace to the next. The definition is a portable package of pre-built
artifacts — not source code — assembled by Export and replayed by Import:

```text
MyAppBackend.AppBackend/
├── .platform          Fabric-managed item metadata (id/type/displayName)
├── rayfin.yml          Services config (auth, data, storage, staticHosting)
├── dab-config.json     Pre-generated DAB entity schema
└── static-app.zip      Compiled SPA bundle (only if a frontend is deployed)
```

Each artifact is sourced from where its state actually lives, and each carries
a different environment-coupling risk:

| Artifact | Source on Export | Moves as-is? | Environment-specific? |
|---|---|---|---|
| `rayfin.yml` | Cosmos `ServiceSettings` | Yes | No — same services config across stages |
| `dab-config.json` | SQL DB `DbAppliedSchema` rows | Yes | No — but dialect-locked (source/target must match) |
| `static-app.zip` | OneLake `StaticAssets/` | Compiled bundle moves as-is | **The bundle, no.** Its endpoint values are the problem this doc solves |
| `rayfin.config.json` | — | **No — excluded from the definition** | Yes — regenerated per stage by Import |

The key interaction with runtime config: the compiled SPA inside
`static-app.zip` (`index.html`, `assets/*.js`) is **byte-identical** across
stages and promotes unchanged. The one environment-specific asset,
`rayfin.config.json`, is deliberately **left out of the exported definition** so
a stale Dev config never travels to Prod. Import writes a fresh
`rayfin.config.json` into the target workspace's `StaticAssets/` using that
stage's API URL, publishable key, and Fabric item metadata.

Backend-only AppBackends (no `static-app.zip`) are unaffected — there is no
bundle and no runtime config to regenerate.

## Migration

Adopting `resolveRayfinConfig()` is **opt-in, not breaking**. Existing apps
that construct `RayfinClient`/`RayfinServerClient` directly from
`import.meta.env.VITE_RAYFIN_*` continue to work unchanged — nothing forces
them onto the new path, and `rayfin up` still emits `.env.local` alongside
`rayfin.config.json`, so framework tooling (`rayfin dev`) that depends on
`VITE_*` values is unaffected either way.

The trade-off for not adopting it: an app that constructs the client directly
from `VITE_*` values instead of resolving through `resolveRayfinConfig()` is
not ALM-compliant — see [Customer impact](#customer-impact) below.

## Customer impact

- **Uses `resolveRayfinConfig()`** → ALM-compliant; Deployment Pipelines work.
- **Uses `import.meta.env.VITE_RAYFIN_*`** → not ALM-compliant; promoted app
  points at the wrong backend.
- **Uses `VITE_*` for non-Rayfin values** → unaffected.

## Out of scope (call out explicitly)

- **Functions** — Python (`.py`) vs TypeScript (zip) export differently; needs
  separate ALM handling.
- **Secrets** — not solved here.
- **Source-code movement / server-side builds** — the definition carries
  pre-built artifacts, not source. (See the BaaS ALM RFC for the
  Git-Integration future enhancement.)
- **Child items** (real-time, lakehouse/storage, SQL DB) — reuse Fabric's
  import/export definition API rather than building custom ALM.
