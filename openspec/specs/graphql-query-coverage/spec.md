# graphql-query-coverage Specification

## Purpose

Add unit and e2e testing for the Rayfin data and client.

## Requirements

### Requirement: Unit tests SHALL validate all string filter operators

The test suite SHALL include unit tests for all string filter operators defined in `StringFilterInput` type that validate DAB-compliant query generation.

#### Scenario: NOT EQUAL string filter

**Given** a query with `neq` string filter
**When** the query is built
**Then** the generated GraphQL contains `fieldName: { neq: "value" }`
**And** the query passes DAB compliance validation

#### Scenario: GREATER THAN string filter

**Given** a query with `gt` string filter
**When** the query is built
**Then** the generated GraphQL contains `fieldName: { gt: "value" }`

#### Scenario: GREATER THAN OR EQUAL string filter

**Given** a query with `gte` string filter
**When** the query is built
**Then** the generated GraphQL contains `fieldName: { gte: "value" }`

#### Scenario: LESS THAN string filter

**Given** a query with `lt` string filter
**When** the query is built
**Then** the generated GraphQL contains `fieldName: { lt: "value" }`

#### Scenario: LESS THAN OR EQUAL string filter

**Given** a query with `lte` string filter
**When** the query is built
**Then** the generated GraphQL contains `fieldName: { lte: "value" }`

#### Scenario: NOT CONTAINS string filter

**Given** a query with `notContains` string filter
**When** the query is built
**Then** the generated GraphQL contains `fieldName: { notContains: "value" }`

#### Scenario: STARTS WITH string filter

**Given** a query with `startsWith` string filter
**When** the query is built
**Then** the generated GraphQL contains `fieldName: { startsWith: "value" }`

#### Scenario: ENDS WITH string filter

**Given** a query with `endsWith` string filter
**When** the query is built
**Then** the generated GraphQL contains `fieldName: { endsWith: "value" }`

#### Scenario: IS NULL string filter

**Given** a query with `isNull: true` string filter
**When** the query is built
**Then** the generated GraphQL contains `fieldName: { isNull: true }`

---

### Requirement: Unit tests SHALL validate all number filter operators

The test suite SHALL include unit tests for all number filter operators defined in `NumberFilterInput` type.

#### Scenario: EQUAL number filter

**Given** a query with `eq` number filter
**When** the query is built
**Then** the generated GraphQL contains `fieldName: { eq: 42 }`
**And** the value is unquoted

#### Scenario: NOT EQUAL number filter

**Given** a query with `neq` number filter
**When** the query is built
**Then** the generated GraphQL contains `fieldName: { neq: 100 }`

#### Scenario: GREATER THAN number filter

**Given** a query with `gt` number filter
**When** the query is built
**Then** the generated GraphQL contains `fieldName: { gt: 50 }`

#### Scenario: GREATER THAN OR EQUAL number filter

**Given** a query with `gte` number filter
**When** the query is built
**Then** the generated GraphQL contains `fieldName: { gte: 25 }`

#### Scenario: LESS THAN number filter

**Given** a query with `lt` number filter
**When** the query is built
**Then** the generated GraphQL contains `fieldName: { lt: 75 }`

#### Scenario: LESS THAN OR EQUAL number filter

**Given** a query with `lte` number filter
**When** the query is built
**Then** the generated GraphQL contains `fieldName: { lte: 90 }`

#### Scenario: IS NULL number filter

**Given** a query with `isNull: true` number filter
**When** the query is built
**Then** the generated GraphQL contains `fieldName: { isNull: true }`

---

### Requirement: Unit tests SHALL validate all boolean filter operators

The test suite SHALL include unit tests for boolean filter operators defined in `BooleanFilterInput` type beyond the currently tested `eq` operator.

#### Scenario: NOT EQUAL boolean filter

**Given** a query with `neq` boolean filter
**When** the query is built
**Then** the generated GraphQL contains `fieldName: { neq: "false" }`
**And** the boolean value is serialized as a quoted string per DAB spec

#### Scenario: IS NULL boolean filter

**Given** a query with `isNull: true` boolean filter
**When** the query is built
**Then** the generated GraphQL contains `fieldName: { isNull: true }`

---

### Requirement: Unit tests SHALL validate all date filter operators

The test suite SHALL include unit tests for all date filter operators defined in `DateFilterInput` type.

#### Scenario: EQUAL date filter

**Given** a query with `eq` date filter
**When** the query is built
**Then** the generated GraphQL contains `fieldName: { eq: "2024-01-01T00:00:00.000Z" }`
**And** the date is serialized as ISO string

#### Scenario: NOT EQUAL date filter

**Given** a query with `neq` date filter
**When** the query is built
**Then** the generated GraphQL contains `fieldName: { neq: "2024-01-01T00:00:00.000Z" }`

#### Scenario: GREATER THAN date filter

**Given** a query with `gt` date filter
**When** the query is built
**Then** the generated GraphQL contains `fieldName: { gt: "2024-01-01T00:00:00.000Z" }`

#### Scenario: LESS THAN date filter

**Given** a query with `lt` date filter
**When** the query is built
**Then** the generated GraphQL contains `fieldName: { lt: "2024-12-31T23:59:59.999Z" }`

#### Scenario: LESS THAN OR EQUAL date filter

**Given** a query with `lte` date filter
**When** the query is built
**Then** the generated GraphQL contains `fieldName: { lte: "2024-12-31T23:59:59.999Z" }`

#### Scenario: IS NULL date filter

**Given** a query with `isNull: true` date filter
**When** the query is built
**Then** the generated GraphQL contains `fieldName: { isNull: true }`

---

### Requirement: Unit tests SHALL validate the logical NOT operator

The test suite SHALL include unit tests for the `not` logical operator which is implemented in `GraphQLQueryBuilder` but not currently tested.

#### Scenario: Simple NOT filter

**Given** a query with `not` wrapping a simple condition
**When** the query is built using `.where({ not: { isCompleted: { eq: true } } })`
**Then** the generated GraphQL contains `filter: { not: { isCompleted: { eq: "true" } } }`

#### Scenario: NOT with AND combination

**Given** a query with `not` wrapping multiple `and` conditions
**When** the query is built
**Then** the generated GraphQL correctly nests `not: { and: [...] }`

#### Scenario: NOT with OR combination

**Given** a query with `not` wrapping multiple `or` conditions
**When** the query is built
**Then** the generated GraphQL correctly nests `not: { or: [...] }`

---

### Requirement: Unit tests SHALL validate nested logical operators

The test suite SHALL include unit tests for complex filter combinations with 3+ nesting levels.

#### Scenario: Three-level nesting with mixed operators

**Given** a query with `and` containing `or` containing `not`
**When** the query is built
**Then** the generated GraphQL correctly represents all three levels
**And** operator precedence is maintained

#### Scenario: Multiple NOT operators at different levels

**Given** a query with `not` at root level and nested inside `and`
**When** the query is built
**Then** each `not` is correctly positioned in the filter tree

---

### Requirement: Unit tests SHALL validate backward pagination

The test suite SHALL include unit tests for backward pagination using `last()` and `before()` methods which are currently untested.

#### Scenario: LAST only pagination

**Given** a query with `.last(10)`
**When** the query is built
**Then** the generated GraphQL contains `last: 10` parameter

#### Scenario: BEFORE cursor pagination

**Given** a query with `.before("cursor_xyz")`
**When** the query is built
**Then** the generated GraphQL contains `before: "cursor_xyz"` parameter

#### Scenario: Combined LAST and BEFORE pagination

**Given** a query with `.last(20).before("cursor_end")`
**When** the query is built
**Then** the generated GraphQL contains both `last: 20, before: "cursor_end"` parameters

---

### Requirement: Unit tests SHALL validate deep nested field selection

The test suite SHALL include unit tests for field selection with 3+ nesting levels.

#### Scenario: Three-level nested field selection

**Given** a query selecting `user.profile.address.city`
**When** the query is built
**Then** the generated GraphQL has correct nested structure with three levels

#### Scenario: Multiple deep paths in same query

**Given** a query selecting `user.profile.address.city` and `user.profile.phone.number`
**When** the query is built
**Then** both paths are correctly represented without duplication

---

### Requirement: Unit tests SHALL validate collection relationship selection

The test suite SHALL include unit tests for one-to-many relationship field selection that generates DAB-compliant Connection wrapper structure.

#### Scenario: Select fields from one-to-many collection

**Given** a Category entity with `todos` collection relationship
**When** selecting `todos.title` and `todos.isCompleted`
**Then** the generated GraphQL contains `todos { items { title isCompleted } }`
**And** the `items` wrapper is correctly inserted

#### Scenario: Mixed scalar and collection selection

**Given** a query selecting both scalar fields and collection fields
**When** the query is built
**Then** scalar fields are selected directly and collections use `items` wrapper

---

### Requirement: Unit tests SHALL validate all query method variations

The test suite SHALL include unit tests for all `GraphQLEntityClient` query methods including `findFirst`, `findMany`, and `findByPk`.

#### Scenario: findFirst query generation

**Given** a call to `.findFirst(filter)`
**When** the query is built internally
**Then** the generated GraphQL includes `first: 1` pagination parameter

#### Scenario: findMany with complex filter

**Given** a call to `.findMany()` with nested `and`/`or` filters
**When** the query is built
**Then** the filter is correctly applied to the query

#### Scenario: findByPk with string ID

**Given** a call to `.findByPk("todo-123")`
**When** the query is built
**Then** the query name is `{entityName}_by_pk` with lowercase first letter
**And** the ID parameter is quoted: `id: "todo-123"`

#### Scenario: findByPk with numeric ID

**Given** a call to `.findByPk(42)`
**When** the query is built
**Then** the ID parameter is unquoted: `id: 42`

---

### Requirement: Unit tests SHALL validate empty and minimal queries

The test suite SHALL include unit tests for queries with minimal or no configuration to document default behavior.

#### Scenario: Empty query with no filters or selection

**Given** a query with no `.where()`, `.select()`, or pagination
**When** the query is built
**Then** the generated GraphQL selects only the `id` field by default

#### Scenario: Query with only orderBy

**Given** a query with only `.orderBy()` and no filters
**When** the query is built
**Then** the query is valid and includes orderBy parameter

---

### Requirement: Unit tests SHALL validate query execution methods

The test suite SHALL include unit tests for `execute()`, `executePaginated()`, and `count()` methods that verify client invocation and response unwrapping.

#### Scenario: execute() method unwraps items array

**Given** a query builder with filters configured
**When** `.execute()` is called
**Then** the method calls `client.query()` with the generated query
**And** the response is unwrapped to return only the items array
**And** nested connections are unwrapped (e.g., `categories.items` becomes `categories`)

#### Scenario: executePaginated() returns PagedResult

**Given** a query builder with pagination configured
**When** `.executePaginated()` is called
**Then** the method calls `client.query()` with pagination query
**And** the response includes `items`, `pageInfo`, `totalCount` as PagedResult type

#### Scenario: executePaginated() unwraps nested connections

**Given** a paginated query selecting collection relationships
**When** `.executePaginated()` is called
**Then** nested collection fields have their `items` wrapper removed
**And** the parent response maintains its pagination structure

#### Scenario: count() method returns totalCount

**Given** a query builder with filters configured
**When** `.count()` is called
**Then** the method calls `client.query()` with count query (no pagination)
**And** the response is unwrapped to return only the numeric totalCount

#### Scenario: execute() handles empty results

**Given** a query that returns no matching items
**When** `.execute()` is called
**Then** the method returns an empty array `[]` without throwing

#### Scenario: executePaginated() handles last page

**Given** a query on the last page of results
**When** `.executePaginated()` is called
**Then** `pageInfo.hasNextPage` is `false`
**And** `pageInfo.endCursor` is the last item's cursor

---

### Requirement: Unit tests SHALL validate mutation null value handling

The test suite SHALL include unit tests for mutations with explicit null values to verify correct serialization.

#### Scenario: Create mutation with null optional field

**Given** a create mutation with `description: null`
**When** the mutation is built
**Then** the generated GraphQL contains `description: null` (unquoted)

#### Scenario: Update mutation setting field to null

**Given** an update mutation with `dueDate: null`
**When** the mutation is built
**Then** the generated GraphQL contains `dueDate: null`

---

### Requirement: Unit tests SHALL validate multiple relationship mutations

The test suite SHALL include unit tests for entities with multiple foreign keys to verify all `_id` fields are generated correctly.

#### Scenario: Create with two relationship fields

**Given** an entity with both `user` and `category` relationships
**When** creating with both relationship objects provided
**Then** the mutation contains both `user_id` and `category_id` parameters

#### Scenario: Create with ID-only relationship shorthand

**Given** a create mutation using relationship objects with only `id` fields
**When** the mutation is built
**Then** each relationship object SHALL be mapped to its `<relationship>_id` field in GraphQL input

#### Scenario: Update with ID-only relationship shorthand

**Given** an update mutation that changes a relationship using `{ id: '...' }`
**When** the mutation is built
**Then** the generated GraphQL input SHALL contain the updated foreign key field

#### Scenario: Relationship can be cleared with null

**Given** an update mutation with a nullable relationship set to `null`
**When** the mutation is built
**Then** the generated GraphQL input SHALL set the corresponding foreign key field to `null`

#### Scenario: Invalid relationship object without id is rejected

**Given** a mutation relationship object missing an `id` or `Id` field
**When** the mutation is validated or formatted
**Then** the operation SHALL fail with a descriptive error indicating relationship ID is required

---

### Requirement: Unit tests SHALL validate upsert operations

The test suite SHALL include unit tests for the `upsert()` method which combines update with fallback to create.

#### Scenario: Upsert on existing entity

**Given** an upsert call where the entity exists
**When** the operation executes
**Then** an update mutation is generated

#### Scenario: Upsert on non-existent entity

**Given** an upsert call where the entity does not exist (404)
**When** the operation executes
**Then** a create mutation is generated with the create input

---

### Requirement: Unit tests SHALL document edge cases with boundary tests

The test suite SHALL include unit tests for boundary conditions and unusual inputs to define behavior.

#### Scenario: Very long string value

**Given** a filter with a 1000+ character string value
**When** the query is built
**Then** the string is properly escaped and quoted

#### Scenario: Special characters in string values

**Given** a filter with values containing quotes, newlines, backslashes
**When** the query is built
**Then** all special characters are escaped per GraphQL spec

#### Scenario: Extreme date values

**Given** filters with dates far in past (year 1900) or future (year 2100)
**When** the query is built
**Then** dates are serialized as valid ISO strings

#### Scenario: Empty string vs null vs undefined

**Given** filters with empty string `""`, null, and undefined values
**When** the query is built
**Then** each case is handled distinctly:
- Empty string becomes `""`
- Null becomes `null`
- Undefined is omitted from query

---

### Requirement: Documentation SHALL track test coverage comprehensively

The test suite SHALL include a coverage matrix document that tracks which features are tested at both unit and E2E levels.

#### Scenario: Coverage matrix exists

**Given** the test suite is implemented
**When** a developer reviews test coverage
**Then** a `test-coverage-matrix.md` file exists in the test directory
**And** it lists all filter operators by type
**And** it shows percentage coverage per category
**And** it distinguishes between unit test and E2E test coverage
**And** it links to specific test files for each feature

#### Scenario: Coverage matrix is accurate

**Given** new tests are added
**When** the coverage matrix is reviewed
**Then** it reflects the current test suite
**And** any missing coverage is clearly identified

---

### Requirement: E2E tests SHALL validate query execution against real database

The test suite SHALL include E2E tests that execute all query builder operations against an actual Rayfin backend with SQL database.

#### Scenario: E2E test infrastructure is available

**Given** the todo-app sample has E2E test infrastructure
**When** query builder E2E tests are run
**Then** tests use `e2e/shared/backend.ts` to manage Rayfin backend lifecycle
**And** tests use `e2e/shared/client-factory.ts` to create authenticated Rayfin clients
**And** tests execute against real SQL database with Docker/Azurite

#### Scenario: String filters execute correctly against database

**Given** todos exist in database with known titles
**When** querying with `.where({ title: { contains: 'test' } })`
**Then** the query executes successfully via DAB
**And** only todos with 'test' in title are returned
**And** results can be verified against seeded test data

#### Scenario: Numeric filters execute correctly against database

**Given** todos exist with different priority values
**When** querying with `.where({ priority: { eq: 'high' } })`
**Then** only high-priority todos are returned from database

#### Scenario: Date range filters execute correctly

**Given** todos exist with various due dates
**When** querying with `.where({ dueDate: { gte: new Date('2024-01-01'), lte: new Date('2024-12-31') } })`
**Then** only todos within date range are returned
**And** date serialization through DAB is validated

#### Scenario: Pagination returns valid cursors

**Given** 50 todos exist in database
**When** querying with `.first(10)`
**Then** exactly 10 results are returned
**And** `endCursor` is a valid cursor string
**And** `hasNextPage` is true
**And** subsequent query with `.after(endCursor)` returns next page

#### Scenario: Backward pagination works with real cursors

**Given** multiple pages of todos exist
**When** querying with `.last(5).before(cursor)`
**Then** correct page of results is returned
**And** cursors are valid for subsequent queries

#### Scenario: Nested relationships are populated

**Given** todos have associated categories and users
**When** selecting `['title', 'category.name', 'user.email']`
**Then** related data is correctly joined and returned
**And** nested objects contain expected field values

#### Scenario: execute() returns items from database

**Given** a query builder configured with filters
**When** calling `.execute()` method
**Then** the method executes against real database via DAB
**And** returns unwrapped array of items matching filters
**And** nested collections have `items` wrapper removed

#### Scenario: executePaginated() returns accurate metadata

**Given** 25 todos exist in database
**When** calling `.executePaginated()` with `.first(10)`
**Then** returns 10 items
**And** `pageInfo.hasNextPage` is true
**And** `pageInfo.endCursor` is valid for next query
**And** `totalCount` is 25

#### Scenario: executePaginated() returns accurate metadata on second query

**Given** 25 todos exist in database
**When** calling `.executePaginated()` with `pageInfo.endCursor` from previous query with `.first(10)`
**Then** returns the next 10 items
**And** `pageInfo.hasNextPage` is true
**And** `pageInfo.endCursor` is valid for next query
**And** `totalCount` is 25

#### Scenario: executePaginated() on last page

**Given** a paginated query on the final page
**When** calling `.executePaginated()`
**Then** `pageInfo.hasNextPage` is false
**And** `pageInfo.endCursor` is the last cursor
**And** subsequent query with that cursor returns empty

#### Scenario: count() returns accurate total

**Given** 15 todos match a filter
**When** calling `.count()` with that filter
**Then** returns exactly 15
**And** no pagination parameters are sent to DAB
**And** count matches manual verification query

#### Scenario: execute() handles empty results

**Given** no todos match a filter
**When** calling `.execute()`
**Then** returns empty array `[]` without error
**And** no exception is thrown

#### Scenario: Create mutation persists to database

**Given** a create mutation with valid todo data
**When** executing `rayfinClient.data.gql.Todo.create({ title: 'E2E Test', ... })`
**Then** mutation succeeds and returns created entity with ID
**And** subsequent query finds the newly created todo in database

#### Scenario: Update mutation modifies database record

**Given** an existing todo in database
**When** executing update mutation with new values
**Then** mutation succeeds
**And** subsequent query shows updated values

#### Scenario: Delete mutation removes database record

**Given** an existing todo in database
**When** executing delete mutation
**Then** mutation succeeds
**And** subsequent query returns null/empty for that ID

#### Scenario: Upsert works against real database

**Given** an entity that may or may not exist
**When** executing upsert operation
**Then** update is attempted first
**And** if not found, create is executed
**And** final state is verified in database

#### Scenario: Complex logical filters execute correctly

**Given** diverse todo data in database
**When** querying with nested `and`/`or`/`not` filters
**Then** correct subset of todos is returned
**And** results match expected filter logic

#### Scenario: Test isolation is maintained

**Given** multiple E2E tests running in parallel
**When** each test uses unique user credentials
**Then** tests do not interfere with each other's data
**And** each test sees only its own todos/categories

### Requirement: Unit tests SHALL validate aggregation query generation

The test suite SHALL include unit tests that validate DAB-compliant GraphQL generation for the aggregation query surface.

#### Scenario: groupBy with aliased aggregations

- **WHEN** a query groups by one or more scalar fields and requests aliased aggregations
- **THEN** the generated GraphQL contains `groupBy(fields: [<fields>])` with a `fields` sub-selection and an `aggregations` sub-selection using the Builder-chosen aliases
- **AND** the query passes DAB compliance validation

#### Scenario: Each aggregation operation generates the expected field

- **WHEN** a query requests `sum`, `avg`, `min`, `max`, or `count`
- **THEN** the generated GraphQL contains the corresponding `<alias>: <op>(field: <fieldName>)` selection with an unquoted field token

#### Scenario: having and distinct arguments are emitted

- **WHEN** an aggregation includes a `having` filter or `distinct` flag
- **THEN** the generated GraphQL contains the `having` filter object and the `distinct` argument on that aggregation

#### Scenario: Aggregation query omits items

- **WHEN** an aggregation query is generated
- **THEN** the generated GraphQL contains `groupBy`
- **AND** the generated GraphQL does not contain `items`, `endCursor`, or `hasNextPage`

### Requirement: Unit tests SHALL validate grouped-response unwrapping

The test suite SHALL include unit tests that validate unwrapping of the grouped aggregation response into the SDK result shape.

#### Scenario: Grouped response is unwrapped to entries

- **WHEN** the server returns a `groupBy` array of `{ fields, aggregations }` objects
- **THEN** the SDK returns an array of entries preserving `fields` and `aggregations` with alias keys intact

### Requirement: Type-safety tests SHALL validate aggregation compile-time constraints

The test suite SHALL include type-level tests that validate the compile-time constraints of the aggregation surface.

#### Scenario: Reject multiple operations in a single entry

- **WHEN** an aggregation entry specifies more than one operation
- **THEN** the type-level test asserts a compile-time type error

#### Scenario: Reject non-numeric field for a numeric aggregation

- **WHEN** a `sum`, `avg`, `min`, or `max` aggregation references a non-numeric field
- **THEN** the type-level test asserts a compile-time type error

#### Scenario: Accept a valid aggregation specification

- **WHEN** an aggregation specification uses a single operation per entry with numeric fields for numeric operations
- **THEN** the type-level test asserts the specification type-checks and infers the expected result shape
