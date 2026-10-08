import { describe, expect, it, vi } from 'vitest';

import type { RayfinConfig } from '../../../../config/index.js';
import type {
  RayfinWorkloadClient,
  WorkloadTarget,
} from '../../../../external/fabric/index.js';
import type {
  PersistHostingUrlRequest,
  StaticHostingService,
} from '../../../../services/static-hosting/index.js';
import { persistHostingUrl } from '../persist-hosting-url.js';

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

function fakeStaticHosting(
  overrides: Partial<StaticHostingService> = {}
): StaticHostingService {
  return {
    validateFolder: vi.fn(),
    runBuild: vi.fn(),
    packageFolder: vi.fn(),
    deploy: vi.fn(),
    persistHostingUrl: vi.fn().mockResolvedValue({
      configUpdated: true,
      workspaceKey: 'my-workspace',
      warnings: [],
    }),
    persistAssetAccess: vi.fn(),
    ...overrides,
  };
}

describe('persistHostingUrl', () => {
  it('delegates to the static-hosting service with the deployment details', async () => {
    const staticHosting = fakeStaticHosting();
    const workload = fakeWorkload();

    const result = await persistHostingUrl(
      {
        target,
        hostingUrl: 'https://app.example',
        services,
        projectRoot: '/p',
        workspaceName: 'My Workspace',
      },
      { staticHosting, workload }
    );

    expect(staticHosting.persistHostingUrl).toHaveBeenCalledTimes(1);
    const request = (
      staticHosting.persistHostingUrl as ReturnType<typeof vi.fn>
    ).mock.calls[0][0] as PersistHostingUrlRequest;
    expect(request.hostingUrl).toBe('https://app.example');
    expect(request.services).toBe(services);
    expect(request.projectRoot).toBe('/p');
    expect(request.workspaceName).toBe('My Workspace');
    expect(result).toEqual({
      configUpdated: true,
      workspaceKey: 'my-workspace',
      warnings: [],
    });
  });

  it('re-applies runtime settings via the patch label, forwarding connectors', async () => {
    const staticHosting = fakeStaticHosting();
    const workload = fakeWorkload();
    const connectors = {
      mysrc: { connector: 'fabric-sqldatabase' },
    } as unknown as RayfinConfig['connectors'];
    const updatedServices = {
      auth: { enabled: true, allowedRedirectUris: ['https://app.example'] },
    } as unknown as RayfinConfig['services'];

    await persistHostingUrl(
      {
        target,
        hostingUrl: 'https://app.example',
        services,
        connectors,
        projectRoot: '/p',
        workspaceName: 'My Workspace',
      },
      { staticHosting, workload }
    );

    const request = (
      staticHosting.persistHostingUrl as ReturnType<typeof vi.fn>
    ).mock.calls[0][0] as PersistHostingUrlRequest;
    await request.postSettings?.(updatedServices);

    expect(workload.applyRuntimeSettings).toHaveBeenCalledWith(target, {
      services: updatedServices,
      connectors,
      label: 'runtime-settings-patch',
    });
  });

  it('propagates a rejecting redirect-URI settings re-apply', async () => {
    const workload = fakeWorkload({
      applyRuntimeSettings: vi
        .fn()
        .mockRejectedValue(new Error('patch failed')),
    });
    // Drive the re-apply through postSettings so the rejection originates from
    // the workload patch send, exactly as the documented @throws contract.
    const staticHosting = fakeStaticHosting({
      persistHostingUrl: vi.fn(async (request: PersistHostingUrlRequest) => {
        await request.postSettings!(services);
        return { configUpdated: false, warnings: [] };
      }),
    });

    await expect(
      persistHostingUrl(
        {
          target,
          hostingUrl: 'https://app.example',
          services,
          projectRoot: '/p',
          workspaceName: 'My Workspace',
        },
        { staticHosting, workload }
      )
    ).rejects.toThrow('patch failed');
  });
});
