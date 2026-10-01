import {
  createConnectorsApi,
  type ConnectorConfig,
  type ConnectorsRuntime,
  type ConnectorsSchema,
  type HostEnvironment,
} from '@microsoft/rayfin-connectors';
import { type EntitySchema } from '@microsoft/rayfin-data';
import { type FunctionsSchema } from '@microsoft/rayfin-functions';

import RayfinClient, { RayfinClientConfig } from '../client';

/**
 * (Experimental) Config for `ConnectorsRayfinClient`. Extends the
 * stable {@link RayfinClientConfig} with an optional `connectors` map so
 * the Builder can declare each connector's runtime routing config
 * (`{ connector: ConnectorType }`) at client construction.
 *
 * The map is consumed by `createConnectorsApi` to pick the right
 * transport per connector name (Cat A GraphQL vs Cat B invoke).
 */
export interface ConnectorsRayfinClientConfig<
  TConnectorsSchema extends ConnectorsSchema = ConnectorsSchema,
> extends RayfinClientConfig {
  /**
   * (Experimental) Per-connector routing config keyed by the connector
   * name used in `rayfin.yml`. Mirrors the CLI-generated
   * `connectorConfig` constants exported from each
   * `rayfin/connectors/<name>/schema.ts`. Required and exhaustive: every
   * connector declared in `TConnectorsSchema` must have a runtime config.
   */
  connectors: Record<keyof TConnectorsSchema & string, ConnectorConfig>;

  /**
   * (Experimental) Hosting environment the connectors runtime runs in. Carried
   * on every invocation context so a registered invoke middleware can branch
   * on it (embedded-in-Fabric vs standalone vs cli). When omitted, the host is
   * auto-detected (`detectHost()`) so callers wire up nothing — `cli` under
   * Node, `embedded` inside a parent frame, otherwise `standalone`. Pass an
   * explicit value only to override detection. The connectors layer only
   * carries this value; confirming a specific Fabric host is the job of the
   * connector-specific package.
   */
  host?: HostEnvironment;
}

/**
 * Rayfin client that surfaces the typed connectors runtime as
 * `client.connectors.<name>.<operation>(input, options?)`.
 *
 * Import it from the stable `@microsoft/rayfin-client` entry. The
 * `@microsoft/rayfin-client/experimental` subpath still re-exports it so
 * existing apps keep building, but new code should not use that path.
 *
 * @typeParam TSchema - Data entity schema (same shape as {@link RayfinClient}).
 * @typeParam TFunctionsSchema - Functions schema (same shape as {@link RayfinClient}).
 * @typeParam TConnectorsSchema - Connector schema mapping connector names
 *   (as declared in `rayfin.yml`) to typed connector markers such as
 *   `FabricSemanticModel<'executeQuery'>`.
 *
 * @example
 * ```ts
 * import { ConnectorsRayfinClient } from '@microsoft/rayfin-client';
 * import type { FabricSemanticModel } from '@microsoft/rayfin-connector-fabric-semanticmodel';
 *
 * type AppConnectorsSchema = {
 *   salesModel: FabricSemanticModel<'executeQuery'>;
 * };
 *
 * const client = new ConnectorsRayfinClient<
 *   DataSchema,
 *   FunctionsSchema,
 *   AppConnectorsSchema
 * >({
 *   baseUrl: import.meta.env.VITE_RAYFIN_API_URL,
 *   publishableKey: import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY,
 * });
 *
 * const result = await client.connectors.salesModel.executeQuery({
 *   query: 'EVALUATE TOPN(10, Sales)',
 * });
 * ```
 *
 * Connectors whose operations return a binary stream (such as the
 * `fabric-semanticmodel` Apache Arrow response) need a runtime decoder. Pass a
 * {@link ConnectorsRuntime} as the second constructor argument, keyed by the
 * same connector names used in the schema:
 *
 * @example
 * ```ts
 * import { fabricSemanticModel } from '@microsoft/rayfin-connector-fabric-semanticmodel';
 *
 * const client = new ConnectorsRayfinClient<
 *   DataSchema,
 *   FunctionsSchema,
 *   AppConnectorsSchema
 * >(config, { salesModel: fabricSemanticModel() });
 * ```
 *
 * @alpha
 * @internal
 */
export class ConnectorsRayfinClient<
  TSchema extends EntitySchema = Record<string, any>,
  TFunctionsSchema extends FunctionsSchema = FunctionsSchema,
  TConnectorsSchema extends ConnectorsSchema = ConnectorsSchema,
> extends RayfinClient<TSchema, TFunctionsSchema> {
  /**
   * (Experimental) Typed accessors for connectors declared in `rayfin.yml`.
   * Each property resolves lazily on first access; the underlying transport
   * (`POST /connector-invoke`) is shared with the rest of the SDK.
   */
  public readonly connectors: ReturnType<
    typeof createConnectorsApi<TConnectorsSchema>
  >;

  /**
   * (Experimental) Creates a Rayfin client with the connectors runtime
   * attached. Accepts the same configuration as {@link RayfinClient},
   * plus an optional `connectors` map (see
   * {@link ConnectorsRayfinClientConfig}) used to route Cat A vs Cat B
   * dispatch per connector name.
   *
   * @param config - Client configuration, including optional auth-token
   *   storage and per-connector routing configs.
   * @param connectorsRuntime - Optional per-connector runtime hooks (e.g. binary
   *   decoders) keyed by connector name. Required only for connectors whose
   *   operations return a binary stream; JSON-only connectors work without it.
   */
  constructor(
    config: ConnectorsRayfinClientConfig<TConnectorsSchema>,
    connectorsRuntime?: ConnectorsRuntime
  ) {
    super(config);
    this.connectors = createConnectorsApi<TConnectorsSchema>(
      this.apiClient,
      config.connectors,
      connectorsRuntime,
      config.host
    );
  }
}

export default ConnectorsRayfinClient;
