# workspace-todo-app

A multi-package npm workspace demonstrating Rayfin's per-service `path` and `buildCommand` support in `rayfin.yml`.
Each package in the workspace has its own responsibility and depends on Rayfin SDKs.

## Workspace layout

- `packages/shared` — Cross-cutting entity definitions (Image) using `@microsoft/rayfin-core` decorators
- `packages/data` — Data package owning Todo, Category entities and the shared schema type. The CLI discovers entities via the package.json `exports` entry point.
- `packages/frontend` — Vite/React app (React Router, Tailwind CSS v4, shadcn/ui) with Fabric auth, todo CRUD, and a serverless-function demo
- `packages/local-dev` — Local development helpers: the Vite proxy plugin and the system-browser auth proxy used by the frontend during `rayfin dev`
- `packages/functions` — Functions package with serverless function type definitions
- `rayfin/rayfin.yml` — Root Rayfin config that points each service to its package using `path` and `buildCommand`

## Key concepts

### Per-service path resolution

The `rayfin.yml` uses `path` fields to direct the CLI to the correct package for each service, and `buildCommand` to build cross-package dependencies before the CLI's own compilation:

```yaml
services:
  data:
    enabled: true
    path: packages/data
    buildCommand: npm run build
  staticHosting:
    enabled: true
    path: packages/frontend
    buildCommand: npm run build:fabric
  functions:
    enabled: true
    path: packages/functions
    buildCommand: npm run build
```

### Package exports entity discovery

When a data service `path` points to a package with a `package.json` that has an `exports` field, the CLI imports entities directly from the built package output. This eliminates the need for a separate `rayfin/data/` re-export layer - entity classes defined in `src/` are discovered automatically through the package's entry point.

### Frontend architecture

The frontend is organized around a small service layer so UI code never touches the SDK directly:

- `services/rayfin/RayfinClientService.ts` — owns the singleton `RayfinClient`, built from `resolveRayfinConfig()` so requests go through the same-origin `/.rayfin` proxy in local dev and the absolute backend URL in production.
- `services/ServiceContainer.ts` — composition root that picks the auth strategy for the current environment.
- `services/rayfin/RayfinProxyAuthService.ts` — local-dev login via the system-browser **auth proxy** (`@workspace-todo-app/local-dev`), so passkeys/SSO work outside the WebView.
- `services/rayfin/RayfinFabricAuthService.ts` — production / in-WebView Fabric login.
- `services/rayfin/RayfinTodoService.ts` — todo CRUD; completing a todo invokes the `completeTodo` Rayfin function.
- `services/rayfin/RayfinFunctionsService.ts` — wraps the `healthCheck` function (the "Health check" button in the dashboard).

Routing (`react-router-dom`), styling (Tailwind CSS v4 + shadcn/ui), and auth state (`hooks/AuthContext.tsx`) round out the foundation.

## Run locally

1. Install dependencies:

```bash
npm install
```

1. Start Rayfin backend services:

```bash
npm run dev:rayfin
```

1. Start frontend development server:

```bash
npm run dev
```

## Build

```bash
npm run build
```
