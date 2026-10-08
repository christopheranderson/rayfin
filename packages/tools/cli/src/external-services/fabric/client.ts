/**
 * CLI implementation of the {@link FabricClient} operations interface.
 *
 * Assembly only: this factory acquires nothing and builds no URLs. It wires
 * one authenticated transport into the per-resource managers that own their
 * endpoints — {@link WorkspaceV2Manager}, {@link CapacityManager}, and the
 * legacy {@link RayfinItemManager}, which keeps the workload's private item
 * semantics — then exposes them as the universal `FabricClient` contract.
 *
 * The workspace and capacity managers sit on the universal `FabricHttpClient`
 * rather than the legacy `FabricApiClient` base class, so every call shares
 * one error shape, one pagination implementation, and one endpoint
 * confinement rule. Swapping in the generated Fabric SDK later is a change
 * here, never in the `common/` steps that consume the interface.
 */
import type {
  Diagnostics,
  Http,
} from '@microsoft/rayfin-tools-common/_internal/adapters';
import type {
  FabricPollableOperation,
  FabricAcceptedResponse,
  FabricCapacity,
  FabricClient,
  FabricItem,
  FabricOperationStatus,
  FabricWorkspace,
  TrialEligibility,
} from '@microsoft/rayfin-tools-common/_internal/external/fabric';
import {
  CapacityManager,
  FabricHttpClient,
  WorkspaceManager,
} from '@microsoft/rayfin-tools-common/_internal/external/fabric';
import type { FabricReadinessClient } from '@microsoft/rayfin-tools-common/_internal/workflows/fabric-readiness';

import { getFabricSettings } from '../../config/constants.js';
import { RayfinItemManager } from '../../services/fabric/rayfin-item.js';
import { fabricFetch } from '../../utils/http-client.js';

/** V2 workflows return/render operation facts; legacy client banners stay silent. */
const silentOutput = {
  log: (): void => {},
  warn: (): void => {},
  error: (): void => {},
};

/**
 * Construct the CLI-host {@link FabricClient} from an acquired Fabric bearer
 * token (e.g. the token returned by `ensureAuthenticated()`).
 */
export function createCliFabricClient(
  accessToken: string,
  options: {
    http?: Http;
    baseUrl?: string;
    diagnostics?: Diagnostics;
    signal?: AbortSignal;
  } = {}
): FabricClient {
  const readiness = createCliFabricReadinessClient(accessToken, options);
  const output = { ...silentOutput, diagnostics: options.diagnostics };
  const items = new RayfinItemManager(accessToken, output);
  return {
    ...readiness,
    getItemByName(
      workspaceId: string,
      displayName: string
    ): Promise<FabricItem | undefined> {
      return items.getRayfinItemByName(workspaceId, displayName);
    },
    createItem(workspaceId: string, displayName: string): Promise<FabricItem> {
      return items.createRayfinItem(workspaceId, displayName);
    },
  };
}

/** Construct only the Fabric capacity/workspace operations readiness needs. */
export function createCliFabricReadinessClient(
  accessToken: string,
  options: {
    http?: Http;
    baseUrl?: string;
    diagnostics?: Diagnostics;
    signal?: AbortSignal;
  } = {}
): FabricReadinessClient {
  const baseUrl =
    options.baseUrl ?? getFabricSettings().fabricApiBaseUrl.replace(/\/+$/, '');
  const transport = new FabricHttpClient({
    http: options.http ?? {
      async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${accessToken}`);
        return fabricFetch(input, { ...init, headers });
      },
    },
    baseUrl,
    diagnostics: options.diagnostics,
    signal: options.signal,
  });

  const workspaces = new WorkspaceManager(transport, baseUrl);
  const capacities = new CapacityManager(transport, baseUrl);

  return {
    findTrialCapacity(): Promise<FabricCapacity | undefined> {
      return capacities.findTrial();
    },
    listCapacities(): Promise<FabricCapacity[]> {
      return capacities.list();
    },
    getCapacity(capacityId: string): Promise<FabricCapacity> {
      return capacities.get(capacityId);
    },
    checkTrialEligibility(): Promise<TrialEligibility> {
      return capacities.checkTrialEligibility();
    },
    startTrial(): Promise<FabricPollableOperation> {
      return capacities.startTrial();
    },
    getOperationStatus(
      operationLocation: string,
      operationId?: string
    ): Promise<FabricOperationStatus> {
      return capacities.getOperationStatus(operationLocation, operationId);
    },
    getOperationResult<T>(operationId: string): Promise<T> {
      return capacities.getOperationResult<T>(operationId);
    },
    listWorkspaces(): Promise<FabricWorkspace[]> {
      return workspaces.list();
    },
    isWorkspaceAdmin(workspaceId: string): Promise<boolean> {
      return workspaces.isAdmin(workspaceId);
    },
    getWorkspace(workspaceId: string): Promise<FabricWorkspace> {
      return workspaces.get(workspaceId);
    },
    createWorkspace(displayName: string): Promise<FabricWorkspace> {
      return workspaces.create(displayName);
    },
    assignWorkspaceToCapacity(
      workspaceId: string,
      capacityId: string
    ): Promise<FabricAcceptedResponse> {
      return workspaces.assignToCapacity(workspaceId, capacityId);
    },
  };
}

/** Resolve an existing Fabric item's current display name by its recorded ID. */
export async function getCliFabricItemById(
  accessToken: string,
  workspaceId: string,
  itemId: string
): Promise<FabricItem | undefined> {
  const items = new RayfinItemManager(accessToken, silentOutput);
  return items.getFabricItemById(workspaceId, itemId);
}
