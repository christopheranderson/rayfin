# Spec: Docker Local Dev Gate

## Purpose

Define the gating behavior for the `rayfin dev` Docker-based local development command behind a feature flag, including CLI command registration, template script conventions, documentation placement, and published guide content.

## Requirements

### Requirement: `rayfin dev` command gated behind feature flag

The CLI SHALL only register the `rayfin dev` command and all its subcommands (`db`, `storage`, `status`, `watch`) when the `docker-local-dev` feature flag resolves to `true`.

#### Scenario: Command available when flag is active

- **WHEN** the `docker-local-dev` feature flag resolves to `true`
- **THEN** `rayfin dev` and its subcommands SHALL be registered and available in the CLI
- **AND** `rayfin --help` SHALL list `dev` as an available command

#### Scenario: Command hidden when flag is inactive

- **WHEN** the `docker-local-dev` feature flag resolves to `false`
- **THEN** `rayfin dev` SHALL NOT be registered in the CLI
- **AND** `rayfin --help` SHALL NOT list `dev` as an available command
- **AND** running `rayfin dev` SHALL produce an unknown command error

### Requirement: CLI templates exclude Docker-local-dev scripts

All CLI templates SHALL NOT include scripts that reference `rayfin dev`.
Templates SHALL use `rayfin up` for database operations.

#### Scenario: Templates do not include `rayfin:dev` script

- **WHEN** a project is scaffolded from any CLI template
- **THEN** the generated `package.json` SHALL NOT contain a `rayfin:dev` script

#### Scenario: Templates use `rayfin up db apply` for database operations

- **WHEN** a project is scaffolded from a CLI template that includes database operations
- **THEN** the `rayfin:db` script SHALL use `rayfin up db apply`

#### Scenario: Templates do not include redundant `:fabric` script variants

- **WHEN** a project is scaffolded from any CLI template
- **THEN** the generated `package.json` SHALL NOT contain `dev:fabric` or `build:fabric` scripts

#### Scenario: `npm run dev` continues to work

- **WHEN** a developer runs `npm run dev` in a scaffolded project
- **THEN** the `predev` script SHALL run `rayfin env --framework vite`
- **AND** the `dev` script SHALL run `vite`

### Requirement: Docker-local-dev documentation in preview area

All Docker-local-dev documentation SHALL be placed in a preview directory that is excluded from both the published Docusaurus build and the MCP server document index.

#### Scenario: Preview directory excluded from published build

- **WHEN** the Docusaurus site is built
- **THEN** content under `packages/guide/assets/docs/preview/` SHALL NOT be included in the published output

#### Scenario: Preview directory excluded from MCP doc index

- **WHEN** the MCP server loads guide documentation
- **THEN** files under `preview/` directories SHALL NOT be indexed or served

#### Scenario: Consolidated Docker-local-dev page exists in preview

- **WHEN** a developer navigates to the preview docs area
- **THEN** a `local-dev-docker.md` page SHALL exist documenting `rayfin dev` usage, subcommands, and configuration

### Requirement: Published guide references `rayfin up` for standard workflows

Published guide documentation SHALL reference `rayfin up` as the standard command for deployment and backend operations, not `rayfin dev`.

#### Scenario: Guide pages use `rayfin up` for deployment workflows

- **WHEN** a published guide page describes deploying or running the application backend
- **THEN** it SHALL reference `rayfin up` commands

#### Scenario: Guide pages use `rayfin up db` for database operations

- **WHEN** a published guide page describes database operations (applying schema, migrations)
- **THEN** it SHALL reference `rayfin up db` commands instead of `rayfin dev db`
