import { KustoEndpointManager } from './fabric/kusto-endpoint.js';

/**
 * Inputs needed to resolve a Kusto connector's cluster query endpoint. This is
 * just the bound Fabric item plus a control-plane token — everything comes from
 * the `connector add` flow that already verified the item.
 */
export interface ResolveKustoEndpointArgs {
  /** Workspace the bound item lives in. */
  workspaceId: string;
  /** The Eventhouse / KQL Database item id the user pointed `connector add` at. */
  itemId: string;
  /**
   * Fabric item `type` returned by `RayfinItemManager.getFabricItemById`.
   * Selects the Eventhouse vs KQLDatabase resolution path.
   */
  itemType: string;
  /** OAuth bearer for Fabric control-plane calls (read item properties). */
  fabricToken: string;
}

/** The resolved Kusto routing baked into the connector's generated schema. */
export interface ResolvedKustoConnectorConfig {
  /** Absolute https cluster query URI. */
  queryServiceUri: string;
  /** KQL database name to run the query against. */
  databaseName: string;
  /**
   * The item the endpoint was ultimately resolved from — differs from the
   * declared `itemId` only when an Eventhouse resolved down to its single child
   * KQL database. Callers keep the *declared* `itemId` in `rayfin.yml`; this is
   * surfaced only for logging / diagnostics.
   */
  resolvedItemId: string;
}

/**
 * Resolve a Kusto (Eventhouse / KQL Database) item into its cluster query
 * endpoint + database name.
 *
 * A pure resolver: it reads Fabric item properties and returns the resolved
 * routing. It does **not** touch `rayfin.yml` — the values are baked into the
 * connector-owned generated `schema.ts` `connectorConfig` by `connector add`,
 * so nothing Kusto-specific reaches the shared config schema or the host. It
 * also does **not** swallow failures: a resolution error throws so the
 * `connector add` command fails before writing a connector that could never
 * reach a cluster.
 *
 * The deployed `rayfin_kusto_v1` UDF reads `queryServiceUri` + `databaseName`
 * off `payload.input`; the `kusto()` runtime middleware injects them there at
 * invoke time from the resolved connector config.
 */
export async function resolveKustoEndpoint(
  args: ResolveKustoEndpointArgs
): Promise<ResolvedKustoConnectorConfig> {
  const manager = new KustoEndpointManager(args.fabricToken);
  return manager.resolve(args.workspaceId, args.itemId, args.itemType);
}
