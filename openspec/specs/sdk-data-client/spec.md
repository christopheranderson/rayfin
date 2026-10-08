# SDK Data Client Specification

## Purpose

The SDK Data Client (`@microsoft/rayfin-data`) provides type-safe interfaces for interacting with Data API Builder (DAB) endpoints from TypeScript applications.
It supports GraphQL access patterns, enabling Builders to query and mutate data with full TypeScript type checking and IntelliSense support.

## Requirements

### Requirement: Dual API Access Patterns

The system SHALL provide a GraphQL access pattern for data operations.

**Change**: Entity clients are now accessed directly via `client.data.Entity` instead of `client.data.gql.Entity`.

#### Scenario: Access entity client by name

- **WHEN** Builder accesses `client.data.EntityName` where EntityName is a key in the schema
- **THEN** the system returns a GraphQL entity client for that entity
- **AND** the client is cached for subsequent access

**Previous behavior**: Required `client.data.gql.EntityName` access pattern.

#### Scenario: Type-safe entity access

- **WHEN** Builder accesses `client.data.User` on a client typed with `{ User: UserType; Product: ProductType }`
- **THEN** TypeScript infers the return type as `GraphQLEntityClient<Schema, 'User'>`
- **AND** autocomplete suggests only `User` and `Product` as available properties

**Previous behavior**: Required `client.data.gql.User` with autocomplete under the `gql` namespace.

#### Scenario: Dynamic entity client creation

- **WHEN** Builder accesses an entity name for the first time
- **THEN** the system creates a new `GraphQLEntityClient` instance for that entity
- **AND** caches it for future access
- **AND** the client is configured with the correct GraphQL endpoint

**Previous behavior**: Proxy operated on `gql` property instead of direct `data` access.

### Requirement: GraphQL Fluent Query Building

The system SHALL provide a fluent interface for building type-safe GraphQL queries.

#### Scenario: Select specific fields

- **WHEN** Builder calls `client.data.User.select(['id', 'name', 'email'])`
- **THEN** the system builds a GraphQL query selecting only those fields
- **AND** TypeScript validates that field names exist on the entity type

#### Scenario: Filter with conditions

- **WHEN** Builder calls `client.data.User.where({ isActive: { eq: true } })`
- **THEN** the system builds a GraphQL filter with the specified condition
- **AND** supports nested field filters and logical operators (and, or)

#### Scenario: Sort results

- **WHEN** Builder calls `client.data.User.orderBy({ createdAt: 'desc' })`
- **THEN** the system builds a GraphQL query with orderBy directive
- **AND** supports multiple sort fields and ascending/descending order

#### Scenario: Paginate with cursor-based pagination

- **WHEN** Builder calls `client.data.User.first(10)` or `.after('cursor123').first(10)`
- **THEN** the system builds a GraphQL query with DAB cursor pagination
- **AND** returns results with proper pagination metadata

#### Scenario: Execute query and return results

- **WHEN** Builder calls `.execute()` on a query builder
- **THEN** the system sends the GraphQL query to the backend
- **AND** returns typed results matching the selected fields
- **AND** throws an error if the request fails

### Requirement: GraphQL Mutations

The system SHALL provide methods for creating, updating, and deleting entities via GraphQL mutations.

**Note**: The existing requirement is extended to clarify relationship handling.

#### Scenario: Create new entity with relationship via GraphQL

- **WHEN** Builder calls `client.data.User.create({ name: 'John', organization: orgReference })`
- **WHERE** `orgReference` is one of: full object, or `{ id: value }`
- **THEN** the system converts the relationship to a foreign key field (`organization_id`)
- **AND** sends a GraphQL mutation with the foreign key value
- **AND** returns the created entity with all fields

#### Scenario: Update existing entity with relationship via GraphQL

- **WHEN** Builder calls `client.data.User.update({ id: '123' }, { organization: newOrgReference })`
- **WHERE** `newOrgReference` is one of: full object, or `{ id: value }`
- **THEN** the system converts the relationship to a foreign key update
- **AND** sends a GraphQL mutation to update the entity

### Requirement: Proxy-based Dynamic Client Creation

The system SHALL use JavaScript Proxy to create entity clients on-demand without pre-generating client code.

**Change**: Proxy now operates directly on the `DataApi` instance instead of separate `rest` and `gql` namespaces.

#### Scenario: Dynamic GraphQL client generation

- **WHEN** Builder accesses any property on `client.data` object
- **THEN** the system intercepts the property access via Proxy
- **AND** creates a new `GraphQLEntityClient` if not already cached
- **AND** returns the client instance

**Previous behavior**: Proxy operated on `client.data.gql` namespace.

#### Scenario: TypeScript type safety with Proxy

- **WHEN** Builder uses a typed schema with the DataApi client
- **THEN** TypeScript provides autocomplete for entity names directly on `client.data`
- **AND** validates that accessed entity names exist in the schema type
- **AND** infers correct return types for entity clients

**Previous behavior**: TypeScript autocomplete worked on `client.data.gql` namespace.

### Requirement: Flexible Relationship Input Types

The system SHALL accept two input forms for relationship fields in mutation operations (create, update, upsert): a full entity object or an object containing only the primary key field(s).

**ID**: `REQ-SDK-DATA-FLEX-REL-INPUT`

**Note**: Initially, primary keys are assumed to be `id` or `Id`. The design supports future extension to custom primary key field names (e.g., `sku`, `email`, or composite keys like `order_id` + `product_id`).

#### Scenario: Create entity with relationship primary-key-only object

- **GIVEN** an entity `Todo` with a `@one(() => Category)` relationship field `category`
- **WHEN** Builder calls `client.data.Todo.create({ Title: 'My Todo', category: { id: 'cat-uuid-123' }, ... })`
- **THEN** the system generates a GraphQL mutation with `category_id: "cat-uuid-123"`
- **AND** the mutation executes successfully creating the todo with the category relationship

#### Scenario: Create entity with full relationship object (backward compatible)

- **GIVEN** an entity `Todo` with a `@one(() => Category)` relationship field `category`
- **WHEN** Builder calls `client.data.Todo.create({ Title: 'My Todo', category: { id: 'cat-123', name: 'Work', color: '#ff0000', user_id: 'u1' }, ... })`
- **THEN** the system extracts the `id` field and generates a GraphQL mutation with `category_id: "cat-123"`
- **AND** the mutation executes successfully (same as current behavior)

#### Scenario: Update entity with relationship ID-only object

- **GIVEN** an existing `Todo` entity
- **WHEN** Builder calls `client.data.Todo.update({ id: 'todo-1' }, { category: { id: 'new-cat-id' } })`
- **THEN** the system generates a GraphQL mutation updating `category_id` to `"new-cat-id"`

#### Scenario: Upsert entity with relationship ID-only object

- **GIVEN** the Builder has a category ID
- **WHEN** Builder calls `client.data.Todo.upsert({ id: 'todo-1' }, { Title: 'My Todo', category: { id: 'cat-id' } })`
- **THEN** the system generates a GraphQL upsert mutation with `category_id: "cat-id"`

#### Scenario: Optional relationship with null value

- **GIVEN** an entity `Todo` with an optional `@one(() => Category, { optional: true })` relationship
- **WHEN** Builder calls `client.data.Todo.update({ id: 'todo-1' }, { category: null })`
- **THEN** the system generates a GraphQL mutation setting `category_id` to `null`
- **AND** the relationship is removed from the todo

#### Scenario: Create entity with custom primary key relationship (future)

- **GIVEN** an entity `OrderItem` with a `@one(() => Product)` relationship where `Product` uses `sku` as primary key
- **WHEN** Builder calls `client.data.OrderItem.create({ quantity: 5, product: { sku: 'WIDGET-001' }, ... })`
- **THEN** the system generates a GraphQL mutation with `product_sku: "WIDGET-001"`
- **AND** the mutation executes successfully

**Note**: This scenario describes future behavior when custom primary key support is available.

### Requirement: Type-Safe Relationship Input Inference

The system SHALL provide TypeScript types that accept all valid relationship input forms with proper type checking.

**ID**: `REQ-SDK-DATA-FLEX-REL-TYPES`

#### Scenario: TypeScript accepts primary-key-only object for relationship field

- **GIVEN** a typed schema with `Todo` having `category: Category` relationship
- **WHEN** Builder writes `client.data.Todo.create({ category: { id: 'string-id' }, ... })`
- **THEN** TypeScript compiles without errors
- **AND** the `category` field type is inferred as `Category | { id: string }` (or `PrimaryKeyOnly<Category>`)

#### Scenario: TypeScript rejects invalid relationship input

- **GIVEN** a typed schema with `Todo` having `category: Category` relationship
- **WHEN** Builder writes `client.data.Todo.create({ category: 'string-id', ... })` (primitive string, not object)
- **THEN** TypeScript reports a type error
- **AND** the error indicates the expected types for the relationship field

#### Scenario: TypeScript autocomplete shows all options

- **GIVEN** a typed schema with relationship fields
- **WHEN** Builder triggers autocomplete on a relationship field in a create/update call
- **THEN** the IDE shows the union type indicating all valid input forms
- **AND** full object autocomplete still works when typing `{ }`

### Requirement: Fluent aggregation query building

The system SHALL provide a fluent aggregation interface on each entity client that groups rows by scalar fields and computes `sum`, `avg`, `min`, `max`, and `count` aggregations against a Rayfin SQL database.

The interface SHALL expose a `groupBy` step that accepts the scalar fields to group by, and an `aggregate` step that accepts the aggregations to compute.

#### Scenario: Group by scalar fields and compute aggregations

- **WHEN** a Builder calls `client.data.Order.groupBy(['region']).aggregate({ revenue: { sum: 'amount' }, orders: { count: 'id' } }).execute()`
- **THEN** the system builds a GraphQL query that selects `groupBy(fields: [region])` with a `fields` sub-selection of the grouped columns and an `aggregations` sub-selection containing `revenue: sum(field: amount)` and `orders: count(field: id)`
- **AND** returns one result entry per group

#### Scenario: Aggregate without grouping fields

- **WHEN** a Builder calls `.aggregate({ revenue: { sum: 'amount' } }).execute()` without a preceding `groupBy`
- **THEN** the system builds a GraphQL query with `groupBy` that omits the `fields` argument and omits the `fields` sub-selection
- **AND** returns a single grand-total group

### Requirement: Alias-keyed aggregation specification with exactly one operation per entry

The aggregation specification SHALL be keyed by Builder-chosen result aliases.
Each alias value SHALL be a single-operation object whose one key is an aggregation operation (`sum`, `avg`, `min`, `max`, or `count`) and whose value is either a field-name shorthand or an options object.

The type system SHALL enforce that each alias value specifies exactly one aggregation operation.

#### Scenario: Alias maps to a single aggregation

- **WHEN** a Builder writes `{ total: { sum: 'amount' } }`
- **THEN** the generated query contains `total: sum(field: amount)`
- **AND** the result exposes the aggregation under the `total` key

#### Scenario: Multiple aggregations of the same operation

- **WHEN** a Builder writes `{ revenue: { sum: 'amount' }, tax: { sum: 'tax' } }`
- **THEN** the generated query contains both `revenue: sum(field: amount)` and `tax: sum(field: tax)`
- **AND** the result exposes both `revenue` and `tax`

#### Scenario: Reject more than one operation in a single entry

- **WHEN** a Builder writes an alias value that specifies two operations, such as `{ x: { sum: 'amount', avg: 'amount' } }`
- **THEN** the type system rejects the specification at compile time

### Requirement: Aggregation options for having and distinct

Each aggregation SHALL accept the `having` and `distinct` arguments through an options object of the form `{ field, having?, distinct? }`, matching Data API Builder's aggregation field surface.

#### Scenario: Emit having filter on an aggregation

- **WHEN** a Builder writes `{ big: { max: { field: 'amount', having: { gt: 500 } } } }`
- **THEN** the generated query contains `big: max(field: amount, having: { gt: 500 })`

#### Scenario: Emit distinct on an aggregation

- **WHEN** a Builder writes `{ n: { count: { field: 'id', distinct: true } } }`
- **THEN** the generated query contains `n: count(field: id, distinct: true)`

### Requirement: Numeric-field type-safety for aggregations

The type system SHALL constrain the `field` of every aggregation operation (`sum`, `avg`, `min`, `max`, and `count`) to numeric fields of the entity, because Data API Builder types each aggregation's `field` argument as the `<Entity>NumericAggregateFields` enum and only generates the aggregations block when the entity has numeric fields.
The type system SHALL constrain `groupBy` fields to scalar fields of the entity.

#### Scenario: Reject a non-numeric field for a numeric aggregation

- **WHEN** a Builder writes `{ x: { sum: 'status' } }` where `status` is a string field
- **THEN** the type system rejects the specification at compile time

#### Scenario: Reject a non-numeric field for count

- **WHEN** a Builder writes `{ n: { count: 'status' } }` where `status` is a non-numeric field
- **THEN** the type system rejects the specification at compile time

#### Scenario: Reject an unknown field

- **WHEN** a Builder references a field that does not exist on the entity, such as `{ x: { avg: 'nope' } }`
- **THEN** the type system rejects the specification at compile time

### Requirement: Aggregation is emitted as a dedicated query without items

Because Data API Builder rejects a query that contains both `groupBy` and `items`, the system SHALL emit aggregation queries containing only `groupBy` and SHALL NOT include `items`, `endCursor`, or `hasNextPage` in an aggregation query.

#### Scenario: Aggregation query omits items

- **WHEN** the system builds an aggregation query
- **THEN** the query contains a `groupBy` selection
- **AND** the query does not contain an `items`, `endCursor`, or `hasNextPage` selection

### Requirement: Grouped result shape and unwrapping

The system SHALL return grouped aggregation results as an array of entries, where each entry exposes a `fields` object carrying the grouped column values and an `aggregations` object whose keys mirror the Builder-chosen aliases.

The `fields` sub-selection SHALL be derived from the `groupBy` argument so the selection and the grouping arguments never diverge.

#### Scenario: Unwrap the grouped response

- **WHEN** the server responds with `{ orders: { groupBy: [{ fields: { region: "West" }, aggregations: { revenue: 100 } }] } }`
- **THEN** the system returns `[{ fields: { region: "West" }, aggregations: { revenue: 100 } }]`

#### Scenario: fields selection matches the groupBy argument

- **WHEN** a Builder groups by `['region']`
- **THEN** the generated query selects `fields { region }`
- **AND** the selected fields match the fields passed to `groupBy`

### Requirement: Field references emitted as enum tokens

The system SHALL emit field references in the `groupBy(fields: [...])` argument and in each aggregation's `field` argument as unquoted GraphQL enum tokens, consistent with how `orderBy` emits enum values.

#### Scenario: Group and aggregate field names are unquoted

- **WHEN** the system builds an aggregation query grouping by `region` and summing `amount`
- **THEN** the generated query contains `groupBy(fields: [region])` and `sum(field: amount)` with unquoted field tokens

### Requirement: Aggregate result nullability

The system SHALL type `count` aggregations as `number` and SHALL type `sum`, `avg`, `min`, and `max` aggregations as `number | null`, because Data API Builder emits these aggregation fields as nullable and SQL returns `NULL` for them over an empty or all-null group.

#### Scenario: Numeric aggregation may be null

- **WHEN** a `sum`, `avg`, `min`, or `max` aggregation is requested
- **THEN** its result type is `number | null`

#### Scenario: Count is never null

- **WHEN** a `count` aggregation is requested
- **THEN** its result type is `number`

### Requirement: Aggregation is mutually exclusive with row operations

The system SHALL reject combining aggregation with row selection or pagination in the same query.
Calling `aggregate` together with `select`, `first`, `after`, or a row-level `orderBy` SHALL produce an error rather than an invalid query.

#### Scenario: Reject select combined with aggregate

- **WHEN** a Builder calls `.select([...])` and `.aggregate({...})` on the same query
- **THEN** the system reports an error indicating aggregation and row selection cannot be combined

#### Scenario: Reject pagination combined with aggregate

- **WHEN** a Builder calls `.first(n)` or `.after(cursor)` together with `.aggregate({...})`
- **THEN** the system reports an error

### Requirement: Runtime validation of the aggregation specification

Independent of the type system, the system SHALL validate the aggregation specification at runtime before emitting a query, because the type constraints can be bypassed by `any` casts or dynamically built specifications.

The system SHALL reject an empty specification, an entry that does not specify exactly one operation, an unknown operation, and any alias or field token that is not a valid GraphQL name.

#### Scenario: Reject an empty specification

- **WHEN** `.aggregate({})` is invoked
- **THEN** the system reports an error and does not emit a query

#### Scenario: Reject an entry with more than one operation at runtime

- **WHEN** a specification value contains more than one aggregation operation (for example via an `any`-typed object)
- **THEN** the system reports an error

#### Scenario: Reject an invalid alias or field token

- **WHEN** an alias or field token does not match the GraphQL name grammar (for example `bad-alias` or `__proto__`)
- **THEN** the system reports an error and does not emit the token into the query
