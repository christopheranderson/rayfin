# cli-artifact-context Specification

## Purpose

CLI flags for passing Fabric artifact context (workspace ID, item ID) through the scaffolding pipeline to pre-seed deployment metadata.

## Requirements

### Requirement: Artifact context flags

The `rayfin init` and `create-rayfin` CLIs SHALL accept `--workspace-id` and `--item-id` flags that pass Fabric artifact context through the scaffolding pipeline.

#### Scenario: Pass both flags to rayfin init

- **WHEN** user runs `rayfin init --workspace-id ws-123 --item-id item-456 .`
- **THEN** the system writes `.env.fabric` with `VITE_FABRIC_ITEM_ID=item-456` and `VITE_FABRIC_WORKSPACE_ID=ws-123`

#### Scenario: Pass only workspace-id

- **WHEN** user runs `rayfin init --workspace-id ws-123 .`
- **THEN** the system writes `.env.fabric` with `VITE_FABRIC_WORKSPACE_ID=ws-123`

#### Scenario: Pass only item-id without workspace-id

- **WHEN** user runs `rayfin init --item-id item-456 .`
- **THEN** the system exits with error code 1
- **AND** displays `--item-id requires --workspace-id to pre-seed deployment metadata`

#### Scenario: No context flags provided

- **WHEN** user runs `rayfin init .` without any context flags
- **THEN** the system SHALL NOT create a `.env.fabric` file for pre-seeding

### Requirement: create-rayfin forwards context to rayfin init

The `create-rayfin` CLI SHALL accept `--workspace-id` and `--item-id` flags and forward them to the `rayfin init` subprocess.

#### Scenario: Forward all context flags

- **WHEN** user runs `npm create @microsoft/rayfin@latest -- --template todo-app --workspace-id ws-123 --item-id item-456`
- **THEN** the system passes `--workspace-id ws-123 --item-id item-456` to the `rayfin init` subprocess

#### Scenario: Forward partial context flags

- **WHEN** user runs `npm create @microsoft/rayfin@latest -- --workspace-id ws-123`
- **THEN** the system passes only `--workspace-id ws-123` to the `rayfin init` subprocess

### Requirement: Pre-seed writes only static env file

The `preSeedDeploymentEnvFile` function SHALL write only the static `.env.fabric` file (not a workspace-named variant).

#### Scenario: Pre-seed creates static file only

- **WHEN** `rayfin init` is called with `--item-id item-123 --workspace-id ws-456`
- **THEN** the system creates `.env.fabric` in the project root
- **AND** the system SHALL NOT create any `.env.fabric-<name>` workspace-scoped file

### Requirement: Env value sanitization

All values written to `.env.fabric` files SHALL be sanitized to prevent environment variable injection via newline characters.

#### Scenario: Strip newlines from values

- **WHEN** a value containing `\n` characters is written to `.env.fabric`
- **THEN** the system strips all `\n`, `\r`, and `\0` characters from the value
- **AND** the resulting value is written as a single line

#### Scenario: Prevent injection via crafted value

- **WHEN** an artifact ID is set to `"bad\nINJECTED_VAR=evil"`
- **THEN** the `.env.fabric` file SHALL NOT contain `INJECTED_VAR` as a separate environment variable key

### Requirement: Partial env file support

The CLI deployment env reader SHALL support reading `.env.fabric` files that do not contain all deployment fields.

#### Scenario: Read file without rayfinApiUrl

- **WHEN** `.env.fabric` contains `VITE_FABRIC_ITEM_ID` and `VITE_FABRIC_WORKSPACE_ID` but no `VITE_RAYFIN_API_URL`
- **THEN** the reader returns a valid `DeploymentEnvVars` object with `rayfinApiUrl` set to `undefined`

#### Scenario: Reject file missing workspace ID

- **WHEN** `.env.fabric` is missing `VITE_FABRIC_WORKSPACE_ID`
- **THEN** the reader returns `null`
