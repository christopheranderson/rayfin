/** Consent gate for assigning a Fabric capacity to a workspace. */
import type { FabricCapacity } from '../../../external/fabric/index.js';

import { problem } from './outcomes.js';
import type {
  EnsureFabricTargetDeps,
  FabricCapacityAssignmentDeclined,
  FabricReadinessProblem,
} from './types.js';

export type CapacityAssignmentConsent =
  | { status: 'approved' }
  | FabricCapacityAssignmentDeclined
  | { status: 'problem'; problem: FabricReadinessProblem };

/** Confirm the exact capacity-to-workspace assignment when it is not pre-approved. */
export async function confirmCapacityAssignment(
  mode: 'confirm' | 'automatic',
  capacity: FabricCapacity,
  workspaceName: string,
  deps: EnsureFabricTargetDeps
): Promise<CapacityAssignmentConsent> {
  if (mode === 'automatic') return { status: 'approved' };

  if (!deps.ui) {
    return {
      status: 'problem',
      problem: capacityAssignmentConfirmationRequired(workspaceName, capacity),
    };
  }

  const confirmed = await deps.ui.confirm(
    `Assign capacity ${capacity.displayName} (${capacity.id}) to workspace ${workspaceName}?`,
    { default: true }
  );
  return confirmed ? { status: 'approved' } : { status: 'assignment-declined' };
}

/** Fail closed before trial provisioning when no interactive consent is possible. */
export function trialAssignmentConfirmationRequired(
  workspaceName: string
): FabricReadinessProblem {
  return problem(
    'action-required',
    'capacity_assignment_confirmation_required',
    `Provisioning and assigning Fabric trial capacity to workspace ${workspaceName} requires confirmation.`,
    true
  );
}

function capacityAssignmentConfirmationRequired(
  workspaceName: string,
  capacity: FabricCapacity
): FabricReadinessProblem {
  return problem(
    'action-required',
    'capacity_assignment_confirmation_required',
    `Assigning capacity ${capacity.displayName} (${capacity.id}) to workspace ${workspaceName} requires confirmation.`,
    true
  );
}
