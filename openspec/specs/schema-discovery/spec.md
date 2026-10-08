# Schema Discovery

## ADDED Requirements

### Requirement: Schema Discovery for Category A Connectors

When `rayfin connector add` succeeds with a Category A connector (`fabric-sqldatabase`, `fabric-warehouse`, or the read-only `fabric-sqlanalytics`), the CLI SHALL discover the SQL schema of the target artifact and write structured metadata to disk.

**ID**: `SCHEMA-DISCOVERY-001`

#### Scenario: Schema discovery triggers after YAML update

- **WHEN** `rayfin connector add` completes the YAML update and folder scaffolding
- **AND** the user is authenticated (prompted via `ensureAuthenticated()` during item verification)
- **THEN** the CLI SHALL proceed to resolve the TDS connection string, connect to the SQL endpoint, and query the schema
- **AND** schema discovery failure SHALL NOT roll back the YAML update (discovery is best-effort)

### Requirement: Connection String Resolution by Item Type

The CLI SHALL resolve the TDS connection string using the type-specific Fabric API based on the item type returned by the Get Item response.

**ID**: `SCHEMA-DISCOVERY-002`

#### Scenario: Lakehouse connection string resolution

- **WHEN** the Get Item API returns `type: "Lakehouse"`
- **THEN** the CLI SHALL call `GET /v1/workspaces/{wsId}/lakehouses/{id}`
- **AND** SHALL extract `properties.sqlEndpointProperties.connectionString`
- **AND** SHALL extract `properties.sqlEndpointProperties.id` as the resolved SQL endpoint ID
- **AND** SHALL persist the resolved SQL endpoint ID in `rayfin.yml` under `config.itemId` (replacing the parent Lakehouse ID)

#### Scenario: SQL Endpoint connection string resolution

- **WHEN** the Get Item API returns `type: "SQLEndpoint"`
- **THEN** the CLI SHALL call `GET /v1/workspaces/{wsId}/sqlEndpoints/{id}/connectionString`
- **AND** SHALL use the `connectionString` directly

#### Scenario: Warehouse connection string resolution

- **WHEN** the Get Item API returns `type: "Warehouse"`
- **THEN** the CLI SHALL call `GET /v1/workspaces/{wsId}/warehouses/{id}`
- **AND** SHALL extract `properties.connectionString`

#### Scenario: SQL Database connection string resolution

- **WHEN** the Get Item API returns `type: "SQLDatabase"`
- **THEN** the CLI SHALL call `GET /v1/workspaces/{wsId}/sqlDatabases/{id}`
- **AND** SHALL extract `properties.serverFqdn` (with fallback to `properties.connectionString`)
- **AND** SHALL extract `properties.databaseName` for the TDS database parameter

#### Scenario: SQL endpoint not found

- **WHEN** the connection string API returns 404
- **THEN** the CLI SHALL print: `SQL endpoint not found for this artifact. Ensure the Lakehouse has a SQL endpoint enabled.`
- **AND** SHALL skip schema discovery (source is still added to YAML)

### Requirement: TDS Token Acquisition

The CLI SHALL acquire an Entra token for TDS connections using the Analysis Services audience.

**ID**: `SCHEMA-DISCOVERY-003`

#### Scenario: Acquire token with Analysis Services audience

- **WHEN** the connection string is resolved
- **THEN** the CLI SHALL acquire an Entra token with scope `https://analysis.windows.net/powerbi/api/.default`
- **AND** SHALL use the existing `ensureAuthenticated()` auth module for token acquisition

#### Scenario: Token acquisition fails

- **WHEN** the TDS token cannot be acquired
- **THEN** the CLI SHALL print: `Schema discovery skipped: <error message>`
- **AND** SHALL skip schema discovery without failing the command

### Requirement: TDS Connection via Tedious

The CLI SHALL connect to the SQL endpoint using the `tedious` TDS library with Entra access token authentication.

**ID**: `SCHEMA-DISCOVERY-004`

#### Scenario: Parse connection string with port

- **WHEN** the connection string is in `host,port` format (e.g., `host.fabric.microsoft.com,1433`)
- **THEN** the CLI SHALL parse the host and port as separate parameters for `tedious`

#### Scenario: Strip tcp: prefix from connection string

- **WHEN** the connection string starts with `tcp:` (e.g., `tcp:fleet-srv-xxx.sqltest-eg1.mscds.com,1433`)
- **THEN** the CLI SHALL strip the `tcp:` prefix before passing the hostname to `tedious`

#### Scenario: Default port when not specified

- **WHEN** the connection string contains only a hostname (no comma-separated port)
- **THEN** the CLI SHALL default to port `1433`

#### Scenario: Connection uses Entra token auth

- **WHEN** connecting via `tedious`
- **THEN** the CLI SHALL use `authentication.type: 'azure-active-directory-access-token'` with the acquired database token
- **AND** SHALL set `encrypt: true`, `connectTimeout: 30000`, and `requestTimeout: 30000`

### Requirement: Table and Column Discovery via INFORMATION_SCHEMA

The CLI SHALL query `INFORMATION_SCHEMA.TABLES` and `INFORMATION_SCHEMA.COLUMNS` to discover the SQL schema.

**ID**: `SCHEMA-DISCOVERY-005`

#### Scenario: Discover all base tables

- **WHEN** the TDS connection is established
- **THEN** the CLI SHALL query `INFORMATION_SCHEMA.TABLES` filtered to `TABLE_TYPE = 'BASE TABLE'`
- **AND** SHALL capture `TABLE_SCHEMA` and `TABLE_NAME` for each table

#### Scenario: Discover all columns with metadata

- **WHEN** table discovery succeeds
- **THEN** the CLI SHALL query `INFORMATION_SCHEMA.COLUMNS` ordered by `ORDINAL_POSITION`
- **AND** SHALL capture `COLUMN_NAME`, `DATA_TYPE`, `IS_NULLABLE`, `CHARACTER_MAXIMUM_LENGTH`, `NUMERIC_PRECISION`, and `NUMERIC_SCALE`

#### Scenario: Column metadata maps to ColumnEntry

- **WHEN** columns are discovered
- **THEN** each column SHALL be represented as a `ColumnEntry` with `columnName`, `dataType`, `isNullable` (boolean), and optional `maxLength`, `precision`, `scale`

### Requirement: Primary Key Discovery

The CLI SHALL discover primary key columns for each table via `INFORMATION_SCHEMA.TABLE_CONSTRAINTS` and `KEY_COLUMN_USAGE`.

**ID**: `SCHEMA-DISCOVERY-006`

#### Scenario: Discover primary key columns

- **WHEN** table and column discovery succeeds
- **THEN** the CLI SHALL query `TABLE_CONSTRAINTS` joined with `KEY_COLUMN_USAGE` filtered to `CONSTRAINT_TYPE = 'PRIMARY KEY'`
- **AND** SHALL capture the PK column names per table ordered by `ORDINAL_POSITION`

#### Scenario: PK discovery error does not fail overall discovery

- **WHEN** PK discovery encounters an error
- **THEN** the CLI SHALL log a warning and continue without PK data
- **AND** SHALL still produce valid metadata with tables and columns

#### Scenario: PK data stored in TableEntry

- **WHEN** primary key columns are discovered
- **THEN** each `TableEntry` SHALL include an optional `primaryKeyColumns` string array

### Requirement: Schema Metadata File Output

The CLI SHALL write discovered schema metadata to `rayfin/.temp/sources/<name>/metadata.json`.

**ID**: `SCHEMA-DISCOVERY-007`

#### Scenario: Metadata file structure

- **WHEN** schema discovery completes
- **THEN** the CLI SHALL write a JSON file containing `source` (name), `connector` (type), `connectionString`, `discoveredAt` (ISO timestamp), and `schemas` (array of `SchemaEntry`)
- **AND** each `SchemaEntry` SHALL contain `schemaName` and `tables` (array of `TableEntry`)

#### Scenario: Metadata directory created if missing

- **WHEN** `rayfin/.temp/sources/<name>/` does not exist
- **THEN** the CLI SHALL create the directory recursively before writing the file

#### Scenario: Discovery summary logged

- **WHEN** metadata is written
- **THEN** the CLI SHALL print: `Discovered <N> tables across <M> schemas. Metadata saved to <path>.`

### Requirement: Graceful Discovery Failure

Schema discovery SHALL be best-effort and SHALL NOT prevent Connector Addition.

**ID**: `SCHEMA-DISCOVERY-008`

#### Scenario: SQL connection fails

- **WHEN** the TDS connection fails (auth error, network timeout, etc.)
- **THEN** the CLI SHALL print: `Schema discovery failed: <error>. Source was added to rayfin.yml but metadata was not captured.`
- **AND** the source SHALL remain in `rayfin.yml`
- **AND** the starter template SHALL be scaffolded instead of entity files

#### Scenario: Empty database

- **WHEN** schema discovery succeeds but finds no tables
- **THEN** the CLI SHALL write an empty metadata file
- **AND** SHALL scaffold the starter template instead of entity files

#### Scenario: Connection closed after discovery

- **WHEN** schema discovery completes (success or failure)
- **THEN** the TDS connection SHALL be closed in a `finally` block

### Requirement: Foreign Key Discovery During Schema Discovery

The CLI SHALL discover foreign key relationships between tables during schema discovery for Category A connectors and include them in the schema metadata.

**ID**: `SCHEMA-DISCOVERY-009`

#### Scenario: Discover foreign key constraints via INFORMATION_SCHEMA

- **WHEN** schema discovery runs for a Category A connector (`fabric-sqldatabase`, `fabric-warehouse`, or the read-only `fabric-sqlanalytics`)
- **THEN** the CLI SHALL query `INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS` joined with `INFORMATION_SCHEMA.KEY_COLUMN_USAGE` to discover all foreign key relationships
- **AND** SHALL capture the constraint name, source table, source column, referenced table, and referenced column for each FK

#### Scenario: FK discovery runs after column discovery

- **WHEN** schema discovery completes table and column discovery
- **THEN** FK discovery SHALL execute as a subsequent step using the same TDS connection
- **AND** SHALL NOT block or fail the overall discovery if FK queries return no results (some databases may have no FKs)

#### Scenario: FK discovery error does not fail overall discovery

- **WHEN** FK discovery encounters an error (e.g., permission denied on system views)
- **THEN** the CLI SHALL log a warning and continue without FK data
- **AND** SHALL still produce valid metadata with tables and columns

### Requirement: FK Metadata Storage in metadata.json

The schema metadata file (`rayfin/.temp/sources/<name>/metadata.json`) SHALL include discovered foreign key relationships.

**ID**: `SCHEMA-DISCOVERY-010`

#### Scenario: FK data stored at table level

- **WHEN** FK relationships are discovered for a source
- **THEN** each `TableEntry` in the metadata SHALL include an optional `foreignKeys` array
- **AND** each entry SHALL contain `constraintName`, `columnName`, `referencedTableSchema`, `referencedTableName`, and `referencedColumnName`

#### Scenario: FK metadata structure

- **WHEN** table `Orders` has a foreign key `FK_Orders_Customer` on column `CustomerId` referencing `Customers.Id`
- **THEN** the metadata for the `Orders` table SHALL include:

```json
{
  "tableName": "Orders",
  "columns": [ ... ],
  "foreignKeys": [
    {
      "constraintName": "FK_Orders_Customer",
      "columnName": "CustomerId",
      "referencedTableSchema": "dbo",
      "referencedTableName": "Customers",
      "referencedColumnName": "Id"
    }
  ]
}
```

#### Scenario: Tables with no foreign keys

- **WHEN** a table has no foreign key constraints
- **THEN** the `foreignKeys` array SHALL be empty or omitted
- **AND** the table's columns and other metadata SHALL be unaffected

#### Scenario: Composite foreign keys

- **WHEN** a table has a composite foreign key spanning multiple columns (e.g., `(OrderId, ProductId)` → `(Id, ProductId)`)
- **THEN** each column in the composite key SHALL be represented as a separate entry in the `foreignKeys` array sharing the same `constraintName`

### Requirement: Entity Generation with Relationship Decorators

When FK metadata is present, the entity generator SHALL emit `@one()` and `@many()` decorators to represent discovered relationships.

**ID**: `SCHEMA-DISCOVERY-011`

#### Scenario: Many-to-one relationship on the FK source entity

- **WHEN** table `Orders` has FK column `CustomerId` referencing `Customers.Id`
- **THEN** the generated `Orders.ts` entity SHALL include a `@one()` decorated property
- **AND** the property name SHALL be derived from the FK column name by stripping the `Id` suffix (e.g., `CustomerId` → `customer`)
- **AND** the decorator SHALL reference the target entity: `@one(() => Customers)`
- **AND** the property type SHALL be `Customers | undefined`

#### Scenario: One-to-many inverse relationship on the referenced entity

- **WHEN** table `Customers` is referenced by `Orders.CustomerId`
- **THEN** the generated `Customers.ts` entity SHALL include a `@many()` decorated property
- **AND** the property name SHALL be the pluralized lowercase source table name (e.g., `orders`)
- **AND** the decorator SHALL reference the source entity: `@many(() => Orders)`
- **AND** the property type SHALL be `Orders[] | undefined`

#### Scenario: Import statements for related entities

- **WHEN** entity `Orders` has a `@one(() => Customers)` relationship
- **THEN** the generated file SHALL include `import { Customers } from './Customers.js'`
- **AND** the `one` decorator SHALL appear in the import from `@microsoft/rayfin-core`

#### Scenario: FK column retained alongside relationship property

- **WHEN** table `Orders` has FK column `CustomerId` referencing `Customers`
- **THEN** the generated entity SHALL keep the `CustomerId` column property with its original decorator (e.g., `@uuid()` or `@int()`)
- **AND** SHALL add the `@one()` relationship property as an additional property below the FK column

#### Scenario: Multiple FKs on a single entity

- **WHEN** table `OrderItems` has FKs `OrderId → Orders.Id` and `ProductId → Products.Id`
- **THEN** the generated entity SHALL include two `@one()` properties: `order` and `product`
- **AND** each SHALL reference its respective target entity

#### Scenario: Self-referential FK

- **WHEN** table `Categories` has FK `ParentCategoryId` referencing `Categories.Id`
- **THEN** the generated entity SHALL include a `@one()` property `parentCategory` referencing `() => Categories`
- **AND** SHALL include a `@many()` property `categories` referencing `() => Categories`

#### Scenario: FK references a table in a different SQL schema

- **WHEN** the FK references a table in a different SQL schema (e.g., `dbo.Orders.CustomerId` → `sales.Customers.Id`)
- **THEN** the relationship decorator SHALL still reference the target entity by class name
- **AND** the import SHALL use the correct relative path for the target entity file

#### Scenario: FK target table not in discovered metadata

- **WHEN** an FK references a table that was not discovered (e.g., filtered out or in a system schema)
- **THEN** the CLI SHALL skip the relationship decorator for that FK
- **AND** SHALL log a verbose warning: `Skipping relationship for FK <constraintName>: referenced table <tableName> not discovered`

#### Scenario: Composite FK skipped with warning

- **WHEN** an FK constraint spans multiple columns (composite key)
- **THEN** the CLI SHALL skip emitting `@one()` / `@many()` decorators for that FK
- **AND** SHALL log a verbose warning: `Skipping composite FK <constraintName> on <tableName> (multi-column FKs not yet supported)`
- **AND** SHALL still store the FK data in metadata.json for future use

### Requirement: Schema.ts Updated with Relationship Imports

The generated `schema.ts` file SHALL include all entity classes including those involved in relationships.

**ID**: `SCHEMA-DISCOVERY-012`

#### Scenario: Schema.ts already imports all entities

- **WHEN** FK relationships exist between entities
- **THEN** the `schema.ts` file SHALL continue to import all entity classes as before
- **AND** the schema array SHALL include all entities regardless of relationships
- **AND** no additional changes to schema.ts generation are required
