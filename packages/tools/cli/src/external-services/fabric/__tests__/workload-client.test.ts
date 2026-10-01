import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import type { WorkloadTarget } from '@microsoft/rayfin-tools-common/_internal/external/fabric';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const getRayfinItemEndpoint = vi.fn();
const getExtendedProperties = vi.fn();
const getAuthorizationHeader = vi.fn();

vi.mock('../../../services/fabric/rayfin-item.js', () => ({
  RayfinItemManager: vi.fn().mockImplementation(() => ({
    getRayfinItemEndpoint,
    getExtendedProperties,
    getAuthorizationHeader,
  })),
}));

const fetchPublishableKey = vi.fn();
vi.mock('../../../utils/publishable-key-utils.js', () => ({
  getPublishableKey: (...args: unknown[]) => fetchPublishableKey(...args),
}));

const postRuntimeSettings = vi.fn();
vi.mock('../../../utils/runtime-settings.js', () => ({
  postRuntimeSettings: (...args: unknown[]) => postRuntimeSettings(...args),
}));

import { MONIKER_HEADER } from '../../../config/constants.js';
import { RayfinItemManager } from '../../../services/fabric/rayfin-item.js';
import { createCliRayfinWorkloadClient } from '../workload-client.js';

const MockedRayfinItemManager = RayfinItemManager as unknown as ReturnType<
  typeof vi.fn
>;

const target: WorkloadTarget = {
  itemId: 'i1',
  itemEndpoint: 'https://api/i1',
  baasEndpoint: 'https://baas/i1',
  authorizationHeader: 'Bearer tok',
};

describe('createCliRayfinWorkloadClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRayfinItemEndpoint.mockReturnValue('https://api/ws/w1/appBackends/i1');
    getExtendedProperties.mockResolvedValue({
      BaaSEndpoint: 'https://baas/i1',
    });
    getAuthorizationHeader.mockReturnValue('Bearer tok');
  });

  it('constructs the RayfinItemManager with the supplied token', () => {
    createCliRayfinWorkloadClient('bearer-123');

    expect(MockedRayfinItemManager).toHaveBeenCalledWith('bearer-123', {
      log: expect.any(Function),
      warn: expect.any(Function),
      error: expect.any(Function),
      diagnostics: undefined,
    });
  });

  it('resolveTarget assembles the item endpoint, BaaS endpoint, and auth header', async () => {
    const resolved = await createCliRayfinWorkloadClient('t').resolveTarget(
      'w1',
      'i1'
    );

    expect(getRayfinItemEndpoint).toHaveBeenCalledWith('w1', 'i1');
    expect(getExtendedProperties).toHaveBeenCalledWith('w1', 'i1');
    expect(resolved).toEqual({
      itemId: 'i1',
      itemEndpoint: 'https://api/ws/w1/appBackends/i1',
      baasEndpoint: 'https://baas/i1',
      authorizationHeader: 'Bearer tok',
    });
  });

  it('resolveTarget rejects when extended properties cannot be read', async () => {
    getExtendedProperties.mockRejectedValueOnce(
      new Error('item still provisioning')
    );

    await expect(
      createCliRayfinWorkloadClient('t').resolveTarget('w1', 'i1')
    ).rejects.toThrow('item still provisioning');
  });

  it('getPublishableKey delegates to the util with the target endpoint and header', async () => {
    fetchPublishableKey.mockResolvedValue('pk_123');

    const key =
      await createCliRayfinWorkloadClient('t').getPublishableKey(target);

    expect(fetchPublishableKey).toHaveBeenCalledWith('https://api/i1', 'i1', {
      authorizationHeader: 'Bearer tok',
    });
    expect(key).toBe('pk_123');
  });

  it('applyRuntimeSettings forwards services, connectors, label, and moniker header', async () => {
    const services = {
      auth: { enabled: true },
    } as unknown as RayfinConfig['services'];
    const connectors = {
      src: { operations: [{ name: 'op' }] },
    } as unknown as RayfinConfig['connectors'];

    await createCliRayfinWorkloadClient('t').applyRuntimeSettings(target, {
      services,
      connectors,
      label: 'runtime-settings-patch',
    });

    expect(postRuntimeSettings).toHaveBeenCalledWith(
      'https://api/i1',
      services,
      'Bearer tok',
      expect.any(Function),
      'runtime-settings-patch',
      { [MONIKER_HEADER]: 'i1' },
      connectors,
      undefined,
      undefined
    );
  });

  it('forwards the caller-supplied package versions verbatim', async () => {
    const services = {
      staticHosting: { enabled: true },
    } as unknown as RayfinConfig['services'];
    const packageVersions = { '@microsoft/rayfin-auth': '1.35.0-alpha.1413' };

    await createCliRayfinWorkloadClient('t').applyRuntimeSettings(target, {
      services,
      packageVersions,
    });

    expect(postRuntimeSettings).toHaveBeenCalledWith(
      'https://api/i1',
      services,
      'Bearer tok',
      expect.any(Function),
      'runtime-settings',
      { [MONIKER_HEADER]: 'i1' },
      undefined,
      packageVersions,
      undefined
    );
  });

  it('applyRuntimeSettings defaults the label to runtime-settings', async () => {
    const services = {} as unknown as RayfinConfig['services'];

    await createCliRayfinWorkloadClient('t').applyRuntimeSettings(target, {
      services,
    });

    expect(postRuntimeSettings).toHaveBeenCalledWith(
      'https://api/i1',
      services,
      'Bearer tok',
      expect.any(Function),
      'runtime-settings',
      { [MONIKER_HEADER]: 'i1' },
      undefined,
      undefined,
      undefined
    );
  });
});
