import type {
  CancellationToken,
  Diagnostics,
  Progress,
} from '../../adapters/index.js';
import type {
  FabricStatusClient,
  FabricWorkspace,
  ManagementEndpointHealth,
} from '../../external/fabric/index.js';
import type {
  ActiveDeployment,
  DeploymentRegistryService,
} from '../../services/deployment-registry/index.js';

/** Product intent for read-only deployment inspection. @internal */
export interface UpStatusRequest {
  projectPath: string;
  deploymentName?: string;
  workspaceId?: string;
}

/** Project facts needed for status, supplied by a host-backed reader. @internal */
export interface StatusProject {
  projectRoot: string;
  id: string;
  services?: {
    auth?: { enabled?: boolean };
    data?: { enabled?: boolean };
    storage?: { enabled?: boolean };
  };
}

/** Collected status facts; a successful inspection can report an unhealthy endpoint. @internal */
export interface UpStatusData {
  projectName: string;
  deployment: ActiveDeployment;
  services: { auth: boolean; data: boolean; storage: boolean };
  authenticated: boolean;
  workspace: FabricWorkspace | null;
  item: Awaited<ReturnType<FabricStatusClient['getItem']>>;
  database:
    | Awaited<ReturnType<FabricStatusClient['listDatabases']>>[number]
    | null;
  endpointHealth: ManagementEndpointHealth | null;
}

/** Only the read capabilities required by this workflow. @internal */
export interface UpStatusDeps {
  project: { load(path: string): Promise<StatusProject | null> };
  registry: Pick<
    DeploymentRegistryService,
    'getActiveDeployment' | 'readDeployment' | 'listDeployments'
  >;
  fabric: { tryConnect(): Promise<FabricStatusClient | null> };
  cancellation: CancellationToken;
  diagnostics: Diagnostics;
  progress: Progress;
}
