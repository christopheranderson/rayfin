# Spec: Postgres Dialect Gate

## Purpose

Define the feature flag and configuration gate controlling when PostgreSQL-specific code, providers, and CLI options are activated across the Rayfin stack.

## Requirements

### Requirement: CLI dialect options are gated by the postgresql feature flag

The CLI SHALL only present PostgreSQL as a selectable dialect option (e.g., in `rayfin init` prompts and `rayfin dev db apply` defaults) when the `postgresql` feature flag resolves to `true`.

#### Scenario: PostgreSQL appears in dialect selection when flag is active

- **WHEN** the `postgresql` feature flag resolves to `true`
- **AND** the CLI presents a dialect selection prompt
- **THEN** `postgresql` SHALL appear as a selectable option

#### Scenario: PostgreSQL hidden from dialect selection when flag is inactive

- **WHEN** the `postgresql` feature flag resolves to `false` or `null`
- **AND** the CLI presents a dialect selection prompt
- **THEN** `postgresql` SHALL NOT appear as a selectable option

#### Scenario: Dialect prompt skipped when only one dialect is available

- **WHEN** the `postgresql` feature flag resolves to `false` or `null`
- **AND** only one dialect option remains (e.g., `mssql`)
- **THEN** the CLI SHALL auto-select that dialect without prompting the user

#### Scenario: Existing projects with postgresql dialect continue working

- **WHEN** a project has `services.data.dialect: postgresql` in `rayfin.yml`
- **THEN** the `postgresql` feature flag SHALL resolve to `true` from the config
- **AND** all PostgreSQL code paths SHALL activate normally

### Requirement: Scaffolding templates gate PostgreSQL content by feature flag

The `create-rayfin` scaffolding tool SHALL only include PostgreSQL-specific configuration in generated project files when the `postgresql` feature flag is active at scaffolding time.

#### Scenario: PostgreSQL template content included when flag is active

- **WHEN** a Builder scaffolds a new project with the `postgresql` feature flag active
- **AND** selects PostgreSQL as the dialect
- **THEN** the generated `rayfin.yml` SHALL include `dialect: postgresql`
- **AND** any PostgreSQL-specific setup instructions SHALL be included

#### Scenario: PostgreSQL template content excluded when flag is inactive

- **WHEN** a Builder scaffolds a new project with the `postgresql` feature flag inactive
- **THEN** the dialect selection SHALL default to `mssql` without offering `postgresql`

### Requirement: TypeScript SDK dialect metadata remains unconditionally available

The `DatabaseDialect.PostgreSql` constant and `DIALECT_CONFIGS['postgresql']` in `@microsoft/rayfin-core` SHALL remain exported and accessible regardless of any feature flag state, since they are inert metadata used at build time.

#### Scenario: PostgreSQL dialect config accessible without feature flag

- **WHEN** code imports `DatabaseDialect.PostgreSql` or calls `getDialectConfig('postgresql')`
- **THEN** the SDK SHALL return the PostgreSQL dialect configuration
- **AND** no feature flag check SHALL be required
