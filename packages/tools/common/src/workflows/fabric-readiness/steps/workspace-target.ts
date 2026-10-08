/** Workspace assignment and verification helpers. */
import { sanitizeWorkspaceName } from '../../../config/index.js';
import {
  FabricError,
  isSupportedPremiumCapacitySku,
  isUsableCapacity,
} from '../../../external/fabric/index.js';
import type {
  FabricCapacity,
  FabricWorkspace,
} from '../../../external/fabric/index.js';

import { problem } from './outcomes.js';
import {
  MAX_TRANSIENT_POLL_ERRORS,
  assignmentPacing,
  delay,
  nextDelayMs,
  untilDeadline,
} from './polling.js';
import { fabricProblem, isTransientFabricError } from './problems.js';
import type {
  EnsureFabricTargetDeps,
  FabricReadinessProblem,
  WorkspaceVerification,
} from './types.js';

/** Progress Fabric reports for an asynchronous capacity assignment. */
export type AssignmentState = 'completed' | 'in-progress' | 'failed';

/**
 * Classify a workspace's capacity assignment.
 *
 * Fabric omits `capacityAssignmentProgress` on tenants that assign
 * synchronously, so an absent value with a capacity id counts as complete. Any
 * other non-terminal value means the assignment is still running — treating it
 * as done would hand the deployment a workspace whose capacity can still fail.
 */
export function assignmentState(workspace: FabricWorkspace): AssignmentState {
  const progress = workspace.capacityAssignmentProgress?.toLowerCase();
  if (progress === undefined || progress === 'completed') return 'completed';
  if (progress === 'failed') return 'failed';
  return 'in-progress';
}

/** Registry keys are narrower than Fabric's 256-character display-name cap. */
const WORKSPACE_NAME_MAX = 200;
const NONCE_LENGTH = 8;

/**
 * Name the workspace this invocation creates.
 *
 * Fabric does not enforce unique workspace display names, so the project id
 * alone silently produces indistinguishable workspaces: a failed deploy, or a
 * deleted `.deployments.json`, makes the next run create a second `my-app`
 * that no portal list, picker, or deployment registry can tell from the first.
 * A UTC creation stamp plus random nonce makes each one identifiable and
 * collision-resistant, including concurrent invocations.
 *
 * The stamp is UTC rather than local time on purpose: local time repeats an
 * hour at every DST fall-back, which would defeat the uniqueness this exists
 * to provide, and it keeps ordering consistent across a team split over
 * timezones.
 */
export function workspaceName(
  projectId: string,
  now: Date = new Date(),
  nonce: string = randomNonce()
): string {
  const stamp = utcStamp(now);
  const safeNonce = sanitizeWorkspaceName(nonce).slice(0, NONCE_LENGTH);
  const suffix = `${stamp}-${safeNonce || randomNonce()}`;
  const maxBase = WORKSPACE_NAME_MAX - suffix.length - 1;
  const base = sanitizeWorkspaceName(projectId).slice(0, maxBase) || 'rayfin';
  return `${base}-${suffix}`;
}

/** `YYYYMMDD-HHMMSSmmm`, derived from the ISO form to stay zero-padded. */
function utcStamp(now: Date): string {
  const iso = now.toISOString();
  const date = iso.slice(0, 10).replace(/-/g, '');
  const time = iso.slice(11, 23).replace(/[:.]/g, '');
  return `${date}-${time}`;
}

function randomNonce(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, NONCE_LENGTH);
}

/** Whether the capacity behind an existing assignment can still be deployed to. */
export type CapacityHealth =
  | { status: 'usable' }
  | { status: 'gone' }
  | { status: 'problem'; problem: FabricReadinessProblem };

/**
 * Confirm the capacity a workspace already carries is still deployable.
 *
 * A workspace keeps reporting `capacityId` — and a `Completed` assignment —
 * after the capacity behind it stops being usable, because the assignment did
 * succeed; it is the capacity that later expired or was paused. Deploying on
 * that answer fails later and less legibly than refusing here.
 *
 * A capacity Fabric no longer knows about is reported as `gone` rather than a
 * failure: the workspace is then effectively unassigned, which is a state the
 * normal selection path already recovers.
 */
export async function capacityHealth(
  capacityId: string,
  deps: EnsureFabricTargetDeps
): Promise<CapacityHealth> {
  try {
    const capacity = await deps.fabric.getCapacity(capacityId);
    if (isUsableCapacity(capacity)) return { status: 'usable' };

    return {
      status: 'problem',
      problem: problem(
        'action-required',
        'capacity_not_usable',
        capacityNotUsableMessage(capacity),
        false
      ),
    };
  } catch (error) {
    if (error instanceof FabricError && error.statusCode === 404) {
      return { status: 'gone' };
    }
    const expected = fabricProblem(error);
    if (expected) return { status: 'problem', problem: expected };
    throw error;
  }
}

/** Name the reason a capacity was refused, not merely the capacity. */
function capacityNotUsableMessage(capacity: FabricCapacity): string {
  const subject = `The capacity assigned to this workspace ("${capacity.displayName}", ${capacity.sku})`;
  const sku = capacity.sku.toUpperCase();

  if (sku.startsWith('P') && !isSupportedPremiumCapacitySku(sku)) {
    return `${subject} is not a supported Power BI Premium capacity for Rayfin apps.`;
  }
  if (
    capacity.state.toLowerCase() === 'active' &&
    !isSupportedPremiumCapacitySku(sku)
  ) {
    return `${subject} is not a supported Fabric capacity for Rayfin apps.`;
  }

  return `${subject} reports state "${capacity.state}" and cannot host a deployment.`;
}

/** Poll a workspace until Fabric reports the target capacity as assigned. */
export async function verifyWorkspaceCapacity(
  workspaceId: string,
  capacityId: string,
  deps: EnsureFabricTargetDeps,
  initialDelayMs = 0
): Promise<WorkspaceVerification> {
  const pacing = assignmentPacing(deps.polling);
  const deadline = Date.now() + pacing.timeoutMs;
  let delayMs = initialDelayMs;
  let transientErrors = 0;

  for (;;) {
    await delay(untilDeadline(delayMs, deadline), deps.signal);

    let workspace: FabricWorkspace;
    try {
      workspace = await deps.fabric.getWorkspace(workspaceId);
      transientErrors = 0;
    } catch (error) {
      // A throttled or faulted read says nothing about the assignment, which
      // is running service-side either way. Failing here would report an error
      // for a workspace that was about to become ready.
      transientErrors += 1;
      if (
        isTransientFabricError(error) &&
        transientErrors < MAX_TRANSIENT_POLL_ERRORS &&
        Date.now() < deadline
      ) {
        delayMs = nextDelayMs(pacing, delayMs, error.retryAfterMs);
        continue;
      }
      const expected = fabricProblem(error);
      if (expected) return expected;
      throw error;
    }

    if (workspace.capacityId === capacityId) {
      const state = assignmentState(workspace);
      if (state === 'completed') return { status: 'ready', workspace };
      if (state === 'failed') return assignmentRefused();
    } else if (assignmentState(workspace) === 'failed') {
      return assignmentRefused();
    }

    if (Date.now() >= deadline) {
      return problem(
        'retry-later',
        'workspace_assignment_timeout',
        `Fabric did not finish the workspace capacity assignment within ${Math.round(
          pacing.timeoutMs / 1000
        )}s; it may still be running.`,
        true
      );
    }
    delayMs = nextDelayMs(pacing, delayMs);
  }
}

/**
 * Fabric reported the assignment itself failed.
 *
 * Distinct from running out of budget: the service reached a terminal verdict,
 * so the Builder is pointed at permissions rather than told to wait. Collapsing
 * the two into one message made a 2-minute timeout indistinguishable from an
 * outright refusal.
 */
function assignmentRefused(): FabricReadinessProblem {
  return problem(
    'failed',
    'workspace_assignment_failed',
    'Fabric reported the workspace capacity assignment failed.',
    true
  );
}
