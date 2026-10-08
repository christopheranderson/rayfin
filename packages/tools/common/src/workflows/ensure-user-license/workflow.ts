import { noopCancellationToken } from '../../adapters/index.js';
import { UserLicenseError } from '../../services/user-license/index.js';
import { type Workflow, cancelled, failed, ok } from '../types.js';

import { ensureUserLicense } from './steps/ensure-user-license.js';
import type {
  EnsureUserLicenseDeps,
  EnsureUserLicenseRequest,
  EnsureUserLicenseResult,
} from './types.js';

/** Run the reusable user-license preflight before provider target resolution. */
export const runEnsureUserLicenseWorkflow: Workflow<
  EnsureUserLicenseRequest,
  EnsureUserLicenseResult,
  EnsureUserLicenseDeps
> = async (request, deps) => {
  const signal = deps.signal ?? noopCancellationToken;
  if (signal.isCancellationRequested) {
    return cancelled();
  }

  deps.progress.report({
    phase: 'license',
    message: 'Checking user license',
  });

  try {
    const result = await ensureUserLicense(
      {
        allowInteractiveEnrollment: request.allowInteractiveEnrollment,
        signal,
      },
      { userLicense: deps.userLicense }
    );

    switch (result.outcome) {
      case 'licensed':
        return ok({ outcome: 'licensed' });
      case 'cancelled':
        return cancelled();
      case 'action_required':
        return failed(
          result.reason,
          'A Fabric license is required. Rerun this command interactively to open Fabric license setup.'
        );
      case 'retry_later':
        return failed(
          result.reason,
          'A Fabric Free license is required to continue command execution. Complete the setup in your browser, then rerun this command.'
        );
    }
  } catch (error) {
    if (error instanceof UserLicenseError) {
      return failed(error.code, error.message, error);
    }
    return failed(
      'user_license_check_failed',
      error instanceof Error ? error.message : String(error),
      error
    );
  }
};
