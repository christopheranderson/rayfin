import { describe, expect, it, vi } from 'vitest';

import {
  createLinkedCancellation,
  noopCancellationToken,
} from '../../../adapters/index.js';
import { UserLicenseError } from '../../../services/user-license/index.js';
import type { EnsureUserLicenseDeps } from '../types.js';
import { runEnsureUserLicenseWorkflow } from '../workflow.js';

function deps(
  outcome:
    | { outcome: 'licensed' }
    | { outcome: 'cancelled' }
    | {
        outcome: 'action_required';
        reason: 'fabric_license_enrollment_required';
      }
    | {
        outcome: 'retry_later';
        reason: 'fabric_license_enrollment_timeout';
      } = { outcome: 'licensed' }
): EnsureUserLicenseDeps {
  return {
    userLicense: {
      ensureUserHasLicense: vi.fn().mockResolvedValue(outcome),
    },
    progress: { report: vi.fn() },
    signal: noopCancellationToken,
  };
}

describe('runEnsureUserLicenseWorkflow', () => {
  it('runs the reusable step with host interaction intent', async () => {
    const dependencies = deps();

    await expect(
      runEnsureUserLicenseWorkflow(
        { allowInteractiveEnrollment: true },
        dependencies
      )
    ).resolves.toEqual({
      status: 'ok',
      data: { outcome: 'licensed' },
    });
    expect(dependencies.userLicense.ensureUserHasLicense).toHaveBeenCalledWith({
      allowInteractiveEnrollment: true,
      signal: noopCancellationToken,
    });
    expect(dependencies.progress.report).toHaveBeenCalledWith({
      phase: 'license',
      message: 'Checking user license',
    });
  });

  it.each([
    [
      {
        outcome: 'action_required' as const,
        reason: 'fabric_license_enrollment_required' as const,
      },
      'fabric_license_enrollment_required',
    ],
    [
      {
        outcome: 'retry_later' as const,
        reason: 'fabric_license_enrollment_timeout' as const,
      },
      'fabric_license_enrollment_timeout',
    ],
  ])('maps %s to a failed result', async (outcome, code) => {
    await expect(
      runEnsureUserLicenseWorkflow(
        { allowInteractiveEnrollment: false },
        deps(outcome)
      )
    ).resolves.toMatchObject({
      status: 'failed',
      error: { code },
    });
  });

  it('maps service cancellation to workflow cancellation', async () => {
    await expect(
      runEnsureUserLicenseWorkflow(
        { allowInteractiveEnrollment: false },
        deps({ outcome: 'cancelled' })
      )
    ).resolves.toEqual({ status: 'cancelled' });
  });

  it('does not invoke the step when already cancelled', async () => {
    const linked = createLinkedCancellation();
    linked.cancel();
    const dependencies = deps();
    dependencies.signal = linked.token;

    await expect(
      runEnsureUserLicenseWorkflow(
        { allowInteractiveEnrollment: false },
        dependencies
      )
    ).resolves.toEqual({ status: 'cancelled' });
    expect(
      dependencies.userLicense.ensureUserHasLicense
    ).not.toHaveBeenCalled();
  });

  it('preserves typed service failures', async () => {
    const dependencies = deps();
    vi.mocked(dependencies.userLicense.ensureUserHasLicense).mockRejectedValue(
      new UserLicenseError(
        'fabric_license_probe_failed',
        'Fabric license probe failed.'
      )
    );

    await expect(
      runEnsureUserLicenseWorkflow(
        { allowInteractiveEnrollment: false },
        dependencies
      )
    ).resolves.toMatchObject({
      status: 'failed',
      error: {
        code: 'fabric_license_probe_failed',
        message: 'Fabric license probe failed.',
      },
    });
  });
});
