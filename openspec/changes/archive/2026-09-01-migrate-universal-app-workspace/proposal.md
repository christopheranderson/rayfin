## Why

The Universal App is currently both a Rush sample and the Builder-facing template source, so its root manifest must simultaneously satisfy monorepo development, generated-app dependency, plugin policy, and capability-pack concerns.
Migrating it to the proven outer-harness plus inner-template pattern separates those responsibilities while preserving the plugin's scaffold and validation contract.

## What Changes

- Restructure `samples/universal-app` as an outer Rush validation harness containing a Builder-facing npm workspace under `template/`.
- Divide the inner workspace into stable `@rayfin-app/frontend`, `@rayfin-app/data`, and `@rayfin-app/shared` packages; keep `@rayfin-app/functions` absent until the existing functions capability pack creates it.
- Continue customizing only the root app name during scaffolding; member package names and cross-package imports remain stable.
- Configure Rayfin service paths and build commands for the workspace layout while preserving the existing project-root resolution contract.
- Use published Rayfin dependency ranges inside the template, `*` for local npm workspace members, and local SDK links only in the generated outer-harness validation target.
- Continue bundling the Universal App exclusively through the Copilot plugin, with stable template identity, policy enforcement, capability detection, and pack application across the new package boundaries.
- Preserve the existing Builder experience and compatibility for generated apps; do not add a CLI template, automatic workspace discovery, a migration command, or a default functions package.

## Capabilities

### New Capabilities

- `universal-app-workspace-template`: Defines the two-layer sample, inner npm workspace boundaries, service wiring, dependency strategy, plugin bundling and validation behavior, opt-in functions pack, compatibility guarantees, and migration validation scenarios.

### Modified Capabilities

None.
The change consumes the contracts established by the prior `workspace-support` change, especially `workspace-path-resolution` and `workspace-todo-app-sample`, without changing their requirements.

## Impact

- **Samples**: `samples/universal-app/` becomes a Rush harness around `template/`, with generated validation output kept ephemeral.
- **Copilot plugin**: `packages/tools/copilot-plugin/` bundles the inner template and resolves policy and capability evidence across the workspace root and package boundaries.
- **Capability packs**: Universal App pack manifests and tests target workspace package paths; functions remains opt-in and pack-created.
- **Dependencies**: Generated apps install published Rayfin packages and local workspace members, while repository validation rewrites only Rayfin dependencies to local SDK paths.
- **Compatibility**: The plugin's template identity, authentication posture, validation gates, and generated-app workflow remain stable.
