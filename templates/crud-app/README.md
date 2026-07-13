# workspace-todo-app

A multi-package npm workspace demonstrating Rayfin's per-service `path` and `buildCommand` support in `rayfin.yml`.
Each package in the workspace has its own responsibility and depends on Rayfin SDKs.

## Workspace layout

- `packages/shared` — Cross-cutting entity definitions (Image) using `@microsoft/rayfin-core` decorators
- `packages/data` — Data package owning Todo, Category entities and the shared schema type. The CLI discovers entities via the package.json `exports` entry point.
- `packages/frontend` — Vite/React app with Fabric auth, todo CRUD, and image attachments
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
