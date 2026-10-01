# CLI Environment Configuration Specification

## Purpose

Define how the Rayfin CLI and `create-rayfin` scaffolder discover, persist, and propagate Fabric environment configuration (Entra ID app, MSAL authority host, Fabric OAuth scope, Fabric REST API base URL, Fabric portal URL).
The mechanism lets contributors target alternate Fabric environments via five user-supplied `RAYFIN_*` environment variables — partitioned into a three-variable all-or-nothing **authentication** group (intended for contributors only) and two **independent endpoint** variables — without hardcoding any non-production environment names in the source.

## Requirements

### Requirement: Environment-Variable Driven Login Overrides

The `rayfin login` command SHALL read five `RAYFIN_*` environment variables that override the Entra ID app, MSAL authority host, Fabric OAuth scope, Fabric REST API base URL, and Fabric portal URL used by the CLI.
The variables SHALL be partitioned into two groups with distinct validation rules: an **authentication** group (`RAYFIN_AUTHORITY_HOST`, `RAYFIN_CLIENT_ID`, `RAYFIN_FABRIC_SCOPE`) that is all-or-nothing, and an **endpoint** group (`RAYFIN_FABRIC_API_URL`, `RAYFIN_FABRIC_PORTAL_URL`) whose variables are individually optional.

**ID**: `CLI-ENV-CONFIG-LOGIN-001`

#### Scenario: User sets all five environment variables before login

- **GIVEN** the user has exported `RAYFIN_AUTHORITY_HOST`, `RAYFIN_CLIENT_ID`, `RAYFIN_FABRIC_SCOPE`, `RAYFIN_FABRIC_API_URL`, and `RAYFIN_FABRIC_PORTAL_URL` in the shell
- **WHEN** the user runs `rayfin login`
- **THEN** the CLI SHALL acquire the Fabric token using the supplied client ID, authority host, and scope
- **AND** the CLI SHALL fetch Fabric resources using the supplied API base URL
- **AND** the CLI SHALL use the supplied portal URL when constructing deep links and `RAYFIN_PUBLIC_PORTAL_URL`
- **AND** on successful sign-in the CLI SHALL persist all five values into `~/.rayfin/auth.json` under an `environmentConfig` block

#### Scenario: User sets only one or two of the three authentication variables

- **WHEN** the user runs `rayfin login` with one or two of `RAYFIN_AUTHORITY_HOST`, `RAYFIN_CLIENT_ID`, `RAYFIN_FABRIC_SCOPE` set (but not all three)
- **THEN** the CLI SHALL exit non-zero before performing any sign-in or network call
- **AND** the CLI SHALL print an error message that lists the missing authentication variable names and instructs the user to export either all three authentication overrides or none
- **AND** the CLI SHALL NOT modify `~/.rayfin/auth.json`
- **AND** the validation SHALL fail even when one or both endpoint variables (`RAYFIN_FABRIC_API_URL`, `RAYFIN_FABRIC_PORTAL_URL`) are also set

#### Scenario: User sets only an endpoint variable

- **GIVEN** none of the three authentication variables are set
- **WHEN** the user runs `rayfin login` with only `RAYFIN_FABRIC_API_URL` (or only `RAYFIN_FABRIC_PORTAL_URL`, or both endpoint variables) set
- **THEN** the CLI SHALL sign the user in against the built-in production authentication endpoints
- **AND** the CLI SHALL fetch Fabric resources using the supplied endpoint value(s)
- **AND** on successful sign-in the CLI SHALL persist the supplied endpoint value(s) into `~/.rayfin/auth.json` under the `environmentConfig` block

#### Scenario: User sets the full authentication group without any endpoint variables

- **GIVEN** the user has exported all three authentication variables but neither endpoint variable
- **WHEN** the user runs `rayfin login`
- **THEN** the CLI SHALL acquire the Fabric token using the supplied authentication overrides
- **AND** the CLI SHALL fetch Fabric resources using the built-in production endpoint defaults
- **AND** on successful sign-in the CLI SHALL persist only the three authentication sub-fields into `~/.rayfin/auth.json` under the `environmentConfig` block

#### Scenario: User sets none of the five environment variables

- **WHEN** the user runs `rayfin login` with none of the five `RAYFIN_*` environment variables set
- **AND** no `environmentConfig` block has been previously persisted via bootstrap
- **THEN** the CLI SHALL behave as it does today, signing the user into the built-in production environment
- **AND** the CLI SHALL NOT modify any existing `environmentConfig` block in `~/.rayfin/auth.json`

#### Scenario: rayfin login does not advertise CLI flags for environment overrides

- **WHEN** a user runs `rayfin login --help`
- **THEN** the five `RAYFIN_*` environment variables SHALL be the only documented configuration mechanism for environment overrides

### Requirement: Environment Configuration Resolution Precedence

The CLI SHALL resolve the five environment-config values (authority host, client ID, Fabric scope, Fabric API base URL, Fabric portal URL) using a fixed precedence so that an explicit shell-exported `RAYFIN_*` env var always wins over persisted state and persisted state always wins over built-in defaults.

**ID**: `CLI-ENV-CONFIG-RESOLUTION-001`

#### Scenario: Shell environment variable overrides persisted state

- **GIVEN** the user has a persisted `environmentConfig` with `clientId = A`
- **AND** the user has exported `RAYFIN_CLIENT_ID=B` in their shell
- **WHEN** the user runs any `rayfin` command
- **THEN** the CLI SHALL use `B` as the client ID for that invocation

#### Scenario: rayfin login persists the resolved env vars

- **GIVEN** the user has a persisted `environmentConfig` and exports a different complete set of `RAYFIN_*` env vars in the shell
- **WHEN** the user runs `rayfin login`
- **THEN** the new env-var values SHALL be used for the current sign-in
- **AND** the new values SHALL replace the persisted `environmentConfig` block after a successful sign-in

#### Scenario: Persisted state overrides built-in defaults

- **GIVEN** the user has a persisted `environmentConfig` with all five fields set
- **AND** no `RAYFIN_*` env vars are set in the shell
- **WHEN** the user runs `rayfin up`
- **THEN** the CLI SHALL use the persisted values for client ID, authority host, Fabric scope, Fabric API URL, and Fabric portal URL

#### Scenario: Built-in defaults used when nothing is persisted or overridden

- **GIVEN** `~/.rayfin/auth.json` does not contain an `environmentConfig` block
- **AND** no `RAYFIN_*` env vars are set in the shell
- **WHEN** the user runs any `rayfin` command
- **THEN** the CLI SHALL use the built-in PROD defaults for all five values
- **AND** behaviour SHALL be identical to the CLI prior to this change

### Requirement: Persisted Environment Configuration Schema

The CLI SHALL persist user-supplied environment configuration in `~/.rayfin/auth.json` under an optional `environmentConfig` field whose sub-fields are individually optional and forward-compatible.

**ID**: `CLI-ENV-CONFIG-PERSISTENCE-001`

#### Scenario: Older auth.json without environmentConfig block remains valid

- **GIVEN** an `~/.rayfin/auth.json` file written by an older CLI that has no `environmentConfig` field
- **WHEN** a newer CLI reads the file
- **THEN** the CLI SHALL load the existing fields without error
- **AND** the CLI SHALL treat the missing `environmentConfig` as "use defaults"

#### Scenario: Persisted file uses owner-only permissions

- **WHEN** the CLI writes `~/.rayfin/auth.json` after a login that supplied environment overrides
- **THEN** the file SHALL be created with mode `0o600` and the parent directory with mode `0o700`
- **AND** the persisted JSON SHALL contain the supplied `environmentConfig` sub-fields

#### Scenario: Future CLI ignores unknown environmentConfig sub-fields

- **GIVEN** an `~/.rayfin/auth.json` whose `environmentConfig` block contains additional unrecognised keys
- **WHEN** the CLI reads the file
- **THEN** the CLI SHALL ignore unknown sub-fields without erroring

### Requirement: Bootstrap Hydration Of process.env From Persisted State

Both CLI entry points SHALL hydrate `process.env` with the persisted `environmentConfig` values before parsing command-line arguments, so that downstream code that reads `RAYFIN_*` env vars (such as `getFabricSettings()` in `@microsoft/rayfin-tools-common`) automatically observes the user's selected environment.

**ID**: `CLI-ENV-CONFIG-BOOTSTRAP-001`

#### Scenario: Bootstrap runs before command parsing in rayfin CLI

- **GIVEN** the user has run `rayfin login` with environment overrides
- **WHEN** the user invokes any `rayfin` subcommand
- **THEN** the CLI SHALL hydrate `process.env.RAYFIN_AUTHORITY_HOST`, `RAYFIN_CLIENT_ID`, `RAYFIN_FABRIC_SCOPE`, `RAYFIN_FABRIC_API_URL`, and `RAYFIN_FABRIC_PORTAL_URL` from the persisted `environmentConfig` before any command handler runs
- **AND** the hydration SHALL only set env vars that are not already defined in the inherited shell environment

#### Scenario: Bootstrap runs before command parsing in create-rayfin

- **GIVEN** the user has run `rayfin login` with environment overrides using a globally-installed CLI
- **WHEN** the user runs `npm create @microsoft/rayfin@latest`
- **THEN** the `create-rayfin` wrapper SHALL hydrate the same `RAYFIN_*` env vars from `~/.rayfin/auth.json` before parsing command-line arguments
- **AND** the scaffold SHALL talk to the same Fabric environment used at login (when invoked with `--workspace-id` and `--item-id`)

#### Scenario: Bootstrap fails silently when persisted state is missing or unreadable

- **GIVEN** `~/.rayfin/auth.json` is missing, malformed, or unreadable
- **WHEN** the CLI starts up
- **THEN** the bootstrap SHALL NOT throw or print an error
- **AND** the CLI SHALL fall back to the existing precedence chain (env vars then built-in defaults)

#### Scenario: Bootstrap does not overwrite explicit shell env vars

- **GIVEN** the user has exported `RAYFIN_CLIENT_ID=X` in their shell
- **AND** the persisted `environmentConfig.clientId` is `Y`
- **WHEN** the CLI starts up
- **THEN** `process.env.RAYFIN_CLIENT_ID` SHALL remain `X` after bootstrap

### Requirement: rayfin up And rayfin init Inherit The Persisted Environment

`rayfin up` and `rayfin init` (including the `npm create @microsoft/rayfin@latest` invocation path) SHALL use the resolved environment configuration without requiring any command-specific flags.

**ID**: `CLI-ENV-CONFIG-DOWNSTREAM-001`

#### Scenario: rayfin up uses the resolved Fabric API URL

- **GIVEN** the user has signed in with all five `RAYFIN_*` env vars set, including `RAYFIN_FABRIC_API_URL=https://example.invalid/v1`
- **WHEN** the user runs `rayfin up` in a Rayfin project directory
- **THEN** the Fabric API client SHALL issue requests against the resolved Fabric API base URL
- **AND** the user SHALL NOT have to pass `--base-api-url` on every `rayfin up` invocation

#### Scenario: rayfin up uses the resolved Fabric portal URL

- **GIVEN** the user has signed in with all five `RAYFIN_*` env vars set, including `RAYFIN_FABRIC_PORTAL_URL=https://portal.example.invalid/`
- **WHEN** the user runs `rayfin up` in a Rayfin project directory
- **THEN** the deployment registry SHALL record the resolved portal URL as the artifact's `fabricPortalUrl`
- **AND** the scaffolded project's `RAYFIN_PUBLIC_PORTAL_URL` SHALL match the resolved portal URL

#### Scenario: rayfin up acquires tokens with the resolved client ID and scope

- **GIVEN** the user has signed in with all five `RAYFIN_*` env vars set, including `RAYFIN_CLIENT_ID` and `RAYFIN_FABRIC_SCOPE`
- **WHEN** the user runs `rayfin up`
- **THEN** the silent token acquisition SHALL use the resolved client ID and scope from `environmentConfig`

#### Scenario: rayfin init hydrates a freshly scaffolded project against the same environment

- **GIVEN** the user has signed in with all five environment overrides
- **WHEN** the user runs `npm create @microsoft/rayfin@latest <name> -- --workspace-id <id> --item-id <id>`
- **THEN** the scaffold SHALL fetch the BaaS endpoint and publishable key from the same Fabric environment used at login

### Requirement: Logout Clears Environment Configuration

The `rayfin logout` command SHALL remove the persisted `environmentConfig` block (along with the existing auth state) and SHALL clear the matching in-process environment variables so that a subsequent `rayfin login` starts from built-in defaults.

**ID**: `CLI-ENV-CONFIG-LOGOUT-001`

#### Scenario: Logout removes auth.json including environmentConfig

- **GIVEN** the user has signed in with environment overrides
- **WHEN** the user runs `rayfin logout`
- **THEN** the CLI SHALL delete `~/.rayfin/auth.json` (including the persisted `environmentConfig`) and `~/.rayfin/cache.bin`

#### Scenario: Logout clears in-process env vars set by bootstrap

- **GIVEN** the bootstrap helper has hydrated `process.env.RAYFIN_AUTHORITY_HOST`, `RAYFIN_CLIENT_ID`, `RAYFIN_FABRIC_SCOPE`, `RAYFIN_FABRIC_API_URL`, and `RAYFIN_FABRIC_PORTAL_URL` from persisted state during the same process invocation
- **WHEN** the user runs `rayfin logout`
- **THEN** the CLI SHALL remove those five entries from `process.env`

#### Scenario: Logout does not unset shell-exported env vars

- **GIVEN** the user has exported `RAYFIN_CLIENT_ID` in their shell prior to running the CLI
- **WHEN** the user runs `rayfin logout`
- **THEN** the next invocation of `rayfin` from the same shell SHALL still observe the user's exported `RAYFIN_CLIENT_ID`

#### Scenario: Logout when ambient RAYFIN_TOKEN is set is a no-op

- **GIVEN** `RAYFIN_TOKEN` is set in the environment
- **WHEN** the user runs `rayfin logout`
- **THEN** the CLI SHALL print an informational message and SHALL NOT delete `~/.rayfin/auth.json` (preserving the existing behaviour)

### Requirement: Login Status Surfaces The Resolved Fabric API Endpoint

`rayfin login status` SHALL display the resolved Fabric API base URL so a user can verify which environment they are signed into without the CLI naming any specific environment in source.

**ID**: `CLI-ENV-CONFIG-STATUS-001`

#### Scenario: Status shows the active endpoint after a custom-environment login

- **GIVEN** the user has signed in with all five `RAYFIN_*` env vars set, including `RAYFIN_FABRIC_API_URL=https://example.invalid/v1`
- **WHEN** the user runs `rayfin login status`
- **THEN** the output SHALL include a line of the form `Endpoint:  https://example.invalid/v1`

#### Scenario: Status shows the default endpoint when no overrides are persisted

- **GIVEN** the user has signed into PROD with no overrides
- **WHEN** the user runs `rayfin login status`
- **THEN** the `Endpoint` line SHALL show the built-in default Fabric API base URL

### Requirement: No Specific Environment Names Hardcoded In Source

The repository SHALL NOT contain any source-level reference to a specific non-production environment in the CLI, `create-rayfin`, or shared common packages introduced by this change.
Documentation and help text SHALL describe the override flags as generic environment-targeting knobs.

**ID**: `CLI-ENV-CONFIG-NEUTRAL-NAMING-001`

#### Scenario: Help and source text refer to "alternate environment" rather than a specific name

- **WHEN** a contributor reviews the source for the five hidden options or the resolver functions
- **THEN** option descriptions, JSDoc, and persisted-state documentation SHALL refer to "an alternate Fabric environment" or equivalent generic phrasing
- **AND** they SHALL NOT mention specific non-production environment names

#### Scenario: Built-in defaults remain the production values

- **WHEN** the CLI is invoked with no environment overrides anywhere in the precedence chain
- **THEN** the built-in defaults SHALL match the public production Fabric values (current `RAYFIN_CLIENT_ID`, `https://login.microsoftonline.com`, `https://api.fabric.microsoft.com/.default`, `https://api.fabric.microsoft.com/v1`, `https://app.fabric.microsoft.com/`)
