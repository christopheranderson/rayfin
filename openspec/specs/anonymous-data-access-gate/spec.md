# Spec: Anonymous Data Access Gate

## Purpose

Define the CLI- and SDK-side controls that govern whether a Rayfin project's
generated DAB configuration is permitted to grant the built-in `anonymous`
role any permissions, and how the related decorator surface is exposed to
builders.

## Requirements

### Requirement: Host forwards caller context to the feature provider through a properties bag

The `IRayfinFeatureProvider.IsEnabledAsync` contract SHALL accept an optional, provider-specific `properties` bag so a host can pass caller context for more granular feature evaluation.
Well-known keys SHALL be defined as constants on `RayfinFeatureProperties`; `RayfinFeatureProperties.UserId` SHALL carry the requesting user's identifier.
The value's interpretation SHALL be provider-defined and SHALL NOT be assumed to be a specific claim type: the default Rayfin host populates `UserId` from the JWT `sub` claim, while other hosts (for example BaaS) populate it with the caller's Entra directory object id (`oid`).
The host populating the bag SHALL use the identifier shape the target provider expects, and a provider SHALL fail closed (treat the feature as disabled) when a required caller identifier is absent.

The requesting user's identifier SHALL be exposed on `IProjectContext.UserId`, sourced by each host's `IProjectContextAccessor` implementation: the default Rayfin host reads the JWT `sub` claim from `HttpContext.User`, while other hosts (for example BaaS) populate it with the caller's Entra directory object id (`oid`).
The data-configuration workflow SHALL read `IProjectContext.UserId` and build the properties bag (via `RayfinFeatureProperties.ForUser`) before invoking the anonymous-data-access gate, rather than receiving the bag as a parameter.
Local (no-token) and anonymous callers SHALL resolve to a null `UserId`, which SHALL produce no properties.

#### Scenario: Requesting user id is forwarded for anonymous-access evaluation

- **GIVEN** an `applyconfig` request carrying an authenticated caller
- **WHEN** the data-configuration workflow evaluates the anonymous-data-access gate
- **THEN** it SHALL read the caller's identifier from `IProjectContext.UserId`
- **AND** build a properties bag whose `RayfinFeatureProperties.UserId` is that identifier
- **AND** forward that bag to `IRayfinFeatureProvider.IsEnabledAsync` for `RayfinFeatures.AllowAnonymousDataAccess`

#### Scenario: Local or anonymous caller forwards no properties

- **GIVEN** an `applyconfig` request with no authenticated caller (local or anonymous)
- **WHEN** the data-configuration workflow evaluates the anonymous-data-access gate
- **THEN** `IProjectContext.UserId` SHALL resolve to `null`
- **AND** the workflow SHALL pass `null` properties
- **AND** the provider SHALL evaluate the feature without any caller-specific context

### Requirement: CLI data-schema commands permit anonymous role permissions unconditionally

The CLI SHALL generate, apply, and propagate a DAB configuration that grants the
built-in `anonymous` role permissions without any feature-flag gate or
apply-time block. No CLI command or subcommand that creates, updates, or applies
the project's data schema — including, but not limited to, `rayfin dev`,
`rayfin dev db apply`, `rayfin dev db apply --gen-config-only`, `rayfin up`, and
`rayfin up db apply` — SHALL reject a configuration solely because an entity
grants the `anonymous` role one or more permissions.

The generated `dab-config.json` SHALL retain `anonymous` permission entries
exactly as declared, and the apply SHALL proceed through its normal flow. The
CLI SHALL NOT emit an "Anonymous data access is not currently supported on
Fabric" error, and SHALL NOT require the `anonymous-data-access` feature flag or
the `RAYFIN_FEATURE_FLAGS` env var for anonymous role usage.

#### Scenario: Anonymous role permissions apply on `rayfin dev db apply`

- **GIVEN** a project whose `rayfin/data/schema.ts` declares an entity with `@anonymous('read')` (or `@role('anonymous', 'read')`)
- **WHEN** the builder runs `rayfin dev db apply`
- **THEN** the command SHALL NOT fail on account of the `anonymous` role
- **AND** the generated DAB configuration SHALL retain the `anonymous` permission entry for the entity
- **AND** the apply SHALL proceed through its normal flow

#### Scenario: Anonymous role permissions apply on `rayfin up`

- **GIVEN** a project whose `rayfin/data/schema.ts` declares an entity with `@anonymous('read')`
- **WHEN** the builder runs `rayfin up`
- **THEN** the database-configuration step SHALL NOT surface an anonymous-access-blocked error
- **AND** the deployment SHALL proceed with the `anonymous` permission retained in `dab-config.json`

#### Scenario: No anonymous-access-blocked error is emitted

- **GIVEN** any project that grants the `anonymous` role permissions
- **WHEN** the builder runs any CLI command that creates, updates, or applies the data schema
- **THEN** the CLI SHALL NOT print "Anonymous data access is not currently supported on Fabric"
- **AND** the CLI SHALL NOT throw an `isAnonymousAccessBlocked` error

### Requirement: TypeScript SDK exports the anonymous decorator from the package root

The `@microsoft/rayfin-core` package SHALL export the `anonymous` decorator from
the package root import (`@microsoft/rayfin-core`), and SHALL NOT export it from
the `@microsoft/rayfin-core/experimental` subpath.

The `role` decorator SHALL be exported from `@microsoft/rayfin-core` with a
public overload signature that accepts `'authenticated' | 'anonymous'`, so that
`@role('anonymous', …)` compiles against the stable package root. The widened
`role` overload SHALL NOT be published from the `/experimental` subpath.
The `authenticated` decorator SHALL continue to be exported from
`@microsoft/rayfin-core` unchanged.

The decorators SHALL behave at runtime identically to today — they contribute
inert role-declaration metadata to entities regardless of any feature-flag
state.

#### Scenario: anonymous decorator importable from package root

- **WHEN** code imports `anonymous` from `@microsoft/rayfin-core`
- **THEN** the import SHALL resolve to the `anonymous` class decorator function
- **AND** the decorator SHALL contribute an `anonymous` role declaration to entity metadata

#### Scenario: anonymous decorator no longer importable from experimental subpath

- **WHEN** code imports `anonymous` from `@microsoft/rayfin-core/experimental`
- **THEN** the build SHALL fail with a TypeScript / module-resolution error indicating `anonymous` is not exported from that subpath

#### Scenario: role decorator and 'anonymous' overload available at the package root

- **WHEN** code imports `role` from `@microsoft/rayfin-core` and applies `@role('anonymous', 'read')`
- **THEN** the import and decorator application SHALL compile and succeed
- **AND** the decorator SHALL contribute an `anonymous` role declaration to the entity's metadata

#### Scenario: authenticated decorator unaffected

- **WHEN** code imports `authenticated` from `@microsoft/rayfin-core`
- **THEN** the import SHALL succeed identically to today
- **AND** the decorator SHALL behave identically to today
