/**
 * Unit coverage for the CLI {@link FunctionsService} delegation. The impl is a
 * thin map onto the legacy `deployFunctions` orchestrator; these tests pin the
 * service-root resolution and the fixed `skipBuild`/`isCompiledZip` legacy-`up`
 * arguments so a regression in the forwarded contract is caught by a fast unit
 * test rather than only the v2 E2E axis.
 */
import type { DeployFunctionsRequest } from '@microsoft/rayfin-tools-common/_internal/services/functions';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../commands/up/up-functions.js', () => ({
  deployFunctions: vi.fn(),
}));
vi.mock('../../utils/config-utils.js', () => ({
  resolveServiceRoot: vi.fn(() => '/proj/functions'),
}));

import { deployFunctions } from '../../commands/up/up-functions.js';
import { resolveServiceRoot } from '../../utils/config-utils.js';
import { createCliFunctionsService } from '../functions.js';

const mockDeployFunctions = deployFunctions as ReturnType<typeof vi.fn>;
const mockResolveServiceRoot = resolveServiceRoot as ReturnType<typeof vi.fn>;

const request = {
  projectRoot: '/proj',
  config: { enabled: true, path: 'packages/functions' },
  deployUrl: 'https://api.test/item-1/__private/functions/deploy',
  itemId: 'item-1',
  authorizationHeader: 'Bearer tok',
} as unknown as DeployFunctionsRequest;

describe('createCliFunctionsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveServiceRoot.mockReturnValue('/proj/functions');
  });

  it('resolves the functions service root from config.path', async () => {
    await createCliFunctionsService().deploy(request);

    expect(mockResolveServiceRoot).toHaveBeenCalledWith(
      '/proj',
      'functions',
      'packages/functions'
    );
  });

  it('delegates to deployFunctions with the mapped legacy `up` arguments', async () => {
    await createCliFunctionsService().deploy(request);

    expect(mockDeployFunctions).toHaveBeenCalledWith({
      serviceRoot: '/proj/functions',
      deployUrl: 'https://api.test/item-1/__private/functions/deploy',
      rayfinItemId: 'item-1',
      authorizationHeader: 'Bearer tok',
      functionsConfig: request.config,
      skipBuild: false,
      isCompiledZip: true,
      buildOutput: 'inherit',
    });
  });

  it.each([false, true])(
    'selects capture explicitly with or without diagnostics (capture=%s)',
    async (captureOutput) => {
      for (const diagnostics of [undefined, { debug: vi.fn() }]) {
        await createCliFunctionsService({ diagnostics, captureOutput }).deploy(
          request
        );
        expect(mockDeployFunctions).toHaveBeenLastCalledWith(
          expect.objectContaining({
            mode: captureOutput ? 'silent' : undefined,
            buildOutput: captureOutput ? 'capture' : 'inherit',
            diagnostics,
          })
        );
      }
    }
  );

  it('rejects when deployFunctions rejects', async () => {
    mockDeployFunctions.mockRejectedValueOnce(new Error('deploy failed'));

    await expect(createCliFunctionsService().deploy(request)).rejects.toThrow(
      'deploy failed'
    );
  });
});
