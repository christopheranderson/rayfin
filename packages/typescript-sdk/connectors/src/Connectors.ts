/**
 * Connectors API factory and error type.
 *
 * The single public surface is `client.connectors[name]` whose shape
 * depends on the connector category:
 *
 * - Cat A (GraphQL-backed) is entity-oriented
 *   (`client.connectors.salesDb.Product.select(...).execute()`).
 * - Cat B (function-bridge) is operation-oriented
 *   (`client.connectors.salesModel.executeQuery(...)`).
 *
 * `name` is constrained by the `ConnectorsSchema` passed to
 * `RayfinClient`; the per-name surface is dictated by the connector
 * marker (e.g. `FabricSemanticModel` for Cat B, `GraphQLBackedConnector`
 * for Cat A). See {@link createConnectorsApi} for the dispatcher
 * contract and a worked example.
 */

import { ApiClient, SdkError } from '@microsoft/rayfin-lib';

import type {
  ConnectorConfig,
  ConnectorMarker,
  ConnectorsSchema,
  InvokeOptions,
} from './ConnectorsSchema';
import { GraphQLConnectorClient } from './category-a/GraphQLConnectorClient';
import { SemanticConnectorClient } from './category-b/SemanticConnectorClient';
import { isCatAGraphqlConnectorType } from './utils';

export { SemanticConnectorClient } from './category-b/SemanticConnectorClient';
export { GraphQLConnectorClient } from './category-a/GraphQLConnectorClient';

/**
 * Connectors error specific to the Rayfin SDK.
 */
export class ConnectorsError extends SdkError {
  public override name = 'ConnectorsError';

  constructor(message: string, code?: string) {
    super(message, code || 'CONNECTORS_ERROR');
    // Required so `instanceof ConnectorsError` works — SdkError's
    // constructor resets the prototype to itself.
    Object.setPrototypeOf(this, ConnectorsError.prototype);
  }
}

/**
 * The hosting environment a connector invocation runs in.
 *
 * Supplied on every {@link InvokeContext} so invoke middleware can branch on
 * where the SDK is executing — for example, taking an in-process fast path
 * when embedded inside a Fabric host versus the default HTTP transport when
 * running standalone.
 *
 * The environment is auto-detected by {@link detectHost} for the two cases the
 * SDK can determine reliably (`'cli'` and `'standalone'`). `'embedded'` is a
 * host-custom distinction the connectors layer cannot structurally confirm, so
 * it is supplied explicitly by the connector-specific package rather than
 * inferred.
 */
export interface HostEnvironment {
  /**
   * Discriminant describing where the connector call is executing:
   *
   * - `'standalone'` — a deployed app calling the backend over HTTP (default).
   * - `'embedded'` — running in-process inside a Fabric host. Set explicitly;
   *   never auto-detected (see {@link detectHost}).
   * - `'cli'` — the Rayfin CLI inner loop, calling under the developer's own
   *   identity with no deployed app.
   */
  type: 'embedded' | 'standalone' | 'cli';
}

/**
 * The standalone host environment — a deployed app calling the backend over
 * HTTP. Used as the value {@link detectHost} returns for any browser document,
 * and a stable reference for callers that want to pin the default explicitly.
 */
export const DEFAULT_HOST_ENVIRONMENT: HostEnvironment = { type: 'standalone' };

/**
 * Auto-detect the {@link HostEnvironment} the SDK is currently running in.
 *
 * Zero-config: callers never have to wire this up. `createConnectorsApi` (and
 * therefore `ConnectorsRayfinClient`) call it whenever an explicit `host` is
 * not supplied, so the correct environment is inferred automatically. An
 * explicit `host` always overrides detection.
 *
 * It only auto-detects the two environments it can determine *reliably* and
 * dependency-free, so the connectors layer stays isomorphic across Node and the
 * browser:
 *
 * - No DOM (`typeof window === 'undefined'`) → `'cli'` (the Rayfin CLI inner
 *   loop, running under Node).
 * - Any browser document → `'standalone'` (a deployed app).
 *
 * `'embedded'` is intentionally *not* auto-detected. Whether a browser document
 * is embedded inside a specific host shell (such as the Fabric portal) is a
 * host-custom distinction the connectors layer cannot structurally confirm:
 * being nested in an iframe only means "some parent frame," not "this host," so
 * an iframe check would misclassify unrelated standalone apps that happen to
 * run framed. Only the host — or the connector-specific package that knows it
 * is embedded — can assert it, by passing an explicit `host` (e.g. via the
 * Fabric-specific detector in `@microsoft/rayfin-fabric-embedded-host`), which
 * always overrides detection.
 *
 * @returns The detected host environment.
 */
export function detectHost(): HostEnvironment {
  // No DOM at all → we are running under Node, i.e. the Rayfin CLI inner loop.
  if (typeof window === 'undefined') {
    return { type: 'cli' };
  }
  // Any browser document → a deployed standalone app. `'embedded'` is never
  // inferred here (see the doc comment): it is a host-custom distinction that
  // an iframe check cannot confirm, so it is only ever set via an explicit
  // `host`.
  return DEFAULT_HOST_ENVIRONMENT;
}

/**
 * A minimal, pre-authenticated HTTP client handed to invoke middleware so a
 * short-circuiting transport can make its own authenticated calls (for example
 * an embedded host that talks to a semantic-model endpoint directly) without
 * ever handling the bearer token itself. The signature mirrors the global
 * `fetch`, and it resolves to a `Response` so callers can read the body however
 * they need — `.json()`, or `.arrayBuffer()` for the Arrow / `decodeBinary`
 * path. The connectors layer supplies the implementation, which injects auth
 * and reuses the SDK's token-refresh behaviour.
 */
export interface InvokeHttpClient {
  /**
   * Perform an authenticated request. Auth headers are injected by the
   * implementation, so callers pass only their own headers and body.
   */
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

/**
 * The per-call context handed to invoke middleware. Carries everything a
 * middleware needs to either service the call itself (short-circuit) or hand
 * off to the next transport in the chain.
 */
export interface InvokeContext {
  /** Connector instance name as declared in `rayfin.yml`. */
  readonly connectorName: string;
  /** Operation being invoked (e.g. `'executeQuery'`). */
  readonly operation: string;
  /** The operation's input payload, if any. */
  readonly input?: unknown;
  /** Per-call options (extra headers, etc.). */
  readonly options?: InvokeOptions;
  /** Hosting environment the middleware may branch on. */
  readonly host: HostEnvironment;
  /**
   * The connector's declared configuration (from `rayfin.yml`), when
   * available. A short-circuiting middleware reads connector-specific settings
   * from here — for example a semantic-model middleware resolving its target
   * item — instead of re-reading config out of band.
   */
  readonly connectorConfig?: ConnectorConfig;
  /**
   * A pre-authenticated HTTP client the middleware may use to service the call
   * itself. Auth is injected by the SDK, so middleware never touches the token.
   * Only populated for transports that can supply one; middleware should fall
   * through to `next(ctx)` when it is absent.
   */
  readonly http?: InvokeHttpClient;
}

/**
 * The continuation passed to invoke middleware. Calling it delegates to the
 * next transport in the chain — ultimately the default standalone HTTP
 * transport. A middleware that fully services the call may return without
 * ever calling `next`.
 */
export type InvokeNext = (ctx: InvokeContext) => Promise<unknown>;

/**
 * Runtime hooks for a single connector operation.
 *
 * Markers are type-only, so any behaviour that must run at runtime (such as
 * decoding a binary response body, or intercepting the whole call to pick a
 * transport) is supplied here by the connector-specific package. The
 * connectors layer itself stays connector-agnostic and only invokes a hook
 * when one is registered.
 */
export interface OperationRuntime {
  /**
   * Decode a binary response body (for example an Apache Arrow IPC stream)
   * into the operation's declared output shape. Only invoked when the
   * transport surfaced an `ArrayBuffer` for this operation; JSON responses
   * bypass it entirely.
   */
  decodeBinary?: (data: ArrayBuffer) => unknown;
  /**
   * Intercept the entire invocation. When registered, the connectors layer
   * calls `invoke(ctx, next)` instead of hitting the default standalone
   * transport directly. The middleware may branch on `ctx.host` to select an
   * execution path (embedded / standalone / cli), short-circuit by
   * returning its own result, or delegate to `next(ctx)` to fall through to
   * the default transport. Whatever it returns is still passed through
   * {@link OperationRuntime.decodeBinary} when that hook is also registered.
   */
  invoke?: (ctx: InvokeContext, next: InvokeNext) => Promise<unknown>;
}

/**
 * Runtime hooks for a single connector instance, keyed by operation name.
 */
export interface ConnectorRuntime {
  /** Per-operation runtime hooks, keyed by operation name. */
  operations?: Record<string, OperationRuntime>;
}

/**
 * Optional runtime companion to a {@link ConnectorsSchema}.
 *
 * Maps connector instance names (as declared in `rayfin.yml`) to their
 * {@link ConnectorRuntime} hooks. Connectors omitted here fall back to the
 * default JSON pass-through behaviour, so the runtime is fully additive.
 */
export type ConnectorsRuntime = Record<string, ConnectorRuntime>;

/**
 * Mapped type that produces one typed connector client per schema entry.
 *
 * `client.connectors` resolves to this type — every key in `TSchema`
 * resolves to the concrete client shape that connector marker exposes.
 * Both Cat B markers (`ConnectorMarker<TCatalog>`) and Cat A markers
 * (`GraphQLBackedConnector<TSchema, TConfig>`) declare a `__client` phantom
 * that carries their resolved shape; this mapped type extracts it via
 * a single-branch conditional, so a new connector category (Cat C, etc.)
 * only needs to declare a `__client` phantom to plug in — no edit here.
 */
export type TypedConnectorsApi<TSchema extends ConnectorsSchema> = {
  [K in keyof TSchema & string]: TSchema[K] extends ConnectorMarker<infer C>
    ? C
    : never;
};

/**
 * Create a typed `client.connectors` proxy that lazily instantiates and
 * caches a per-connector client on first access.
 *
 * The dispatcher routes by `config.connector` type:
 * - Cat A (`fabric-sqldatabase`, `fabric-warehouse`, `fabric-sqlanalytics`) →
 *   {@link GraphQLConnectorClient} (entity-oriented:
 *   `connectors.<name>.<Entity>.select(...)`)
 * - Cat B (`fabric-semanticmodel`, `kusto`) → {@link SemanticConnectorClient}
 *   (operation-oriented: `connectors.<name>.<op>(input)`)
 *
 * Accessing a connector with no config throws
 * `ConnectorsError('UNKNOWN_CONNECTOR')`.
 *
 * @example
 * ```ts
 * const connectors = createConnectorsApi<MyConnectorsSchema>(apiClient, {
 *   salesDb: { connector: 'fabric-sqldatabase' },
 *   salesModel: { connector: 'fabric-semanticmodel' },
 *   telemetry: { connector: 'kusto' },
 * });
 * await connectors.salesDb.Product.select(['id', 'name']).execute();
 * await connectors.salesModel.executeQuery({ query: 'EVALUATE ...' });
 * ```
 */
export function createConnectorsApi<
  TSchema extends ConnectorsSchema = ConnectorsSchema,
>(
  apiClient: ApiClient,
  configs: Record<keyof TSchema & string, ConnectorConfig>,
  runtime?: ConnectorsRuntime,
  host?: HostEnvironment
): TypedConnectorsApi<TSchema> {
  // When the caller doesn't pin a host, auto-detect it so nothing has to be
  // wired up. An explicit `host` always wins.
  const resolvedHost = host ?? detectHost();
  const entryCache = new Map<string, unknown>();

  const getEntry = (name: string): unknown => {
    let entry = entryCache.get(name);
    if (!entry) {
      const config = configs[name as keyof TSchema & string];
      if (!config) {
        // Defense-in-depth: typed callers can't reach this branch (the
        // signature now requires an exhaustive `configs` record), but
        // untyped JS consumers and `as any` escapes still can.
        throw new ConnectorsError(
          `Connector "${name}" was accessed but has no configuration. ` +
            `Pass it via \`new RayfinClient({ connectors: { ${name}: { connector: '<type>' } } })\`.`,
          'UNKNOWN_CONNECTOR'
        );
      }
      entry = isCatAGraphqlConnectorType(config.connector)
        ? new GraphQLConnectorClient(
            apiClient,
            name,
            config.connector,
            config.operations,
            config.entities
          )
        : new SemanticConnectorClient(
            apiClient,
            name,
            runtime?.[name],
            resolvedHost,
            config
          );
      entryCache.set(name, entry);
    }
    return entry;
  };

  return new Proxy(Object.create(null) as TypedConnectorsApi<TSchema>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      return getEntry(prop);
    },

    has(_target, prop) {
      return typeof prop === 'string';
    },

    ownKeys() {
      return Array.from(entryCache.keys());
    },

    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      return {
        enumerable: true,
        configurable: true,
        value: getEntry(prop),
      };
    },
  });
}
