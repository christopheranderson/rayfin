# Spec: CLI Feature Flags

## Purpose

Define the feature flag primitives used by the Rayfin CLI to evaluate per-invocation feature visibility from resolved environment variables and project configuration.

## Requirements

### Requirement: Feature flag registry

The CLI SHALL provide a feature flag registry that allows code to register named feature resolvers and query resolved feature state for the current command invocation.

#### Scenario: Registered feature resolves to true

- **WHEN** a feature resolver is registered for a feature name and its `on(env, rayfinConfig)` callback returns `true`
- **THEN** querying that feature through the registry SHALL return `true`

#### Scenario: Registered feature resolves to false

- **WHEN** a feature resolver is registered for a feature name and its `on(env, rayfinConfig)` callback returns `false`
- **THEN** querying that feature through the registry SHALL return `false`

#### Scenario: Unregistered feature is unresolved

- **WHEN** code queries a feature name that has no registered resolver
- **THEN** the registry SHALL return `null`

#### Scenario: Resolver receives resolved environment and project config

- **WHEN** the registry evaluates a registered feature
- **THEN** it SHALL invoke the resolver with the resolved environment variables for the current invocation
- **AND** it SHALL provide the loaded `rayfin.yml` configuration when project configuration is available

### Requirement: Feature flag names are normalized

The CLI SHALL normalize feature flag names for both registration and lookup so feature resolution is case-insensitive and resilient to incidental whitespace.

#### Scenario: Registration and lookup use different casing

- **WHEN** code registers a resolver for `storage` and later queries `STORAGE`
- **THEN** the registry SHALL resolve both names as the same feature

#### Scenario: Feature names are trimmed before resolution

- **WHEN** code registers or queries a feature name with leading or trailing whitespace
- **THEN** the registry SHALL trim whitespace before storing or resolving the feature name

### Requirement: Environment flag list supports generic feature enablement

The CLI SHALL support `RAYFIN_FEATURE_FLAGS` as a comma-delimited list of feature identifiers that feature resolvers can use for generic environment-driven enablement.

#### Scenario: Environment flag list enables a feature

- **WHEN** `RAYFIN_FEATURE_FLAGS` contains `storage`
- **THEN** a resolver that checks the parsed feature flag list SHALL treat `storage` as enabled

#### Scenario: Environment flag list ignores empty entries

- **WHEN** `RAYFIN_FEATURE_FLAGS` contains empty values caused by extra commas or whitespace
- **THEN** the parser SHALL ignore empty entries when building the enabled feature set

#### Scenario: Environment flag list is case-insensitive

- **WHEN** `RAYFIN_FEATURE_FLAGS` contains ` STORAGE ` or `Storage`
- **THEN** the parsed feature flag list SHALL treat the `storage` feature as enabled

### Requirement: PostgreSQL feature flag registered in CLI

The CLI feature flag registry SHALL include a `postgresql` feature resolver that activates when the project's configured dialect is `postgresql` or when `postgresql` appears in the `RAYFIN_FEATURE_FLAGS` environment variable.

#### Scenario: Flag resolves to true from rayfin.yml dialect

- **WHEN** the loaded `rayfin.yml` contains `services.data.dialect: postgresql`
- **THEN** the `postgresql` feature flag SHALL resolve to `true`

#### Scenario: Flag resolves to true from environment variable

- **WHEN** the `RAYFIN_FEATURE_FLAGS` environment variable contains `postgresql`
- **THEN** the `postgresql` feature flag SHALL resolve to `true`

#### Scenario: Flag resolves to false when dialect is mssql and env var absent

- **WHEN** the loaded `rayfin.yml` contains `services.data.dialect: mssql` or no dialect is set
- **AND** `RAYFIN_FEATURE_FLAGS` does not contain `postgresql`
- **THEN** the `postgresql` feature flag SHALL resolve to `false`

#### Scenario: Flag resolves to true from environment variable without rayfin.yml

- **WHEN** no `rayfin.yml` is found (outside a Rayfin project)
- **AND** `RAYFIN_FEATURE_FLAGS` contains `postgresql`
- **THEN** the `postgresql` feature flag SHALL resolve to `true`

### Requirement: Docker-local-dev feature flag registered in CLI

The CLI feature flag registry SHALL include a `docker-local-dev` feature resolver that activates only when `docker-local-dev` appears in the `RAYFIN_FEATURE_FLAGS` environment variable.

#### Scenario: Flag resolves to true from environment variable

- **WHEN** the `RAYFIN_FEATURE_FLAGS` environment variable contains `docker-local-dev`
- **THEN** the `docker-local-dev` feature flag SHALL resolve to `true`

#### Scenario: Flag resolves to false when environment variable is absent

- **WHEN** the `RAYFIN_FEATURE_FLAGS` environment variable does not contain `docker-local-dev`
- **THEN** the `docker-local-dev` feature flag SHALL resolve to `false`

#### Scenario: Flag resolves to false when environment variable is unset

- **WHEN** the `RAYFIN_FEATURE_FLAGS` environment variable is not set
- **THEN** the `docker-local-dev` feature flag SHALL resolve to `false`
