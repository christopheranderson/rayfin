import { describe, expect, it, vi } from 'vitest';

import type { FunctionsConfig } from '../../../../config/index.js';
import type { WorkloadTarget } from '../../../../external/fabric/index.js';
import type { FunctionsService } from '../../../../services/functions/index.js';
import { deployFunctions } from '../deploy-functions.js';

const target: WorkloadTarget = {
  itemId: 'i1',
  itemEndpoint: 'https://api/i1',
  baasEndpoint: 'https://baas/i1',
  authorizationHeader: 'Bearer t',
};

const config = {
  enabled: true,
  auth: { type: 'application' },
} as FunctionsConfig;

function fakeFunctions(
  overrides: Partial<FunctionsService> = {}
): FunctionsService {
  return {
    deploy: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('deployFunctions', () => {
  it('builds the deploy URL and forwards target identifiers', async () => {
    const functions = fakeFunctions();

    await deployFunctions({ projectRoot: '/p', config, target }, { functions });

    expect(functions.deploy).toHaveBeenCalledWith({
      projectRoot: '/p',
      config,
      deployUrl: 'https://api/i1/__private/functions/deploy',
      itemId: 'i1',
      authorizationHeader: 'Bearer t',
    });
  });

  it('forwards the resolved auth type without adding parallel auth fields', async () => {
    const functions = fakeFunctions();

    await deployFunctions({ projectRoot: '/p', config, target }, { functions });

    const request = vi.mocked(functions.deploy).mock.calls[0][0];
    // Auth travels inside `config`, which the runtime-settings POST already
    // carries. The deploy request itself must not gain a second copy.
    expect(request.config.auth?.type).toBe('application');
    expect(Object.keys(request).sort()).toEqual([
      'authorizationHeader',
      'config',
      'deployUrl',
      'itemId',
      'projectRoot',
    ]);
  });

  it('propagates a deploy failure', async () => {
    const functions = fakeFunctions({
      deploy: vi.fn().mockRejectedValue(new Error('build failed')),
    });

    await expect(
      deployFunctions({ projectRoot: '/p', config, target }, { functions })
    ).rejects.toThrow('build failed');
  });
});
