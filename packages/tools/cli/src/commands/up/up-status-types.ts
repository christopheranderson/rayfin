import type { ManagementEndpointHealth } from '@microsoft/rayfin-tools-common/_internal/external/fabric';

import type { DeploymentEnvVars } from '../../utils/env-fabric-utils.js';

export const UP_STATUS_EXIT_CODES = {
  HEALTHY: 0,
  ERROR: 1,
  UNHEALTHY: 2,
  CANCELLED: 2,
} as const;

export interface WorkspaceInfo {
  id: string;
  displayName: string;
  capacityId?: string;
  state?: string;
}

export interface ItemInfo {
  id: string;
  displayName: string;
  type: string;
}

export interface DatabaseInfo {
  id: string;
  displayName: string;
  deepLink: string;
}

export interface EndpointHealth extends ManagementEndpointHealth {
  hint?: string;
}

export interface EnvFabricInfo {
  exists: boolean;
  workspaceName?: string;
  apiUrl?: string;
  itemId?: string;
  publishableKey?: string;
  fabricWorkspaceId?: string;
  hostingUrl?: string;
}

export interface UpStatusInfo {
  projectName: string;
  deployment: DeploymentEnvVars;
  services: {
    auth: boolean;
    data: boolean;
    storage: boolean;
  };
  workspace: WorkspaceInfo | null;
  item: ItemInfo | null;
  database: DatabaseInfo | null;
  endpointHealth: EndpointHealth | null;
  envFabric: EnvFabricInfo;
  authenticated: boolean;
}
