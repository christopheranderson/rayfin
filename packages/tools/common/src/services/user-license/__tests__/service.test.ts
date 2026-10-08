import { describe, expect, it, vi } from 'vitest';

import {
  createLinkedCancellation,
  noopCancellationToken,
} from '../../../adapters/cancellation.js';
import {
  BoundedPollingLicenseResolutionStrategy,
  FabricUserLicenseService,
  ManualLicenseResolutionStrategy,
} from '../service.js';
import type { LicenseClock, LicenseProbe } from '../types.js';

describe('FabricUserLicenseService', () => {
  it('does not navigate when the user is already licensed', async () => {
    const navigation = { open: vi.fn() };
    const service = new FabricUserLicenseService({
      probe: {
        probe: vi.fn().mockResolvedValue({ outcome: 'licensed' }),
      },
      navigation,
      resolution: new ManualLicenseResolutionStrategy(),
      fabricPortalUrl: 'https://app.fabric.microsoft.com',
    });

    await expect(
      service.ensureUserHasLicense({
        allowInteractiveEnrollment: true,
        signal: noopCancellationToken,
      })
    ).resolves.toEqual({ outcome: 'licensed' });
    expect(navigation.open).not.toHaveBeenCalled();
  });

  it('returns cancelled when cancellation arrives during the initial probe', async () => {
    const linked = createLinkedCancellation();
    let resolveProbe: ((value: { outcome: 'licensed' }) => void) | undefined;
    const probeResult = new Promise<{ outcome: 'licensed' }>((resolve) => {
      resolveProbe = resolve;
    });
    const service = new FabricUserLicenseService({
      probe: { probe: vi.fn(() => probeResult) },
      navigation: { open: vi.fn() },
      resolution: new ManualLicenseResolutionStrategy(),
      fabricPortalUrl: 'https://app.fabric.microsoft.com',
    });

    const result = service.ensureUserHasLicense({
      allowInteractiveEnrollment: true,
      signal: linked.token,
    });
    linked.cancel();
    resolveProbe?.({ outcome: 'licensed' });

    await expect(result).resolves.toEqual({ outcome: 'cancelled' });
  });

  it('returns action required without opening a browser when non-interactive', async () => {
    const navigation = { open: vi.fn() };
    const probe: LicenseProbe = {
      probe: vi.fn().mockResolvedValue({ outcome: 'unlicensed' }),
    };
    const service = new FabricUserLicenseService({
      probe,
      navigation,
      resolution: new ManualLicenseResolutionStrategy(),
      fabricPortalUrl: 'https://app.fabric.microsoft.com',
    });

    await expect(
      service.ensureUserHasLicense({
        allowInteractiveEnrollment: false,
        signal: noopCancellationToken,
      })
    ).resolves.toEqual({
      outcome: 'action_required',
      reason: 'fabric_license_enrollment_required',
    });
    expect(probe.probe).toHaveBeenCalledWith(noopCancellationToken, {
      allowAutoLicenseAssignment: false,
    });
    expect(navigation.open).not.toHaveBeenCalled();
  });

  it('reports an automatically assigned license and does not open a browser', async () => {
    const navigation = { open: vi.fn() };
    const onLicenseAssigned = vi.fn();
    const probe: LicenseProbe = {
      probe: vi.fn().mockResolvedValue({ outcome: 'license_assigned' }),
    };
    const service = new FabricUserLicenseService({
      probe,
      navigation,
      resolution: new ManualLicenseResolutionStrategy(),
      fabricPortalUrl: 'https://app.fabric.microsoft.com',
      onLicenseAssigned,
    });

    await expect(
      service.ensureUserHasLicense({
        allowInteractiveEnrollment: true,
        signal: noopCancellationToken,
      })
    ).resolves.toEqual({ outcome: 'licensed' });
    expect(probe.probe).toHaveBeenCalledWith(noopCancellationToken, {
      allowAutoLicenseAssignment: true,
    });
    expect(onLicenseAssigned).toHaveBeenCalledOnce();
    expect(navigation.open).not.toHaveBeenCalled();
  });

  it('does not opt into assignment without an assignment notifier', async () => {
    const navigation = { open: vi.fn().mockResolvedValue(undefined) };
    const probe: LicenseProbe = {
      probe: vi.fn().mockResolvedValue({ outcome: 'unlicensed' }),
    };
    const service = new FabricUserLicenseService({
      probe,
      navigation,
      resolution: new ManualLicenseResolutionStrategy(),
      fabricPortalUrl: 'https://app.fabric.microsoft.com',
    });

    await service.ensureUserHasLicense({
      allowInteractiveEnrollment: true,
      signal: noopCancellationToken,
    });

    expect(probe.probe).toHaveBeenCalledWith(noopCancellationToken, {
      allowAutoLicenseAssignment: false,
    });
  });

  it('fails with tenant guidance when auto-license assignment is disabled', async () => {
    const navigation = { open: vi.fn() };
    const service = new FabricUserLicenseService({
      probe: {
        probe: vi.fn().mockResolvedValue({
          outcome: 'auto_license_disabled',
        }),
      },
      navigation,
      resolution: new ManualLicenseResolutionStrategy(),
      fabricPortalUrl: 'https://app.fabric.microsoft.com',
      onLicenseAssigned: vi.fn(),
    });

    await expect(
      service.ensureUserHasLicense({
        allowInteractiveEnrollment: true,
        signal: noopCancellationToken,
      })
    ).rejects.toMatchObject({
      code: 'fabric_auto_license_disabled_by_tenant',
    });
    expect(navigation.open).not.toHaveBeenCalled();
  });

  it('opens basic autosignup and delegates resolution for an interactive user', async () => {
    const navigation = { open: vi.fn().mockResolvedValue(undefined) };
    const onEnrollmentStarted = vi.fn();
    const onLicenseAssigned = vi.fn();
    const resolution = {
      resolve: vi.fn().mockResolvedValue({ outcome: 'licensed' }),
    };
    const probe: LicenseProbe = {
      probe: vi.fn().mockResolvedValue({ outcome: 'unlicensed' }),
    };
    const service = new FabricUserLicenseService({
      probe,
      navigation,
      resolution,
      fabricPortalUrl: 'https://app.fabric.microsoft.com',
      onEnrollmentStarted,
      onLicenseAssigned,
    });

    await expect(
      service.ensureUserHasLicense({
        allowInteractiveEnrollment: true,
        signal: noopCancellationToken,
      })
    ).resolves.toEqual({ outcome: 'licensed' });
    expect(navigation.open).toHaveBeenCalledWith(
      'https://app.fabric.microsoft.com/autoSignUp?clientApp=rayfincli&displayMode=basic'
    );
    expect(onEnrollmentStarted).toHaveBeenCalledOnce();
    expect(onEnrollmentStarted.mock.invocationCallOrder[0]).toBeLessThan(
      navigation.open.mock.invocationCallOrder[0]
    );
    expect(probe.probe).toHaveBeenCalledWith(noopCancellationToken, {
      allowAutoLicenseAssignment: true,
    });
    expect(resolution.resolve).toHaveBeenCalledWith(
      probe,
      noopCancellationToken
    );
    expect(onLicenseAssigned).toHaveBeenCalledOnce();
    expect(resolution.resolve.mock.invocationCallOrder[0]).toBeLessThan(
      onLicenseAssigned.mock.invocationCallOrder[0]
    );
  });
});

describe('BoundedPollingLicenseResolutionStrategy', () => {
  it('continues when a delayed probe becomes licensed', async () => {
    let now = 0;
    const clock: LicenseClock = {
      now: () => now,
      wait: vi.fn(async (milliseconds) => {
        now += milliseconds;
      }),
    };
    const probe: LicenseProbe = {
      probe: vi.fn(async () =>
        now >= 15_000
          ? { outcome: 'licensed' as const }
          : { outcome: 'unlicensed' as const }
      ),
    };
    const strategy = new BoundedPollingLicenseResolutionStrategy({
      clock,
      intervalMs: 3_000,
      timeoutMs: 180_000,
    });

    await expect(
      strategy.resolve(probe, noopCancellationToken)
    ).resolves.toEqual({ outcome: 'licensed' });
    expect(probe.probe).toHaveBeenCalledTimes(5);
  });

  it('returns cancelled promptly', async () => {
    const linked = createLinkedCancellation();
    let now = 0;
    const clock: LicenseClock = {
      now: () => now,
      wait: vi.fn(async (milliseconds) => {
        now += milliseconds;
        linked.cancel();
      }),
    };
    const strategy = new BoundedPollingLicenseResolutionStrategy({
      clock,
      intervalMs: 3_000,
      timeoutMs: 180_000,
    });

    await expect(
      strategy.resolve(
        { probe: vi.fn().mockResolvedValue({ outcome: 'unlicensed' }) },
        linked.token
      )
    ).resolves.toEqual({ outcome: 'cancelled' });
  });

  it('aborts a pending probe when the polling deadline expires', async () => {
    vi.useFakeTimers();
    let now = 0;
    const clock: LicenseClock = {
      now: () => now,
      wait: vi.fn(async (milliseconds) => {
        now += milliseconds;
      }),
    };
    const probe: LicenseProbe = {
      probe: vi.fn(
        (signal): Promise<Awaited<ReturnType<LicenseProbe['probe']>>> =>
          new Promise((_resolve, reject) => {
            signal.onCancellationRequested(() => {
              const abortError = new Error('Aborted');
              abortError.name = 'AbortError';
              reject(abortError);
            });
          })
      ),
    };
    const strategy = new BoundedPollingLicenseResolutionStrategy({
      clock,
      intervalMs: 10,
      timeoutMs: 100,
    });

    try {
      const result = strategy.resolve(probe, noopCancellationToken);
      await vi.advanceTimersByTimeAsync(100);

      await expect(result).resolves.toEqual({
        outcome: 'retry_later',
        reason: 'fabric_license_enrollment_timeout',
      });
      expect(probe.probe).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
