/**
 * Fabric operations interface (Layer 3 external client).
 *
 * The seam that workflow steps depend on for Microsoft Fabric operations.
 * Today it is backed by the hand-rolled {@link FabricHttpClient} transport
 * (via each host's thin impl); when the generated Fabric TypeScript SDK lands
 * it drops in as an alternative implementation — typed methods for the public
 * REST surface, the SDK's generic client for `__private/*` workload calls —
 * without changing the steps that consume it.
 *
 * Auth wiring and client assembly live in the host: the CLI builds this from
 * an acquired bearer token (`cli/src/external-services/fabric/`); the universal
 * interface never acquires tokens itself.
 *
 * Operations are added as the first consuming step needs them (RFC: "introduce
 * the operations interface when the first step needs an operation"). The
 * workspace operations are shaped by the `up` workflow's `resolve-workspace`
 * step; the item operations by its `resolve-or-create-item` step.
 */

import type {
  FabricCapacity,
  FabricOperationStatus,
  TrialEligibility,
} from './capacity.js';
import type { FabricPollableOperation } from './types.js';
import type { FabricAcceptedResponse } from './types.js';

/** A Microsoft Fabric workspace, narrowed to the fields Rayfin tools consume. */
export interface FabricWorkspace {
  /** Workspace GUID. */
  id: string;
  /** Human-readable workspace name shown in the Fabric portal. */
  displayName: string;
  /** Optional workspace description. */
  description?: string;
  /** Capacity GUID the workspace is assigned to, when applicable. */
  capacityId?: string;
  /** Progress of an asynchronous capacity assignment, when reported. */
  capacityAssignmentProgress?: string;
  /** Workspace lifecycle state reported by Fabric. */
  state?: string;
  /** Workspace type discriminator reported by Fabric. */
  type?: string;
}

/**
 * A Rayfin item (Fabric `AppBackend`), narrowed to the fields Rayfin tools
 * consume. Item operations target this Rayfin-specific item type; the impl
 * filters Fabric's generic Items API to it.
 */
export interface FabricItem {
  /** Item GUID. */
  id: string;
  /** Human-readable item name shown in the Fabric portal. */
  displayName: string;
  /** Fabric item type discriminator (the Rayfin `AppBackend` workload). */
  type: string;
  /** GUID of the workspace the item lives in. */
  workspaceId: string;
  /** Optional item description. */
  description?: string;
}

/** Operations over the Microsoft Fabric REST API consumed by workflow steps. */
export interface FabricClient {
  /**
   * Find an active Fabric trial capacity the principal can use, if one exists.
   *
   * Trial provisioning uses this for eventual-consistency rediscovery after
   * eligibility or operation responses report that a trial already exists.
   * An implementation SHOULD stop reading pages at the first match.
   */
  findTrialCapacity(): Promise<FabricCapacity | undefined>;

  /**
   * List every capacity the authenticated principal may assign.
   *
   * Readiness uses the complete list to offer active paid F-SKU capacity
   * without silently choosing the first result.
   */
  listCapacities(): Promise<FabricCapacity[]>;

  /**
   * Fetch a single capacity by its GUID.
   *
   * Readiness uses this to confirm the capacity a workspace already carries is
   * still deployable: Fabric keeps reporting `capacityId` on the workspace
   * after the capacity behind it stops being usable — a trial that has since
   * expired, or one an administrator paused — so assignment progress alone
   * cannot answer whether a deployment can proceed.
   */
  getCapacity(capacityId: string): Promise<FabricCapacity>;

  /**
   * Check whether a Fabric-licensed delegated user can activate the Fabric
   * trial entitlement and capacity.
   */
  checkTrialEligibility(): Promise<TrialEligibility>;

  /**
   * Activate the eligible user's Fabric trial entitlement and provision its
   * trial capacity, returning metadata for caller-owned polling.
   */
  startTrial(): Promise<FabricPollableOperation>;

  /**
   * Read the current status of a Fabric long-running operation.
   *
   * The operation ID lets proxy-backed hosts rebuild a canonical Fabric
   * location under their configured endpoint without following another
   * origin.
   */
  getOperationStatus(
    operationLocation: string,
    operationId?: string
  ): Promise<FabricOperationStatus>;

  /** Fetch the result of a successfully completed Fabric operation. */
  getOperationResult<T>(operationId: string): Promise<T>;

  /**
   * List every workspace the authenticated principal can access. The impl
   * follows Fabric API pagination so callers receive the full set, not just
   * the first page.
   */
  listWorkspaces(): Promise<FabricWorkspace[]>;

  /**
   * Report whether the principal holds the `Admin` role on a workspace.
   *
   * Fabric answers this only by listing role-filtered workspaces, so the search
   * is the host's concern for the same reason as {@link findTrialCapacity}: an
   * implementation SHOULD stop at the match rather than materializing every
   * workspace in the tenant to answer one yes-or-no question.
   */
  isWorkspaceAdmin(workspaceId: string): Promise<boolean>;

  /** Fetch a single workspace by its GUID. */
  getWorkspace(workspaceId: string): Promise<FabricWorkspace>;

  /** Create a workspace without assigning capacity. */
  createWorkspace(displayName: string): Promise<FabricWorkspace>;

  /** Assign an existing workspace to a validated capacity. */
  assignWorkspaceToCapacity(
    workspaceId: string,
    capacityId: string
  ): Promise<FabricAcceptedResponse>;

  /**
   * Find the Rayfin item with the given display name in a workspace, matched
   * case-insensitively. Resolves to `undefined` when no such item exists.
   */
  getItemByName(
    workspaceId: string,
    displayName: string
  ): Promise<FabricItem | undefined>;

  /** Create a new Rayfin item with the given display name in a workspace. */
  createItem(workspaceId: string, displayName: string): Promise<FabricItem>;
}
