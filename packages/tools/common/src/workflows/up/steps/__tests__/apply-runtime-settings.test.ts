import { describe, expect, it, vi } from 'vitest';

import {
  parseRayfinYaml,
  type RayfinConfig,
} from '../../../../config/index.js';
import type {
  RayfinWorkloadClient,
  WorkloadTarget,
} from '../../../../external/fabric/index.js';
import { applyRuntimeSettings } from '../apply-runtime-settings.js';

const target: WorkloadTarget = {
  itemId: 'i1',
  itemEndpoint: 'https://api/i1',
  baasEndpoint: 'https://baas/i1',
  authorizationHeader: 'Bearer t',
};

const services = {
  auth: { enabled: true },
} as unknown as RayfinConfig['services'];

function fakeWorkload(
  overrides: Partial<RayfinWorkloadClient> = {}
): RayfinWorkloadClient {
  return {
    resolveTarget: vi.fn(),
    getPublishableKey: vi.fn(),
    applyRuntimeSettings: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('applyRuntimeSettings', () => {
  it.each([true, false])(
    'forwards explicit application auth unchanged (enabled=%s)',
    async (enabled) => {
      const workload = fakeWorkload();
      const authored = {
        ...services,
        functions: { enabled, auth: { type: 'application' as const } },
      };
      const result = await applyRuntimeSettings(
        { target, services: authored },
        { workload }
      );
      expect(result).toEqual({ status: 'applied' });
      expect(
        vi.mocked(workload.applyRuntimeSettings).mock.calls[0][1].services
      ).toBe(authored);
    }
  );

  it('applies settings under the runtime-settings label', async () => {
    const workload = fakeWorkload();

    const result = await applyRuntimeSettings(
      { target, services },
      { workload }
    );

    expect(result).toEqual({ status: 'applied' });
    expect(workload.applyRuntimeSettings).toHaveBeenCalledWith(target, {
      services,
      connectors: undefined,
      label: 'runtime-settings',
    });
  });

  it('forwards a valid connectors block to the workload', async () => {
    const workload = fakeWorkload();
    const connectors: RayfinConfig['connectors'] = [
      {
        name: 'mysrc',
        type: 'fabric-sqldatabase',
        config: { workspaceId: 'w', itemId: 'i' },
        auth: { type: 'delegated' },
      },
    ];

    const result = await applyRuntimeSettings(
      { target, services, connectors },
      { workload }
    );

    expect(result).toEqual({ status: 'applied' });
    expect(workload.applyRuntimeSettings).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ connectors, label: 'runtime-settings' })
    );
  });

  it('forwards storage settings unchanged', async () => {
    const workload = fakeWorkload();
    const servicesWithStorage = {
      ...services,
      storage: { enabled: true, path: 'packages/storage' },
    } as RayfinConfig['services'];

    await applyRuntimeSettings(
      { target, services: servicesWithStorage },
      { workload }
    );

    expect(workload.applyRuntimeSettings).toHaveBeenCalledWith(target, {
      services: servicesWithStorage,
      connectors: undefined,
      label: 'runtime-settings',
    });
  });

  it('returns invalid-connectors without posting when validation fails', async () => {
    const workload = fakeWorkload();
    const connectors: RayfinConfig['connectors'] = [
      { name: 'bad', type: 'fabric-sqldatabase' },
    ];

    const result = await applyRuntimeSettings(
      { target, services, connectors },
      { workload }
    );

    expect(result.status).toBe('invalid-connectors');
    if (result.status === 'invalid-connectors') {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].sourceName).toBe('bad');
    }
    expect(workload.applyRuntimeSettings).not.toHaveBeenCalled();
  });

  it.each([
    ['', 'services.functions.auth'],
    ['auth: {}', 'services.functions.auth.type'],
    ['auth:\n      type: delegated', 'services.functions.auth.type'],
    ['auth:\n      type: appAuth', 'services.functions.auth.type'],
  ])(
    'rejects invalid Functions auth without posting: %s',
    async (auth, field) => {
      const workload = fakeWorkload();
      const { services: servicesWithInvalidFunctions } = parseRayfinYaml(`
id: test-app
services:
  functions:
    enabled: true
    ${auth}
`);

      const result = await applyRuntimeSettings(
        { target, services: servicesWithInvalidFunctions },
        { workload }
      );

      expect(result.status).toBe('invalid-functions-config');
      if (result.status === 'invalid-functions-config') {
        expect(result.errors).toEqual([expect.objectContaining({ field })]);
      }
      expect(workload.applyRuntimeSettings).not.toHaveBeenCalled();
    }
  );

  it('propagates a rejecting workload apply', async () => {
    const workload = fakeWorkload({
      applyRuntimeSettings: vi.fn().mockRejectedValue(new Error('boom')),
    });

    await expect(
      applyRuntimeSettings({ target, services }, { workload })
    ).rejects.toThrow('boom');
  });
});
