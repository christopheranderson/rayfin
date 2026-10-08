/**
 * Shared Fabric-readiness workflow.
 *
 * Hosts provide an authenticated Fabric operations client and render the typed
 * result. Workspace selection after an unavailable readiness attempt remains a
 * host concern because it may require interactive UI.
 */
import { cancelled, failed, ok, type Workflow } from '../types.js';

import type {
  EnsureFabricTargetInput,
  FabricReadinessNotice,
} from './steps/index.js';
import {
  ensureFabricTarget,
  type EnsureFabricTargetDeps,
  type EnsureFabricTargetResult,
} from './workflow.js';
export { readinessHint, readinessHintForReason } from './steps/index.js';
export type {
  EnsureFabricTargetInput as FabricReadinessRequest,
  CapacityAssignmentMode,
  FabricCapacitySource,
  FabricReadinessClient,
  FabricReadinessNotice,
  FabricReadinessProblem,
  FabricReadinessReason,
  FabricTargetReady,
  PremiumCapacitySelectionPolicy,
} from './steps/index.js';

export type FabricReadinessDeps = Omit<EnsureFabricTargetDeps, 'onNotice'>;

export interface FabricReadinessOutcome {
  result: Exclude<EnsureFabricTargetResult, { status: 'cancelled' }>;
  notices: FabricReadinessNotice[];
}

export const runFabricReadinessWorkflow: Workflow<
  EnsureFabricTargetInput,
  FabricReadinessOutcome,
  FabricReadinessDeps,
  FabricReadinessNotice
> = async (request, deps) => {
  const notices: FabricReadinessNotice[] = [];
  const isCancelled = (): boolean =>
    deps.signal?.isCancellationRequested === true;
  if (isCancelled()) {
    return cancelled(notices);
  }
  try {
    const result = await ensureFabricTarget(request, {
      ...deps,
      onNotice: (notice) => notices.push(notice),
    });
    if (result.status === 'cancelled') {
      return cancelled(notices);
    }
    if (isCancelled()) {
      return cancelled(notices);
    }
    return ok({ result, notices });
  } catch (error) {
    if (isCancelled()) {
      return cancelled(notices);
    }
    return failed(
      'fabric-readiness-failed',
      error instanceof Error ? error.message : String(error),
      error,
      notices
    );
  }
};
