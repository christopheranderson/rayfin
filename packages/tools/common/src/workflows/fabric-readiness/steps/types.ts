/**
 * Contracts shared by the Fabric readiness modules.
 *
 * The step's public shape lives here so the focused modules under
 * `fabric-readiness/` can depend on the vocabulary without depending on each
 * other.
 */
import type {
  CancellationToken,
  Logger,
  Progress,
  UserInteraction,
} from '../../../adapters/index.js';
import type {
  FabricCapacity,
  FabricClient,
  FabricWorkspace,
} from '../../../external/fabric/index.js';

/** Fabric operations used by readiness, excluding Rayfin item deployment. */
export type FabricReadinessClient = Pick<
  FabricClient,
  | 'findTrialCapacity'
  | 'listCapacities'
  | 'getCapacity'
  | 'checkTrialEligibility'
  | 'startTrial'
  | 'getOperationStatus'
  | 'getOperationResult'
  | 'listWorkspaces'
  | 'isWorkspaceAdmin'
  | 'getWorkspace'
  | 'createWorkspace'
  | 'assignWorkspaceToCapacity'
>;

/** Where the capacity backing the deployment came from. */
export type FabricCapacitySource =
  | 'workspace'
  | 'explicit'
  | 'selected-paid'
  | 'existing-trial'
  | 'new-trial';

/** Whether workspace-capacity assignment is pre-approved or needs a prompt. */
export type CapacityAssignmentMode = 'confirm' | 'automatic';

/** Host policy for resolving multiple available premium capacities. */
export type PremiumCapacitySelectionPolicy = 'prompt' | 'fallback';

/** Machine-readable outcome codes a readiness failure can report. */
export type FabricReadinessReason =
  | 'capacity_not_usable'
  | 'capacity_selection_required'
  | 'capacity_assignment_confirmation_required'
  | 'workspace_admin_required'
  | 'trials_disabled'
  | 'trial_limit_exceeded'
  | 'ineligible_for_trial'
  | 'trial_provisioning_failed'
  | 'trial_provisioning_timeout'
  | 'too_many_requests'
  | 'fabric_authentication_required'
  | 'fabric_permission_missing'
  | 'workspace_assignment_failed'
  | 'workspace_assignment_timeout'
  | 'workspace_creation_failed';

/** Normalized intent handed to the readiness step. */
export interface EnsureFabricTargetInput {
  projectId: string;
  workspaceId?: string;
  /** Exact Fabric capacity explicitly selected by the caller. */
  capacityId?: string;
  /** Whether the eventual workspace-capacity assignment needs confirmation. */
  capacityAssignmentMode: CapacityAssignmentMode;
}

/** A readiness outcome the caller must surface rather than retry blindly. */
export interface FabricReadinessProblem {
  status: 'action-required' | 'retry-later' | 'failed';
  reason: FabricReadinessReason;
  message: string;
  retryable: boolean;
}

/** Readiness stopped because the user dismissed capacity selection. */
export interface FabricReadinessCancelled {
  status: 'cancelled';
}

/** The proposed assignment was declined so the host can resume target fallback. */
export interface FabricCapacityAssignmentDeclined {
  status: 'assignment-declined';
}

/** A workspace that is assigned to usable capacity and safe to deploy to. */
export interface FabricTargetReady {
  status: 'ready';
  workspace: FabricWorkspace;
  capacityId: string;
  capacitySource: FabricCapacitySource;
  workspaceCreated: boolean;
}

/** Fabric resources created or changed during readiness. */
export type FabricReadinessNotice =
  | {
      kind: 'workspace-created';
      workspaceId: string;
      workspaceName: string;
    }
  | {
      kind: 'trial-started';
      capacityId: string;
      capacityName: string;
    }
  | {
      kind: 'capacity-assigned';
      workspaceId: string;
      workspaceName: string;
      capacityId: string;
      capacityName: string;
    };

/** Result of preparing a Fabric deployment target. */
export type EnsureFabricTargetResult =
  | FabricTargetReady
  | FabricReadinessCancelled
  | FabricCapacityAssignmentDeclined
  | FabricReadinessProblem;

/**
 * Poll pacing for the two long-running Fabric operations readiness drives.
 *
 * Defaults follow Fabric's published guidance; a host (or a test) can shorten
 * them without reaching into module constants.
 */
export interface FabricPollingOptions {
  /** Delay before the second poll when the service sends no `Retry-After`. */
  initialDelayMs?: number;
  /** Ceiling for the backoff applied between polls. */
  maxDelayMs?: number;
  /** Total budget for trial capacity provisioning. */
  trialTimeoutMs?: number;
  /** Total budget for a workspace capacity assignment to complete. */
  assignmentTimeoutMs?: number;
}

/**
 * Coarse phases readiness reports as it advances.
 *
 * Readiness is the only part of `up` that can block for minutes at a time —
 * trial provisioning alone is budgeted at ten — so each phase is announced
 * before it starts rather than summarized after it finishes.
 */
export type FabricReadinessPhase =
  | 'capacity'
  | 'trial'
  | 'workspace'
  | 'assignment';

/** Capability slice the readiness step composes. */
export interface EnsureFabricTargetDeps {
  fabric: FabricReadinessClient;
  /** Explicit capacity selection, supplied only by interactive hosts. */
  ui?: UserInteraction;
  /** How to resolve multiple premium capacities without changing core policy. */
  premiumCapacitySelection?: PremiumCapacitySelectionPolicy;
  /** Cooperative cancellation for polling and workflow outcome mapping. */
  signal?: CancellationToken;
  /** Durable milestone output for resources the user may need to clean up manually. */
  logger?: Logger;
  /** Typed side effects retained by the readiness workflow for structured output. */
  onNotice?: (notice: FabricReadinessNotice) => void;
  /** Push-style progress; omitted when the host renders nothing. */
  progress?: Progress;
  /** Poll pacing overrides; omitted values fall back to Fabric guidance. */
  polling?: FabricPollingOptions;
}

/** Outcome of looking for an already-provisioned trial capacity. */
export type TrialLookup =
  | { status: 'found'; capacity: FabricCapacity }
  | { status: 'not-found' }
  | { status: 'problem'; problem: FabricReadinessProblem };

/** Outcome of choosing the capacity a workspace will be assigned to. */
export type CapacitySelection =
  | {
      status: 'selected';
      capacity: FabricCapacity;
      source: FabricCapacitySource;
    }
  | FabricReadinessCancelled
  | { status: 'problem'; problem: FabricReadinessProblem };

/** Outcome of confirming a workspace reached its target capacity. */
export type WorkspaceVerification =
  | { status: 'ready'; workspace: FabricWorkspace }
  | FabricReadinessProblem;
