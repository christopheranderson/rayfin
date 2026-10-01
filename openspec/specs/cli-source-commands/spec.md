# CLI Source Commands

## ADDED Requirements

### Requirement: Source Command Registration

The CLI SHALL register a `connector` command group at the top level of the `rayfin` command tree, alongside existing `dev`, `up`, `init`, `login`, and `logout` commands.

**ID**: `CLI-SOURCE-REGISTRATION-001`

#### Scenario: Source command is registered in the program

- **WHEN** the CLI program initializes
- **THEN** `rayfin connector` SHALL be available as a top-level command
- **AND** SHALL appear in `rayfin --help` output

#### Scenario: First connector can be added without an opt-in

- **WHEN** a project has no `connectors:` block
- **THEN** the `connector` command group SHALL be registered
- **AND** `rayfin connector add` SHALL be usable without any feature flag in the process environment

#### Scenario: Source command does not conflict with existing commands

- **WHEN** a user runs any existing command (`rayfin dev`, `rayfin up`, `rayfin init`, `rayfin login`, `rayfin logout`)
- **THEN** the behavior SHALL be unchanged by the addition of the `connector` command group

### Requirement: connector command group Structure

The CLI SHALL provide a `rayfin connector` top-level command group with subcommands for managing external data source entries in `rayfin.yml`.

**ID**: `CLI-SOURCE-CMD-001`

#### Scenario: connector command group is available at top level

- **WHEN** a user runs `rayfin --help`
- **THEN** the output SHALL list `source` as a top-level command
- **AND** the description SHALL read "Manage external data source connections"

#### Scenario: Source command shows subcommand help

- **WHEN** a user runs `rayfin connector --help`
- **THEN** the output SHALL list `add`, `list`, and `remove` subcommands
- **AND** each subcommand SHALL have a brief description

### Requirement: Verbose Logging Option

The `rayfin connector add` command SHALL support a `--verbose` flag consistent with other CLI commands, enabling detailed diagnostic output for Fabric API calls and schema discovery.

**ID**: `CLI-SOURCE-VERBOSE-001`

#### Scenario: Verbose flag enables Fabric API tracing

- **WHEN** a user runs `rayfin connector add --verbose --connector fabric-sqlanalytics --name test ...`
- **THEN** the CLI SHALL enable `FabricApiClient.enableVerbose()` to log HTTP requests, responses, and timing
- **AND** SHALL use `createVerboseLogger` for command-level diagnostic messages

#### Scenario: Verbose flag logs schema discovery details

- **WHEN** `--verbose` is enabled and schema discovery runs
- **THEN** the CLI SHALL log the connection string obtained from the SQL endpoint API
- **AND** SHALL log the number of tables and columns discovered
- **AND** SHALL log the `metadata.json` path it wrote

#### Scenario: Verbose flag is off by default

- **WHEN** a user runs `rayfin connector add` without `--verbose`
- **THEN** no verbose diagnostic output SHALL be printed
- **AND** only essential status messages and errors SHALL appear

### Requirement: Connector Add Command

The CLI SHALL provide a `rayfin connector add` command that registers a new external data source in `rayfin.yml` by accepting a connector type, connector-specific arguments, and an optional user-chosen name.
The CLI SHALL load the project's `rayfin/.env` file early (before any Fabric API calls) to hydrate `RAYFIN_FABRIC_API_URL` and other environment variables.

**ID**: `CLI-SOURCE-ADD-001`

#### Scenario: Verify item exists before adding source

- **WHEN** a user runs `rayfin connector add --connector fabric-sqlanalytics --name inventory --workspace-id <wsId> --item-id <itemId>` with literal IDs
- **AND** the user is authenticated
- **THEN** the CLI SHALL call `GET /v1/workspaces/{wsId}/items/{itemId}` to verify the item exists
- **AND** SHALL validate the response is successful (200 OK)
- **AND** SHALL print: `Verified item: "<displayName>" (<type>)`
- **AND** SHALL log the item type and display name in verbose mode
- **AND** SHALL proceed with YAML update, schema discovery, and entity generation

#### Scenario: Item not found aborts the command

- **WHEN** the Fabric Items API returns 404 (ItemNotFound)
- **THEN** the CLI SHALL exit with a non-zero code
- **AND** SHALL print: `Item not found. Verify the workspace ID and artifact ID are correct.`
- **AND** SHALL NOT update `rayfin.yml`

#### Scenario: Add a Category A connector with explicit name

- **WHEN** a user runs `rayfin connector add --connector fabric-sqlanalytics --name inventory --workspace-id <wsId> --item-id <itemId>`
- **AND** the item exists in Fabric
- **THEN** the CLI SHALL append a new entry under `connectors.inventory` in `rayfin.yml`
- **AND** the entry SHALL contain `connector: fabric-sqlanalytics`
- **AND** the entry SHALL contain `config.workspaceId: <wsId>` and `config.itemId: <itemId>`
- **AND** auth SHALL default to `delegated` for `fabric-*` connectors

#### Scenario: Derive name from item displayName when --name is omitted

- **WHEN** a user runs `rayfin connector add --connector fabric-sqlanalytics --workspace-id <wsId> --item-id <itemId>` without `--name`
- **AND** the item exists and the Fabric Items API returns `displayName: "Sales Lakehouse"`
- **THEN** the CLI SHALL sanitize the display name into a valid Connector name by:
  - Converting to lowercase
  - Replacing spaces and non-alphanumeric characters (except hyphens/underscores) with hyphens
  - Collapsing consecutive hyphens
  - Trimming leading/trailing hyphens
- **AND** SHALL use the sanitized name as the source key in `rayfin.yml` (e.g., `"Sales Lakehouse"` → `"sales-lakehouse"`)
- **AND** SHALL print: `Using derived name: "sales-lakehouse". Override with --name <name>.`

#### Scenario: Derived name conflict prompts for override

- **WHEN** the derived name already exists under `connectors` in `rayfin.yml`
- **THEN** the CLI SHALL exit with a non-zero code
- **AND** SHALL print: `Derived name "<name>" already exists in rayfin.yml. Use --name to specify a different name.`

#### Scenario: Item verification skipped for interpolated IDs

- **WHEN** a user runs `rayfin connector add --connector fabric-sqlanalytics --workspace-id '${WS_ID}' --item-id '${ART_ID}' --name inventory`
- **THEN** the CLI SHALL skip item verification and name derivation (since IDs are not literal values)
- **AND** SHALL proceed directly with YAML update and scaffolding

#### Scenario: Name required when IDs use env var interpolation

- **WHEN** a user runs `rayfin connector add --connector fabric-sqlanalytics --workspace-id '${WS_ID}' --item-id '${ART_ID}'` without `--name`
- **THEN** the CLI SHALL exit with a non-zero code
- **AND** SHALL print: `Cannot derive Connector name from interpolated IDs. Use --name to specify a Connector name.`

#### Scenario: Not authenticated triggers login prompt

- **WHEN** the user is not authenticated via `rayfin login`
- **AND** literal (non-interpolated) IDs are provided
- **THEN** the CLI SHALL print: `Authentication required to verify the Fabric item. Please sign in.`
- **AND** SHALL initiate the `rayfin login` flow (interactive browser or device code)
- **AND** SHALL proceed with item verification after successful authentication

#### Scenario: Authentication declined aborts the command

- **WHEN** the user is not authenticated and the login flow fails or is cancelled
- **THEN** the CLI SHALL exit with a non-zero code
- **AND** SHALL print: `Authentication is required for item verification. Use interpolated IDs ($\{VAR}) to skip verification.`
- **AND** SHALL NOT update `rayfin.yml`

#### Scenario: Not authenticated without --name fails

- **WHEN** the user is not authenticated and the login flow fails or is cancelled
- **AND** `--name` is not provided
- **THEN** the CLI SHALL exit with a non-zero code
- **AND** SHALL print: `Authentication is required to derive the Connector name from the Fabric item. Use --name to specify a Connector name, or run "rayfin login" first.`

#### Scenario: Duplicate Connector name prompts to overwrite

- **WHEN** a user runs `rayfin connector add` and the resolved Connector name (explicit or derived) already exists under `connectors` in `rayfin.yml`
- **THEN** the CLI SHALL prompt: `Source "<name>" already exists. Overwrite? (y/N)`
- **AND** if the user confirms, the CLI SHALL remove the existing entry and source directory (if present), then proceed with YAML update and scaffolding
- **AND** if the user declines, the CLI SHALL exit with a non-zero code

#### Scenario: Duplicate Connector name with --yes flag skips prompt

- **WHEN** a user runs `rayfin connector add --yes` (or `rayfin -y Connector Add`) and the resolved Connector name already exists
- **THEN** the CLI SHALL overwrite the existing entry without prompting
- **AND** the `--yes` flag SHALL be inherited from the parent program's global `-y, --yes` option

#### Scenario: Reject unknown connector type

- **WHEN** a user runs `rayfin connector add --connector unknown-type --name foo`
- **THEN** the CLI SHALL exit with a non-zero code
- **AND** SHALL print an error listing supported connector types
- **AND** SHALL suggest the closest match if a fuzzy match exists (e.g., `fabric-sqlanalitics` → `Did you mean "fabric-sqlanalytics"?`)

#### Scenario: Workspace and artifact IDs required for fabric connectors

- **WHEN** a user runs `rayfin connector add --connector fabric-sqlanalytics --name inventory` without `--workspace-id` or `--item-id`
- **THEN** the CLI SHALL exit with a non-zero code
- **AND** SHALL print an error indicating that `--workspace-id` and `--item-id` are required for `fabric-*` connectors

#### Scenario: Connector name must be a valid identifier

- **WHEN** a user runs `rayfin connector add --name "my source!" --connector fabric-sqlanalytics ...`
- **THEN** the CLI SHALL exit with a non-zero code
- **AND** SHALL print an error: `Connector name "my source!" contains invalid characters. Only alphanumeric characters, hyphens, and underscores are allowed.`

### Requirement: Schema Discovery for Fabric Connectors

When a Category A connector (`fabric-sqlanalytics`, `fabric-warehouse`, or `fabric-sqldatabase`) source is added with literal (non-interpolated) IDs, the CLI SHALL discover the SQL schema by connecting to the Fabric SQL endpoint and store the metadata alongside the connector.

**ID**: `CLI-SOURCE-DISCOVER-001`

#### Scenario: Successful schema discovery on Connector Add

- **WHEN** a user runs `rayfin connector add` with a Category A connector (`fabric-sqlanalytics`, `fabric-warehouse`, or `fabric-sqldatabase`) and literal IDs
- **AND** the user is authenticated via `rayfin login`
- **THEN** the CLI SHALL call `GET /v1/workspaces/{wsId}/sqlEndpoints/{itemId}/connectionString` to obtain the TDS connection string
- **AND** SHALL acquire a database-scoped Entra token with audience `https://database.windows.net/.default` (separate from the Fabric API token)
- **AND** SHALL connect to the SQL endpoint using `tedious` with the database-scoped token
- **AND** SHALL query `INFORMATION_SCHEMA.TABLES` and `INFORMATION_SCHEMA.COLUMNS` to discover all schemas, tables, column names, and data types
- **AND** SHALL write the metadata to `rayfin/connectors/<name>/metadata.json`
- **AND** SHALL print a summary of the tables and schemas discovered and the path written

#### Scenario: Database token acquisition timeout

- **WHEN** the CLI attempts to acquire a database-scoped token and the acquisition does not complete within 10 seconds
- **THEN** the CLI SHALL cancel the token acquisition
- **AND** SHALL print a warning: `Schema discovery skipped: Database token acquisition timed out (10s). The CLI app may not be preauthorized for database.windows.net.`
- **AND** SHALL still have added the source entry to `rayfin.yml`
- **AND** SHALL fall back to the generic starter template

#### Scenario: Database token preauthorization failure

- **WHEN** the Entra app registration is not preauthorized for `database.windows.net` (AADSTS65002)
- **THEN** the CLI SHALL NOT hang waiting for interactive auth
- **AND** SHALL time out after 10 seconds and print a warning
- **AND** SHALL proceed with YAML update and starter template scaffolding

#### Scenario: Schema discovery skipped for interpolated IDs

- **WHEN** a user runs `rayfin connector add --connector fabric-sqlanalytics --name inventory --workspace-id '${WS_ID}' --item-id '${ART_ID}'`
- **THEN** the CLI SHALL skip schema discovery
- **AND** SHALL print: `Schema discovery skipped (IDs use variable interpolation). Run "rayfin connector discover inventory" after setting environment variables.`

#### Scenario: SQL endpoint not found

- **WHEN** the CLI calls the connection string API and receives a 404 (ItemNotFound)
- **THEN** the CLI SHALL still add the source entry to `rayfin.yml`
- **AND** SHALL print a warning: `SQL endpoint not found for this artifact. Ensure the Lakehouse has a SQL endpoint enabled.`
- **AND** SHALL NOT write a metadata file

#### Scenario: SQL connection failure during discovery

- **WHEN** the CLI obtains the connection string but fails to connect via TDS (auth error, network timeout)
- **THEN** the CLI SHALL still add the source entry to `rayfin.yml`
- **AND** SHALL print a warning: `Schema discovery failed: <error>. Source was added but metadata was not captured.`
- **AND** SHALL NOT write a metadata file

#### Scenario: Metadata file format

- **WHEN** schema discovery succeeds
- **THEN** the metadata file SHALL be JSON containing: `source`, `connector`, `connectionString`, `discoveredAt` (ISO 8601), and a `schemas` array
- **AND** each schema entry SHALL contain `schemaName` and a `tables` array
- **AND** each table entry SHALL contain `tableName` and a `columns` array
- **AND** each column entry SHALL contain `columnName`, `dataType`, `isNullable`, and optional `maxLength`, `precision`, `scale` fields

#### Scenario: User not authenticated

- **WHEN** a user runs `rayfin connector add --connector fabric-sqlanalytics` with literal IDs but is not authenticated
- **THEN** the CLI SHALL still add the source entry to `rayfin.yml`
- **AND** SHALL print a warning: `Not authenticated. Schema discovery skipped. Run "rayfin login" and then "rayfin connector discover inventory" to discover the schema.`

### Requirement: Ownership of Generated Connector Code

The CLI SHALL scaffold connector code per category and SHALL NOT emit Category A entity files.
Category B (function-bridge) connectors are fully machine-generated; Category A (GraphQL-entities) connectors are transcribed from `metadata.json` by the `rayfin-connectors` skill or by hand.

**ID**: `CLI-SOURCE-CODEGEN-001`

#### Scenario: Category B schema is generated by the CLI

- **WHEN** a user runs `rayfin connector add` for `kusto` or `fabric-semanticmodel`
- **THEN** the CLI SHALL write a complete, typed `rayfin/connectors/<name>/schema.ts`
- **AND** the file SHALL carry a `@generated — do not edit.` banner
- **AND** re-running `connector add` SHALL regenerate it without prompting
- **AND** this SHALL apply only while the type's authoring policy is `released`; a `held` type is refused by `connector add` before any file is written (see `CLI-SOURCE-CATALOG-001`)

#### Scenario: Category A entity files are authored against metadata.json

- **WHEN** a user runs `rayfin connector add` for `fabric-sqlanalytics`, `fabric-warehouse`, or `fabric-sqldatabase`
- **THEN** the CLI SHALL write `rayfin/connectors/<name>/metadata.json` and a placeholder `schema.ts`
- **AND** the placeholder SHALL NOT carry a `@generated` banner, because it is expected to be overwritten
- **AND** the CLI SHALL NOT emit entity `.ts` files
- **AND** the CLI SHALL install the `rayfin-connectors` skill so the entity-generation contract is available

#### Scenario: Authored entity files must be validated against metadata.json

- **WHEN** entity files are authored from `metadata.json`
- **THEN** column types, nullability, primary keys (including composite and keyless tables), and relationships SHALL be taken from `metadata.json` rather than inferred from names
- **AND** the contract SHALL be documented in the Category A guide so the transcription is checkable

### Requirement: Connector Package Install Guidance

`rayfin connector add` SHALL report the exact, version-pinned packages required for the generated code to compile.

**ID**: `CLI-SOURCE-INSTALL-001`

#### Scenario: Add prints a version-pinned install command

- **WHEN** `rayfin connector add` completes successfully
- **THEN** the CLI SHALL print an `npm install` command listing every package in the type's `clientPackages`
- **AND** each package SHALL carry an explicit `@<version>` matching the CLI's own version
- **AND** the command SHALL NOT be emitted unversioned, because connector dist-tags may lag the published release and resolve to a mismatched `@microsoft/rayfin-data`

#### Scenario: JSON output carries the install command

- **WHEN** `rayfin connector add --json` completes successfully
- **THEN** the payload SHALL include an `install` object with a `packages` array of pinned specs and a `command` string

### Requirement: Connector List Command

The CLI SHALL provide a `rayfin connector list` command that displays all configured data sources from `rayfin.yml`.

**ID**: `CLI-SOURCE-LIST-001`

#### Scenario: List sources when sources are configured

- **WHEN** a user runs `rayfin connector list` and `rayfin.yml` contains entries under `connectors`
- **THEN** the CLI SHALL display a table with columns: Name, Connector, Auth Type
- **AND** each row SHALL correspond to one entry under `connectors` in `rayfin.yml`

#### Scenario: List sources when no sources are configured

- **WHEN** a user runs `rayfin connector list` and `rayfin.yml` has no `connectors` section or it is empty
- **THEN** the CLI SHALL print: `No data sources configured. Use "rayfin connector add" to add one.`

#### Scenario: List sources with JSON output

- **WHEN** a user runs `rayfin connector list --json`
- **THEN** the CLI SHALL output the sources as a JSON array to stdout
- **AND** each object SHALL contain `name`, `connector`, and `auth` fields

### Requirement: Connector Remove Command

The CLI SHALL provide a `rayfin connector remove <name>` command that removes a named data source entry from `rayfin.yml`.

**ID**: `CLI-SOURCE-REMOVE-001`

#### Scenario: Remove an existing source

- **WHEN** a user runs `rayfin connector remove inventory` and `connectors.inventory` exists in `rayfin.yml`
- **THEN** the CLI SHALL remove the `connectors.inventory` entry from `rayfin.yml`
- **AND** SHALL print: `Removed source "inventory" from rayfin.yml.`

#### Scenario: Remove source with source directory cleanup prompt

- **WHEN** a user runs `rayfin connector remove inventory` and the directory `rayfin/connectors/inventory/` exists
- **THEN** the CLI SHALL prompt: `Directory rayfin/connectors/inventory/ exists. Delete it? (y/N)`
- **AND** if the user confirms, the CLI SHALL delete the directory and its contents
- **AND** if the user declines, the CLI SHALL leave the directory intact

#### Scenario: Remove source with --yes flag skips prompt

- **WHEN** a user runs `rayfin connector remove inventory --yes` and the directory `rayfin/connectors/inventory/` exists
- **THEN** the CLI SHALL delete the directory without prompting
- **AND** SHALL print: `Removed source "inventory" from rayfin.yml and deleted rayfin/connectors/inventory/.`

#### Scenario: Remove source cleans up temp metadata

- **WHEN** a source is removed (with or without directory deletion)
- **AND** the directory `rayfin/.temp/sources/<name>/` exists (containing `metadata.json` from schema discovery)
- **THEN** the CLI SHALL unconditionally delete `rayfin/.temp/sources/<name>/` without prompting
- **AND** temp cleanup SHALL NOT affect the user-facing confirmation prompt for `rayfin/connectors/<name>/`

#### Scenario: Remove a non-existent source

- **WHEN** a user runs `rayfin connector remove nonexistent` and no `sources.nonexistent` key exists in `rayfin.yml`
- **THEN** the CLI SHALL exit with a non-zero code
- **AND** SHALL print: `Source "nonexistent" not found in rayfin.yml.`

### Requirement: Supported Connector Types

The CLI SHALL maintain a registry of supported connector types used by `rayfin connector add` for validation and help text.

**ID**: `CLI-SOURCE-CATALOG-001`

#### Scenario: Phase 1 connector catalog

- **WHEN** the CLI validates a connector type
- **THEN** the following types SHALL be recognized as valid: `fabric-sqlanalytics`, `fabric-warehouse`, `fabric-sqldatabase`, `fabric-semanticmodel`, `kusto`
- **AND** each type SHALL have associated metadata: category (A or B), required arguments, default auth model, and an explicit authoring policy of `released` or `held`
- **AND** the authoring policy SHALL be required, so a type cannot be added to the catalog without an explicit decision to ship or hold it

#### Scenario: Every released catalog type is addable

- **WHEN** a user runs `rayfin connector add --type <type> ...` for a recognized type whose authoring policy is `released`
- **THEN** the CLI SHALL proceed with YAML update and category-appropriate scaffolding
- **AND** SHALL NOT reject any released type as unimplemented

#### Scenario: A held type is refused explicitly, never silently

- **WHEN** a user runs `rayfin connector add --type <type> ...` for a recognized type whose authoring policy is `held`
- **THEN** the CLI SHALL refuse before writing a YAML entry or a scaffold directory, so a held type cannot be left half-authored
- **AND** the message SHALL state that the type is not available in this release, rather than reporting it as an unknown type or correcting it to a different type as a typo
- **AND** a project that **already declares** that type SHALL continue to validate, generate, apply, and deploy through `rayfin up`, and remain usable through `connector list`, `connector remove` and `connector invoke`

> A hold withdraws **new authoring** only. The catalog entry stays complete, which is what keeps an existing project working and makes re-enabling a one-line change to that type's authoring policy.

#### Scenario: Help points at the authorable type list

- **WHEN** a user runs `rayfin connector add --help`
- **THEN** the `--type` help SHALL direct the user to `rayfin connector types` rather than enumerating types inline, so one source stays authoritative as the catalog changes
- **AND** `rayfin connector types` SHALL list exactly the recognized types whose authoring policy is `released`

#### Scenario: Every released catalog type is discoverable

- **WHEN** the CLI builds the set of item types for `rayfin connector search`
- **THEN** every recognized connector type whose authoring policy is `released` SHALL contribute its Fabric item type
- **AND** `rayfin connector search --type fabric-semanticmodel` SHALL return `SemanticModel` items
- **AND** a released type SHALL NOT be excluded from search by omission, because search is how a Builder obtains the workspace and item IDs required by `connector add`
- **AND** a `held` type SHALL be absent from search, because search exists to feed `connector add`, which would refuse it — surfacing a source the Builder cannot then attach

### Requirement: Dev Source Apply Command

The CLI SHALL provide a `rayfin dev source apply` command that generates per-source GraphQL `Source` JSON payloads from compiled TypeScript entities and applies them to the local or remote server. Source config generation and apply SHALL NOT be mixed into `rayfin dev db apply`.

**ID**: `CLI-SOURCE-DEV-APPLY-001`

#### Scenario: Generate and apply source configs locally

- **WHEN** a user runs `rayfin dev source apply`
- **AND** `rayfin.yml` contains `connectors` entries with Fabric connectors
- **THEN** the CLI SHALL compile TypeScript entities under `rayfin/connectors/<name>/`
- **AND** SHALL run `SchemaAnalyzer` on the compiled entities to extract table names, schemas, primary keys, and relationships
- **AND** SHALL build a GraphQL `Source` JSON payload with `sourceArtifactId`, `sourceWorkspaceId`, `artifactType`, and `objects` (one per entity)
- **AND** SHALL write the payload to `rayfin/.temp/sources/<name>/source-config.json`
- **AND** SHALL POST the payload to `{localEndpoint}/api/applysourceconfig`
- **AND** SHALL print a summary per source: `✅ Source config applied: "<name>" (<N> objects)`

#### Scenario: Source objects derived from TypeScript entities

- **WHEN** the CLI generates source objects from compiled entities
- **THEN** each entity SHALL produce a `SourceObject` with:
  - `type` = entity name (GraphQL type name)
  - `object` = schema-qualified `[schema].[tableName]` from `@entity({ source })` decorator
  - `objectType` = `"Table"`
  - `relationships` = FK relationships from `@one()` and `@many()` decorators
- **AND** `keyFields` SHALL NOT be included (the GraphQL workload introspects PKs from the database during source attach)

#### Scenario: FK column names resolved from entity fields

- **WHEN** an entity has `@one(() => Target) propName` alongside an FK column field (e.g., `@int() TargetID`)
- **THEN** the CLI SHALL resolve the actual FK column name by reversing the naming convention (`propName` → `PropNameID`, `PropNameId`)
- **AND** SHALL use the actual column name in `sourceFields` (for `ManyToOne`) or `targetFields` (for `OneToMany`)
- **AND** SHALL NOT use convention-based names like `propName_id`

#### Scenario: Multi-FK disambiguation

- **WHEN** two `@many()` properties on entity A reference the same target entity B (e.g., `billToAddress` and `shipToAddress` both → `Address`)
- **THEN** the CLI SHALL resolve each to the correct FK column on entity B by matching positionally against the `@one()` fields on B that reference A
- **AND** the first `@many()` SHALL resolve to the first `@one()` FK column, the second to the second, etc.

#### Scenario: Generate config only without applying

- **WHEN** a user runs `rayfin dev source apply --gen-config-only`
- **THEN** the CLI SHALL generate per-source payloads and write to `rayfin/.temp/sources/<name>/source-config.json`
- **AND** SHALL NOT POST them to any endpoint

#### Scenario: No sources configured

- **WHEN** a user runs `rayfin dev source apply`
- **AND** `rayfin.yml` has no `connectors` section or no Fabric connector sources
- **THEN** the CLI SHALL print: `No Fabric data sources configured. Use "rayfin connector add" to add one.`

#### Scenario: Source config generation failure is per-source

- **WHEN** source config generation fails for one source (e.g., no compiled entities found)
- **THEN** the CLI SHALL log a warning for that source including the endpoint URL
- **AND** SHALL continue generating and applying configs for remaining sources

#### Scenario: Apply returns failure count

- **WHEN** one or more sources fail to apply
- **THEN** the CLI SHALL print: `❌ N source(s) failed to apply. See warnings above.`
- **AND** SHALL exit with a non-zero code
- **AND** SHALL NOT print the success message

#### Scenario: Error includes endpoint URL

- **WHEN** a source config apply fails
- **THEN** the CLI SHALL include the target endpoint URL in the warning message
- **AND** SHALL log the endpoint even without `--verbose`

#### Scenario: Source config apply is separate from db apply

- **WHEN** a user runs `rayfin dev db apply`
- **THEN** the CLI SHALL NOT generate or apply source configs as a side effect
- **AND** source config generation SHALL only run via `rayfin dev source apply`

### Requirement: Up Source Apply Command

The CLI SHALL provide a `rayfin up source apply` command that generates per-source Source JSON payloads and applies them to the remote Rayfin item workload endpoint.

**ID**: `CLI-SOURCE-UP-APPLY-001`

#### Scenario: Apply source configs to remote endpoint

- **WHEN** a user runs `rayfin up source apply`
- **AND** the remote endpoint is configured from a previous `rayfin up` deployment
- **THEN** the CLI SHALL generate per-source Source JSON payloads
- **AND** SHALL POST each payload to `{remoteEndpoint}/__private/applysourceconfig` with authorization header
- **AND** SHALL print a summary per source

#### Scenario: Remote endpoint not configured

- **WHEN** a user runs `rayfin up source apply`
- **AND** no remote endpoint is configured
- **THEN** the CLI SHALL exit with a non-zero code
- **AND** SHALL print: `No remote endpoint configured. Run "rayfin up" first to deploy.`
