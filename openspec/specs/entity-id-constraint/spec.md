# Entity ID Constraint

## Requirements

### Requirement: IEntity interface contract

The system SHALL export an `IEntity` interface from `@microsoft/rayfin-core` that defines the structural contract for all entity classes.
The `IEntity` interface SHALL declare an optional property using the `PrimaryKeyField` type alias as the key name, typed as `string`.
The interface SHALL include an index signature to allow arbitrary additional properties.

#### Scenario: Entity with explicit string id satisfies IEntity

- **WHEN** a class declares `id` as `string` (e.g., `@uuid() id!: string`)
- **THEN** the class satisfies the `IEntity` contract
- **AND** no compile-time error is produced

#### Scenario: Entity without id property satisfies IEntity

- **WHEN** a class does not declare an `id` property at all
- **THEN** the class satisfies the `IEntity` contract because `id` is optional
- **AND** no compile-time error is produced

#### Scenario: Entity with numeric id fails IEntity

- **WHEN** a class declares `id` as `number` (e.g., `@int() id!: number`)
- **THEN** the class does NOT satisfy the `IEntity` contract
- **AND** TypeScript produces a compile-time type error at the `@entity()` decorator

#### Scenario: Entity with boolean id fails IEntity

- **WHEN** a class declares `id` as `boolean`
- **THEN** the class does NOT satisfy the `IEntity` contract
- **AND** TypeScript produces a compile-time type error at the `@entity()` decorator

### Requirement: DAB config generator uses id convention for primary key

The DAB config generator SHALL generate the primary key constraint using the value from `getPrimaryKeyField()` by convention rather than a hardcoded string literal.
The `inferPrimaryKey()` method SHALL determine primary key status by checking whether the field name equals the value returned by `getPrimaryKeyField()`.

#### Scenario: Entity with id field gets PK constraint

- **WHEN** an entity has a field named `id`
- **THEN** the DAB x-schema output includes a primary key constraint with `columns: ['id']`

#### Scenario: Entity without id field gets auto-generated id PK

- **WHEN** an entity does not declare an `id` field
- **THEN** the DAB x-schema output includes an auto-generated `id` field with the default primary key type
- **AND** a primary key constraint with `columns: ['id']` is added

#### Scenario: Non-id field is never treated as primary key

- **WHEN** an entity has fields named `sku`, `email`, or any name other than `id`
- **THEN** none of those fields generate a primary key constraint
- **AND** the system does not provide a mechanism to override this convention
