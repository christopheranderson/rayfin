import type { CancellationToken } from '../../../adapters/index.js';
import type {
  EnsureUserHasLicenseOutcome,
  UserLicenseService,
} from '../../../services/user-license/index.js';
import type { Step } from '../../types.js';

export interface EnsureUserLicenseStepInput {
  allowInteractiveEnrollment: boolean;
  signal: CancellationToken;
}

export interface EnsureUserLicenseStepDeps {
  userLicense: UserLicenseService;
}

/** Invoke the provider-neutral user-license capability. */
export const ensureUserLicense: Step<
  EnsureUserLicenseStepInput,
  EnsureUserHasLicenseOutcome,
  EnsureUserLicenseStepDeps
> = (input, deps) => deps.userLicense.ensureUserHasLicense(input);
