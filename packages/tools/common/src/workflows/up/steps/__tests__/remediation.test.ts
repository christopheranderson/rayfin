import { describe, expect, it } from 'vitest';

import { readinessHint } from '../../../fabric-readiness/steps/remediation.js';
import type { FabricReadinessProblem } from '../../../fabric-readiness/steps/types.js';

function problem(
  overrides: Partial<FabricReadinessProblem> = {}
): FabricReadinessProblem {
  return {
    status: 'failed',
    reason: 'workspace_assignment_failed',
    message: 'Fabric workspace capacity assignment failed.',
    retryable: true,
    ...overrides,
  } as FabricReadinessProblem;
}

describe('readinessHint', () => {
  // Each eligibility reason needs a different remedy: an admin can enable
  // trials, but cannot grant one past the tenant quota or make an ineligible
  // account eligible. A shared hint would send Builders on errands that
  // cannot succeed.
  it.each([
    [
      'trials_disabled',
      'Ask your Fabric tenant administrator to enable trials',
    ],
    ['trial_limit_exceeded', 'The tenant has no trial capacity left to grant'],
    ['ineligible_for_trial', 'This account cannot start a Fabric trial'],
  ] as const)('gives %s its own recovery hint', (reason, hint) => {
    expect(readinessHint(problem({ reason }))).toContain(hint);
  });

  // A timeout and a refusal are different situations with different remedies:
  // checking roles cannot speed up an assignment Fabric is still running, and
  // waiting cannot fix one Fabric refused. They shared a hint until the reasons
  // were split, so a 2-minute timeout told Builders to audit permissions.
  it('separates an assignment timeout from an assignment refusal', () => {
    const timedOut = readinessHint(
      problem({ status: 'retry-later', reason: 'workspace_assignment_timeout' })
    );
    const refused = readinessHint(
      problem({ reason: 'workspace_assignment_failed' })
    );

    expect(timedOut).toContain('Wait');
    expect(refused).toContain('permissions');
    expect(timedOut).not.toBe(refused);
  });

  it('names the invoking command in retry guidance', () => {
    const hint = readinessHint(
      problem({ reason: 'workspace_assignment_timeout' }),
      'dev'
    );

    expect(hint).toContain('`rayfin dev`');
    expect(hint).not.toContain('`rayfin up`');
  });

  it.each([
    'capacity_assignment_confirmation_required',
    'capacity_selection_required',
  ] as const)(
    'does not suggest combining a workspace option with --capacity-id for %s',
    (reason) => {
      const hint = readinessHint(problem({ reason }));

      expect(hint).toContain('`--capacity-id <id>`');
      expect(hint).toContain('do not also pass a workspace option');
    }
  );
});
