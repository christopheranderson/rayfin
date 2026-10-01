# PK Resolution Strategy

## Requirements

### Requirement: PrimaryKeyField type alias

The system SHALL export a `PrimaryKeyField` type alias from `@microsoft/rayfin-core` that resolves to the string literal type `'id'`.
All type-level references to the primary key field name across `@microsoft/rayfin-core` and `@microsoft/rayfin-data` SHALL use `PrimaryKeyField` instead of hardcoded `'id'` string literals.

#### Scenario: PrimaryKeyField resolves to id

- **WHEN** a consumer imports `PrimaryKeyField` from `@microsoft/rayfin-core`
- **THEN** the type resolves to the string literal type `'id'`
- **AND** it can be used in type positions like `Omit<T, PrimaryKeyField>`

#### Scenario: PrimaryKeyField is a single source of truth for types

- **WHEN** a developer searches for all type-level references to the PK field name
- **THEN** all such references use `PrimaryKeyField` rather than inline `'id'` literals
- **AND** changing `PrimaryKeyField` to a different string (e.g., `'pk'`) causes compile errors at every dependent type

### Requirement: getPrimaryKeyField runtime function

The system SHALL export a `getPrimaryKeyField()` function from `@microsoft/rayfin-core` that returns the canonical primary key field name as a string.
All runtime references to the primary key field name across `@microsoft/rayfin-core` analysis/codegen layers and `@microsoft/rayfin-data` client code SHALL call `getPrimaryKeyField()` instead of using hardcoded `'id'` string literals.

#### Scenario: getPrimaryKeyField returns id

- **WHEN** `getPrimaryKeyField()` is called at runtime
- **THEN** it returns the string `'id'`

#### Scenario: getPrimaryKeyField is used in inference engine

- **WHEN** `TypeInferenceEngine.inferPrimaryKey()` checks whether a field is the primary key
- **THEN** it compares `fieldName` against the value returned by `getPrimaryKeyField()`
- **AND** does not use a hardcoded `'id'` string literal

#### Scenario: getPrimaryKeyField is used in schema analyzer

- **WHEN** `SchemaAnalyzer.analyzeField()` sets the `referencedField` for foreign keys
- **THEN** it uses the value from `getPrimaryKeyField()` instead of the literal `'id'`

#### Scenario: getPrimaryKeyField is used in DAB config generator

- **WHEN** the DAB config generator constructs `source.fields` or `target.fields` for relationships
- **THEN** it passes `getPrimaryKeyField()` to `getFieldNameForEntity()` instead of the literal `'id'`

#### Scenario: getPrimaryKeyField is used in data client

- **WHEN** `GraphQLEntityClient` builds queries or mutations referencing the primary key
- **THEN** it uses `getPrimaryKeyField()` for field names in `getDefaultFields()`, `findById()` queries, and mutation construction
- **AND** does not use hardcoded `'id'` string literals

### Requirement: System User entity preserves Id casing

The `getPrimaryKeyField()` function SHALL return `'id'` (lowercase) as the canonical PK field name.
The system `User` entity's PascalCase `Id` column SHALL continue to be handled by the existing `getSystemUserFieldName()` mapping, which translates `'id'` → `'Id'` for the User entity specifically.
The `isRelationshipObject()` and `getRelationshipId()` methods SHALL continue to check for both `'id'` and `'Id'` to support relationships referencing the system `User` entity.

#### Scenario: User entity FK references use Id casing

- **WHEN** an entity has a `@one(() => User)` relationship
- **THEN** the DAB config generator produces `target.fields: ['Id']` (PascalCase)
- **AND** the `getSystemUserFieldName()` mapping converts the canonical `'id'` to `'Id'`

#### Scenario: Relationship object detection handles User Id

- **WHEN** a mutation input includes a relationship object with `{ Id: 'user-uuid' }` (from a User reference)
- **THEN** `isRelationshipObject()` detects it as a relationship object
- **AND** `getRelationshipId()` extracts `'user-uuid'` from the `Id` property
