import { describe, expect, it, vi } from 'vitest';

import type { RayfinConfig } from '../../../../config/index.js';
import { enrichDeploymentTelemetry } from '../enrich-deployment-telemetry.js';

const ORIGIN_ID = '9f970daa-6101-4df2-98f9-e0d86e975c61';

function config(): RayfinConfig {
  return {
    id: 'app',
    name: 'App',
    version: '1',
    services: {
      auth: { enabled: true },
      data: { enabled: true, path: 'packages/data' },
      storage: { enabled: true, path: 'packages/storage' },
      staticHosting: {
        enabled: true,
        path: 'packages/web',
        folder: 'dist',
      },
      functions: { enabled: true },
    },
  } as RayfinConfig;
}

describe('enrichDeploymentTelemetry', () => {
  it('records provenance and installed Microsoft packages', async () => {
    const addProperty = vi.fn();
    const addMeasurement = vi.fn();
    const collectDeploymentTelemetry = vi.fn().mockResolvedValue({
      projectOriginId: ORIGIN_ID,
      unresolvedPackageCount: 1,
      microsoftPackages: [
        { name: '@microsoft/fabric-visuals', version: '1.0.0' },
        { name: '@microsoft/rayfin-core', version: '1.35.0-alpha' },
      ],
    });

    await enrichDeploymentTelemetry(
      { projectRoot: '/p', config: config() },
      {
        telemetry: { addProperty, addMeasurement },
        projectTelemetry: {
          collectDeploymentTelemetry,
        },
      }
    );

    expect(collectDeploymentTelemetry).toHaveBeenCalledWith('/p', [
      'packages/data',
      'packages/storage',
      'packages/web',
      'rayfin/functions',
    ]);
    expect(addProperty).toHaveBeenCalledWith('project_origin_id', ORIGIN_ID);
    expect(addProperty).toHaveBeenCalledWith(
      'microsoft_packages',
      '[{"name":"@microsoft/fabric-visuals","version":"1.0.0"},{"name":"@microsoft/rayfin-core","version":"1.35.0-alpha"}]'
    );
    expect(addMeasurement).toHaveBeenCalledWith('microsoft_package_count', 2);
    expect(addMeasurement).toHaveBeenCalledWith('package_unresolved_count', 1);
  });

  it('records a valid empty package inventory', async () => {
    const addProperty = vi.fn();
    const addMeasurement = vi.fn();

    await enrichDeploymentTelemetry(
      { projectRoot: '/p', config: config() },
      {
        telemetry: { addProperty, addMeasurement },
        projectTelemetry: {
          collectDeploymentTelemetry: vi
            .fn()
            .mockResolvedValue({ microsoftPackages: [] }),
        },
      }
    );

    expect(addProperty).toHaveBeenCalledWith('microsoft_packages', '[]');
    expect(addMeasurement).toHaveBeenCalledWith('microsoft_package_count', 0);
    expect(addMeasurement).toHaveBeenCalledWith('package_unresolved_count', 0);
  });

  it('counts only valid packages included in the emitted inventory', async () => {
    const addProperty = vi.fn();
    const addMeasurement = vi.fn();

    await enrichDeploymentTelemetry(
      { projectRoot: '/p', config: config() },
      {
        telemetry: { addProperty, addMeasurement },
        projectTelemetry: {
          collectDeploymentTelemetry: vi.fn().mockResolvedValue({
            microsoftPackages: [
              { name: '@microsoft/rayfin-core', version: '1.35.0-alpha' },
              { name: '@other/not-emitted', version: '1.0.0' },
            ],
          }),
        },
      }
    );

    expect(addMeasurement).toHaveBeenCalledWith('microsoft_package_count', 1);
  });

  it('swallows collection failures', async () => {
    const addProperty = vi.fn();

    await expect(
      enrichDeploymentTelemetry(
        { projectRoot: '/p', config: config() },
        {
          telemetry: { addProperty, addMeasurement: vi.fn() },
          projectTelemetry: {
            collectDeploymentTelemetry: vi
              .fn()
              .mockRejectedValue(new Error('disk failed')),
          },
        }
      )
    ).resolves.toBeUndefined();
    expect(addProperty).not.toHaveBeenCalled();
  });
});
