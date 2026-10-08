import { describe, expect, it, vi } from 'vitest';

import type { StaticHostingConfig } from '../../../../config/index.js';
import type { WorkloadTarget } from '../../../../external/fabric/index.js';
import { MONIKER_HEADER } from '../../../../fabric.js';
import type {
  StaticDeployResult,
  StaticFolderValidation,
  StaticHostingService,
} from '../../../../services/static-hosting/index.js';
import { deployStatic } from '../deploy-static.js';

const target: WorkloadTarget = {
  itemId: 'i1',
  itemEndpoint: 'https://api/i1',
  baasEndpoint: 'https://baas/i1',
  authorizationHeader: 'Bearer t',
};

const config = {
  enabled: true,
  folder: 'dist',
} as StaticHostingConfig;

const validFolder: StaticFolderValidation = {
  exists: true,
  empty: false,
  resolvedPath: '/p/dist',
  fileCount: 3,
  totalSizeBytes: 1024,
};

const deployOk: StaticDeployResult = {
  success: true,
  hostingUrl: 'https://app.example',
  deploymentId: 'dep-1',
  errorMessage: null,
};

function fakeStaticHosting(
  overrides: Partial<StaticHostingService> = {}
): StaticHostingService {
  return {
    validateFolder: vi.fn().mockResolvedValue(validFolder),
    runBuild: vi.fn().mockResolvedValue(true),
    packageFolder: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    deploy: vi.fn().mockResolvedValue(deployOk),
    persistHostingUrl: vi.fn(),
    persistAssetAccess: vi.fn(),
    ...overrides,
  };
}

describe('deployStatic', () => {
  it('builds, validates, packages, and deploys to the workload deploy URL', async () => {
    const staticHosting = fakeStaticHosting();

    const result = await deployStatic(
      {
        target,
        config: { ...config, buildCommand: 'npm run build' },
        projectRoot: '/p',
      },
      { staticHosting }
    );

    expect(staticHosting.runBuild).toHaveBeenCalledWith(
      '/p',
      expect.any(Object)
    );
    expect(staticHosting.packageFolder).toHaveBeenCalledWith('/p/dist');
    expect(staticHosting.deploy).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3]),
      'https://api/i1/__private/webapp/deploy',
      'Bearer t',
      { [MONIKER_HEADER]: 'i1' }
    );
    expect(result).toEqual({
      hostingUrl: 'https://app.example',
      deploymentId: 'dep-1',
      fileCount: 3,
      totalSizeBytes: 1024,
    });
  });

  it('skips the build when no build command is configured', async () => {
    const staticHosting = fakeStaticHosting();

    await deployStatic(
      { target, config, projectRoot: '/p' },
      { staticHosting }
    );

    expect(staticHosting.runBuild).not.toHaveBeenCalled();
  });

  it('throws when the build command fails', async () => {
    const staticHosting = fakeStaticHosting({
      runBuild: vi.fn().mockResolvedValue(false),
    });

    await expect(
      deployStatic(
        { target, config: { ...config, buildCommand: 'x' }, projectRoot: '/p' },
        { staticHosting }
      )
    ).rejects.toThrow(/Static build command failed/);
  });

  it('throws when the static folder is missing', async () => {
    const staticHosting = fakeStaticHosting({
      validateFolder: vi
        .fn()
        .mockResolvedValue({ ...validFolder, exists: false, message: 'nope' }),
    });

    await expect(
      deployStatic({ target, config, projectRoot: '/p' }, { staticHosting })
    ).rejects.toThrow('nope');
  });

  it('throws when the static folder is empty', async () => {
    const staticHosting = fakeStaticHosting({
      validateFolder: vi
        .fn()
        .mockResolvedValue({ ...validFolder, empty: true }),
    });

    await expect(
      deployStatic({ target, config, projectRoot: '/p' }, { staticHosting })
    ).rejects.toThrow(/empty/);
  });

  it('throws when the deploy reports failure', async () => {
    const staticHosting = fakeStaticHosting({
      deploy: vi
        .fn()
        .mockResolvedValue({ success: false, errorMessage: 'rejected' }),
    });

    await expect(
      deployStatic({ target, config, projectRoot: '/p' }, { staticHosting })
    ).rejects.toThrow('rejected');
  });
});
