## ADDED Requirements

### Requirement: Universal App uses a two-layer sample structure

`samples/universal-app` SHALL be an outer Rush validation harness.
The Builder-facing Universal App source SHALL live under `samples/universal-app/template` as an npm workspace and SHALL be the only sample subtree bundled by the Copilot plugin.
Generated validation output SHALL remain ephemeral and SHALL NOT be bundled or committed.

#### Scenario: repository validates the Builder-facing template

- **WHEN** the Universal App Rush build runs
- **THEN** the harness SHALL scaffold or copy `template/` into an ephemeral target
- **THEN** it SHALL link that target to repository SDK packages
- **THEN** it SHALL install, build, type-check, lint, and test the generated workspace through existing root commands

#### Scenario: plugin bundles only the inner template

- **WHEN** the Copilot plugin bundles Universal App
- **THEN** the source SHALL be `samples/universal-app/template`
- **THEN** outer harness scripts, Rush configuration, and generated targets SHALL NOT appear in the vendored template

### Requirement: Base workspace has explicit package boundaries

The inner template SHALL declare npm workspace members for `packages/frontend`, `packages/data`, and `packages/shared`.
Their package names SHALL be `@rayfin-app/frontend`, `@rayfin-app/data`, and `@rayfin-app/shared`, respectively.
The frontend package SHALL own browser application code and static-hosting output.
The data package SHALL own Rayfin entity registration and data schema exports.
The shared package SHALL own isomorphic contracts used across runtime boundaries.
The workspace root SHALL own template identity, orchestration scripts, `rayfinPacks`, capability-pack tooling, and `rayfin/rayfin.yml`.

#### Scenario: base package ownership is inspectable

- **WHEN** a Builder inspects a newly generated Universal App
- **THEN** browser code SHALL be under `packages/frontend`
- **THEN** entity registration SHALL be under `packages/data`
- **THEN** cross-runtime contracts SHALL be under `packages/shared`
- **THEN** root commands SHALL orchestrate those packages without making the root an application package

### Requirement: Member package names remain stable during scaffolding

The generated app root package name SHALL be customized from the user-selected app name.
Member package names SHALL remain stable, non-user-derived `@rayfin-app/*` names.
Cross-package dependency keys and import specifiers SHALL NOT be renamed during scaffolding.
The generic template customizer SHALL continue to modify only the root manifest name and SHALL NOT perform recursive text substitution.

#### Scenario: app creation personalizes only the root package

- **WHEN** a Builder creates a Universal App named `sales-dashboard`
- **THEN** the root `package.json` name SHALL be `sales-dashboard`
- **THEN** member manifests SHALL retain `@rayfin-app/frontend`, `@rayfin-app/data`, and `@rayfin-app/shared`
- **THEN** local dependency keys and import specifiers SHALL continue to reference those stable member names

#### Scenario: functions is applied after root personalization

- **WHEN** the functions capability is applied to an app whose root package name was customized
- **THEN** the created functions package SHALL be named `@rayfin-app/functions`
- **THEN** existing member package names SHALL remain unchanged

### Requirement: Functions remains an opt-in package

The base template SHALL NOT contain `packages/functions` and SHALL keep the functions service disabled.
The canonical `functions` capability pack SHALL create `packages/functions` named `@rayfin-app/functions`, preserve authored files on reapplication, configure `services.functions.path` for that package, enable the service, and compose its build into root commands.

#### Scenario: base app does not install functions

- **WHEN** a Universal App is generated without the functions capability
- **THEN** `packages/functions` SHALL NOT exist
- **THEN** `services.functions.enabled` SHALL be `false`

#### Scenario: functions capability creates the package

- **WHEN** `npm run pack:add -- functions` succeeds
- **THEN** `packages/functions` SHALL be a workspace member named `@rayfin-app/functions` with its required source and configuration
- **THEN** `services.functions.path` SHALL identify `packages/functions`
- **THEN** functions SHALL build before any root command that consumes generated function types or deployable output

### Requirement: Service configuration addresses workspace packages

The template SHALL use the service `path` and `buildCommand` behavior defined by the prior `workspace-support` change.
The data service SHALL resolve from `packages/data`.
Static hosting SHALL resolve from `packages/frontend`, including its output folder.
After functions is applied, the functions service SHALL resolve from `packages/functions`.
Each service build command SHALL be valid when executed with its configured service path as the working directory.

#### Scenario: base services resolve to their owning packages

- **WHEN** the CLI loads the template's `rayfin/rayfin.yml`
- **THEN** data discovery and its build command SHALL resolve under `packages/data`
- **THEN** the static-hosting build and output folder SHALL resolve under `packages/frontend`

#### Scenario: functions service resolves after pack application

- **WHEN** the functions capability pack has been applied
- **THEN** functions discovery, type generation, and build SHALL resolve under `packages/functions`

### Requirement: Inner workspace uses distributable dependency specifications

Committed inner manifests SHALL use supported published ranges for Rayfin packages.
References from one inner workspace member to another SHALL use `*`.
Committed inner manifests SHALL NOT use `workspace:*` or repository-relative `file:` specifications.
The outer harness SHALL replace only Rayfin package ranges in its ephemeral validation target with links to repository packages.

#### Scenario: committed template installs outside the monorepo

- **WHEN** the inner template manifests are inspected before bundling
- **THEN** every Rayfin dependency SHALL use a published range
- **THEN** every local member dependency SHALL use `*`
- **THEN** no dependency SHALL require the Rayfin repository filesystem

#### Scenario: harness tests the current branch

- **WHEN** the outer harness prepares its validation target
- **THEN** Rayfin dependencies in the target SHALL resolve to local repository package outputs
- **THEN** local workspace-member specifications SHALL remain unchanged
- **THEN** the committed inner manifests SHALL remain unchanged

### Requirement: Copilot plugin preserves template identity without stamping it

The inner workspace root manifest SHALL declare the template identity `universal-app`.
The Copilot plugin bundler SHALL verify and preserve that identity while copying the inner template.
It SHALL NOT rely on an outer harness manifest, stamp a missing identity, or rewrite `workspace:*` dependency specifications in the inner template.

#### Scenario: source and vendored identities match

- **WHEN** the plugin bundle is built
- **THEN** both the inner source manifest and vendored root manifest SHALL declare `template.name: universal-app`
- **THEN** the outer harness manifest SHALL NOT be treated as the generated app identity

#### Scenario: invalid source identity fails bundling

- **WHEN** the inner source manifest omits or changes the Universal App identity
- **THEN** the plugin bundle SHALL fail before producing a distributable artifact

### Requirement: Plugin policy is workspace-aware and fails closed

The workspace root manifest SHALL remain authoritative for template identity, forbidden lifecycle scripts, root validation scripts, and `rayfinPacks`.
Dependency policy SHALL inspect the root manifest and all member manifests declared by the root npm workspace.
The plugin SHALL reject an unreadable declared member or an unsupported Rayfin dependency range.
It SHALL NOT require member manifests to duplicate root template identity or pack state.

#### Scenario: required dependency is owned by a member

- **WHEN** a required Rayfin dependency moves from the root manifest to its owning workspace package
- **THEN** plugin policy SHALL validate that member's range
- **THEN** policy SHALL NOT report the dependency missing solely because it is absent from the root manifest

#### Scenario: declared workspace member cannot be inspected

- **WHEN** the root workspaces declaration names a member whose manifest is missing or malformed
- **THEN** plugin policy SHALL fail before package scripts or deployment work runs
- **THEN** the failure SHALL identify the unreadable member

#### Scenario: existing flat Universal App is validated

- **WHEN** an existing Universal App has no npm workspaces declaration
- **THEN** plugin policy SHALL retain the flat root-manifest and fixed-path behavior
- **THEN** the app SHALL NOT be required to migrate before validation

### Requirement: Capability detection follows package and service evidence

Manifest-derived capability detection SHALL inspect `rayfinPacks` at the workspace root and relevant dependencies across declared workspace members.
Service-derived capability detection SHALL continue to treat `rayfin/rayfin.yml` as authoritative for enabled services.
Data schema detection SHALL use the configured data service path and SHALL retain the flat `rayfin/data/schema.ts` fallback for existing apps.

#### Scenario: member dependency activates a required validation

- **WHEN** a workspace member declares a dependency that proves a visual or analytics capability
- **THEN** the corresponding validation SHALL be required even when the root manifest does not declare that dependency

#### Scenario: root pack marker activates a required validation

- **WHEN** the root `rayfinPacks` records a capability
- **THEN** the corresponding validation SHALL be required without duplicating that marker into member manifests

#### Scenario: workspace data package registers entities

- **WHEN** the data service is enabled or the configured data package registers entities
- **THEN** Rayfin data access policy SHALL run against that package
- **THEN** the plugin SHALL NOT require `rayfin/data/schema.ts` at the workspace root

### Requirement: Generated app and plugin contracts remain compatible

The migration SHALL preserve root commands for build, type-check, lint, test, preview, capability application, and deployment preparation.
It SHALL preserve Fabric authentication enabled, password authentication disabled, the `universal-app` identity, existing capability names, and Copilot plugin tool input and output contracts.
Existing flat generated apps SHALL remain supported.

#### Scenario: Builder uses existing root commands

- **WHEN** a Builder follows the existing Universal App workflow in a newly generated workspace app
- **THEN** the documented root npm commands SHALL continue to perform the equivalent application action

#### Scenario: existing app validates after plugin upgrade

- **WHEN** the plugin validates a previously generated flat Universal App
- **THEN** policy and capability checks SHALL use the compatibility fallback
- **THEN** validation SHALL NOT fail solely because the app lacks the new workspace layout

### Requirement: Migration is verified across source, bundle, pack, and validation surfaces

The implementation SHALL include automated coverage for the outer harness, committed inner manifests, plugin bundle source and identity, workspace dependency policy, root and member capability evidence, service paths, functions pack application, existing flat-app compatibility, and the generated workspace's root validation commands.

#### Scenario: clean repository validation succeeds

- **WHEN** targeted Universal App harness, Copilot plugin, template, and workspace path tests run from a clean checkout
- **THEN** all tests SHALL pass without modifying committed template files
- **THEN** the generated target SHALL be removable without affecting source state

#### Scenario: migration surface regresses

- **WHEN** bundle source, identity, dependency ranges, package evidence, service paths, or capability-pack destinations diverge from this contract
- **THEN** at least one focused automated test SHALL fail before a plugin artifact is released
