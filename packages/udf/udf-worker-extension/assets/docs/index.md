---
symbols:
  - UserDataFunctions
  - UserDataFunctions.func
  - UserDataFunctions.connection
  - RayfinContext
  - RayfinContext.Tokens
  - RayfinContext.Secrets
  - RayfinContext.getDataClient
  - AudienceType
  - Connection
  - AnyConnection
  - AudiencesOf
  - GenericConnectionOptions
  - RayfinSecretRegistry
  - RegisteredSecretNames
  - UserDataFunctionError
  - UDFExceptionCodes
---

# @microsoft/fabric-user-data-functions

[![TypeScript](https://img.shields.io/badge/TypeScript-5.2+-blue.svg)](https://www.typescriptlang.org/)

Server-side authoring surface and Azure Functions worker extension for Microsoft Fabric User Data Functions.
This package is how you _write_ a function; invoking one from app code is the separate `@microsoft/rayfin-functions` client.

Scaffold the project with the CLI rather than installing by hand:

```bash
npx rayfin functions init
```

That pins the worker to the exact version of the CLI that generated the project, prerelease suffix included, so the runtime your handlers compile against matches the one that will host them. If you are adding the dependency to an existing project, pin the same exact version rather than a floating dist-tag:

```bash
npm install @microsoft/fabric-user-data-functions@<your-rayfin-cli-version>
```

## API summary

| Export                                            | Purpose                                                                                                                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UserDataFunctions`                               | Registry for a functions project. Create one per `function_app.ts`.                                                                                       |
| `UserDataFunctions.func(...)`                     | Register a function: `(name, handler, connections?)`.                                                                                                     |
| `UserDataFunctions.connection(...)`               | Build an audience-scoped connection declaration from `{ audienceType }`.                                                                                  |
| `RayfinContext<TSchema, TokenTypes, TSecretNames>` | Injected request context: typed data client, audience-scoped access tokens, secrets.                                                                       |
| `AudienceType`                                    | Supported resource audiences: `Sql`, `Storage`, `Fabric`, `AzureAI`, and `ADO`.                                                                             |
| `Connection<TokenType>`                           | A declared connection. `TokenType` is a phantom parameter carrying the declared audience.                                                                 |
| `AnyConnection`                                   | `Connection<AudienceType>` — any connection regardless of audience.                                                                                       |
| `AudiencesOf<TConnections>`                       | The union of audiences declared by an array of connections.                                                                                               |
| `GenericConnectionOptions<TokenType>`             | `{ audienceType }` — the options accepted by `connection()`.                                                                                              |
| `RayfinSecretRegistry`                            | Empty interface the CLI augments to type `ctx.Secrets`. **Do not implement by hand.**                                                                     |
| `RegisteredSecretNames`                           | `keyof RayfinSecretRegistry` — the secret names known to this compilation.                                                                                |
| `UserDataFunctionError`                           | Base error for invocation failures, carrying `errorCode` and `properties`. Subclasses cover internal, invalid-input, missing-input, and user-thrown cases. |
| `UDFExceptionCodes`                               | The `errorCode` constants: `InvalidInput`, `MissingInput`, `UserThrown`, `InternalError`.                                                                 |

## Registering a function

```ts
import { UserDataFunctions } from "@microsoft/fabric-user-data-functions";

const udf = new UserDataFunctions();

udf.func(
  "greet",
  (firstName: string, lastName: string): string =>
    `Hello ${firstName} ${lastName}!`,
  [],
);
```

`func()` takes the function name, the handler, and an optional `connections` array — pass `[]`; audience-scoped connections are declared in the context annotation instead.
The handler's parameter and return types are read at build time and written into the generated `types.ts`, which is what gives the frontend a typed `client.functions.greet.invoke(...)`. `Promise<T>` return types are unwrapped to `T`.

## `RayfinContext`

Declare a `RayfinContext` parameter to reach data, tokens, and secrets. It is injected by the runtime and stripped from the generated input type, so it never appears in the invocation payload.

```ts
import {
  AudienceType,
  type RayfinContext,
} from "@microsoft/fabric-user-data-functions";

udf.func(
  "syncTodos",
  async (ctx: RayfinContext<AppSchema, AudienceType.Sql>): Promise<void> => {
    const data = ctx.getDataClient(); // typed by AppSchema
    const token: string = ctx.Tokens.Sql;
    const apiKey: string = ctx.Secrets.THIRD_PARTY_API_KEY;
  },
  [],
);
```

| Type parameter | Default                 | Meaning                                                                       |
| -------------- | ----------------------- | ------------------------------------------------------------------------------- |
| `TSchema`      | `Record<string, any>`   | The app data schema. Types `getDataClient()`; the same type as `RayfinClient<TSchema>`. |
| `TokenTypes`   | `never`                 | Union of audiences this function declares. Keys `Tokens`.                     |
| `TSecretNames` | `RegisteredSecretNames` | Secret names available to this function. Keys `Secrets`.                      |

Other members: `baseUrl`, `accessToken`, `publishableKey` (all readonly).

**The context parameter must carry an explicit `RayfinContext<...>` annotation.** Type generation identifies it from the annotation's source text; an unannotated parameter is treated as a request-body parameter instead.

### `Tokens`

Generic connections are declared **in the annotation**, and the declaration is what registers the binding — there is nothing to add to the `connections` argument.
`Tokens` is an exact `Readonly<Record<TokenTypes, string>>`, so reading an audience you did not declare is a compile error:

```ts
async (ctx: RayfinContext<AppSchema, AudienceType.Sql>) => {
  ctx.Tokens.AzureAI; // compile error — not declared
  const token: string = ctx.Tokens.Sql;
};
```

Type arguments are erased before the worker runs, so `npx rayfin up` resolves the declared audiences with the TypeScript compiler and writes the resolved union into the deployment metadata. A type alias therefore works — but prefer literal `AudienceType.X`, and keep a `tsconfig.json` in the functions project: without one the CLI falls back to reading the annotation syntactically, cannot resolve an alias, and warns.

Values are typed `string` rather than `string | undefined`. A declared audience that fails to mint at runtime is installed as a non-enumerable accessor that throws a diagnosable error, so `Object.keys`, spread, and `JSON.stringify` stay safe.

### `Secrets`

Secret names come from `RayfinSecretRegistry`, which `npx rayfin secret set <NAME>` types by regenerating `rayfin/functions/src/secrets.generated.ts` — a module augmentation that nothing needs to import:

```ts
ctx.Secrets.THIRD_PARTY_API_KEY; // string
ctx.Secrets.NOT_DECLARED; // compile error
```

Resolution is the host-supplied secret bag first, then `process.env`, so secrets injected as environment variables during local development behave identically.

## Deprecated accessors

`ctx.getToken(audienceType)` and `ctx.getSecret(name)` are deprecated in favour of `ctx.Tokens` and `ctx.Secrets`, and are flagged by `@typescript-eslint/no-deprecated`, which the scaffolded ESLint config reports as an error.

Migrating is not only a rename. Audiences declared in the `connections` argument are still honoured at runtime — they are unioned with the annotated ones — but they contribute nothing to the type system. `TokenTypes` defaults to `never`, so `ctx.getToken(AudienceType.Sql)` on a bare `RayfinContext<AppSchema>` no longer compiles even when `Sql` is in the array. Add the audience to the annotation, then switch to `ctx.Tokens.Sql`.

## Guides

See the [Functions guide](/docs/guide/functions/), [writing functions](/docs/guide/functions/writing-functions), [connecting to external resources](/docs/guide/functions/connections/), and [secrets](/docs/guide/functions/secrets) for task-oriented instructions.

## License

Copyright (c) Microsoft Corporation. Licensed under the MIT License.
