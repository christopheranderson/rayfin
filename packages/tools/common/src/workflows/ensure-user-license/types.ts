import type { CancellationToken, Progress } from '../../adapters/index.js';
import type { UserLicenseService } from '../../services/user-license/index.js';

/** Product intent for a user-license preflight. */
export interface EnsureUserLicenseRequest {
  /** Whether the host may open browser-based license enrollment. */
  allowInteractiveEnrollment: boolean;
}

/** Successful result of a user-license preflight. */
export interface EnsureUserLicenseResult {
  outcome: 'licensed';
}

/** Capabilities required by the user-license workflow. */
export interface EnsureUserLicenseDeps {
  userLicense: UserLicenseService;
  progress: Progress;
  signal?: CancellationToken;
}
