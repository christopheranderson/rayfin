## 1. Shared config and path resolution

- [x] 1.1 Add `path?: string` to the service config types that rely on local files (`data`, `storage`, `staticHosting`, `functions`) in `packages/tools/common/src/config/types.ts`.
- [x] 1.2 Update the shared Rayfin YAML parser so `path` is preserved when configs are loaded and omitted when not present.
- [x] 1.3 Add a shared `resolveServicePath(projectRoot, servicePath?)` helper that returns `projectRoot` when `servicePath` is missing and resolves relative paths otherwise.
- [x] 1.4 Add validation for absolute paths, path traversal outside the project root, and missing target directories with service-specific error messages.

## 2. CLI integration

- [x] 2.1 Update data entity discovery to resolve the data service root from `services.data.path` before searching for entity files.
- [x] 2.2 Update static hosting build and upload logic to run from the resolved `services.staticHosting.path` directory and resolve the output folder relative to it.
- [x] 2.3 Update functions discovery and type generation to resolve the functions root from `services.functions.path` before reading files and `tsconfig.json`.
- [x] 2.4 Update `rayfin env`, `rayfin up`, and `rayfin dev` path handling so all service-relative file access uses the resolved service directory.
- [x] 2.5 Preserve existing single-package behavior when `path` is omitted for every affected command.

## 2.5 (added). Data service buildCommand support

- [x] 2.6 Add `buildCommand?: string` to the data service type in `packages/tools/common/src/config/types.ts`.
- [x] 2.7 Add `buildCommand` to `DabGenerationOptions` in `dab-config-generator.ts` and implement `runDataBuildCommand()` helper.
- [x] 2.8 Thread `buildCommand` through `applyDbConfig`, `applyDbConfigWithRetries`, and all call sites in `dev.ts`, `dev-db.ts`, `watch.ts`, `up.ts`, `up-db.ts`.
- [x] 2.9 Create `packages/data/rayfin/tsconfig.json` in the workspace sample for CLI entity compilation.
- [x] 2.10 Update entity discovery files to import from built package exports instead of raw source paths.

## 3. Workspace sample

- [x] 3.1 Add the new `samples/workspace-todo-app/` directory with a root npm workspace `package.json` and the required sub-packages.
- [x] 3.2 Wire `rayfin/rayfin.yml` in the sample to the sub-packages using service `path` and `buildCommand` fields.
- [x] 3.3 Apply the D6 package-role conventions to the sample packages (`browser-only`, `Node.js-only`, and `isomorphic/shared`).
- [x] 3.4 ~~Register the sample in Rush under the `samples` subspace.~~ REMOVED — sample is standalone (not Rush-managed, see D9).
- [x] 3.5 Add sample documentation that explains the workspace layout and how to run it.
- [x] 3.6 Integrate Fabric auth via `@microsoft/rayfin-auth-provider-fabric`.
- [x] 3.7 Distribute entities across packages: Todo/Category in data, Image in shared.
- [x] 3.8 Add todo creation UI with image attachment support in the frontend.

## 4. Verification

- [x] 4.1 Add or update unit tests for config parsing, path resolution, path validation, and fallback behavior when `path` is omitted.
- [x] 4.2 Add or update CLI tests that cover entity discovery, static hosting, functions discovery, and environment generation with workspace paths — including data `buildCommand` execution.
- [x] 4.3 Validate the sample with `npm install && npm run build` from the workspace root, and confirm the repo still passes `rush build --to @microsoft/rayfin-cli` for the touched CLI areas.

## 5. OpenSpec documentation

- [x] 5.1 Update proposal.md with data.buildCommand capability and impact.
- [x] 5.2 Update design.md with D8 (data buildCommand), D9 (standalone sample), D10 (entity distribution).
- [x] 5.3 Update workspace-path-resolution spec with data buildCommand requirements.
- [x] 5.4 Update workspace-todo-app-sample spec with entity distribution, Fabric auth, standalone build, and removed Rush requirement.
