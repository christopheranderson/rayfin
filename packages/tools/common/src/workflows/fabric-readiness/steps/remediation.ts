/**
 * Recovery hints for readiness failures.
 *
 * The hints live with the reasons they describe, not in a host renderer:
 * adding a reason to {@link FabricReadinessReason} breaks this table rather
 * than silently producing a failure with no next step.
 */
import type { FabricReadinessProblem, FabricReadinessReason } from './types.js';

const CAPACITY_HINT =
  'Pass a workspace with active Fabric capacity, or contact your Fabric administrator.';
const WORKSPACE_PERMISSION_HINT =
  'Verify workspace and capacity permissions, then rerun `rayfin up`.';
const WAIT_AND_RETRY_HINT = 'Wait, then rerun `rayfin up`.';

const READINESS_HINTS: Record<FabricReadinessReason, string> = {
  capacity_assignment_confirmation_required:
    'Rerun with `--yes`. To use `--capacity-id <id>`, do not also pass a workspace option.',
  capacity_selection_required:
    'Run interactively to choose a capacity. To use `--capacity-id <id>`, do not also pass a workspace option.',
  workspace_admin_required:
    'Ask a workspace Admin to promote your role, or pass a workspace that already has capacity.',
  capacity_not_usable: CAPACITY_HINT,
  fabric_authentication_required: 'Run `rayfin login`, then rerun `rayfin up`.',
  trials_disabled:
    'Ask your Fabric tenant administrator to enable trials, or pass a workspace that already has capacity.',
  trial_limit_exceeded:
    'The tenant has no trial capacity left to grant. Ask your administrator to free one or assign existing capacity, then rerun `rayfin up`.',
  ineligible_for_trial:
    'This account cannot start a Fabric trial. Ask your administrator to assign existing capacity, or pass a workspace that already has capacity.',
  fabric_permission_missing:
    'Run `rayfin login` again, then contact your tenant administrator if the permission is still unavailable.',
  trial_provisioning_timeout: WAIT_AND_RETRY_HINT,
  too_many_requests: WAIT_AND_RETRY_HINT,
  trial_provisioning_failed:
    'Retry `rayfin up`; contact support if provisioning continues to fail.',
  workspace_assignment_failed: WORKSPACE_PERMISSION_HINT,
  // A timeout says nothing about permissions — the assignment is still running
  // service-side — so it must not send the Builder to check their roles.
  workspace_assignment_timeout: WAIT_AND_RETRY_HINT,
  workspace_creation_failed: WORKSPACE_PERMISSION_HINT,
};

type ReadinessCommand = 'up' | 'dev';

/** Return one recovery sentence for a readiness reason and invoking command. */
export function readinessHintForReason(
  reason: string,
  command: ReadinessCommand = 'up'
): string {
  if (!Object.hasOwn(READINESS_HINTS, reason)) {
    return `Resolve the Fabric readiness issue, then rerun \`rayfin ${command}\`.`;
  }
  const hint = READINESS_HINTS[reason as FabricReadinessReason];
  return hint.replaceAll('`rayfin up`', `\`rayfin ${command}\``);
}

/** Return one sentence telling the caller how to recover from a readiness problem. */
export function readinessHint(
  problem: FabricReadinessProblem,
  command: ReadinessCommand = 'up'
): string {
  return readinessHintForReason(problem.reason, command);
}
