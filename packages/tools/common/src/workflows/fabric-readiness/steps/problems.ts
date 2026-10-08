/**
 * Fabric failure classification.
 *
 * Fabric returns a machine-readable `errorCode` alongside the HTTP status, and
 * a single status covers several distinct outcomes — a `403` is
 * `TrialsDisabled`, `IneligibleForTrial`, `PrincipalTypeNotSupported`,
 * `UserNotLicensed`, or a genuinely missing permission. Mapping on status
 * alone tells the Builder to fix a permission they already have, so the code
 * is consulted first and the status is only the fallback.
 */
import { FabricError } from '../../../external/fabric/index.js';
import type { TrialEligibilityReason } from '../../../external/fabric/index.js';

import { problem } from './outcomes.js';
import type { FabricReadinessProblem } from './types.js';

/**
 * Codes meaning "this tenant already has a trial". Both eligibility and Start
 * Trial report `TrialAlreadyExists`; `activetrialexists` is Fabric's internal
 * spelling, kept here because it is what the service maps *from* and costs
 * nothing to tolerate. Either is recovered by discovery, never by a second
 * `POST`.
 */
const TRIAL_EXISTS_CODES = new Set(['trialalreadyexists', 'activetrialexists']);

/** Code meaning a trial is mid-provision; wait and rediscover, never re-POST. */
const TRIAL_IN_PROGRESS_CODES = new Set(['trialprovisioninginprogress']);

/** Whether a Start Trial failure means a trial already exists or is arriving. */
export function isExistingTrialError(error: unknown): boolean {
  const code = fabricErrorCode(error);
  return (
    code !== undefined &&
    (TRIAL_EXISTS_CODES.has(code) || TRIAL_IN_PROGRESS_CODES.has(code))
  );
}

/** Whether capacity creation may have succeeded despite a provisioning error. */
export function isCapacityCreationFailure(error: unknown): boolean {
  if (error instanceof FabricError) {
    return (
      error.statusCode === 500 &&
      error.errorCode?.toLowerCase() === 'capacitycreationfailure'
    );
  }
  if (!error || typeof error !== 'object') return false;

  const candidate = error as { errorCode?: unknown; code?: unknown };
  const code = candidate.errorCode ?? candidate.code;
  return (
    typeof code === 'string' && code.toLowerCase() === 'capacitycreationfailure'
  );
}

/**
 * Whether a poll failure is worth retrying inside the operation's budget.
 * Fabric returns a `500 CapacityCreationFailure` for transient provisioning
 * faults, and `429` while throttling; neither means the operation is lost.
 *
 * Narrows to {@link FabricError} so a caller that retries can also read the
 * `Retry-After` the service sent — the `429` case states exactly when the
 * caller may return, and ignoring it polls straight back into the throttle.
 */
export function isTransientFabricError(error: unknown): error is FabricError {
  return (
    error instanceof FabricError &&
    (error.statusCode >= 500 || error.statusCode === 429)
  );
}

/**
 * Map a thrown Fabric error to a readiness problem, or `undefined` when the
 * error is not one readiness can explain — the caller rethrows those.
 */
export function fabricProblem(
  error: unknown
): FabricReadinessProblem | undefined {
  if (!(error instanceof FabricError)) return undefined;

  const mapped = problemForErrorCode(error.errorCode);
  if (mapped) return mapped;

  switch (error.statusCode) {
    case 401:
      return problem(
        'action-required',
        'fabric_authentication_required',
        'The Fabric session is no longer valid.',
        true
      );
    case 403:
      return problem(
        'action-required',
        'fabric_permission_missing',
        'The signed-in identity does not have the required Fabric permissions.',
        true
      );
    case 429:
      return problem(
        'retry-later',
        'too_many_requests',
        'Fabric is throttling readiness requests. Retry later.',
        true
      );
    default:
      return undefined;
  }
}

/** Map the documented eligibility reasons to their readiness outcome. */
export function eligibilityProblem(
  reason: TrialEligibilityReason
): FabricReadinessProblem {
  switch (reason) {
    case 'TrialsDisabled':
      return problem(
        'action-required',
        'trials_disabled',
        'Fabric trials are disabled for this tenant.',
        false
      );
    case 'TrialLimitExceeded':
      return problem(
        'action-required',
        'trial_limit_exceeded',
        'The tenant Fabric trial capacity limit has been reached.',
        false
      );
    case 'TrialAlreadyExists':
      return problem(
        'retry-later',
        'trial_provisioning_timeout',
        'An existing Fabric trial was reported but is not yet visible.',
        true
      );
    default:
      return problem(
        'action-required',
        'ineligible_for_trial',
        'This account is not eligible for a Fabric trial capacity.',
        false
      );
  }
}

/**
 * Fabric error codes that describe a tenant or licensing state rather than a
 * missing permission. Trial-exists codes are deliberately absent: they are
 * recovered by discovery at the call site, not reported.
 */
function problemForErrorCode(
  errorCode?: string
): FabricReadinessProblem | undefined {
  switch (errorCode?.toLowerCase()) {
    case 'trialsdisabled':
      return eligibilityProblem('TrialsDisabled');
    case 'triallimitexceeded':
      return eligibilityProblem('TrialLimitExceeded');
    case 'ineligiblefortrial':
    case 'usernotlicensed':
    case 'principaltypenotsupported':
      return eligibilityProblem('IneligibleForTrial');
    default:
      return undefined;
  }
}

function fabricErrorCode(error: unknown): string | undefined {
  return error instanceof FabricError
    ? error.errorCode?.toLowerCase()
    : undefined;
}
