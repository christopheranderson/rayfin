import { describe, expect, it, vi } from 'vitest';

import { noopCancellationToken } from '../../../adapters/cancellation.js';
import type { Http } from '../../../adapters/http.js';
import { FabricLicenseProbe } from '../fabric-probe.js';
import { UserLicenseError } from '../types.js';

describe('FabricLicenseProbe', () => {
  it('uses cluster discovery and reports a successful response as licensed', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const probe = new FabricLicenseProbe({
      http: { fetch } as Http,
      fabricApiBaseUrl: 'https://cluster.example.invalid/v1',
    });

    await expect(probe.probe(noopCancellationToken)).resolves.toEqual({
      outcome: 'licensed',
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://cluster.example.invalid/metadata/cluster',
      expect.objectContaining({
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('opts into auto-license assignment only when requested', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          'X-PowerBI-Auto-License-Info': 'AutoLicenseAssignmentSucceeded',
        },
      })
    );
    const probe = new FabricLicenseProbe({
      http: { fetch } as Http,
      fabricApiBaseUrl: 'https://api.fabric.microsoft.com/v1',
    });

    await expect(
      probe.probe(noopCancellationToken, {
        allowAutoLicenseAssignment: true,
      })
    ).resolves.toEqual({ outcome: 'license_assigned' });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.fabric.microsoft.com/metadata/cluster',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-PowerBI-Auto-License-Info': 'AutoLicenseAssignmentSupported',
        },
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('reports when auto-license assignment is disabled by the tenant', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 401,
        headers: {
          'X-PowerBI-Error-Info': 'UserNotLicensed',
          'X-PowerBI-Auto-License-Info':
            'AutoLicenseAssignmentDisabledByTenant',
        },
      })
    );
    const probe = new FabricLicenseProbe({
      http: { fetch } as Http,
      fabricApiBaseUrl: 'https://api.fabric.microsoft.com/v1',
    });

    await expect(
      probe.probe(noopCancellationToken, {
        allowAutoLicenseAssignment: true,
      })
    ).resolves.toEqual({ outcome: 'auto_license_disabled' });
  });

  it('requires the exact UserNotLicensed header on an expected status', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 403,
        headers: { 'X-PowerBI-Error-Info': 'userNOTlicensed' },
      })
    );
    const probe = new FabricLicenseProbe({
      http: { fetch } as Http,
      fabricApiBaseUrl: 'https://cluster.example.invalid/v1',
    });

    await expect(probe.probe(noopCancellationToken)).resolves.toEqual({
      outcome: 'unlicensed',
    });
  });

  it('does not classify a generic authorization failure as unlicensed', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 403 }));
    const probe = new FabricLicenseProbe({
      http: { fetch } as Http,
      fabricApiBaseUrl: 'https://cluster.example.invalid/v1',
    });

    await expect(probe.probe(noopCancellationToken)).rejects.toMatchObject({
      code: 'fabric_license_probe_failed',
    } satisfies Partial<UserLicenseError>);
  });

  it.each([
    [
      'environment URL',
      'https://dxtapi.fabric.microsoft.com/v1',
      'https://dxtapi.fabric.microsoft.com/metadata/cluster',
    ],
    [
      'proxy URL',
      'https://proxy.example.invalid/fabric/abc/v1',
      'https://proxy.example.invalid/fabric/abc/metadata/cluster',
    ],
    [
      'mixed-case version',
      'https://cluster.example.invalid/V1',
      'https://cluster.example.invalid/metadata/cluster',
    ],
    [
      'query and fragment',
      'https://cluster.example.invalid/v1?ignored=true#fragment',
      'https://cluster.example.invalid/metadata/cluster',
    ],
  ])('derives cluster discovery from a normalized %s', async (_, base, url) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const probe = new FabricLicenseProbe({
      http: { fetch } as Http,
      fabricApiBaseUrl: base,
    });

    await probe.probe(noopCancellationToken);

    expect(fetch).toHaveBeenCalledWith(url, expect.any(Object));
  });

  it('rejects a base URL without the final /v1 segment', async () => {
    const fetch = vi.fn();
    const probe = new FabricLicenseProbe({
      http: { fetch } as Http,
      fabricApiBaseUrl: 'https://cluster.example.invalid',
    });

    await expect(probe.probe(noopCancellationToken)).rejects.toMatchObject({
      code: 'fabric_license_probe_failed',
      message: 'The Fabric API base URL must end with /v1.',
    } satisfies Partial<UserLicenseError>);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('classifies a malformed base URL as a probe failure', async () => {
    const fetch = vi.fn();
    const probe = new FabricLicenseProbe({
      http: { fetch } as Http,
      fabricApiBaseUrl: 'not a URL',
    });

    await expect(probe.probe(noopCancellationToken)).rejects.toMatchObject({
      code: 'fabric_license_probe_failed',
      message:
        'Unable to resolve the cluster discovery URL from the Fabric API base URL: expected base url to end with "/v1".',
    } satisfies Partial<UserLicenseError>);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('aborts a pending HTTP request when cancellation is requested', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(
      (_input: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const abortError = new Error('Aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        })
    );
    const probe = new FabricLicenseProbe({
      http: { fetch } as Http,
      fabricApiBaseUrl: 'https://cluster.example.invalid/v1',
    });

    const result = probe.probe({
      get isCancellationRequested() {
        return controller.signal.aborted;
      },
      onCancellationRequested(listener) {
        controller.signal.addEventListener('abort', listener, { once: true });
        return {
          dispose() {
            controller.signal.removeEventListener('abort', listener);
          },
        };
      },
    });
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});
