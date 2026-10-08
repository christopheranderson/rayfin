import type { CancellationToken } from '../../adapters/cancellation.js';

export type LicenseProbeOutcome =
  | { outcome: 'licensed' }
  | { outcome: 'unlicensed' }
  | { outcome: 'license_assigned' }
  | { outcome: 'auto_license_disabled' };

export interface LicenseProbeOptions {
  allowAutoLicenseAssignment?: boolean;
}

export interface LicenseProbe {
  probe(
    signal: CancellationToken,
    options?: LicenseProbeOptions
  ): Promise<LicenseProbeOutcome>;
}

export type EnsureUserHasLicenseOutcome =
  | { outcome: 'licensed' }
  | {
      outcome: 'action_required';
      reason: 'fabric_license_enrollment_required';
    }
  | {
      outcome: 'retry_later';
      reason: 'fabric_license_enrollment_timeout';
    }
  | { outcome: 'cancelled' };

export interface EnsureUserHasLicenseRequest {
  allowInteractiveEnrollment: boolean;
  signal: CancellationToken;
}

export interface UserLicenseService {
  ensureUserHasLicense(
    request: EnsureUserHasLicenseRequest
  ): Promise<EnsureUserHasLicenseOutcome>;
}

export interface ExternalNavigation {
  open(url: string): Promise<void>;
}

export interface LicenseClock {
  now(): number;
  wait(milliseconds: number, signal: CancellationToken): Promise<void>;
}

export interface LicenseResolutionStrategy {
  resolve(
    probe: LicenseProbe,
    signal: CancellationToken
  ): Promise<EnsureUserHasLicenseOutcome>;
}

export class UserLicenseError extends Error {
  constructor(
    readonly code:
      | 'fabric_license_probe_failed'
      | 'fabric_license_browser_open_failed'
      | 'fabric_auto_license_disabled_by_tenant',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'UserLicenseError';
  }
}
