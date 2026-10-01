# CLI Commands - Spec Deltas

## Purpose

This specification defines the dynamic port allocation and local development environment management capabilities for the Rayfin CLI.
It enables developers to run multiple Rayfin projects concurrently without port conflicts by automatically allocating available ports and managing environment configuration.
Additionally, it defines how sample applications automatically configure their environment to connect to the running Rayfin backend using dynamically allocated ports.

## Requirements

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
- **WHEN** `rayfin dev` displays service information
- **THEN** the CLI SHALL read `RAYFIN_WEBSERVICE_HTTP_PORT` from `.env`
- **AND** SHALL display `> Web Service: http://localhost:5170`

#### Scenario: Display SQL Server connection string

- **GIVEN** SQL Server is running on allocated port 1434
- **WHEN** `rayfin dev` displays service information
- **THEN** the CLI SHALL read `RAYFIN_SQLSERVER_PORT` from `.env`
- **AND** SHALL display `> SQL Connection: Server=localhost,1434;User Id=sa;Password=YourStrong!Passw0rd;TrustServerCertificate=True;`
- **AND** SHALL include the connection string in service output

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

### Requirement: Sample Application Environment Configuration

Sample applications SHALL automatically configure their local environment to connect to the running Rayfin backend using dynamically allocated ports.

**ID**: `REQ-SAMPLE-ENV-001`

**Priority**: Medium

#### Scenario: Generate .env.local from rayfin/.temp/.env

- **GIVEN** a sample application (e.g., `todo-app`)
- **AND** a running Rayfin backend that has generated `rayfin/.temp/.env` with `RAYFIN_WEBSERVICE_HTTP_PORT=5168`
- **WHEN** the user runs `npm run dev`
- **THEN** a `.env.local` file SHALL be created (or updated) in the project root
- **AND** it SHALL contain `VITE_RAYFIN_API_URL=http://localhost:5168`
- **AND** the Vite development server SHALL start using this configuration

#### Scenario: Handle missing rayfin/.temp/.env

- **GIVEN** a sample application
- **AND** the Rayfin backend has NOT been started (no `rayfin/.temp/.env` file)
- **WHEN** the user runs `npm run dev`
- **THEN** the script SHALL warn the user that the backend configuration was not found
- **AND** it SHALL NOT fail the build/start process (allowing mock mode or default fallback)
- **AND** it SHALL skip creating `.env.local`

#### Scenario: Preserve existing .env.local content

- **GIVEN** an existing `.env.local` with other custom variables (e.g., `CUSTOM_VAR=value`)
- **WHEN** the user runs `npm run dev`
- **THEN** the script SHALL preserve all other variables
- **AND** SHALL ONLY update the `VITE_RAYFIN_API_URL` variable if it exists
- **AND** SHALL add the `VITE_RAYFIN_API_URL` variable if it doesn't exist
- **AND** the resulting `.env.local` SHALL contain both the original variables and the updated `VITE_RAYFIN_API_URL`
