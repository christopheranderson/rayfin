## ADDED Requirements

### Requirement: RayfinConfig service entries support optional path field

The `RayfinConfig` interface in `@microsoft/rayfin-tools-common` (`packages/tools/common/src/config/types.ts`) SHALL expose an optional `path?: string` field on service entries that rely on local file references beyond `rayfin.yml` itself.
Service entries that do not rely on local file references SHALL NOT expose a `path` field.
In the current service set, this means `path` applies to `data`, `storage`, `staticHosting`, and `functions`, and does not apply to `auth`.

#### Scenario: data service accepts path field

- **WHEN** `rayfin.yml` contains `services.data.path: packages/data`
- **THEN** the parsed `RayfinConfig` object SHALL have `services.data.path === 'packages/data'`

#### Scenario: staticHosting service accepts path field

- **WHEN** `rayfin.yml` contains `services.staticHosting.path: packages/frontend`
- **THEN** the parsed `RayfinConfig` object SHALL have `services.staticHosting.path === 'packages/frontend'`

#### Scenario: functions service accepts path field

- **WHEN** `rayfin.yml` contains `services.functions.path: packages/api`
- **THEN** the parsed `RayfinConfig` object SHALL have `services.functions.path === 'packages/api'`

#### Scenario: storage service accepts path field

- **WHEN** `rayfin.yml` contains `services.storage.path: packages/data`
- **THEN** the parsed `RayfinConfig` object SHALL have `services.storage.path === 'packages/data'`

#### Scenario: path field is optional

- **WHEN** `rayfin.yml` omits `path` on any service entry
- **THEN** the parsed `RayfinConfig` object SHALL have `undefined` for the `path` field on that service

---

### Requirement: resolveServicePath helper returns the correct directory

A `resolveServicePath(projectRoot: string, servicePath?: string): string` function SHALL be available for use by the CLI.
When `servicePath` is defined, it SHALL return `path.resolve(projectRoot, servicePath)`.
When `servicePath` is `undefined`, it SHALL return `projectRoot` unchanged.

#### Scenario: resolves relative service path

- **WHEN** `resolveServicePath('/workspace', 'packages/data')` is called
- **THEN** the function SHALL return `'/workspace/packages/data'`

#### Scenario: falls back to project root when path is absent

- **WHEN** `resolveServicePath('/workspace', undefined)` is called
- **THEN** the function SHALL return `'/workspace'`

#### Scenario: handles nested relative path

- **WHEN** `resolveServicePath('/workspace', 'apps/frontend/src')` is called
- **THEN** the function SHALL return `'/workspace/apps/frontend/src'`

---

### Requirement: service path is resolved relative to the project root

The `path` field in each service entry SHALL be treated as a path relative to `projectRoot` — the directory containing the `rayfin/` folder — not relative to `process.cwd()` or the `rayfin/` subdirectory itself.

#### Scenario: CLI invoked from a sub-directory uses project root as anchor

- **WHEN** the user runs a CLI command from `packages/frontend/`
- **AND** `rayfin.yml` is found at the workspace root (three levels up)
- **AND** `services.data.path` is set to `packages/data`
- **THEN** the CLI SHALL resolve the data service path to `<workspace-root>/packages/data`, not relative to `packages/frontend/`

#### Scenario: path does not accept absolute paths

- **WHEN** `rayfin.yml` contains a `path` value that is an absolute filesystem path (begins with `/` on Unix or a drive letter on Windows)
- **THEN** the CLI SHALL emit an error message stating that `path` values must be relative and SHALL NOT proceed with that service operation

---

### Requirement: path traversal outside the project root is rejected

The CLI SHALL validate that every resolved service path stays within `projectRoot`.
Any `path` value whose resolved form escapes the project root (i.e., resolves to a directory that does not have `projectRoot` as a prefix) SHALL be rejected with a clear error message before any service operation is performed.

#### Scenario: path escapes project root via dot-dot segments

- **WHEN** `rayfin.yml` contains `services.data.path: ../../outside`
- **THEN** the CLI SHALL emit an error identifying the offending service and the resolved path
- **THEN** the CLI SHALL NOT perform entity discovery or any other operation for that service

#### Scenario: valid sub-directory path is accepted

- **WHEN** `rayfin.yml` contains `services.data.path: packages/data`
- **AND** `packages/data` resolves to a directory within `projectRoot`
- **THEN** the CLI SHALL proceed normally

---

### Requirement: non-existent service path produces a clear error

When a `path` value is explicitly set on a service entry and the resolved directory does not exist on disk, the CLI SHALL emit a descriptive error message that includes the service name, the configured `path` value, and the resolved absolute path.
The error SHALL occur before the affected service operation (e.g., entity discovery, build) is attempted.

#### Scenario: configured path directory is missing

- **WHEN** `rayfin.yml` contains `services.data.path: packages/data`
- **AND** `<projectRoot>/packages/data` does not exist
- **THEN** the CLI SHALL emit an error such as: `Service 'data' path 'packages/data' does not exist at '<resolved-path>'`
- **THEN** the CLI SHALL NOT attempt entity discovery for that service

#### Scenario: missing path for disabled service does not produce an error

- **WHEN** `rayfin.yml` contains `services.data.path: packages/data` and `services.data.enabled: false`
- **THEN** the CLI SHALL NOT validate or resolve the `path` value for that service

---

### Requirement: entity discovery uses the resolved data service path

The CLI's entity discovery process SHALL use the directory returned by `resolveServicePath(projectRoot, config.services.data.path)` as the data service root.

When the data service root contains a `package.json` with a resolvable `exports` (or `main`) field, the CLI SHALL import entities directly from the resolved entry point(s). This is the preferred path for workspace packages.

When the data service root does NOT contain a `package.json` with resolvable exports, the CLI SHALL fall back to compiling the `rayfin/` directory via `compileRayfinDirectory` and globbing `rayfin/.temp/compiled/data/*.js` for entity files.

#### Scenario: entity files discovered from package.json exports

- **WHEN** `rayfin.yml` contains `services.data.path: packages/data`
- **AND** `<projectRoot>/packages/data/package.json` contains `"exports": { ".": { "import": "./dist/src/index.js" } }`
- **AND** the data `buildCommand` has been executed (producing the `dist/` output)
- **THEN** the CLI SHALL import `<projectRoot>/packages/data/dist/src/index.js` and scan its exports for decorated entity classes

#### Scenario: entity discovery falls back to rayfin/data when no package exports exist

- **WHEN** `rayfin.yml` contains `services.data.path: packages/data`
- **AND** `<projectRoot>/packages/data/` does NOT contain a `package.json` with an `exports` or `main` field
- **AND** entity definition files exist under `<projectRoot>/packages/data/rayfin/data/`
- **THEN** the CLI SHALL compile and discover entity files from the `rayfin/data/` directory

#### Scenario: entity discovery falls back to project root when path is absent

- **WHEN** `rayfin.yml` omits `services.data.path`
- **AND** entity definition files exist under `<projectRoot>/rayfin/data/`
- **THEN** the CLI SHALL discover and compile those entity files, preserving existing behavior

#### Scenario: package exports entry not found after build

- **WHEN** `rayfin.yml` contains `services.data.path: packages/data`
- **AND** `<projectRoot>/packages/data/package.json` has `exports` pointing to `./dist/src/index.js`
- **AND** `./dist/src/index.js` does not exist on disk
- **THEN** the CLI SHALL emit an error indicating the exports entry was not found, suggesting the build command be run first

---

### Requirement: Data service supports a buildCommand for pre-compilation

The data service entry in `RayfinConfig` SHALL support an optional `buildCommand?: string` field.
When `buildCommand` is set and the CLI initiates entity discovery (DAB config generation), the CLI SHALL execute the build command from the resolved data service root BEFORE attempting entity discovery (whether via package exports or the traditional `rayfin/data/` compilation path).
When `buildCommand` is absent, the CLI SHALL skip the build step and proceed directly to entity discovery, preserving existing behavior.

#### Scenario: build command runs before entity compilation

- **WHEN** `rayfin.yml` contains `services.data.buildCommand: npm run build`
- **AND** `services.data.path: packages/data`
- **THEN** the CLI SHALL execute `npm run build` with cwd set to `<projectRoot>/packages/data` before running TypeScript entity compilation

#### Scenario: build command failure stops entity compilation

- **WHEN** `rayfin.yml` contains `services.data.buildCommand: npm run build`
- **AND** the build command exits with a non-zero exit code
- **THEN** the CLI SHALL NOT proceed with entity compilation
- **AND** the CLI SHALL emit an error message indicating the build command failed

#### Scenario: no build command preserves existing behavior

- **WHEN** `rayfin.yml` omits `services.data.buildCommand`
- **THEN** the CLI SHALL proceed directly to entity compilation without running any build step

---

### Requirement: static hosting build uses the resolved staticHosting service path

The CLI's static hosting build and upload operations SHALL use `resolveServicePath(projectRoot, config.services.staticHosting.path)` as the working directory when executing `buildCommand` and resolving the `folder` output directory.

#### Scenario: build command runs in configured sub-package directory

- **WHEN** `rayfin.yml` contains `services.staticHosting.path: packages/frontend`
- **AND** `services.staticHosting.buildCommand: npm run build`
- **THEN** the CLI SHALL execute `npm run build` with cwd set to `<projectRoot>/packages/frontend`

#### Scenario: output folder is resolved relative to service path

- **WHEN** `rayfin.yml` contains `services.staticHosting.path: packages/frontend`
- **AND** `services.staticHosting.folder: dist`
- **THEN** the CLI SHALL upload files from `<projectRoot>/packages/frontend/dist`

#### Scenario: build falls back to project root when path is absent

- **WHEN** `rayfin.yml` omits `services.staticHosting.path`
- **AND** `services.staticHosting.buildCommand: npm run build`
- **THEN** the CLI SHALL execute the build command with cwd set to `projectRoot`, preserving existing behavior

---

### Requirement: functions discovery uses the resolved functions service path

The CLI's functions type generation and discovery SHALL use `resolveServicePath(projectRoot, config.services.functions.path)` as the root from which it searches for function files and reads `tsconfig.json`.

#### Scenario: functions discovered from configured sub-package

- **WHEN** `rayfin.yml` contains `services.functions.path: packages/api`
- **AND** function definition files and a `tsconfig.json` exist under `<projectRoot>/packages/api/`
- **THEN** the CLI SHALL use `<projectRoot>/packages/api/` as the functions root for type resolution and discovery

#### Scenario: functions discovery falls back to project root when path is absent

- **WHEN** `rayfin.yml` omits `services.functions.path`
- **THEN** the CLI SHALL use `projectRoot` as the functions root, preserving existing behavior

---

### Requirement: project root is the Rayfin anchor, not the git root

The CLI SHALL continue to treat the directory containing `rayfin/rayfin.yml` as the Rayfin project root.
The git repository root SHALL NOT be required to match the Rayfin project root.

#### Scenario: Rayfin project nested inside a git repository

- **WHEN** `rayfin.yml` is located in a subdirectory of a git repository
- **AND** the git repository root is different from the Rayfin project root
- **THEN** the CLI SHALL continue using the Rayfin project root as the base for service path resolution

---

### Requirement: env generation uses the resolved service paths

The `rayfin env` command and any dev-time environment variable generation SHALL resolve per-service output or input locations using `resolveServicePath` for each enabled service that has a `path` configured.

#### Scenario: env file written to configured data package location

- **WHEN** `rayfin.yml` contains `services.data.path: packages/data`
- **AND** the `rayfin env` command is run
- **THEN** any generated or updated env artifacts for the data service SHALL reference or be placed relative to `<projectRoot>/packages/data`

#### Scenario: env generation preserves existing behavior when path is absent

- **WHEN** `rayfin.yml` omits all service `path` fields
- **THEN** `rayfin env` behavior SHALL be identical to pre-change behavior

---

### Requirement: omitting path preserves existing single-package behavior

For every CLI operation affected by this change, the absence of a service `path` field SHALL produce behavior identical to the behavior before this change was introduced.
No existing single-package project SHALL require any `rayfin.yml` changes.

#### Scenario: existing project with no path fields continues to work

- **WHEN** an existing `rayfin.yml` has no `path` fields on any service
- **THEN** `rayfin dev`, `rayfin up`, and `rayfin env` SHALL behave identically to their pre-change behavior
