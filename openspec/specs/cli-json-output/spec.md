# cli-json-output Specification

## Purpose

TBD - created by archiving change cli-quiet-json-output.
Update Purpose after archive.
Structured JSON output mode for `rayfin up` commands via `--json` flag, emitting machine-readable deployment results with status, deployment metadata, and per-step timing.
Also covers the machine-readable catalog emitted by `rayfin connector types --json`.

## Requirements

### Requirement: JSON output for rayfin up

The `rayfin up` command SHALL accept a `--json` flag that suppresses all interactive output (spinners, emoji, progress text) and emits a single JSON object to stdout on completion.

**ID**: `CLI-JSON-UP-001`

#### Scenario: Successful deployment with --json

- **WHEN** a user runs `rayfin up --json`
- **THEN** the CLI SHALL emit no spinner or progress output to stdout
- **AND** the CLI SHALL emit a single JSON object to stdout with the following fields:
  - `status`: `"success"`
  - `itemId`: the Rayfin item ID
  - `workspaceId`: the Fabric workspace ID
  - `endpoint`: the deployment endpoint URL
  - `hostingUrl`: the static hosting URL (if static content was deployed)
  - `publishableKey`: the publishable key string
  - `steps`: an object mapping step names to `{ "duration": "<timing>", "status": "success" }`

#### Scenario: Failed deployment with --json

- **WHEN** a user runs `rayfin up --json` and the deployment fails at any step
- **THEN** the CLI SHALL emit a single JSON object to stdout with the following fields:
  - `status`: `"error"`
  - `error`: a human-readable error message
  - `step`: the name of the step that failed
  - `partialResult`: an object containing any successfully completed deployment metadata
- **AND** the CLI SHALL exit with a non-zero exit code

#### Scenario: JSON output is valid JSON

- **WHEN** a user runs `rayfin up --json`
- **THEN** the entire stdout output SHALL be parseable as a single JSON object via `JSON.parse()`
- **AND** no ANSI escape sequences, spinner characters, or emoji SHALL appear in stdout

### Requirement: JSON output for rayfin up db apply

The `rayfin up db apply` command SHALL accept a `--json` flag with the same suppression behavior.

**ID**: `CLI-JSON-UP-DB-001`

#### Scenario: Successful db apply with --json

- **WHEN** a user runs `rayfin up db apply --json`
- **THEN** the CLI SHALL emit a JSON object to stdout with:
  - `status`: `"success"`
  - `endpoint`: the target endpoint
  - `duration`: the total operation duration

#### Scenario: Failed db apply with --json

- **WHEN** a user runs `rayfin up db apply --json` and the operation fails
- **THEN** the CLI SHALL emit a JSON object to stdout with `status: "error"` and `error` message
- **AND** the CLI SHALL exit with a non-zero exit code

### Requirement: JSON output for rayfin up staticapp deploy

The `rayfin up staticapp deploy` command SHALL accept a `--json` flag with the same suppression behavior.

**ID**: `CLI-JSON-UP-STATIC-001`

#### Scenario: Successful staticapp deploy with --json

- **WHEN** a user runs `rayfin up staticapp deploy --json`
- **THEN** the CLI SHALL emit a JSON object to stdout with:
  - `status`: `"success"`
  - `hostingUrl`: the deployed static content URL
  - `duration`: the total operation duration

#### Scenario: Failed staticapp deploy with --json

- **WHEN** a user runs `rayfin up staticapp deploy --json` and the operation fails
- **THEN** the CLI SHALL emit a JSON object to stdout with `status: "error"` and `error` message
- **AND** the CLI SHALL exit with a non-zero exit code

### Requirement: JSON output for rayfin connector types

The `rayfin connector types` command SHALL accept a `--json` flag that emits the connector catalog as a single machine-readable object, so an agent can read the supported types, their capabilities, and the packages to install without a hand-copied table.

**ID**: `CLI-JSON-CONNECTOR-TYPES-001`

#### Scenario: Catalog payload with --json

- **WHEN** a user runs `rayfin connector types --json`
- **THEN** the CLI SHALL emit a single JSON object to stdout with the following fields:
  - `status`: `"ok"`
  - `schemaVersion`: an integer identifying the payload contract version
  - `count`: the number of entries in `types`
  - `types`: an array of connector-type objects, sorted ascending by `type`
- **AND** each entry in `types` SHALL contain:
  - `type`: the connector type identifier used by `--type` and by `rayfin.yml`
  - `category`: `"graphql-entities"` (Category A) or `"function-bridge"` (Category B)
  - `description`: a human-readable description
  - `defaultAuth`: the auth type written by `connector add` when none is given
  - `allowedAuthTypes`: every auth type the validator accepts for this type
  - `dialect`: the analyzer dialect, or `null` for function-bridge types
  - `allowedOperations`: the operation allowlist the validator enforces
  - `requiredConfig`: the config keys `connector add` requires
  - `discoverableItemTypes`: the Fabric item types `connector search` can list, or `[]`
  - `requiresVersion`: whether the `rayfin.yml` entry needs a pinned adapter `version`
  - `packages`: the npm packages the generated `schema.ts` imports, each `{ name, role, version }` where `role` is `"marker"` or `"runtime"`
- **AND** each entry SHALL contain `defaultVersion` when `requiresVersion` is `true`

#### Scenario: Package metadata is installable as emitted

- **WHEN** an agent reads a `packages` entry from `rayfin connector types --json`
- **THEN** `name` and `version` together SHALL be sufficient to install the package (`npm install <name>@<version>`)
- **AND** the emitted `version` SHALL be the CLI's own version, because the connector SDK packages are published in lockstep with the CLI

#### Scenario: Compatibility expectations for catalog changes

- **WHEN** a connector type is added, or a field is added to a `types` entry
- **THEN** `schemaVersion` SHALL remain unchanged, and consumers SHALL ignore unknown fields and unknown `type` values
- **WHEN** a field is removed or renamed, or the meaning of an existing field changes
- **THEN** `schemaVersion` SHALL be incremented

#### Scenario: JSON and verbose are mutually exclusive

- **WHEN** a user runs `rayfin connector types --json --verbose`
- **THEN** the CLI SHALL emit `status: "error"` with a recovery hint and exit with a non-zero exit code
