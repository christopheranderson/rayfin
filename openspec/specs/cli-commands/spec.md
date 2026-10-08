# Spec: CLI Commands

## Purpose

Define the command-line interface structure for the Rayfin CLI, organizing database, storage, and watch operations to clearly separate local development operations (`rayfin dev`) from remote deployment operations (`rayfin up`), eliminating confusion about target environments.

## Requirements

### Requirement: Database Command Structure

The CLI SHALL provide database configuration commands grouped under appropriate environment contexts to clearly distinguish between local development and remote deployment.

**ID**: `CLI-DB-COMMANDS-001`

#### Scenario: Local database operations

**Given** a user is developing an application locally
**When** they need to manage database configuration
**Then** they should use `rayfin dev db apply` command

- `rayfin dev db apply` - Generate and apply DAB configuration to local development server
- `rayfin dev db apply --gen-config-only` - Generate DAB configuration file from TypeScript decorators without applying

**And** these commands SHALL target `http://localhost:5168` by default
**And** the `--gen-config-only` flag SHALL skip the apply step and only generate configuration files

#### Scenario: Remote database operations

- **GIVEN** a user has deployed their application to Fabric via `rayfin up`
- **WHEN** they need to manage database configuration on the remote environment
- **THEN** they should use `rayfin up db` commands
- `rayfin up db apply` - Generate and apply DAB configuration to remote Rayfin item workload endpoint
- **AND** these commands SHALL target the remote endpoint configured in `rayfin.yml` at `deployment.rayfinItemEndpoint`
- **AND** these commands SHALL use the endpoint stored from a previous `rayfin up` deployment
- **AND** if only the legacy `deployment.containerAppEndpoint` field exists, the CLI SHALL warn that the deployment format is outdated and suggest running `rayfin up` to migrate

#### Scenario: Destructive schema changes require --force

- **GIVEN** a user runs `rayfin up db apply`
- **WHEN** the schema diff contains destructive changes (dropping columns, removing tables, changing column types that would lose data)
- **THEN** the apply SHALL fail by default with a clear listing of the destructive operations
- **AND** the CLI SHALL print guidance: `Use --force to apply destructive changes. This may result in data loss.`
- **AND** if `--force` is provided, the CLI SHALL proceed with the apply and display a warning
- **AND** non-destructive changes (adding columns, adding tables, adding entities) SHALL apply without requiring `--force`

### Requirement: Storage Command Structure

The CLI SHALL provide storage configuration commands grouped under appropriate environment contexts to clearly distinguish between local development and remote deployment, and SHALL expose those commands only when storage is visible for the current project context.

**ID**: `CLI-STORAGE-COMMANDS-001`

#### Scenario: Storage commands visible when project enables storage

- **GIVEN** a project configuration with storage enabled in `rayfin.yml`
- **WHEN** a user views available CLI commands or help output
- **THEN** the CLI SHALL expose storage commands without requiring `RAYFIN_FEATURE_FLAGS`

#### Scenario: Storage commands visible when feature flag is enabled from shell environment

- **GIVEN** the project does not enable storage in `rayfin.yml`
- **AND** the shell environment resolves `RAYFIN_FEATURE_FLAGS` to include `storage`
- **WHEN** a user views available CLI commands or help output
- **THEN** the CLI SHALL expose storage commands for the current invocation

#### Scenario: Storage commands visible when feature flag is enabled from rayfin/.env

- **GIVEN** the project does not enable storage in `rayfin.yml`
- **AND** the shell environment does not set `RAYFIN_FEATURE_FLAGS`
- **AND** `rayfin/.env` resolves `RAYFIN_FEATURE_FLAGS` to include `storage`
- **WHEN** a user views available CLI commands or help output
- **THEN** the CLI SHALL expose storage commands for the current invocation

#### Scenario: Storage commands hidden when neither config nor feature flag enables storage

- **GIVEN** the project does not enable storage in `rayfin.yml`
- **AND** resolved environment variables do not enable the `storage` feature
- **WHEN** a user views available CLI commands or help output
- **THEN** the CLI SHALL omit storage commands from command discovery surfaces

#### Scenario: Local storage operations

**Given** storage is visible for the current project context
**When** a user is developing an application locally and needs to manage storage configuration
**Then** they should use `rayfin dev storage apply` command

- `rayfin dev storage apply` - Generate and apply storage configuration to local development server
- `rayfin dev storage apply --gen-config-only` - Generate storage configuration file from TypeScript decorators without applying

**And** these commands SHALL target Azurite (local storage emulator) at `http://localhost:5168`
**And** the `--gen-config-only` flag SHALL skip the apply step and only generate configuration files

#### Scenario: Storage apply with force option

**Given** storage is visible for the current project context
**And** a user needs to apply storage configuration that may conflict with existing metadata
**When** they run `rayfin dev storage apply --force`
**Then** the configuration SHALL be accepted even if it may conflict with existing metadata
**And** the system SHALL display a warning about force mode being enabled

### Requirement: Watch Command Structure

The CLI SHALL provide a watch command under the dev context for local development file watching.

**ID**: `CLI-WATCH-COMMAND-001`

#### Scenario: Watch command for local development

**Given** a user is developing an application locally
**When** they want to automatically apply configuration changes as files are modified
**Then** they should use `rayfin dev watch`

**And** the command SHALL watch for changes in TypeScript source files
**And** the command SHALL automatically regenerate and apply database and storage configurations
**And** the command SHALL target the local development server only

#### Scenario: Watch command not available remotely

**Given** the remote deployment context
**When** a user views `rayfin up` commands
**Then** `watch` subcommand SHALL not be available
**And** watch functionality SHALL only be available in local development context

### Requirement: Command Context Separation

The CLI SHALL clearly separate local development operations from remote deployment operations through command structure, preventing accidental targeting of wrong environments.

**ID**: `CLI-CONTEXT-SEPARATION-001`

#### Scenario: Command path indicates target environment

**Given** a user wants to perform database or storage operations
**When** they view available commands
**Then** `rayfin dev` subcommands SHALL be clearly labeled for local development
**And** `rayfin up` subcommands SHALL be clearly labeled for remote deployment
**And** the command path itself SHALL indicate the target environment without requiring flags

#### Scenario: No remote flag needed

**Given** the reorganized command structure
**When** users run any database or storage command
**Then** the `--remote` flag SHALL not exist
**And** the target environment SHALL be determined by the command path (`dev` vs `up`)
**And** this SHALL prevent accidental targeting of wrong environments

### Requirement: Gen-Config Flag for Local Development

Configuration generation SHALL be available as a flag on apply commands for local development, allowing users to generate configuration without applying it.

**ID**: `CLI-GEN-CONFIG-001`

#### Scenario: Gen-config-only flag with dev commands

**Given** a user needs to generate configuration from TypeScript decorators without applying
**When** they run `rayfin dev db apply --gen-config-only` or `rayfin dev storage apply --gen-config-only`
**Then** the command SHALL scan local TypeScript files
**And** generate appropriate configuration files in `rayfin/.temp/`
**And** SHALL NOT apply the configuration to the local development server
**And** SHALL exit after generation is complete

#### Scenario: Normal apply includes generation

**Given** a user runs apply without the `--gen-config-only` flag
**When** they run `rayfin dev db apply` or `rayfin dev storage apply`
**Then** the command SHALL first generate configuration from TypeScript decorators
**And** then apply the generated configuration to the local development server

#### Scenario: Gen-config-only not available for remote commands

**Given** the remote deployment context operates on pre-generated configs
**When** a user runs `rayfin up db apply --gen-config-only`
**Then** the command SHALL reject the flag with an error
**And** SHALL inform the user that `--gen-config-only` is only available for local development (`rayfin dev`)
**And** SHALL suggest running `rayfin dev db apply --gen-config-only` locally first

> **Note**: TypeScript compilation requirements are detailed in the [TypeScript Compilation During Config Generation](#requirement-typescript-compilation-during-config-generation) section below.

### Requirement: Backward Compatibility Breaking

The command reorganization represents a breaking change that SHALL require migration from existing users with clear documentation and migration paths.

**ID**: `CLI-BREAKING-CHANGE-001`

#### Scenario: Old commands removed

**Given** the reorganized CLI structure
**When** a user tries to run legacy commands
**Then** `rayfin db` SHALL not be available as a top-level command
**And** `rayfin storage` SHALL not be available as a top-level command
**And** `rayfin watch` SHALL not be available as a top-level command
**And** users SHALL be directed to use the new command structure

#### Scenario: Migration path clear

**Given** a user familiar with old command structure
**When** they need to update their workflows
**Then** migration documentation SHALL clearly map old commands to new commands:

- `rayfin db apply` → `rayfin dev db apply`
- `rayfin db apply --remote` → `rayfin up db apply`
- `rayfin db gen-config` → `rayfin dev db apply --gen-config-only`
- `rayfin storage apply` → `rayfin dev storage apply`
- `rayfin storage gen-config` → `rayfin dev storage apply --gen-config-only`
- `rayfin watch` → `rayfin dev watch`

**And** release notes SHALL clearly indicate this is a breaking change

### Requirement: Local Development Environment Management

The system SHALL provide `rayfin dev` command to start, stop, and manage local Docker-based development environments with dynamic port allocation to support concurrent multi-project development.

**ID**: `REQ-CLI-DEV-ENV-001`

**Priority**: High

#### Scenario: Start development environment with dynamic port allocation

- **GIVEN** a Rayfin project initialized with `rayfin init`
- **WHEN** developer runs `rayfin dev`
- **THEN** the CLI SHALL allocate available ports for all services based on enabled profiles
- **AND** SHALL write port variables to `rayfin/.temp/.env`
- **AND** SHALL start Docker Compose with parameterized ports
- **AND** SHALL display service URLs with actual allocated ports
- **AND** SHALL display SQL Server connection string with actual allocated port

#### Scenario: Start second project while first is running

- **GIVEN** a first Rayfin project is running on default ports (5168, 1433, etc.)
- **WHEN** developer starts a second Rayfin project with `rayfin dev`
- **THEN** the CLI SHALL detect port conflicts
- **AND** SHALL increment from default ports until finding available ports
- **AND** SHALL start the second project successfully with different ports
- **AND** SHALL display the allocated ports for the second project

#### Scenario: Stop development environment and clean port variables

- **GIVEN** a running development environment with allocated ports in `.env`
- **WHEN** developer runs `rayfin dev --stop`
- **THEN** the CLI SHALL stop all Docker containers
- **AND** SHALL remove all `RAYFIN_*_PORT` variables from `rayfin/.temp/.env`
- **AND** SHALL preserve non-port variables (publishable key, service enable flags)

#### Scenario: Purge development environment and clean port variables

- **GIVEN** a running development environment with allocated ports in `.env`
- **WHEN** developer runs `rayfin dev --purge`
- **THEN** the CLI SHALL stop all Docker containers
- **AND** SHALL remove all volumes
- **AND** SHALL remove all `RAYFIN_*_PORT` variables from `rayfin/.temp/.env`
- **AND** SHALL preserve non-port variables (publishable key, service enable flags)

#### Scenario: Export environment variables

- **GIVEN** a running development environment with allocated ports
- **WHEN** developer runs `rayfin dev --export-env`
- **THEN** the CLI SHALL read all variables from `rayfin/.temp/.env`
- **AND** SHALL print variables to stdout in `.env` format without comments
- **AND** SHALL allow redirection to user's `.env` file (e.g., `rayfin dev --export-env > .env`)

#### Scenario: CLI utilities connect to dynamic WebService port

- **GIVEN** a development environment running with WebService on port 5170 (not default 5168)
- **WHEN** developer runs `rayfin dev db apply`
- **THEN** the CLI SHALL read `RAYFIN_WEBSERVICE_HTTP_PORT` from `rayfin/.temp/.env`
- **AND** SHALL construct endpoint URL as `http://localhost:5170/api/applyconfig`
- **AND** SHALL successfully apply configuration to the running WebService

### Requirement: Dynamic Port Allocation

The system SHALL dynamically allocate ports for Docker services based on availability to prevent conflicts when running multiple Rayfin projects concurrently.

**ID**: `REQ-CLI-DEV-PORT-001`

**Priority**: High

#### Scenario: Allocate ports only for enabled services

- **GIVEN** a project with only `data` service enabled in `rayfin.yml`
- **WHEN** `rayfin dev` starts the environment
- **THEN** the CLI SHALL allocate ports only for WebService and SQL Server
- **AND** SHALL NOT allocate ports for Azurite, Functions, or Aspire Dashboard
- **AND** SHALL NOT write unused port variables to `.env`

#### Scenario: Sequential port allocation for multi-port services

- **GIVEN** Azurite service requires 3 ports (blob, queue, table)
- **WHEN** default port 10000 is available but 10001 is occupied
- **THEN** the CLI SHALL allocate 10000, 10002, 10003 for blob, queue, table respectively
- **AND** SHALL ensure all three ports are available before starting service

#### Scenario: Port availability check before allocation

- **GIVEN** WebService default HTTP port 5168 is occupied
- **WHEN** `rayfin dev` performs port allocation
- **THEN** the CLI SHALL attempt to bind to port 5168
- **AND** SHALL detect the port is unavailable
- **AND** SHALL increment to 5169, 5170, etc. until finding an available port
- **AND** SHALL write the allocated port to `.env` as `RAYFIN_WEBSERVICE_HTTP_PORT`

### Requirement: Port Variable Management

The system SHALL manage port-related environment variables in `rayfin/.temp/.env` throughout the development lifecycle.

**ID**: `REQ-CLI-DEV-PORT-002`

**Priority**: High

#### Scenario: Write port variables on startup

- **GIVEN** `rayfin dev` has allocated ports for enabled services
- **WHEN** writing environment variables to `.env`
- **THEN** the CLI SHALL write all allocated ports with `RAYFIN_*_PORT` naming convention
- **AND** SHALL preserve existing non-port variables
- **AND** SHALL use standard `.env` format without comments

#### Scenario: Clean port variables on stop

- **GIVEN** a `.env` file containing port variables and other variables
- **WHEN** `rayfin dev --stop` is executed
- **THEN** the CLI SHALL remove all variables matching pattern `RAYFIN_*_PORT`
- **AND** SHALL preserve `Auth__Enabled`, `Data__Enabled`, `Storage__Enabled`
- **AND** SHALL preserve `PUBLISHABLE_KEY`

#### Scenario: Export environment for application integration

- **GIVEN** allocated ports in `rayfin/.temp/.env`
- **WHEN** developer runs `rayfin dev --export-env`
- **THEN** the CLI SHALL output all variables in `.env` format
- **AND** SHALL NOT include comments or header text
- **AND** SHALL output to stdout for shell redirection
- **AND** SHALL include format: `KEY=VALUE\n` for each variable

### Requirement: Dynamic Service URLs

The system SHALL display service URLs and connection strings using actual allocated ports from `.env` file.

**ID**: `REQ-CLI-DEV-PORT-003`

**Priority**: Medium

#### Scenario: Display WebService URL with allocated port

- **GIVEN** WebService is running on allocated port 5170
- **WHEN** `rayfin dev status` displays service information
- **THEN** the CLI SHALL read `RAYFIN_WEBSERVICE_HTTP_PORT` from `.env`
- **AND** SHALL display `🌐 Rayfin Backend URL: http://localhost:5170`

#### Scenario: Display database connection strings

- **GIVEN** SQL Server is running on allocated port 1434
- **AND** PostgreSQL is running on allocated port 5433
- **WHEN** `rayfin dev status` displays service information
- **THEN** the CLI SHALL display a "Connection strings:" section header
- **AND** SHALL read `RAYFIN_POSTGRES_PORT` from `.env`
- **AND** SHALL display `> PostgreSQL: Host=localhost;Port=5433;Database=rayfindb;Username=rayfinuser;Password=YourStrong!Passw0rd;`
- **AND** SHALL read `RAYFIN_SQLSERVER_PORT` from `.env`
- **AND** SHALL display `> SQL Server: Server=localhost,1434;User Id=sa;Password=YourStrong!Passw0rd;TrustServerCertificate=True;`

#### Scenario: CLI utilities use dynamic ports

- **GIVEN** WebService running on non-default port from `.env`
- **WHEN** any CLI utility needs to connect to WebService
- **THEN** the utility SHALL read `RAYFIN_WEBSERVICE_HTTP_PORT` from `rayfin/.temp/.env`
- **AND** SHALL construct the endpoint URL using the allocated port
- **AND** SHALL NOT use hardcoded port 5168

### Requirement: Docker Compose Configuration

The system SHALL generate Docker Compose configurations that support project-specific container naming and parameterized port bindings.

**ID**: `REQ-CLI-DOCKER-001`

**Priority**: High

#### Scenario: Generate compose file without hardcoded container names

- **GIVEN** `rayfin init` creates a new project
- **WHEN** `docker-compose.yml` is generated
- **THEN** the file SHALL NOT contain any `container_name` directives
- **AND** SHALL allow Docker Compose to auto-generate names based on project name
- **AND** SHALL prevent container name conflicts between projects

#### Scenario: Generate compose file with parameterized ports

- **GIVEN** `docker-compose.yml` is generated for a project
- **WHEN** examining the port bindings
- **THEN** all host ports SHALL use environment variable syntax (e.g., `${RAYFIN_WEBSERVICE_HTTP_PORT}:8080`)
- **AND** SHALL NOT contain hardcoded host ports
- **AND** SHALL support dynamic port allocation from `.env` file

### Requirement: Development Environment Status Command

The CLI SHALL provide a `rayfin dev status` command that displays the current state of the local development environment, including container health, service ports, connection strings, and publishable key.

**ID**: `REQ-CLI-DEV-STATUS-001`

**Priority**: High

#### Scenario: Display comprehensive environment status

- **GIVEN** a running Rayfin development environment
- **WHEN** developer runs `rayfin dev status`
- **THEN** the CLI SHALL display:
  - Enabled services from `rayfin.yml` in multiline format (e.g., "auth: enabled")
  - Container status table for all services (name, status, health, ports)
  - Rayfin Backend URL with allocated port (e.g., "<http://localhost:5168>")
  - Connection strings section header (if data or storage services enabled)
  - PostgreSQL connection string with allocated port (if data service enabled)
  - SQL Server connection string with allocated port (if data service enabled)
  - Azurite Blob endpoint URL with allocated port (if storage service enabled)
  - Publishable key (if auth service enabled)
- **AND** SHALL exit with code 0 if all running containers are healthy

#### Scenario: Display status when no containers are running

- **GIVEN** no Rayfin development environment is running
- **WHEN** developer runs `rayfin dev status`
- **THEN** the CLI SHALL display message "No containers are running"
- **AND** SHALL suggest running `rayfin dev` to start the environment
- **AND** SHALL exit with code 1

#### Scenario: Display status when .env file is missing

- **GIVEN** no `rayfin/.temp/.env` file exists
- **WHEN** developer runs `rayfin dev status`
- **THEN** the CLI SHALL treat this as "no containers running"
- **AND** SHALL display message "No containers are running"
- **AND** SHALL suggest running `rayfin dev` to start the environment
- **AND** SHALL exit with code 1

#### Scenario: Display status when containers are unhealthy

- **GIVEN** at least one container is running but has unhealthy status
- **WHEN** developer runs `rayfin dev status`
- **THEN** the CLI SHALL display all container statuses
- **AND** SHALL highlight unhealthy containers with warning indicators
- **AND** SHALL suggest waiting or restarting the environment
- **AND** SHALL exit with code 2

#### Scenario: Display enabled services from rayfin.yml

- **GIVEN** a `rayfin.yml` with `auth: enabled: true`, `data: enabled: false`, `storage: enabled: true`
- **WHEN** developer runs `rayfin dev status`
- **THEN** the CLI SHALL read the `rayfin.yml` configuration
- **AND** SHALL display in multiline format:

  ```text
  Services:
      auth: enabled
      storage: enabled
  ```

- **AND** SHALL NOT display data as enabled

### Requirement: Port Reading from Environment File

The CLI SHALL read dynamically allocated ports from `rayfin/.temp/.env` for all services to display accurate connection information.

**ID**: `REQ-CLI-DEV-STATUS-PORTS-001`

**Priority**: High

#### Scenario: Read WebService port from .env

- **GIVEN** `rayfin/.temp/.env` contains `RAYFIN_WEBSERVICE_HTTP_PORT=5170`
- **WHEN** developer runs `rayfin dev status`
- **THEN** the CLI SHALL read the port from .env
- **AND** SHALL display `🌐 Rayfin Backend URL: http://localhost:5170`

#### Scenario: Read SQL Server port from .env

- **GIVEN** `rayfin/.temp/.env` contains `RAYFIN_SQLSERVER_PORT=1434`
- **WHEN** developer runs `rayfin dev status`
- **THEN** the CLI SHALL read the port from .env
- **AND** SHALL display connection string with port 1434

#### Scenario: Read PostgreSQL port from .env

- **GIVEN** `rayfin/.temp/.env` contains `RAYFIN_POSTGRES_PORT=5433`
- **WHEN** developer runs `rayfin dev status`
- **THEN** the CLI SHALL read the port from .env
- **AND** SHALL display connection string with port 5433

#### Scenario: Read Azurite blob port from .env

- **GIVEN** `rayfin/.temp/.env` contains `RAYFIN_AZURITE_BLOB_PORT=10003`
- **WHEN** developer runs `rayfin dev status`
- **THEN** the CLI SHALL read the blob port from .env
- **AND** SHALL display `Azurite (Blob)` with port 10003 in the status table
- **AND** SHALL display `> Azurite Blob: http://127.0.0.1:10003/devstoreaccount1` in the connection strings section

#### Scenario: Error when .env variables missing

- **GIVEN** `rayfin/.temp/.env` exists but does not contain `RAYFIN_WEBSERVICE_HTTP_PORT`
- **WHEN** developer runs `rayfin dev status`
- **THEN** the CLI SHALL display error message "Port configuration not found in .env"
- **AND** SHALL suggest running `rayfin dev` to regenerate the environment
- **AND** SHALL exit with code 1

### Requirement: Container Health Status Display

The CLI SHALL query Docker container health status and display it clearly for each service.

**ID**: `REQ-CLI-DEV-STATUS-HEALTH-001`

**Priority**: High

#### Scenario: Display healthy container status

- **GIVEN** all containers report health status "healthy"
- **WHEN** developer runs `rayfin dev status`
- **THEN** the CLI SHALL display each container with "healthy" status
- **AND** SHALL use text-based visual indicators (e.g., "healthy" text)

#### Scenario: Display unhealthy container status

- **GIVEN** SQL Server container reports health status "unhealthy"
- **WHEN** developer runs `rayfin dev status`
- **THEN** the CLI SHALL display SQL Server with "unhealthy" status
- **AND** SHALL use text-based visual indicators (e.g., "unhealthy" text)
- **AND** SHALL exit with code 2

#### Scenario: Display starting container status

- **GIVEN** WebService container reports health status "starting"
- **WHEN** developer runs `rayfin dev status`
- **THEN** the CLI SHALL display WebService with "starting" status
- **AND** SHALL use text-based visual indicators (e.g., "starting" text)
- **AND** SHALL exit with code 2 (not fully healthy)

#### Scenario: Display containers without health checks

- **GIVEN** a container is running but has no health check defined
- **WHEN** developer runs `rayfin dev status`
- **THEN** the CLI SHALL display the container status as "running"
- **AND** SHALL display health as "n/a" or empty
- **AND** SHALL NOT treat missing health check as unhealthy (exit code 0)

### Requirement: Publishable Key Display

The CLI SHALL display the publishable key from the development environment when the auth service is enabled.

**ID**: `REQ-CLI-DEV-STATUS-PUBKEY-001`

**Priority**: High

#### Scenario: Display publishable key when auth enabled

- **GIVEN** auth service is enabled in `rayfin.yml`
- **AND** `rayfin/.temp/.env` contains `RAYFIN_PUBLISHABLE_KEY=pk_dev_1234567890abcdef`
- **WHEN** developer runs `rayfin dev status`
- **THEN** the CLI SHALL display an Authentication section
- **AND** SHALL display `> Publishable Key: pk_dev_1234567890abcdef`

#### Scenario: No publishable key section when auth disabled

- **GIVEN** auth service is disabled in `rayfin.yml`
- **WHEN** developer runs `rayfin dev status`
- **THEN** the CLI SHALL NOT display an Authentication section
- **AND** SHALL NOT attempt to read publishable key from .env

#### Scenario: Error when publishable key missing but auth enabled

- **GIVEN** auth service is enabled in `rayfin.yml`
- **AND** `rayfin/.temp/.env` does not contain `RAYFIN_PUBLISHABLE_KEY`
- **WHEN** developer runs `rayfin dev status`
- **THEN** the CLI SHALL display warning "Publishable key not found in .env"
- **AND** SHALL suggest running `rayfin dev` to regenerate the environment
- **AND** SHALL still display other status information
- **AND** SHALL exit with code 0 (warning, not error)

### Requirement: rayfin dev Command Options

The `rayfin dev` command SHALL accept an `--env-file <path>` option to specify a custom .env file for rayfin.yml interpolation.

**ID**: `CLI-DEV-ENV-001` (extends existing CLI-DEV-* requirements)

**Changes**: Adds new CLI option for environment variable file specification.

#### Scenario: Run dev with custom env file

- **GIVEN** a builder has `.env.development` in their project
- **WHEN** they run `rayfin dev --env-file .env.development`
- **THEN** the CLI SHALL load environment variables from `.env.development`
- **AND** use them for rayfin.yml interpolation
- **AND** start the development environment as normal

#### Scenario: Help text documents env-file option

- **WHEN** a builder runs `rayfin dev --help`
- **THEN** the help output SHALL include `--env-file <path>` option
- **AND** describe it as "Path to .env file for configuration interpolation"

#### Scenario: Dev subcommands inherit env-file option

- **GIVEN** a builder has `.env.development` in their project
- **WHEN** they run `rayfin dev db apply --env-file .env.development`
- **THEN** the CLI SHALL load environment variables from `.env.development`
- **AND** use them for rayfin.yml interpolation in the database configuration

#### Scenario: Nested subcommands support env-file

- **GIVEN** nested command structure like `rayfin dev db apply`
- **WHEN** a builder runs with `--env-file` option
- **THEN** the option SHALL be accessible to all command levels in the hierarchy
- **AND** work correctly for commands like `dev db apply`, `dev storage apply`, `dev status`, and `dev watch`

#### Scenario: Absolute paths supported for env-file

- **GIVEN** a builder has an env file at `/path/to/project/.env.custom`
- **WHEN** they run `rayfin dev --env-file /path/to/project/.env.custom`
- **THEN** the CLI SHALL load variables from the absolute path
- **AND** not attempt to resolve it relative to the project root

### Requirement: rayfin up Command Options

The `rayfin up` command SHALL accept an `--env-file <path>` option to specify a custom .env file for rayfin.yml interpolation.

**ID**: `CLI-UP-OPTIONS-001`

#### Scenario: Custom env file for deployment

- **GIVEN** a builder has a custom .env file at `.env.production`
- **WHEN** they run `rayfin up --env-file .env.production`
- **THEN** the CLI SHALL use `.env.production` for rayfin.yml variable interpolation

#### Scenario: Help text shows all options

- **WHEN** a builder runs `rayfin up --help`
- **THEN** the help text SHALL list `--env-file <path>` with description
- **AND** the help text SHALL list `--json` with description "Output deployment result as JSON"
- **AND** the help text SHALL list `--workspace-id <id>`, `--force`, `--dry-run`, and `--verbose`

#### Scenario: JSON flag in help for subcommands

- **WHEN** a builder runs `rayfin up db apply --help`
- **THEN** the help text SHALL list `--json` with description "Output result as JSON"
- **WHEN** a builder runs `rayfin up staticapp deploy --help`
- **THEN** the help text SHALL list `--json` with description "Output result as JSON"

### Requirement: TypeScript Compilation During Config Generation

The CLI SHALL compile the `./rayfin` directory using TypeScript before generating DAB or storage configuration to ensure type-checked entity definitions.

This requirement covers the automatic TypeScript compilation process that occurs before configuration generation, including tsconfig.json management and error handling.

**ID**: `CLI-TS-COMPILE-001`

**Priority**: Medium

#### Scenario: Compile TypeScript before DAB config generation

- **GIVEN** a Rayfin project with TypeScript entity definitions in `./rayfin/data`
- **WHEN** developer runs `rayfin dev db apply` or `rayfin dev db apply --gen-config-only`
- **THEN** the CLI SHALL compile TypeScript files in `./rayfin` directory using `tsc`
- **AND** SHALL output compiled JavaScript to `./rayfin/.temp/compiled`
- **AND** SHALL proceed with config generation only if compilation succeeds
- **AND** SHALL display clear error messages if TypeScript compilation fails

#### Scenario: Compile TypeScript before storage config generation

- **GIVEN** a Rayfin project with TypeScript storage definitions in `./rayfin/storage`
- **WHEN** developer runs `rayfin dev storage apply` or `rayfin dev storage apply --gen-config-only`
- **THEN** the CLI SHALL compile TypeScript files in `./rayfin` directory using `tsc`
- **AND** SHALL output compiled JavaScript to `./rayfin/.temp/compiled`
- **AND** SHALL proceed with config generation only if compilation succeeds
- **AND** SHALL display clear error messages if TypeScript compilation fails

#### Scenario: Compilation errors prevent config generation

- **GIVEN** TypeScript entity definitions contain syntax or type errors
- **WHEN** developer runs `rayfin dev db apply` or `rayfin dev storage apply`
- **THEN** the CLI SHALL run TypeScript compilation
- **AND** SHALL detect compilation errors
- **AND** SHALL display TypeScript diagnostic messages with file paths and line numbers
- **AND** SHALL exit with non-zero status code
- **AND** SHALL NOT proceed with configuration generation

#### Scenario: Auto-generate tsconfig.json if missing

- **GIVEN** a Rayfin project without `./rayfin/tsconfig.json`
- **WHEN** developer runs `rayfin dev db apply` or `rayfin dev storage apply`
- **THEN** the CLI SHALL detect missing `tsconfig.json`
- **AND** SHALL create default `tsconfig.json` in `./rayfin` directory
- **AND** SHALL log message indicating tsconfig.json was created
- **AND** SHALL proceed with TypeScript compilation using the generated config

#### Scenario: Use existing tsconfig.json if present

- **GIVEN** a Rayfin project with custom `./rayfin/tsconfig.json`
- **WHEN** developer runs config generation commands
- **THEN** the CLI SHALL use the existing `tsconfig.json` settings
- **AND** SHALL NOT overwrite or modify the existing file
- **AND** SHALL respect custom compiler options specified by the developer

### Requirement: TypeScript Compilation Output Location

Compiled TypeScript output SHALL be written to `./rayfin/.temp/compiled` and properly git-ignored to avoid committing generated artifacts.

**ID**: `CLI-TS-COMPILE-002`

**Priority**: Medium

#### Scenario: Compiled output in .temp directory

- **GIVEN** TypeScript compilation is running
- **WHEN** compilation completes successfully
- **THEN** the CLI SHALL output compiled JavaScript files to `./rayfin/.temp/compiled`
- **AND** SHALL preserve directory structure (`data/`, `storage/` subdirectories)
- **AND** SHALL include all compiled `.js` files

#### Scenario: Compiled output is git-ignored

- **GIVEN** a Rayfin project created with `rayfin init`
- **THEN** the `.gitignore` file SHALL include `rayfin/.temp/` pattern
- **AND** SHALL prevent `./rayfin/.temp/compiled/` from being committed to version control

### Requirement: Compilation Performance

TypeScript compilation SHALL complete quickly to maintain developer productivity during the config generation workflow.

**ID**: `CLI-TS-COMPILE-003`

**Priority**: Low

#### Scenario: Fast compilation for typical projects

- **GIVEN** a Rayfin project with 10-20 entity definition files
- **WHEN** developer runs config generation commands
- **THEN** TypeScript compilation SHALL complete in less than 2 seconds
- **AND** SHALL not significantly impact overall config generation time

#### Scenario: Compilation progress feedback

- **GIVEN** TypeScript compilation is in progress
- **WHEN** compilation is running
- **THEN** the CLI SHALL display status indicator (e.g., "Compiling TypeScript...")
- **AND** SHALL provide feedback when compilation succeeds or fails
