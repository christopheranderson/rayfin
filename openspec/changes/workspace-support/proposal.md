# Workspace Support Proposal

## Why

Rayfin currently assumes a 1:1 relationship between a project directory and a `rayfin.yml` configuration — one package, one app.
Real-world projects often split concerns across multiple packages (frontend, data models, functions, shared utilities) using npm or pnpm workspaces.
Today there is no way to express "this service's code lives in `packages/frontend/`" in `rayfin.yml`, forcing workspace users to flatten their project or work around the CLI.
Adding per-service path support unlocks multi-package architectures without breaking the existing single-package default.

## What Changes

- `rayfin.yml` gains an optional `path` field on each service entry (e.g., `services.data.path`, `services.staticHosting.path`, `services.functions.path`) that tells the CLI where the relevant package lives relative to the project root.
- `rayfin.yml` gains an optional `buildCommand` field on the `data` service entry, mirroring the existing `buildCommand` on `staticHosting` and `functions`. When set, the CLI executes it before entity compilation — essential for workspace layouts where cross-package dependencies must be built before the CLI's own TypeScript compilation step.
- When `path` is omitted, existing behavior is preserved (the project root is used, matching today's single-package model).
- A new `workspace-todo-app` sample demonstrates a multi-package npm-workspace layout with separate packages for the frontend, data entities, shared types, and functions — all wired through a single `rayfin.yml` at the workspace root.
- The `workspace-todo-app` sample is structured as a Rush project that validates the template via `rayfin init -t ./template` on each build, and is **not** registered as a public template.

## Capabilities

### New Capabilities

- `workspace-path-resolution`: The CLI resolves service-level `path` fields in `rayfin.yml` to locate package directories for build commands, entity discovery, env generation, and static hosting.
- `data-build-command`: The data service now supports a `buildCommand` field. When set, the CLI executes it before entity discovery.
- `package-exports-entity-resolution`: When a data service `path` points to a directory with a `package.json` that has an `exports` (or `main`) field, the CLI imports entities directly from the built package output. This eliminates the need for a separate `rayfin/data/` re-export layer in workspace packages. The CLI falls back to the traditional `compileRayfinDirectory` + glob approach when no `package.json` or `exports` field is found.
- `workspace-todo-app-sample`: A new sample under `samples/workspace-todo-app/` demonstrating npm workspaces with Rayfin, serving as a reference implementation and integration test surface.

### Modified Capabilities

(none — existing single-package behavior is unchanged; `path` defaults to project root when absent)

## Impact

- **`@microsoft/rayfin-tools-common`**: `RayfinConfig` type gains optional `path?: string` on service entries and `buildCommand?: string` on the data service entry.
- **`@microsoft/rayfin-cli`**: Config loading, entity discovery, `rayfin env`, `rayfin up`, and `rayfin dev` commands must resolve relative `path` values to locate the correct package directory for each service. The DAB config generator resolves entities from package.json `exports` when available (preferred for workspace packages), falling back to `compileRayfinDirectory` + `rayfin/.temp/compiled/data/` glob when no package.json or exports exist. The `applyDbConfig` and `applyDbConfigWithRetries` accept and execute the data `buildCommand` before entity discovery.
- **Samples**: New `samples/workspace-todo-app/` directory structured as a Rush project wrapping a `template/` directory containing the npm workspace with sub-packages. The Rush build pipeline runs `rayfin init -t ./template` to validate the template, rewrites SDK deps to local `file:` paths, then installs and builds the output. Entity definitions live directly in package `src/` directories — no `rayfin/data/` re-export layer is needed thanks to package exports resolution. The `template/` is the Builder-facing source of truth; `target/` is ephemeral build output (`.gitignored`).
- **No breaking changes**: Omitting `path` and `buildCommand` preserves current single-package resolution. Projects without `package.json` exports in the data service root continue using the existing `rayfin/data/` compilation flow.
