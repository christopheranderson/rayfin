# @microsoft/fabric-user-data-functions Agent Instructions

TypeScript worker extension for Microsoft Fabric User Data Functions (UDFs). It provides
the `udf.func()` authoring surface, `RayfinContext`, the `AudienceType` connection model,
and the AST-based typegen that emits `types.ts`. See [README.md](./README.md) for the
package overview and license.

## Commands

This is a standalone npm package (not a Rush project). Run from
`packages/udf/udf-worker-extension/`:

```bash
npm install
npm run build          # tsc
npm run build:watch    # tsc --watch
npm run test           # jest (ESM)
npm run lint           # tsc --noEmit (src) + tsc --noEmit -p tsconfig.test.json (tests)
npm run lint:tests     # type-check the test files only
npm pack               # produce the .tgz consumed by scaffolded apps
```

> **`npm test` does not type-check.** The shared base config sets
> `isolatedModules: true`, so ts-jest transpiles without diagnostics — a test file
> containing `const x: number = 'nope'` still passes. `tsconfig.json` also excludes
> `src/**/__tests__/**`, so `npm run build` skips them too. `npm run lint` is the
> only thing that type-checks tests, via `tsconfig.test.json`. This matters because
> several suites assert *compile-time* behaviour with `@ts-expect-error`; those
> assertions are inert unless a real `tsc` pass reads them.

## Architecture

- **Authoring surface** (`src/userDataFunctions.ts`, `src/index.ts`): the `udf.func()`
  registration API exposed to app authors.
- **Context** (`src/types/rayfinContext.ts`): `RayfinContext` — per-invocation tokens,
  secrets, and the Rayfin endpoint. In deployed mode values arrive via request headers; in
  local dev they fall back to `process.env` (seeded from `local.settings.json`).
- **Connections** (`src/types/connection.ts`, `src/types/audienceScopes.ts`): the
  `AudienceType` enum and its per-audience OBO scope overrides.
- **Typegen** (`src/astparser.ts`, `src/internal/*`): parses handler type annotations and
  emits `types.ts`. Annotations are captured as literal text, so handler parameter/return
  types must be inline structural types, not named imports.

## Connection type safety

Generic connections are declared on the handler's context annotation, not in the
`connections` array:

```ts
udf.func(
  'myFunc',
  async (ctx: RayfinContext<DataModel, AudienceType.Sql | AudienceType.Storage>) => {
    ctx.getToken(AudienceType.AzureAI);  // compile error — not declared
    const token: string = ctx.getToken(AudienceType.Sql);
  },
  [] // or omit entirely
);
```

`RayfinContext<TSchema, TokenTypes>` takes the audience union as its second type
parameter, defaulting to `never` — so a handler that declares nothing cannot call
`getToken` at all.

**Type arguments are erased before the worker runs**, so the audiences have to be
recovered at build time. The CLI resolves them with its type checker and writes
them to runtime metadata as `functions[].contextAudiences`; the worker reads that
array and never needs the TypeScript compiler at runtime. Deploy metadata carries
the same audiences as `FabricItem` bindings:

| Stage | Where | Source |
|---|---|---|
| Deploy `FabricItem` bindings | `tools/cli/src/utils/functions-metadata-generator.ts` | `TypeChecker` via `functions-context-audiences.ts` |
| Worker input bindings | `UserDataFunctions.resolveMetadataAudiences` | `functions[].contextAudiences` |

**`typescript` must stay out of the import graph entirely.** Deployed function
apps are bundled without it (see the CLI's `functions-bundler.ts`), so nothing
reachable from `userDataFunctions.ts` may import `typescript` or
`internal/contextAudiences.ts` — statically *or* dynamically. There is no
runtime fallback that parses TypeScript: runtime metadata is the only source of
delegate parameters and audiences. `src/astparser.ts` and
`internal/contextAudiences.ts` survive only as the CLI-parity oracle in tests
and are unreachable from `index.ts`. `runtimeMetadataGolden.test.ts` mocks
`typescript` to throw, so a static import fails that test.

`runtimemetadata.json` is at schema `2.0`. The version is a dotted
`major.minor` string, and the worker accepts it when the **major matches**
`MINIMUM_RUNTIME_METADATA_SCHEMA_VERSION` exactly and the **minor is greater
than or equal to** it. So a newer CLI paired with an older worker still loads
across a minor bump, but a differing major is rejected in either direction —
the worker cannot interpret a schema it predates, and must not guess at one it
postdates. Compare the parsed integers, never the strings:
`'2.15' < '2.9'` lexicographically.

That tolerance only holds from the `2.0` floor forward. Every worker published
**before** `2.0` compares with `===` and, on a mismatch, falls back to
TypeScript source analysis — which the deploy bundle deliberately does not
carry, so its entry point fails to load and the host reports "No job functions
found". The CLI therefore refuses to deploy against such a worker; see
`functions-worker-compat.ts`. Practically: **roll the worker out before or
alongside the CLI**, never after.

The `2.0` bump exists because `contextAudiences` became a guaranteed field.
With source analysis gone the worker cannot recover audiences from a `1.0`
file, so connections would silently resolve to none; the gate rejects it
outright and the instance enters the error state described below, naming the
required version and telling the user to upgrade the CLI.

`FUNCTION_KEYS` is a closed allowlist, so a new field makes new metadata
**invalid** for an already-deployed worker. Fields must therefore be added
worker-first, and the version gate does not change that: a newer minor still
fails the key check if it carries fields this worker does not know. Bump the
minor for additive changes the worker tolerates, and the major when the worker
genuinely cannot run against older metadata — as `2.0` did. A major bump is a
hard break on both sides, so it has to ship worker-first too.
Both constants live in two places that must move together:
`runtimeMetadata.ts` here and `functions-metadata-generator.ts` in the CLI.

**The annotation written into runtime metadata is normalised, not verbatim.**
Older workers — and the legacy path above — read audiences from the annotation
text. The deploy row resolves `type SqlAccess = AudienceType.Sql` through the
checker and emits a `Sql` binding, while a text reader sees only `SqlAccess`,
fails to match it against `AudienceType`, and registers nothing.
`toRuntimeMetadata` therefore still substitutes the resolved union into type
argument 1 (`normalizeContextAnnotation` in the CLI), preserving the schema
argument and any trailing arguments.

The two extraction modules (worker + CLI) are intentional duplicates; the
packages share no code, exactly as they already duplicate `RuntimeMetadataFile`.
**Keep them in sync.** `src/__tests__/runtimeMetadataGolden.test.ts` feeds the
CLI-generated `fixtures/parity-runtimemetadata.json` straight into
`UserDataFunctions` and asserts the registered bindings equal the CLI's deploy
bindings; the CLI's `functions-metadata-parity.test.ts` asserts it still emits
exactly those fixtures. Regenerating one side alone fails the other.

Notes:

- **Audiences are resolved by the compiler**, so a type alias works — the CLI
  writes the resolved union back into the annotation. Prefer literal
  `AudienceType.Sql` anyway, and keep a `tsconfig.json` in the functions
  project: with no program there is no checker, the CLI reads the annotation
  syntactically, and it emits an `unverified-context-audience` diagnostic
  because an alias then resolves to its own name. Whatever reaches the worker is
  validated against `AudienceType`; anything unrecognised is skipped with a
  `console.warn` naming the function — a loud failure rather than a bogus
  binding.
- Results are **sorted**. The checker returns a union in its own normalised
  order while the text path returns source order; sorting makes the two agree
  and keeps generated metadata stable across builds.
- `RayfinContext.__audienceVariance` is a phantom `declare` field, erased at
  runtime, that makes `TokenTypes` contravariant. `getToken` is a method, and
  method parameters compare bivariantly even under `strictFunctionTypes`, so
  without *some* contravariant member `RayfinContext<S, never>` would be
  assignable to `RayfinContext<S, AudienceType.Sql>` — letting a context reach
  a helper needing an audience it never declared. Since `Tokens` became an
  exact `Record<TokenTypes, string>`, that member alone now also enforces it,
  so the phantom field is **belt-and-braces rather than load-bearing**. It is
  kept so the guarantee does not silently depend on `Tokens` staying
  non-optional. The behaviour is pinned directly by *"a narrower context cannot
  satisfy one declaring more audiences"* in `connection.test.ts`, which holds
  whichever member provides it.
- `Tokens` is typed `Readonly<Record<TokenTypes, string>>` — exact, not
  `Partial`. Declaring an audience is what registers its binding, so the value
  is modelled as present. A declared audience can still fail to mint, so
  `buildTokenView` installs those as **non-enumerable throwing accessors**
  rather than letting a `string`-typed property yield `undefined`. Minted
  tokens stay ordinary enumerable data properties, so `Object.keys`, spreading
  and `JSON.stringify` keep working and report only real tokens.

**The `connections` array stays `[]` in guidance and examples.** Audience-scoped
connections are declared entirely in the context annotation. Generic connections
passed in the array are still unioned with the annotated audiences and bind at
**runtime**, but they contribute nothing to the type system — `TokenTypes`
defaults to `never`, so a handler annotated `RayfinContext<Schema>` cannot reach
an audience declared only in the array (pinned by *"array only — declared but
unreachable"* in `connectionTypeSafety.test.ts`). Migration guidance must say
the audience moves into the annotation, not that existing code keeps compiling.

**Do not document alias connections.** The implementation and its test coverage
stay (`Connection({ alias, argName })`, the `FabricItem` binding path, and the
alias case in `__tests__/fixtures/parity-function-app.ts.txt`), but the feature
is not supported yet. Writing it up here leads agents to emit unsupported
examples and to reintroduce it into user-facing docs. Keep guidance on
audience-based connections only.

**The context parameter must carry an explicit `RayfinContext<...>`
annotation.** Typegen identifies it from the annotation's source text
(`isRayfinContextType` in `userDataFunctions.ts`, fed by `param.type.getText()`
in the AST parser, and `RUNTIME_INJECTED_PARAM_TYPES` in the CLI's
`functions-types-generator.ts`). An unannotated parameter is treated as a
request-body parameter and fails at invoke time — even though audience
extraction itself would cope with it.

## Runtime metadata is the only metadata path

`runtimemetadata.json` is the sole source of delegate parameters and audiences.
There is no startup fallback that parses TypeScript sources, and `typescript` is
a **devDependency**, never a runtime one.

This is what makes the worker bundle-friendly: the CLI bundles functions with
esbuild for deploy, and the compiler dominated the bundle while the parser was
still reachable. `new UserDataFunctions()` is correct and is what every template
and doc shows; both `rayfin dev` and `rayfin up` generate the metadata.
`UserDataFunctions.create()` remains as a deprecated async wrapper so existing
call sites keep working.

### The metadata error state

When metadata is missing, malformed, on an unsupported schema version, or
predates `contextAudiences` while a handler declares some, construction **does
not throw**. It records the reason, logs a detailed diagnostic, and enters an
error state where `func()` still registers every route but each invocation fails
with `METADATA_UNAVAILABLE_MESSAGE` (HTTP 500 locally, `Failed` in the response
envelope).

Throwing during construction is the one thing to avoid here. It happens while
the Functions host is loading `function_app.js`, so the host reports it as "No
job functions found" — no routes, and nothing naming the real cause. That is the
exact symptom this whole area was built to eliminate. Registering the routes and
failing each invocation keeps the app reachable and says what is wrong.

No bindings are registered in the error state, since the audiences a handler
needs are precisely what could not be determined.

The failure crosses the invoke boundary as a category token only —
`properties.reason` is one of `missing`, `invalid`, `unsupported-version`, or
`legacy-metadata`. Keep it that way: `properties` is serialized into the invoke
response, so the metadata path (and anything else describing the host's
filesystem) belongs in the logged diagnostic, never here.

## Typed secrets

`RayfinContext.Secrets` exposes secret values by name, bounded by what the app
declared:

```ts
udf.func('charge', async (ctx: RayfinContext<TodoAppSchema>) => {
  ctx.Secrets.STRIPE_API_KEY; // string
  ctx.Secrets.NOT_DECLARED;   // compile error
});
```

**Nothing about a function's declaration changes, and the data schema is not
involved.** Secrets reach the type system through declaration merging: the CLI
generates `rayfin/functions/src/secrets.generated.ts`, which augments
`RayfinSecretRegistry` (`src/types/secretsRegistry.ts`), and `RayfinContext`'s
third type parameter defaults to `RegisteredSecretNames`.

```ts
// generated — imported by nothing
declare module '@microsoft/fabric-user-data-functions' {
  interface RayfinSecretRegistry {
    STRIPE_API_KEY: string;
  }
}
export {};
```

Notes:

- The generated file only needs to be **part of the compilation**, which the
  functions `tsconfig.json` `src` include already guarantees. It is written
  under `rayfin/functions/src/` rather than `rayfin/data/` because the latter is
  shared with the frontend, which has no dependency on this package.
- Because secrets are app-wide, the registry is **global to a compilation**. Two
  Rayfin apps in one `tsconfig` would merge their secrets; this is not detected.
- An empty registry makes `Secrets` an empty object type, so an app that has
  declared no secrets gets a compile error on any access — the correct state.
- The third type parameter is still overridable
  (`RayfinContext<Schema, never, 'ONE_SECRET'>`) to narrow a single function.
- `Secrets` is backed by a **`Proxy`**, not a snapshot, because `getSecret`
  falls back to `process.env` — which is how secrets arrive in local dev, and
  those names are not known when the context is constructed. Resolution order
  matches `getSecret` exactly, including `??` so an empty-string header secret
  does not fall through to the environment.
- The proxy delegates symbols, `Object.prototype` members and runtime protocol
  probes (`then`, `toJSON`, `inspect`, `constructor`) untouched. `then` matters:
  without it, awaiting or returning the secrets object would throw far from the
  cause. Covered by *"the secrets object survives being awaited"* in
  `secrets.test.ts`.
- A declared-but-unsupplied secret **throws** rather than yielding `undefined`
  from a `string`-typed property, matching `Tokens`. `getSecret` keeps its
  lenient `string | undefined` contract as the escape hatch.

## Local debugging with a PPE (EDOG) account

> Contributor-only. Real app builders always run against PROD; the EDOG environment is for
> Fabric/Rayfin contributors debugging the local UDF host against pre-production.

When you debug the local functions host (`rayfin dev functions apply` / `func start`) and
need to sign in with a **PPE account**, add `FabricEnvironment` under `Values` in
`rayfin/functions/local.settings.json`:

```jsonc
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "AZURE_FUNCTIONS_ENVIRONMENT": "Development",
    "FabricEnvironment": "EDOG"
  }
}
```

Notes:

- `FabricEnvironment` is consumed by the **Fabric UDF host** that boots the local
  `func start` process, not by this TypeScript extension's own code (which reads
  `AZURE_FUNCTIONS_ENVIRONMENT` and the `RAYFIN_*` vars in `rayfinContext.ts`). Setting it
  steers the host's interactive login toward the EDOG/PPE authority instead of PROD.
- Omit the key (or leave it unset) for the default PROD login.
- Sign in with your PPE credentials when the interactive browser prompt appears.
- `local.settings.json` is git-ignored — this stays a local-only override.

## Key Files

- `src/userDataFunctions.ts` — `udf.func()` authoring API
- `src/types/rayfinContext.ts` — `RayfinContext`, token/secret/env resolution
- `src/types/connection.ts` — `AudienceType` enum
- `src/types/audienceScopes.ts` — per-audience OBO scope overrides
- `src/astparser.ts` — typegen AST parser
- `src/index.ts` — public exports
- `assets/docs/index.md` — hand-authored SDK reference hub

## SDK reference

`assets/docs/index.md` is this package's api-reference hub, declared by the
`rayfinDocs` manifest in `package.json` (`module: "fabric-user-data-functions"`)
and listed in `packages/tools/docs-lib/assets/catalog.json`. It is what makes
the authoring surface listable and searchable through `rayfin docs` and MCP.

**Keep its `symbols:` frontmatter in sync with `src/index.ts`.** Adding or
removing a public export without updating that list silently degrades symbol
lookup.

The package is **not** a TypeDoc entry point: its directory name does not match
its `rayfinDocs.module`, so the required-module derivation would be orphaned.
It is still on the stable docs site — the catalog carries no `stability` flag,
which is a docs classification and deliberately independent of the package's npm
release channel (`functions-scaffold.ts` pins the exact running CLI version).
See `packages/docgen/AGENTS.md`.
