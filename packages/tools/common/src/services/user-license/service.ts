import type { CancellationToken } from '../../adapters/cancellation.js';
import { createLinkedCancellation } from '../../adapters/cancellation.js';

import type {
  EnsureUserHasLicenseOutcome,
  EnsureUserHasLicenseRequest,
  ExternalNavigation,
  LicenseClock,
  LicenseProbe,
  LicenseProbeOutcome,
  LicenseResolutionStrategy,
  UserLicenseService,
} from './types.js';
import { UserLicenseError } from './types.js';

export const systemLicenseClock: LicenseClock = {
  now: Date.now,
  wait(milliseconds, signal) {
    if (signal.isCancellationRequested) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(finish, milliseconds);
      const subscription = signal.onCancellationRequested(finish);

      function finish(): void {
        clearTimeout(timeout);
        subscription.dispose();
        resolve();
      }
    });
  },
};

export class ManualLicenseResolutionStrategy implements LicenseResolutionStrategy {
  async resolve(): Promise<EnsureUserHasLicenseOutcome> {
    return {
      outcome: 'action_required',
      reason: 'fabric_license_enrollment_required',
    };
  }
}

export interface BoundedPollingOptions {
  clock?: LicenseClock;
  timeoutMs?: number;
  intervalMs?: number;
}

export class BoundedPollingLicenseResolutionStrategy implements LicenseResolutionStrategy {
  private readonly clock: LicenseClock;
  private readonly timeoutMs: number;
  private readonly intervalMs: number;

  constructor(options: BoundedPollingOptions = {}) {
    this.clock = options.clock ?? systemLicenseClock;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.intervalMs = options.intervalMs ?? 3_000;
  }

  async resolve(
    probe: LicenseProbe,
    signal: CancellationToken
  ): Promise<EnsureUserHasLicenseOutcome> {
    const deadline = this.clock.now() + this.timeoutMs;
    while (this.clock.now() < deadline) {
      if (signal.isCancellationRequested) {
        return { outcome: 'cancelled' };
      }

      await this.clock.wait(
        Math.min(this.intervalMs, deadline - this.clock.now()),
        signal
      );
      if (signal.isCancellationRequested) {
        return { outcome: 'cancelled' };
      }

      const probeScope = createLinkedCancellation(signal);
      let deadlineElapsed = false;
      const remainingMs = Math.max(0, deadline - this.clock.now());
      const deadlineTimer = setTimeout(() => {
        deadlineElapsed = true;
        probeScope.cancel();
      }, remainingMs);
      let outcome: LicenseProbeOutcome;
      try {
        outcome = await probe.probe(probeScope.token);
      } catch (error) {
        if (signal.isCancellationRequested) {
          return { outcome: 'cancelled' };
        }
        if (deadlineElapsed) {
          return {
            outcome: 'retry_later',
            reason: 'fabric_license_enrollment_timeout',
          };
        }
        throw error;
      } finally {
        clearTimeout(deadlineTimer);
        probeScope.dispose();
      }
      if (signal.isCancellationRequested) {
        return { outcome: 'cancelled' };
      }
      if (
        outcome.outcome === 'licensed' ||
        outcome.outcome === 'license_assigned'
      ) {
        return { outcome: 'licensed' };
      }
      if (outcome.outcome === 'auto_license_disabled') {
        throw new UserLicenseError(
          'fabric_auto_license_disabled_by_tenant',
          'Automatic Fabric license assignment is disabled by your organization. Contact your Fabric administrator or visit https://aka.ms/pbiAdHocSubscriptionNotAllowed.'
        );
      }
      if (deadlineElapsed) {
        return {
          outcome: 'retry_later',
          reason: 'fabric_license_enrollment_timeout',
        };
      }
    }

    return {
      outcome: 'retry_later',
      reason: 'fabric_license_enrollment_timeout',
    };
  }
}

export interface FabricUserLicenseServiceOptions {
  probe: LicenseProbe;
  navigation: ExternalNavigation;
  resolution: LicenseResolutionStrategy;
  fabricPortalUrl: string;
  onEnrollmentStarted?: () => void | Promise<void>;
  onLicenseAssigned?: () => void | Promise<void>;
}

export class FabricUserLicenseService implements UserLicenseService {
  constructor(private readonly options: FabricUserLicenseServiceOptions) {}

  async ensureUserHasLicense(
    request: EnsureUserHasLicenseRequest
  ): Promise<EnsureUserHasLicenseOutcome> {
    if (request.signal.isCancellationRequested) {
      return { outcome: 'cancelled' };
    }

    let initialProbe;
    try {
      initialProbe = await this.options.probe.probe(request.signal, {
        allowAutoLicenseAssignment:
          request.allowInteractiveEnrollment &&
          this.options.onLicenseAssigned !== undefined,
      });
    } catch (error) {
      if (request.signal.isCancellationRequested) {
        return { outcome: 'cancelled' };
      }
      throw error;
    }
    if (request.signal.isCancellationRequested) {
      return { outcome: 'cancelled' };
    }
    if (initialProbe.outcome === 'license_assigned') {
      await this.options.onLicenseAssigned?.();
      return { outcome: 'licensed' };
    }
    if (initialProbe.outcome === 'licensed') {
      return { outcome: 'licensed' };
    }
    if (initialProbe.outcome === 'auto_license_disabled') {
      throw new UserLicenseError(
        'fabric_auto_license_disabled_by_tenant',
        'Automatic Fabric license assignment is disabled by your organization. Contact your Fabric administrator or visit https://aka.ms/pbiAdHocSubscriptionNotAllowed.'
      );
    }

    if (!request.allowInteractiveEnrollment) {
      return {
        outcome: 'action_required',
        reason: 'fabric_license_enrollment_required',
      };
    }

    const enrollmentUrl = new URL('/autoSignUp', this.options.fabricPortalUrl);
    enrollmentUrl.searchParams.set('clientApp', 'rayfincli');
    enrollmentUrl.searchParams.set('displayMode', 'basic');

    await this.options.onEnrollmentStarted?.();
    if (request.signal.isCancellationRequested) {
      return { outcome: 'cancelled' };
    }
    try {
      await this.options.navigation.open(enrollmentUrl.toString());
    } catch (error) {
      throw new UserLicenseError(
        'fabric_license_browser_open_failed',
        `Rayfin could not open Fabric setup in the default browser. Open ${enrollmentUrl.toString()} in a supported browser, complete Fabric licensing, then rerun this command.`,
        { cause: error }
      );
    }
    if (request.signal.isCancellationRequested) {
      return { outcome: 'cancelled' };
    }

    let resolution;
    try {
      resolution = await this.options.resolution.resolve(
        this.options.probe,
        request.signal
      );
    } catch (error) {
      if (request.signal.isCancellationRequested) {
        return { outcome: 'cancelled' };
      }
      throw error;
    }
    if (request.signal.isCancellationRequested) {
      return { outcome: 'cancelled' };
    }
    if (resolution.outcome === 'licensed') {
      await this.options.onLicenseAssigned?.();
    }
    return resolution;
  }
}

export const noOpUserLicenseService: UserLicenseService = {
  async ensureUserHasLicense() {
    return { outcome: 'licensed' };
  },
};
