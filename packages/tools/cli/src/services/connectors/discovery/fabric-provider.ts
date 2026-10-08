import {
  CONNECTOR_CATALOG,
  type ConnectorDiscoveryProvider,
  type ConnectorType,
  type DiscoveredSource,
  type DiscoveryRequest,
  type WorkspaceRole,
} from '@microsoft/rayfin-tools-common/_internal/config';

import type { FabricDiscoveryClient } from './fabric-discovery-client.js';

/**
 * Case-insensitive substring match. An empty query matches everything so
 * `rayfin connector search` with no query lists all connectable items.
 */
function matchesQuery(displayName: string, query: string): boolean {
  if (!query) return true;
  return displayName.toLowerCase().includes(query.toLowerCase());
}

/** Roles that can add a connector — Contributor or above. */
const ADD_ELIGIBLE_ROLES: ReadonlySet<WorkspaceRole> = new Set([
  'Admin',
  'Member',
  'Contributor',
]);

/** Derive add eligibility from a workspace role; Viewer/Unknown are ineligible. */
function deriveAddEligibility(role: WorkspaceRole): {
  addEligible: boolean;
  addEligibilityReason?: string;
} {
  if (ADD_ELIGIBLE_ROLES.has(role)) {
    return { addEligible: true };
  }
  return {
    addEligible: false,
    addEligibilityReason: `${role} role is insufficient — Contributor or above required`,
  };
}

/**
 * Discovery provider backed by Fabric items of one or more item types.
 *
 * One provider is registered per connector type marked `discoverable` in
 * `CONNECTOR_CATALOG`. The provider is purely
 * declarative — it lists its item types across the scoped workspaces (via
 * the shared {@link FabricDiscoveryClient}) and tags every result with its
 * connector type and the catalog's static capability hints.
 */
export class FabricConnectorProvider implements ConnectorDiscoveryProvider {
  public readonly connectorTypes: readonly ConnectorType[];

  public constructor(
    private readonly connectorType: ConnectorType,
    private readonly itemTypes: readonly string[],
    private readonly client: FabricDiscoveryClient,
    private readonly userOid?: string
  ) {
    this.connectorTypes = [connectorType];
  }

  public async discover(
    request: DiscoveryRequest
  ): Promise<DiscoveredSource[]> {
    const workspaces = await this.client.resolveWorkspaces(request.scope);

    // Pre-fetch roles for all workspaces (parallel, memoized per workspace)
    const roleByWorkspace = new Map<string, WorkspaceRole>();
    await Promise.all(
      workspaces.map(async (ws) => {
        const role = await this.client.getMyRoleInWorkspace(
          ws.id,
          this.userOid
        );
        roleByWorkspace.set(ws.id, role);
      })
    );

    const pairs = await this.client.listItemsAcrossWorkspaces(
      workspaces,
      this.itemTypes
    );

    const meta = CONNECTOR_CATALOG[this.connectorType];

    // Schema discovery for SQL-based connectors depends on SQL endpoint
    // permissions (not queryable here); add eligibility is role-based.
    return pairs
      .filter(({ item }) => matchesQuery(item.displayName, request.query))
      .map(({ workspace, item }) => {
        const role = roleByWorkspace.get(workspace.id) ?? 'Unknown';
        return {
          connectorType: this.connectorType,
          itemType: item.type,
          workspaceId: workspace.id,
          workspaceName: workspace.displayName,
          itemId: item.id,
          displayName: item.displayName,
          capabilities: {
            operations: meta.allowedOperations,
            defaultAuth: meta.defaultAuth,
            requiresVersion: meta.requiresVersion,
          },
          workspaceRole: role,
          ...deriveAddEligibility(role),
        };
      });
  }
}

export default FabricConnectorProvider;
