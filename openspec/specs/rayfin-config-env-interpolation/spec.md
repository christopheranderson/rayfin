# rayfin-config-env-interpolation Specification

## Purpose

Enable Builders to externalize environment-specific configuration from `rayfin.yml` using Docker Compose-style variable interpolation, supporting development, staging, and production environments through `.env` files without duplicating configuration or hard-coding sensitive values.

## Requirements

### Requirement: Environment Variable Interpolation Syntax

The Rayfin CLI SHALL support Docker Compose-style environment variable interpolation in all string values within `rayfin.yml` configuration files using `${VARIABLE}` and `${VARIABLE:-default}` syntax.

**ID**: `ENV-INTERP-001`

**Rationale**: Builders need to manage environment-specific configuration across different deployment contexts without hard-coding sensitive values or maintaining duplicate configuration files.

#### Scenario: Simple variable substitution

- **GIVEN** a `.env` file contains `AUTH_ISSUER=https://auth.example.com`
- **AND** `rayfin.yml` contains `issuer: ${AUTH_ISSUER}`
- **WHEN** the CLI loads the configuration
- **THEN** the resolved configuration SHALL have `issuer: "https://auth.example.com"`

#### Scenario: Variable with default value

- **GIVEN** no environment variable or .env file defines `DB_PORT`
- **AND** `rayfin.yml` contains `port: ${DB_PORT:-5432}`
- **WHEN** the CLI loads the configuration
- **THEN** the resolved configuration SHALL have `port: 5432` (using the default value)

#### Scenario: Partial string interpolation

- **GIVEN** a `.env` file contains `DOMAIN=example.com`
- **AND** `rayfin.yml` contains `connectionString: "Server=${DOMAIN};Port=5432"`
- **WHEN** the CLI loads the configuration
- **THEN** the resolved configuration SHALL have `connectionString: "Server=example.com;Port=5432"`

#### Scenario: Multiple variables in one value

- **GIVEN** `.env` contains `HOST=db.local` and `DB_NAME=todos`
- **AND** `rayfin.yml` contains `connectionString: "Server=${HOST};Database=${DB_NAME}"`
- **WHEN** the CLI loads the configuration
- **THEN** the resolved configuration SHALL have `connectionString: "Server=db.local;Database=todos"`

#### Scenario: Nested object interpolation

- **GIVEN** `.env` contains `SMTP_HOST=mail.local`
- **AND** `rayfin.yml` contains nested config with `services.auth.email.smtp.host: ${SMTP_HOST}`
- **WHEN** the CLI loads the configuration
- **THEN** the interpolation SHALL work at any nesting level within the configuration

### Requirement: Environment Variable Resolution Priority

The Rayfin CLI SHALL resolve environment variables using the following priority order (highest to lowest): shell environment variables, then .env file variables.

**ID**: `ENV-INTERP-002`

**Rationale**: Allows runtime overrides via shell environment while providing local defaults via .env files, following Docker Compose conventions.

#### Scenario: Shell environment overrides .env file

- **GIVEN** `.env` file contains `PORT=3000`
- **AND** shell environment has `PORT=8080` exported
- **AND** `rayfin.yml` contains `port: ${PORT}`
- **WHEN** the CLI loads the configuration
- **THEN** the resolved value SHALL be `port: 8080` (from shell, not .env)

#### Scenario: .env file used when shell environment unset

- **GIVEN** `.env` file contains `API_KEY=local-dev-key`
- **AND** shell environment does not have `API_KEY` set
- **AND** `rayfin.yml` contains `key: ${API_KEY}`
- **WHEN** the CLI loads the configuration
- **THEN** the resolved value SHALL be `key: "local-dev-key"` (from .env file)

### Requirement: Missing Variable Error Handling

The Rayfin CLI SHALL fail with a clear error message when a referenced environment variable is not defined in either shell environment or .env file and no default value is provided.

**ID**: `ENV-INTERP-003`

**Rationale**: Fail fast with actionable feedback to prevent runtime errors or misconfiguration.

#### Scenario: Missing required variable

- **GIVEN** no environment variable or .env file defines `DB_HOST`
- **AND** `rayfin.yml` contains `host: ${DB_HOST}` (no default)
- **WHEN** the CLI attempts to load the configuration
- **THEN** the CLI SHALL exit with a non-zero code
- **AND** the error message SHALL include the variable name `DB_HOST`
- **AND** the error message SHALL include the location in rayfin.yml (e.g., `services.data.host`)
- **AND** the error message SHALL suggest remediation (e.g., "Set it in .env file or shell environment")

#### Scenario: Multiple missing variables

- **GIVEN** `rayfin.yml` references `${VAR1}` and `${VAR2}` both undefined
- **WHEN** the CLI attempts to load the configuration
- **THEN** the error message SHALL list all missing variables
- **OR** the CLI MAY fail on the first missing variable encountered (implementation choice)

### Requirement: .env File Location and Discovery

The Rayfin CLI SHALL search for environment variable definitions in a `.env` file located in the `rayfin/` directory by default, with support for custom absolute paths via CLI argument or environment variable.

**ID**: `ENV-INTERP-004`

**Rationale**: Colocates environment configuration with rayfin.yml while allowing flexibility for CI/CD and custom project structures.

#### Scenario: Default .env file location

- **GIVEN** a project has `rayfin/.env` file with `KEY=value`
- **AND** no `--env-file` argument is provided
- **AND** `RAYFIN_ENV_FILE` environment variable is not set
- **WHEN** the CLI loads configuration
- **THEN** the CLI SHALL read variables from `rayfin/.env`

#### Scenario: Custom .env file via CLI argument

- **GIVEN** a project has `.env.production` in the project root
- **AND** the user runs `rayfin dev --env-file .env.production`
- **WHEN** the CLI loads configuration
- **THEN** the CLI SHALL read variables from `.env.production` instead of `rayfin/.env`

#### Scenario: Custom .env file via environment variable

- **GIVEN** a project has `config/custom.env` file
- **AND** shell environment has `RAYFIN_ENV_FILE=config/custom.env` exported
- **AND** no `--env-file` argument is provided
- **WHEN** the CLI loads configuration
- **THEN** the CLI SHALL read variables from `config/custom.env`

#### Scenario: CLI argument precedence over environment variable

- **GIVEN** shell environment has `RAYFIN_ENV_FILE=config/env1.env`
- **AND** user runs `rayfin dev --env-file config/env2.env`
- **WHEN** the CLI loads configuration
- **THEN** the CLI SHALL use `config/env2.env` (CLI argument wins)

#### Scenario: Missing .env file is not an error

- **GIVEN** no `.env` file exists at the default or specified location
- **WHEN** the CLI loads configuration
- **THEN** the CLI SHALL continue without error
- **AND** only shell environment variables SHALL be available for interpolation

### Requirement: Type Preservation After Interpolation

The Rayfin CLI SHALL attempt to preserve YAML type semantics (numbers, booleans, null) when substituting environment variable values, falling back to string types when coercion fails.

**ID**: `ENV-INTERP-005`

**Rationale**: Maintains YAML's type system so numeric ports, boolean flags, and null values work as expected without explicit casting.

#### Scenario: Numeric value interpolation

- **GIVEN** `.env` contains `PORT=5432`
- **AND** `rayfin.yml` contains `port: ${PORT}`
- **WHEN** the CLI loads the configuration
- **THEN** the resolved value SHALL be `port: 5432` (number type, not string "5432")

#### Scenario: Boolean value interpolation

- **GIVEN** `.env` contains `ENABLED=true`
- **AND** `rayfin.yml` contains `enabled: ${ENABLED}`
- **WHEN** the CLI loads the configuration
- **THEN** the resolved value SHALL be `enabled: true` (boolean type, not string "true")

#### Scenario: Default value type coercion

- **GIVEN** no environment defines `TIMEOUT`
- **AND** `rayfin.yml` contains `timeout: ${TIMEOUT:-30}`
- **WHEN** the CLI loads the configuration
- **THEN** the resolved value SHALL be `timeout: 30` (number type from default)

#### Scenario: String fallback for non-coercible values

- **GIVEN** `.env` contains `NAME=my-app-123`
- **AND** `rayfin.yml` contains `name: ${NAME}`
- **WHEN** the CLI loads the configuration
- **THEN** the resolved value SHALL be `name: "my-app-123"` (string type)

### Requirement: .env File Format Compatibility

The Rayfin CLI SHALL parse `.env` files using standard dotenv format conventions, supporting comments, quoted values, and empty values, but SHALL NOT expand variables within the .env file itself.

**ID**: `ENV-INTERP-006`

**Rationale**: Follows Node.js ecosystem standards via `dotenv` library while keeping .env files simple (literal values only, no recursive expansion).

#### Scenario: Comments and empty lines

- **GIVEN** a `.env` file contains:

  ```bash
  # This is a comment
  KEY1=value1

  KEY2=value2
  ```

- **WHEN** the CLI loads the .env file
- **THEN** comments and empty lines SHALL be ignored
- **AND** `KEY1` and `KEY2` SHALL be available for interpolation

#### Scenario: Quoted values with spaces

- **GIVEN** a `.env` file contains `MESSAGE="Hello World"`
- **AND** `rayfin.yml` contains `message: ${MESSAGE}`
- **WHEN** the CLI loads the configuration
- **THEN** the resolved value SHALL be `message: "Hello World"` (quotes removed, spaces preserved)

#### Scenario: Empty value

- **GIVEN** a `.env` file contains `OPTIONAL_VAR=`
- **AND** `rayfin.yml` contains `value: ${OPTIONAL_VAR:-default}`
- **WHEN** the CLI loads the configuration
- **THEN** the empty value SHALL trigger the default: `value: "default"`

#### Scenario: No variable expansion in .env

- **GIVEN** a `.env` file contains:

  ```bash
  BASE_URL=http://localhost
  FULL_URL=${BASE_URL}/api
  ```

- **AND** `rayfin.yml` contains `url: ${FULL_URL}`
- **WHEN** the CLI loads the configuration
- **THEN** the resolved value SHALL be `url: "${BASE_URL}/api"` (literal string, not expanded)

### Requirement: Backward Compatibility

The Rayfin CLI SHALL treat `rayfin.yml` files without environment variable syntax (`${}`) as static configuration and process them unchanged, maintaining full backward compatibility.

**ID**: `ENV-INTERP-007`

**Rationale**: Existing projects continue to work without modification; interpolation is opt-in via syntax usage.

#### Scenario: Static configuration unchanged

- **GIVEN** a `rayfin.yml` file contains no `${}` syntax anywhere
- **WHEN** the CLI loads the configuration
- **THEN** the configuration SHALL be processed exactly as before (no interpolation attempted)
- **AND** the presence or absence of .env files SHALL have no effect

#### Scenario: Mixed static and interpolated values

- **GIVEN** `rayfin.yml` contains both static values (`name: "my-app"`) and interpolated values (`port: ${PORT}`)
- **WHEN** the CLI loads the configuration
- **THEN** static values SHALL remain unchanged
- **AND** only values with `${}` syntax SHALL be interpolated

### Requirement: CLI Command Support for Custom .env Files

The `rayfin dev` and `rayfin up` commands SHALL accept an `--env-file <path>` option to specify a custom .env file path.

**ID**: `ENV-INTERP-008`

**Rationale**: Enables builders to use environment-specific .env files (e.g., .env.development, .env.production) without relying on environment variables.

#### Scenario: rayfin dev with custom .env

- **GIVEN** a project has `.env.development` in the root
- **AND** the user runs `rayfin dev --env-file .env.development`
- **WHEN** the CLI loads the configuration
- **THEN** variables SHALL be loaded from `.env.development`
- **AND** the rest of `rayfin dev` behavior SHALL be unchanged

#### Scenario: rayfin up with custom .env

- **GIVEN** a project has `.env.production` in the root
- **AND** the user runs `rayfin up --env-file .env.production`
- **WHEN** the CLI loads the configuration
- **THEN** variables SHALL be loaded from `.env.production`
- **AND** the interpolated config SHALL be sent to the remote WebService

#### Scenario: Invalid .env file path error

- **GIVEN** the user runs `rayfin dev --env-file missing.env`
- **AND** `missing.env` does not exist
- **WHEN** the CLI processes the command
- **THEN** the CLI SHALL fail with an error indicating the file was not found
- **AND** the error message SHALL include the attempted path

### Requirement: Separation from Generated Container Configuration

The `.env` file used for `rayfin.yml` interpolation SHALL be distinct from the auto-generated `rayfin/.temp/.env` file used for Docker container configuration.

**ID**: `ENV-INTERP-009`

**Rationale**: Prevents confusion between builder-managed environment variables (for config interpolation) and CLI-managed environment variables (for container runtime).

#### Scenario: User .env not overwritten by CLI

- **GIVEN** a builder creates `rayfin/.env` with custom variables
- **WHEN** the CLI runs and generates `rayfin/.temp/.env` for Docker
- **THEN** the builder's `rayfin/.env` SHALL remain unchanged
- **AND** both files SHALL coexist independently

#### Scenario: Documentation distinguishes the two files

- **GIVEN** builder documentation for environment variables
- **THEN** it SHALL clearly explain:
  - `rayfin/.env` is for rayfin.yml interpolation (user-managed)
  - `rayfin/.temp/.env` is for container config (CLI-generated, do not edit)

### Requirement: Environment-backed feature evaluation uses supported default sources

The Rayfin CLI SHALL evaluate environment-backed feature flags using direct environment variables and the default `rayfin/.env` file, with direct environment variables taking precedence over the default `.env` file.

#### Scenario: Shell environment enables a feature flag

- **WHEN** the shell environment sets `RAYFIN_FEATURE_FLAGS=storage`
- **THEN** feature evaluation SHALL treat the `storage` feature as enabled for the current invocation

#### Scenario: rayfin/.env enables a feature flag when shell is unset

- **GIVEN** the shell environment does not set `RAYFIN_FEATURE_FLAGS`
- **AND** `rayfin/.env` contains `RAYFIN_FEATURE_FLAGS=storage`
- **WHEN** the CLI evaluates feature flags
- **THEN** feature evaluation SHALL treat the `storage` feature as enabled for the current invocation

#### Scenario: Shell environment overrides rayfin/.env for feature evaluation

- **GIVEN** `rayfin/.env` contains `RAYFIN_FEATURE_FLAGS=storage`
- **AND** the shell environment sets `RAYFIN_FEATURE_FLAGS=`
- **WHEN** the CLI evaluates feature flags
- **THEN** the shell environment value SHALL take precedence over the `.env` value

#### Scenario: Custom env files are not part of the visibility contract

- **GIVEN** the user supplies a custom env file through `--env-file`, `RAYFIN_ENV_FILE`, or another non-default `.env.*` variant
- **WHEN** the CLI evaluates feature flags for command visibility
- **THEN** this change SHALL NOT require feature visibility to honor that custom env file
- **AND** the supported visibility contract SHALL remain direct environment variables plus the default `rayfin/.env` file
