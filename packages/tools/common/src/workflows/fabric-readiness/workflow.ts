/**
 * `ensureFabricTarget` — prepare a Fabric workspace with usable capacity.
 *
 * The shared readiness workflow delegates its implementation here. The verbs
 * behind it (capacity classification, trial activation, workspace creation,
 * and assignment verification) live in `fabric-readiness/` so this file stays
 * a sequence rather than duplicating orchestration.
 *
 * Two invariants shape the control flow:
 *
 * - **A created workspace is retained.** Its name is logged as soon as creation
 *   completes so the Builder can inspect or remove it manually if a later
 *   readiness or deployment operation fails.
 * - **A trial is never started twice.** Trials are scarce per tenant, so every
 *   "already exists" signal is recovered by rediscovery, never a second POST.
 */
import type {
  FabricCapacity,
  FabricWorkspace,
} from '../../external/fabric/index.js';
import {
  FabricError,
  isSelectablePaidCapacity,
  isTrialCapacity,
  isUsableCapacity,
} from '../../external/fabric/index.js';
import type { Step } from '../types.js';

import {
  cancelledReadiness,
  confirmCapacityAssignment,
  errorMessage,
  fabricProblem,
  isReadinessCancelled,
  problem,
  readinessHint,
  ready,
  reportCompleted,
  reportNotice,
  reportPhase,
  selectCapacity,
  trialAssignmentConfirmationRequired,
  verifyWorkspaceCapacity,
  workspaceName,
} from './steps/index.js';
import type {
  CapacitySelection,
  EnsureFabricTargetDeps,
  EnsureFabricTargetInput,
  EnsureFabricTargetResult,
  FabricCapacitySource,
  FabricPollingOptions,
  FabricReadinessProblem,
  FabricReadinessNotice,
  FabricReadinessReason,
  FabricTargetReady,
} from './steps/index.js';

/** The step's public type surface, re-exported for the workflow that runs it. */
export type {
  EnsureFabricTargetDeps,
  EnsureFabricTargetInput,
  EnsureFabricTargetResult,
  FabricCapacitySource,
  FabricPollingOptions,
  FabricReadinessProblem,
  FabricReadinessNotice,
  FabricReadinessReason,
  FabricTargetReady,
};

export { readinessHint };

export const ensureFabricTarget: Step<
  EnsureFabricTargetInput,
  EnsureFabricTargetResult,
  EnsureFabricTargetDeps
> = async (input, deps) => {
  if (isReadinessCancelled(deps)) return cancelledReadiness();
  const target = await readTargetWorkspace(input.workspaceId, deps);
  if (isReadinessCancelled(deps)) return cancelledReadiness();
  if (target.status === 'problem') return target.problem;
  const workspace = target.workspace;

  // A caller-supplied workspace that reports any capacity assignment is used
  // as-is. Fabric remains authoritative for whether that workspace can host
  // the item; readiness only assigns capacity when the workspace has none.
  if (workspace?.capacityId) {
    return ready(workspace, workspace.capacityId, 'workspace', false);
  }

  if (workspace) {
    const denied = await requireWorkspaceAdmin(workspace, deps);
    if (isReadinessCancelled(deps)) return cancelledReadiness();
    if (denied) return denied;
  }

  const proposedWorkspaceName =
    workspace?.displayName ?? workspaceName(input.projectId);
  let selection: CapacitySelection;
  if (input.capacityId) {
    selection = await resolveExplicitCapacity(input.capacityId, deps);
  } else {
    let capacities: FabricCapacity[];
    try {
      reportPhase(deps, 'capacity', 'Checking Fabric capacity');
      capacities = await deps.fabric.listCapacities();
      if (isReadinessCancelled(deps)) return cancelledReadiness();
    } catch (error) {
      const expected = fabricProblem(error);
      if (expected) return expected;
      throw error;
    }
    const requiresNonInteractiveConsent =
      input.capacityAssignmentMode === 'confirm' && !deps.ui;
    if (
      requiresNonInteractiveConsent &&
      !capacities.some(
        (capacity) =>
          isTrialCapacity(capacity) || isSelectablePaidCapacity(capacity)
      )
    ) {
      return trialAssignmentConfirmationRequired(proposedWorkspaceName);
    }
    selection = await selectCapacity(capacities, deps);
  }
  if (isReadinessCancelled(deps) && selection.status !== 'selected') {
    return cancelledReadiness();
  }
  if (selection.status === 'cancelled') return selection;
  if (selection.status !== 'selected') return selection.problem;
  const { capacity, source } = selection;
  if (source === 'new-trial') {
    reportCompleted(
      deps,
      `Created Fabric trial capacity "${capacity.displayName}".`
    );
    reportNotice(deps, {
      kind: 'trial-started',
      capacityId: capacity.id,
      capacityName: capacity.displayName,
    });
  }
  if (isReadinessCancelled(deps)) return cancelledReadiness();

  const consent = await confirmCapacityAssignment(
    input.capacityAssignmentMode,
    capacity,
    proposedWorkspaceName,
    deps
  );
  if (consent.status === 'assignment-declined') return consent;
  if (consent.status === 'problem') return consent.problem;
  if (isReadinessCancelled(deps)) return cancelledReadiness();

  return workspace
    ? assignExistingWorkspace(workspace, capacity, source, deps)
    : createAssignedWorkspace(proposedWorkspaceName, capacity, source, deps);
};

/** Resolve an explicitly selected capacity without falling back to discovery. */
async function resolveExplicitCapacity(
  capacityId: string,
  deps: EnsureFabricTargetDeps
): Promise<CapacitySelection> {
  try {
    const capacity = await deps.fabric.getCapacity(capacityId);
    if (!isUsableCapacity(capacity)) {
      return {
        status: 'problem',
        problem: problem(
          'action-required',
          'capacity_not_usable',
          `Fabric capacity "${capacity.displayName}" (${capacity.id}) is not active or uses an unsupported SKU.`,
          false
        ),
      };
    }
    return { status: 'selected', capacity, source: 'explicit' };
  } catch (error) {
    const expected = fabricProblem(error);
    if (expected) return { status: 'problem', problem: expected };
    if (error instanceof FabricError && error.statusCode === 404) {
      return {
        status: 'problem',
        problem: problem(
          'action-required',
          'capacity_not_usable',
          `Fabric capacity ${capacityId} was not found or is not accessible.`,
          false
        ),
      };
    }
    throw error;
  }
}

type TargetWorkspace =
  | { status: 'resolved'; workspace?: FabricWorkspace }
  | { status: 'problem'; problem: FabricReadinessProblem };

/** Read the caller-supplied workspace, if the run targets one. */
async function readTargetWorkspace(
  workspaceId: string | undefined,
  deps: EnsureFabricTargetDeps
): Promise<TargetWorkspace> {
  if (!workspaceId) return { status: 'resolved' };

  try {
    const workspace = await deps.fabric.getWorkspace(workspaceId);
    return { status: 'resolved', workspace };
  } catch (error) {
    const expected = fabricProblem(error);
    if (expected) return { status: 'problem', problem: expected };
    throw error;
  }
}

/** Assigning capacity to an existing workspace requires Workspace Admin. */
async function requireWorkspaceAdmin(
  workspace: FabricWorkspace,
  deps: EnsureFabricTargetDeps
): Promise<FabricReadinessProblem | undefined> {
  let isAdmin: boolean;
  try {
    isAdmin = await deps.fabric.isWorkspaceAdmin(workspace.id);
  } catch (error) {
    const expected = fabricProblem(error);
    if (expected) return expected;
    throw error;
  }

  if (isAdmin) return undefined;

  return problem(
    'action-required',
    'workspace_admin_required',
    `Workspace Admin permission is required to assign capacity to "${workspace.displayName}".`,
    false
  );
}

/** The readiness problem for an assignment Fabric refused or dropped. */
function assignmentFailure(error: unknown): FabricReadinessProblem {
  return (
    fabricProblem(error) ??
    problem(
      'failed',
      'workspace_assignment_failed',
      errorMessage(error, 'Fabric workspace capacity assignment failed.'),
      true
    )
  );
}

/** Assign a user-owned workspace. Never deleted, however the assignment ends. */
async function assignExistingWorkspace(
  workspace: FabricWorkspace,
  capacity: FabricCapacity,
  source: FabricCapacitySource,
  deps: EnsureFabricTargetDeps
): Promise<EnsureFabricTargetResult> {
  return assignAndVerifyWorkspace(workspace, capacity, source, false, deps);
}

/** Assign capacity, verify completion, and record the completed side effect. */
async function assignAndVerifyWorkspace(
  workspace: FabricWorkspace,
  capacity: FabricCapacity,
  source: FabricCapacitySource,
  workspaceCreated: boolean,
  deps: EnsureFabricTargetDeps
): Promise<EnsureFabricTargetResult> {
  if (isReadinessCancelled(deps)) return cancelledReadiness();
  try {
    reportPhase(deps, 'assignment', 'Assigning workspace to Fabric capacity');
    const accepted = await deps.fabric.assignWorkspaceToCapacity(
      workspace.id,
      capacity.id
    );
    if (isReadinessCancelled(deps)) return cancelledReadiness();
    return finishWorkspaceAssignment(
      workspace,
      capacity,
      source,
      workspaceCreated,
      accepted?.retryAfterMs,
      deps
    );
  } catch (error) {
    return assignmentFailure(error);
  }
}

async function finishWorkspaceAssignment(
  workspace: FabricWorkspace,
  capacity: FabricCapacity,
  source: FabricCapacitySource,
  workspaceCreated: boolean,
  initialDelayMs: number | undefined,
  deps: EnsureFabricTargetDeps
): Promise<EnsureFabricTargetResult> {
  let verified;
  try {
    verified = await verifyWorkspaceCapacity(
      workspace.id,
      capacity.id,
      deps,
      initialDelayMs
    );
  } catch (error) {
    if (workspaceCreated) return assignmentFailure(error);
    throw error;
  }
  if (verified.status !== 'ready') return verified;
  reportCompleted(
    deps,
    `Assigned Fabric workspace "${verified.workspace.displayName}" to capacity "${capacity.displayName}".`
  );
  reportNotice(deps, {
    kind: 'capacity-assigned',
    workspaceId: verified.workspace.id,
    workspaceName: verified.workspace.displayName,
    capacityId: capacity.id,
    capacityName: capacity.displayName,
  });
  return ready(verified.workspace, capacity.id, source, workspaceCreated);
}

/**
 * Create the project's workspace and assign it capacity.
 *
 * The workspace is retained if a later operation fails. Its identity is logged
 * immediately so the Builder can inspect or remove it manually.
 */
async function createAssignedWorkspace(
  proposedWorkspaceName: string,
  capacity: FabricCapacity,
  source: FabricCapacitySource,
  deps: EnsureFabricTargetDeps
): Promise<EnsureFabricTargetResult> {
  if (isReadinessCancelled(deps)) return cancelledReadiness();
  let created: FabricWorkspace;
  try {
    reportPhase(deps, 'workspace', 'Creating Fabric workspace');
    created = await deps.fabric.createWorkspace(proposedWorkspaceName);
    reportCompleted(
      deps,
      `Created Fabric workspace "${created.displayName}". If this command is interrupted, delete it manually in the Fabric portal.`
    );
    reportNotice(deps, {
      kind: 'workspace-created',
      workspaceId: created.id,
      workspaceName: created.displayName,
    });
    if (isReadinessCancelled(deps)) return cancelledReadiness();
  } catch (error) {
    return (
      fabricProblem(error) ??
      problem(
        'failed',
        'workspace_creation_failed',
        errorMessage(error, 'Fabric workspace creation failed.'),
        true
      )
    );
  }

  return assignAndVerifyWorkspace(created, capacity, source, true, deps);
}
