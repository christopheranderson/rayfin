# @microsoft/rayfin-connectors

See the [SDK reference overview](./assets/docs/index.md) for the public API.

Typed runtime for invoking Rayfin function-bridge connectors from the browser
SDK. Exposes a single Proxy factory, `createConnectorsApi`, that the
`ConnectorsRayfinClient` mounts as `client.connectors`.

The public surface is:

```ts
client.connectors.<name>.<operation>(input, options?)
```

where `<name>` is a connector key declared in `rayfin.yml` and `<operation>`
is one of the allowed operations for that connector's category (e.g.
`executeQuery` for `fabric-semanticmodel`).

The connector marker types (e.g. `FabricSemanticModel<'executeQuery'>`)
live in connector-specific packages such as
`@microsoft/rayfin-connector-fabric-semanticmodel`. Compose them into a
`ConnectorsSchema` and pass it as the third type parameter of
`ConnectorsRayfinClient` for end-to-end type-safety:

```ts
import type { ConnectorsSchema } from "@microsoft/rayfin-client";
import type { FabricSemanticModel } from "@microsoft/rayfin-connector-fabric-semanticmodel";

export type AppConnectorsSchema = {
  salesModel: FabricSemanticModel<"executeQuery">;
};

// Optional compile-time guard:
const _check: ConnectorsSchema = null as unknown as AppConnectorsSchema;
void _check;
```

Then call:

```ts
import { ConnectorsRayfinClient } from "@microsoft/rayfin-client";
import type { AppSchema } from "../rayfin/data/schema";
import type { AppFunctionsSchema } from "../rayfin/functions/schema";

const client = new ConnectorsRayfinClient<
  AppSchema,
  AppFunctionsSchema,
  AppConnectorsSchema
>({
  baseUrl: import.meta.env.VITE_RAYFIN_API_URL,
  publishableKey: import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY,
});

const result = await client.connectors.salesModel.executeQuery({
  query: "EVALUATE TOPN(10, Sales)",
});
```

---

## Authoring a connector runtime (decoders + middleware)

> **Audience:** authors and owners of a connector-specific package (e.g.
> `@microsoft/rayfin-connector-fabric-semanticmodel`). App developers
> consuming `client.connectors.<name>.<op>()` do not need any of this — it
> is transparent to them.

Connector markers are **type-only**. Anything that must run at runtime — decoding
a binary response, or choosing a transport based on where the app is running — is
supplied by the connector package as a `ConnectorRuntime` and passed to
`ConnectorsRayfinClient` (or `createConnectorsApi`) under the same connector name
used in the typed schema:

```ts
const client = new ConnectorsRayfinClient<
  AppSchema,
  AppFunctionsSchema,
  AppConnectorsSchema
>(config, { salesModel: fabricSemanticModel() });
```

A runtime is a map of per-operation hooks:

```ts
interface ConnectorRuntime {
  operations?: Record<string, OperationRuntime>;
}

interface OperationRuntime {
  decodeBinary?: (data: ArrayBuffer) => unknown;
  invoke?: (ctx: InvokeContext, next: InvokeNext) => Promise<unknown>;
}
```

There are exactly **two extension points**, and they compose.

### 1. `decodeBinary` — normalise a binary response

Applied by the connectors proxy **after** the transport returns, and **only** when
the payload came back as an `ArrayBuffer`. JSON responses bypass it entirely, so a
worker that still returns JSON keeps working unchanged. Use it to turn the wire
format into the operation's declared output shape.

This is the whole runtime the `fabric-semanticmodel` connector ships with today:

```ts
export function fabricSemanticModel(): ConnectorRuntime {
  return {
    operations: {
      executeQuery: {
        decodeBinary: (data) => parseArrowStream(data),
      },
    },
  };
}
```

### 2. `invoke` — intercept the call and pick a transport

When registered, the connectors layer calls `invoke(ctx, next)` **instead of**
hitting the default standalone transport directly. The middleware can either:

- **short-circuit** — service the call itself and return a result, or
- **delegate** — `return next(ctx)` to fall through to the default BaaS transport.

Whatever it returns is _still_ passed through `decodeBinary` when that hook is also
registered **and** the return value is an `ArrayBuffer`. That gives you two clean
strategies:

| Middleware returns           | `decodeBinary` runs? | Use when                                                         |
| ---------------------------- | -------------------- | ---------------------------------------------------------------- |
| an `ArrayBuffer` (raw bytes) | **yes**              | You only want to swap the transport; keep decoding in one place. |
| an already-decoded object    | no (skipped)         | The middleware owns the full transform for that path.            |

Prefer returning raw bytes so decoding stays centralised in `decodeBinary`.

### The `InvokeContext`

Everything a middleware needs is stamped onto `ctx` per call:

| Field               | Notes                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `connectorName`     | Connector instance name from `rayfin.yml`.                                                                            |
| `operation`         | e.g. `'executeQuery'`.                                                                                                |
| `input` / `options` | The operation payload and per-call options.                                                                           |
| `host`              | An **object** — branch on `ctx.host.type`, never on `ctx.host`.                                                       |
| `connectorConfig`   | The connector's declared config from `rayfin.yml` (resolve your target item from here, not out of band).              |
| `http`              | A **pre-authenticated** HTTP client (see below). Optional in the type; fall through to `next(ctx)` when it is absent. |

### Host environments (`ctx.host.type`)

```ts
type HostEnvironment = { type: "embedded" | "standalone" | "cli" };
```

- `'standalone'` — a deployed app calling the backend over HTTP. **The default**,
  and byte-for-byte the current behaviour: delegate with `next(ctx)`.
- `'cli'` — the Rayfin CLI inner loop, running under the developer's own identity.
- `'embedded'` — running inside a Fabric host shell.

`detectHost()` only ever auto-detects `'cli'` (no DOM) or `'standalone'` (any
browser document). **`'embedded'` is never inferred** — it is asserted explicitly
by the host or the connector-specific package (e.g. via
`@microsoft/rayfin-fabric-embedded-host`), which always overrides detection.

The routing _policy_ is the middleware author's call, but the intended pattern is:
`cli` and `embedded` can call the target endpoint **directly** through `ctx.http`
(short-circuit), while `standalone` **delegates** to the default BaaS transport.

### The pre-authenticated `ctx.http`

`ctx.http.fetch(input, init?)` mirrors the global `fetch` and resolves to a
`Response`, so you read the body however you need — `.json()`, or `.arrayBuffer()`
for the Arrow / `decodeBinary` path. Auth headers and the SDK's token-refresh are
injected by the connectors layer, so **middleware never touches the bearer token**.
It is populated in practice today, but is typed optional — always guard with a
fall-through to `next(ctx)` when it is absent.

### What `invoke()` is _not_

`client.connectors.<name>.invoke('<op>', input)` (and the `SemanticConnectorClient`
method behind it) is the **raw escape hatch**: it runs the default standalone
transport only — **no middleware, no `decodeBinary`** — and returns the undecoded
payload. It exists for tests and programmatic callers. Do **not** put connector
routing or decode logic there; that belongs in the `invoke` / `decodeBinary` hooks,
which run on the operation proxy (`client.connectors.<name>.<op>(input)`).

### Worked example — routing `executeQuery`

Adding an environment-aware transport to the semantic-model runtime, on top of the
Arrow decoder it already ships:

```ts
import type { ConnectorRuntime } from "@microsoft/rayfin-connectors";
import { parseArrowStream } from "./arrow";

export function fabricSemanticModel(): ConnectorRuntime {
  return {
    operations: {
      executeQuery: {
        // Runs for whichever transport ran (middleware or default),
        // whenever the payload comes back as Arrow bytes.
        decodeBinary: (data) => parseArrowStream(data),

        invoke: async (ctx, next) => {
          // Standalone (or no http client) keeps the BaaS round-trip,
          // byte-for-byte the pre-middleware behaviour.
          if (ctx.host.type === "standalone" || !ctx.http) {
            return next(ctx);
          }

          // cli / embedded: call the semantic-model endpoint directly.
          // Auth + token refresh are handled by ctx.http.
          const target = resolveItemPath(ctx.connectorConfig); // from rayfin.yml
          const res = await ctx.http.fetch(target, {
            method: "POST",
            headers: {
              Accept: "application/vnd.apache.arrow.stream, application/json",
            },
            body: JSON.stringify(ctx.input ?? {}),
          });

          // Return raw bytes and let decodeBinary above normalise them,
          // so decoding stays in one place.
          return res.arrayBuffer();
        },
      },
    },
  };
}
```

Consumers keep calling `client.connectors.salesModel.executeQuery(...)` and get the
same decoded `FabricSemanticModelTabularResponse` regardless of which transport ran —
feed it to `toQueryResult` exactly as before.
