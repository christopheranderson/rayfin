import {
  CONNECTOR_CATALOG,
  type ConnectorDiscoveryProvider,
  type ConnectorType,
  type DiscoveredSource,
  type DiscoveryRequest,
} from '@microsoft/rayfin-tools-common/_internal/config';

import { FabricDiscoveryClient } from './fabric-discovery-client.js';
import { FabricConnectorProvider } from './fabric-provider.js';

/**
 * Build Fabric discovery providers from `CONNECTOR_CATALOG`; a new
 * discoverable connector type is a catalog edit, not a registry edit.
 */
export function createFabricProviders(
  client: FabricDiscoveryClient,
  userOid?: string
): ConnectorDiscoveryProvider[] {
  const providers: ConnectorDiscoveryProvider[] = [];
  for (const [type, meta] of Object.entries(CONNECTOR_CATALOG)) {
    // Gate purely on `discoverable`; dialect is unrelated (semantic models
    // have no dialect but are still discoverable).
    if (!meta.discoverable) continue;
    const itemTypes = [meta.fabricItemType];
    providers.push(
      new FabricConnectorProvider(
        type as ConnectorType,
        itemTypes,
        client,
        userOid
      )
    );
  }
  return providers;
}

/**
 * Stable sort for merged results (type, then workspace, then name) so
 * CLI/JSON output is deterministic across discovery engines.
 */
export function compareSources(
  a: DiscoveredSource,
  b: DiscoveredSource
): number {
  return (
    a.connectorType.localeCompare(b.connectorType) ||
    (a.workspaceName ?? a.workspaceId).localeCompare(
      b.workspaceName ?? b.workspaceId
    ) ||
    a.displayName.localeCompare(b.displayName)
  );
}

/**
 * Fan a discovery request out across providers and merge into one sorted
 * list; `types`, if given, narrows to providers covering those types.
 */
export async function runProviders(
  providers: readonly ConnectorDiscoveryProvider[],
  request: DiscoveryRequest,
  types?: readonly ConnectorType[]
): Promise<DiscoveredSource[]> {
  const selected =
    types && types.length > 0
      ? providers.filter((p) => p.connectorTypes.some((t) => types.includes(t)))
      : providers;

  const batches = await Promise.all(selected.map((p) => p.discover(request)));
  return batches.flat().sort(compareSources);
}

/**
 * End-to-end entry point: build a Fabric discovery client from the token,
 * register catalog providers, and run them.
 */
export async function discoverFabricSources(options: {
  token: string;
  request: DiscoveryRequest;
  types?: readonly ConnectorType[];
  userOid?: string;
}): Promise<DiscoveredSource[]> {
  const client = new FabricDiscoveryClient(options.token);
  const providers = createFabricProviders(client, options.userOid);
  return runProviders(providers, options.request, options.types);
}
