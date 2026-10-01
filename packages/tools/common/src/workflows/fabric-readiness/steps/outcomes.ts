/** Constructors for the readiness step's typed outcomes. */
import type { FabricWorkspace } from '../../../external/fabric/index.js';

import type {
  EnsureFabricTargetDeps,
  FabricCapacitySource,
  FabricReadinessCancelled,
  FabricReadinessPhase,
  FabricReadinessProblem,
  FabricReadinessReason,
  FabricReadinessNotice,
  FabricTargetReady,
} from './types.js';

/** Whether the host has requested readiness cancellation. */
export function isReadinessCancelled(deps: EnsureFabricTargetDeps): boolean {
  return deps.signal?.isCancellationRequested === true;
}

/** Build the shared readiness cancellation outcome. */
export function cancelledReadiness(): FabricReadinessCancelled {
  return { status: 'cancelled' };
}

/**
 * Announce the phase readiness is entering.
 *
 * Reporting is best-effort and optional: a host that renders nothing simply
 * omits the adapter, so no call site needs to know whether anyone is looking.
 *
 * No percentage is reported. The only Fabric operation that offers one pins it
 * at 0 until it completes, so the figure would be a 0-to-100 jump carrying no
 * information the phase itself does not. `ProgressUpdate` still accepts one for
 * hosts with a real measure.
 */
export function reportPhase(
  deps: EnsureFabricTargetDeps,
  phase: FabricReadinessPhase,
  message: string
): void {
  deps.progress?.report({ phase, message });
}

/** Persist a completed side effect so it remains visible if the process exits. */
export function reportCompleted(
  deps: EnsureFabricTargetDeps,
  message: string
): void {
  deps.logger?.log(message);
}

/** Retain a completed side effect independently of human-readable logging. */
export function reportNotice(
  deps: EnsureFabricTargetDeps,
  notice: FabricReadinessNotice
): void {
  deps.onNotice?.(notice);
}

/** Build the success outcome for a workspace that is ready to deploy to. */
export function ready(
  workspace: FabricWorkspace,
  capacityId: string,
  capacitySource: FabricCapacitySource,
  workspaceCreated: boolean
): FabricTargetReady {
  return {
    status: 'ready',
    workspace,
    capacityId,
    capacitySource,
    workspaceCreated,
  };
}

/** Build a readiness failure the caller renders instead of throwing. */
export function problem(
  status: FabricReadinessProblem['status'],
  reason: FabricReadinessReason,
  message: string,
  retryable: boolean
): FabricReadinessProblem {
  return { status, reason, message, retryable };
}

/** Prefer a thrown error's message, falling back to a caller-owned default. */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
