import type { Http } from '@microsoft/rayfin-tools-common/_internal/adapters';
import { noopCancellationToken } from '@microsoft/rayfin-tools-common/_internal/adapters';
import { describe, expect, it, vi } from 'vitest';

import { createCliUserLicenseService } from '../user-license.js';

vi.mock('../../config/constants.js', () => ({
  getFabricSettings: vi.fn(() => ({
    fabricApiBaseUrl: 'https://cluster.example.invalid/v1',
    fabricPortalUrl: 'https://app.fabric.microsoft.com',
  })),
}));

vi.mock('../../adapters/http.js', () => ({
  createCliHttp: vi.fn(() => ({ fetch: vi.fn() }) satisfies Http),
}));

describe('createCliUserLicenseService', () => {
  it('bypasses probing for service principals', async () => {
    const service = await createCliUserLicenseService({
      provider: 'fabric',
      session: {
        token: 'service-principal-token',
        identityType: 'service_principal',
      },
    });

    await expect(
      service.ensureUserHasLicense({
        allowInteractiveEnrollment: true,
        signal: noopCancellationToken,
      })
    ).resolves.toEqual({ outcome: 'licensed' });
  });

  it('supports an injected probe and clock', async () => {
    let now = 0;
    const navigation = { open: vi.fn().mockResolvedValue(undefined) };
    const notify = vi.fn();
    const probe = {
      probe: vi.fn(async () =>
        now >= 15_000
          ? { outcome: 'licensed' as const }
          : { outcome: 'unlicensed' as const }
      ),
    };
    const service = await createCliUserLicenseService({
      provider: 'fabric',
      session: { token: 'user-token', identityType: 'user' },
      navigation,
      probe,
      pollIntervalMs: 3_000,
      clock: {
        now: () => now,
        wait: vi.fn(async (milliseconds) => {
          now += milliseconds;
        }),
      },
      notify,
    });

    await expect(
      service.ensureUserHasLicense({
        allowInteractiveEnrollment: true,
        signal: noopCancellationToken,
      })
    ).resolves.toEqual({ outcome: 'licensed' });
    expect(navigation.open).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenNthCalledWith(
      1,
      'Opening the browser to initiate Fabric Free license signup. Waiting for license acquisition to complete...'
    );
    expect(notify).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('A Fabric Free license was added')
    );
    expect(probe.probe).toHaveBeenCalledTimes(6);
    expect(now).toBe(15_000);
  });

  it('returns the no-op service for non-Fabric providers', async () => {
    const service = await createCliUserLicenseService({
      provider: 'docker',
    });

    await expect(
      service.ensureUserHasLicense({
        allowInteractiveEnrollment: true,
        signal: noopCancellationToken,
      })
    ).resolves.toEqual({ outcome: 'licensed' });
  });

  it('returns the no-op service for externally supplied tokens', async () => {
    const service = await createCliUserLicenseService({
      provider: 'fabric',
      session: { token: 'external-token', identityType: 'external' },
    });

    await expect(
      service.ensureUserHasLicense({
        allowInteractiveEnrollment: true,
        signal: noopCancellationToken,
      })
    ).resolves.toEqual({ outcome: 'licensed' });
  });
});
