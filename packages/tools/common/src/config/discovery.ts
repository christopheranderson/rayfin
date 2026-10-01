import type {
  ConnectorAuthType,
  ConnectorOperationType,
  ConnectorType,
} from './types.js';

// Widening ladder, resolved in order: workspaceId, then workspaceIds, then
// allWorkspaces; tenantWide is modeled for later but not implemented yet.
export interface DiscoveryScope {
  /** Restrict discovery to a single Fabric workspace. */
  workspaceId?: string;
  /** Explicit workspace set, e.g. every workspace a Builder's app deploys to. */
  workspaceIds?: string[];
  /** Search every workspace the authenticated identity can access. */
  allWorkspaces?: boolean;
  /** Tenant-wide admin search. Not implemented — needs Fabric admin scopes. */
  tenantWide?: boolean;
}

/** A single request handed to every registered discovery provider. */
export interface DiscoveryRequest {
  /** Case-insensitive substring match on item display name; empty = no filter. */
  query: string;
  scope: DiscoveryScope;
}

// Static capability hint copied from CONNECTOR_CATALOG — catalog defaults,
// not a live authorization probe.
export interface DiscoveredSourceCapabilities {
  operations: readonly ConnectorOperationType[];
  defaultAuth: ConnectorAuthType;
  requiresVersion: boolean;
}

// One connectable Fabric source found by discovery, already mapped to the
// connector type it would be added as. Pure data — the CLI turns it into a
// suggested `rayfin connector add` command.
export type WorkspaceRole =
  | 'Admin'
  | 'Member'
  | 'Contributor'
  | 'Viewer'
  | 'Unknown';
export interface DiscoveredSource {
  /** Connector type this source would be added as. */
  connectorType: ConnectorType;
  /** Underlying Fabric item type (e.g. `Lakehouse`, `Warehouse`). */
  itemType: string;
  workspaceId: string;
  /** Human-friendly workspace name, when the workspace was resolved by name. */
  workspaceName?: string;
  itemId: string;
  displayName: string;
  capabilities: DiscoveredSourceCapabilities;
  workspaceRole?: WorkspaceRole;
  addEligible?: boolean;
  addEligibilityReason?: string;
}

// A source of connectable items for one or more connector types.
// Transport-free: implementations (Fabric REST calls) live in the CLI.
export interface ConnectorDiscoveryProvider {
  /** Connector types this provider can discover sources for. */
  readonly connectorTypes: readonly ConnectorType[];
  /** Discover connectable sources within `request.scope` matching the query. */
  discover(request: DiscoveryRequest): Promise<DiscoveredSource[]>;
}
