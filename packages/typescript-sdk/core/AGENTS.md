# @microsoft/rayfin-core Agent Instructions

This package contains TypeScript decorators that store runtime metadata for data model definition.
The Rayfin CLI reads this metadata to generate DAB-compliant configuration.

## Commands

Run these from `packages/typescript-sdk/core/`:

```bash
# Build and Test
rushx build              # Compile TypeScript
rushx test              # Run unit tests (decorator validation)
rushx test:coverage     # Run unit tests with coverage (prints the text coverage table)
rushx test:watch        # Watch mode for tests

# Verification (Integration)
# Integration fixtures removed; use unit tests and package consumers for validation

# DAB Validation (requires DAB CLI installed)
rushx dab:validate      # Validate generated config
rushx dab:start         # Start DAB server with generated config
rushx dab:clean         # Clean generated config files
```

## Architecture

**Runtime Metadata**: Decorators store metadata at runtime using `Symbol.metadata`.

- Type decorators (`@text()`, `@uuid()`, `@int()`, etc.) record field types in class metadata.
- The CLI reads this metadata to generate configuration.
- No `reflect-metadata` is used; relies on TC39 Stage 3 decorator metadata.

## Implementation Rules

1. **Metadata Storage**: Type decorators must store field metadata using `getEntityMetadataFromContext()`.

   ```typescript
   export function newTypeDecorator(options: SomeOptions = {}) {
     return function (_: any, context: ClassFieldDecoratorContext) {
       const config = getEntityMetadataFromContext(context);
       const fieldName = context.name.toString();
       const fieldMetadata: Partial<FieldMetadata<any>> = {
         ...options,
         format: 'type-name',
         jsType: 'JSType',
         isSystemType: false,
       };
       config.fields[fieldName] = upsertFieldMetadata(
         config.fields[fieldName],
         fieldMetadata
       );
     };
   }
   ```

2. **Type Definitions**: Add options interfaces extending `BaseFieldOptions` to `src/decorators/decorators.ts`.
3. **Exports**: Export new decorators from `src/index.ts`.

   `src/index.ts` re-exports `./schema.js` by an explicit named list rather than
   with `export *`. That is deliberate: the storage folder symbols
   (`RayfinStorageFolder`, `isRayfinStorageFolder`, `getStorageFolderMetadata`,
   `tryGetStorageFolderMetadata`, `StorageFolderClass`, `StorageFolderMetadata`)
   must stay off the stable surface while the storage service is not enabled in
   Fabric. They remain exported from the `@microsoft/rayfin-core/schema`
   subpath, which is the contract the CLI's config generators build against.

   Do not revert that to a wildcard, and do not restate this rationale in
   `src/index.ts`. The shared tsconfig sets `removeComments: false`, so any
   comment there ships verbatim in `dist/index.js` — the first file a consumer
   or coding agent reads — and would re-advertise the exact API this hides.

## Available Decorator Categories

- **Type Decorators**: `@text()`, `@uuid()`, `@int()`, `@decimal()`, `@boolean()`, `@date()`, `@set()`, `@email()`
- **Relationship Decorators**: `@one()`, `@many()` (pass `() => Target` for circular refs)
- **Permissions Decorators**: `@role()`, `@anonymous()`, `@authenticated()`
- **Class Decorators**: `@entity()`

## Decorator Usage Patterns

### Type Decorator Pattern

Use type-specific decorators instead of a generic `@field()`:

```typescript
import { entity, text, uuid, int, decimal, boolean, date, set } from '@microsoft/rayfin-core';

@entity()
export class MyEntity {
  @uuid() id!: string;
  @text() name!: string;
  @int() count!: number;
  @decimal() price!: number;
  @boolean() active!: boolean;
  @date() createdAt!: Date;
  @set('a', 'b', 'c') status!: 'a' | 'b' | 'c';
  @text({ optional: true }) description?: string;
}
```

### Permissions Decorator Pattern

Only built-in roles are supported: `'anonymous'` and `'authenticated'`.

- `@role()` is class-only.
- The `policy` callback uses the typed policy DSL and compiles to a DAB policy string.
- Use `include` and `exclude` on the role options for field visibility.

The `@anonymous()` shorthand and the `@role('anonymous', …)` overload are part of the stable `@microsoft/rayfin-core` surface. `@anonymous(...)` and `@role('anonymous', …)` grant public, unauthenticated access to an entity.

```typescript
import { entity, anonymous, authenticated, uuid, text } from '@microsoft/rayfin-core';

@entity()
@anonymous('read')
@authenticated('*', {
  policy: (claims, item) => claims.sub.eq(item.owner_id),
  exclude: ['secret'],
})
class Document {
  @uuid() id!: string;
  @text() owner_id!: string;
  @text() title!: string;
  @text({ optional: true }) secret?: string;
}
```

### Relationship Decorators

Use `@one()` and `@many()` (pass `() => Target` for circular references):

```typescript
import { entity, uuid, one, many } from '@microsoft/rayfin-core';

@entity()
export class Parent {
  @uuid() id!: string;
  @many(() => Child) children?: Child[];
}

@entity()
export class Child {
  @uuid() id!: string;
  @one(() => Parent) parent!: Parent;
}
```

## Development Workflow

When adding a new decorator:

1. **Define**: Add the decorator function in `src/decorators/decorators.ts` with proper metadata storage.
2. **Test**: Add unit tests in `src/__tests__/` to verify decorator behavior.
3. **Sample**: Update samples under `samples/` to demonstrate usage.
4. **Verify**: Run `rushx test` to validate decorator functionality.

## Testing Strategy

- **Unit Tests**: Verify decorators store correct metadata and can be applied without errors.
- **Integration Tests**: Run against samples to verify end-to-end config generation.
- **Samples**: `samples/todo-app` and `samples/welcome-app-*` are the source of truth for supported patterns.

## Key Files

- `src/decorators/decorators.ts`: Decorator implementations with metadata storage.
- `src/schema.ts`: Metadata type definitions and helper functions.
- `src/options.ts`: Permission configuration types (roles, actions, typed policy options).
- `src/policy.ts`: Typed policy DSL used by `@role()`.
- `src/analysis/`: Runtime metadata analysis utilities.
