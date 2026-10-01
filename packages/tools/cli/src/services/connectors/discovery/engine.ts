import type {
  ConnectorType,
  DiscoveredSource,
  DiscoveryRequest,
} from '@microsoft/rayfin-tools-common/_internal/config';

import {
  CatalogSearchDiscoveryEngine,
  FabricCatalogClient,
} from './catalog-search-engine.js';
import { discoverFabricSources } from './registry.js';

/** Everything a discovery engine needs to run one discovery request. */
export interface DiscoveryEngineInput {
  request: DiscoveryRequest;
  /** Optional `--type` narrowing; when omitted, all connector types are searched. */
  types?: readonly ConnectorType[];
  /** Current user's OID for role-based eligibility checks. */
  userOid?: string;
}

/**
 * A pluggable strategy for finding connectable Fabric sources, so the command
 * layer can swap engines without touching scope resolution or output.
 */
export interface DiscoveryEngine {
  /** Stable identifier, surfaced in verbose logs and used by tests. */
  readonly name: string;
  discover(input: DiscoveryEngineInput): Promise<DiscoveredSource[]>;
}

/**
 * Per-workspace engine: fans a per-connector-type provider run across the
 * resolved workspace list. Needs only `Workspace.Read.All` / `Item.Read.All`.
 */
export class FanoutDiscoveryEngine implements DiscoveryEngine {
  public readonly name = 'fanout';

  public constructor(
    private readonly token: string,
    private readonly userOid?: string
  ) {}

  public discover({
    request,
    types,
  }: DiscoveryEngineInput): Promise<DiscoveredSource[]> {
    return discoverFabricSources({
      token: this.token,
      request,
      types,
      userOid: this.userOid,
    });
  }
}

/** Options controlling which discovery engine {@link createDiscoveryEngine} returns. */
export interface CreateDiscoveryEngineOptions {
  /**
   * Use Catalog Search (one cross-workspace call) instead of the fan-out.
   * Requires `Catalog.Read.All`; only set for a true `--all-workspaces` scan.
   */
  catalogSearch?: boolean;
  /** Current user's OID for role-based eligibility checks. */
  userOid?: string;
}

/**
 * Select the discovery engine: Catalog Search for tenant-wide scope,
 * fan-out otherwise (bounded scope, or callers that skip the option).
 */
export function createDiscoveryEngine(
  token: string,
  options: CreateDiscoveryEngineOptions = {}
): DiscoveryEngine {
  if (options.catalogSearch) {
    // Catalog Search cannot resolve workspace roles; userOid is not needed
    return new CatalogSearchDiscoveryEngine(new FabricCatalogClient(token));
  }
  return new FanoutDiscoveryEngine(token, options.userOid);
}
