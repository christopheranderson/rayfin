/**
 * Capacity selection.
 *
 * Capacity resolution distinguishes trial capacity from supported premium
 * capacity (P1-P5 and the supported F-SKU allowlist). Ambiguous combinations
 * are returned to the host so it can use its existing targeting fallback.
 */
import {
  isSelectablePaidCapacity,
  isTrialCapacity,
  type FabricCapacity,
} from '../../../external/fabric/index.js';

import { problem } from './outcomes.js';
import { selectTrialCapacity } from './trial-provisioning.js';
import type { CapacitySelection, EnsureFabricTargetDeps } from './types.js';

/** Choose the capacity a workspace will be assigned to. */
export async function selectCapacity(
  capacities: readonly FabricCapacity[],
  deps: EnsureFabricTargetDeps
): Promise<CapacitySelection> {
  const trialCapacities = capacities.filter((capacity) =>
    isTrialCapacity(capacity)
  );
  const premiumCapacities = capacities.filter(isSelectablePaidCapacity);
  const policy =
    deps.premiumCapacitySelection ?? (deps.ui ? 'prompt' : 'fallback');

  if (premiumCapacities.length === 0) {
    const existingTrial = trialCapacities[0];
    if (existingTrial) {
      return {
        status: 'selected',
        capacity: existingTrial,
        source: 'existing-trial',
      };
    }
    return selectTrialCapacity(deps);
  }

  if (premiumCapacities.length === 1) {
    return {
      status: 'selected',
      capacity: premiumCapacities[0],
      source: 'selected-paid',
    };
  }

  if (policy !== 'prompt' || !deps.ui) {
    return multiplePremiumCapacitiesRequireSelection();
  }

  const selected = await deps.ui.select(
    'Which Fabric capacity should Rayfin use?',
    premiumCapacities.map((capacity) => ({
      label: capacity.displayName,
      value: capacity,
      description: `Premium SKU ${capacity.sku}`,
    })),
    { requireExplicitChoice: true }
  );
  if (!selected) return { status: 'cancelled' };

  return {
    status: 'selected',
    capacity: selected,
    source: 'selected-paid',
  };
}

function multiplePremiumCapacitiesRequireSelection(): CapacitySelection {
  return {
    status: 'problem',
    problem: problem(
      'action-required',
      'capacity_selection_required',
      'Multiple premium Fabric capacities are available and require interactive selection.',
      true
    ),
  };
}
