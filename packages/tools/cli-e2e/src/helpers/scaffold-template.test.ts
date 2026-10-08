import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loginScaffoldAndDeploy,
  type CliRunners,
  useLocalPackages,
} from './scaffold-template.js';

vi.mock('./env.js', () => ({ authMode: 'sp' }));

vi.mock('./local-packages.js', () => ({
  rewriteToLocalPackages: vi.fn(),
  runNpmInstall: vi.fn().mockResolvedValue({ exitCode: 0, output: '' }),
}));

afterEach(() => {
  vi.useRealTimers();
});

describe('loginScaffoldAndDeploy', () => {
  it('scaffolds the existing artifact and deploys to its workspace', async () => {
    const successResult = {
      exitCode: 0,
      stdout: '',
      stderr: '',
      output: '',
    };
    const runCli = vi
      .fn<CliRunners['runCli']>()
      .mockResolvedValue(successResult);
    const runCreateRayfin = vi
      .fn<CliRunners['runCreateRayfin']>()
      .mockResolvedValue(successResult);
    const tempDir = '/tmp/rayfin-scaffold-test';

    const result = await loginScaffoldAndDeploy({
      config: {
        clientId: 'test-client',
        clientSecret: 'test-secret',
        tenantId: 'test-tenant',
        artifactName: 'test-app',
        artifactId: 'test-item-id',
        workspaceId: 'test-workspace-id',
        workspaceName: 'Requested Workspace',
        baseApiUrl: 'https://example.test/v1',
      },
      tempDir,
      runners: { runCli, runCreateRayfin },
    });

    const projectDir = join(tempDir, 'test-app');
    expect(result.projectDir).toBe(projectDir);
    expect(runCreateRayfin).toHaveBeenCalledWith(
      [
        'test-app',
        '--template',
        'todoapp',
        '--workspace-id',
        'test-workspace-id',
        '--item-id',
        'test-item-id',
        '--base-api-url',
        'https://example.test/v1',
        ...(useLocalPackages ? ['--skip-install'] : []),
      ],
      { cwd: tempDir, timeoutMs: 120_000 }
    );
    expect(runCli).toHaveBeenLastCalledWith(
      ['up', '--workspace', 'Requested Workspace', '-y', '--verbose'],
      { cwd: projectDir, timeoutMs: 120_000 }
    );
  });

  it('retries deployment while stale Fabric child items release capacity', async () => {
    vi.useFakeTimers();
    const successResult = {
      exitCode: 0,
      stdout: '',
      stderr: '',
      output: '',
    };
    const capacityResult = {
      ...successResult,
      exitCode: 1,
      output: 'The workspace has reached the maximum number of items allowed.',
    };
    const runCli = vi
      .fn<CliRunners['runCli']>()
      .mockResolvedValueOnce(successResult)
      .mockResolvedValueOnce(capacityResult)
      .mockResolvedValueOnce(successResult);
    const runCreateRayfin = vi
      .fn<CliRunners['runCreateRayfin']>()
      .mockResolvedValue(successResult);

    const deployment = loginScaffoldAndDeploy({
      config: {
        clientId: 'test-client',
        clientSecret: 'test-secret',
        tenantId: 'test-tenant',
        artifactName: 'test-app',
        artifactId: 'test-item-id',
        workspaceId: 'test-workspace-id',
        workspaceName: 'Requested Workspace',
        baseApiUrl: 'https://example.test/v1',
      },
      tempDir: '/tmp/rayfin-scaffold-test',
      runners: { runCli, runCreateRayfin },
    });

    await vi.runAllTimersAsync();
    await expect(deployment).resolves.toEqual({
      projectDir: join('/tmp/rayfin-scaffold-test', 'test-app'),
    });
    expect(runCli).toHaveBeenCalledTimes(3);
  });

  it('does not retry unrelated deployment failures', async () => {
    const successResult = {
      exitCode: 0,
      stdout: '',
      stderr: '',
      output: '',
    };
    const runCli = vi
      .fn<CliRunners['runCli']>()
      .mockResolvedValueOnce(successResult)
      .mockResolvedValueOnce({
        ...successResult,
        exitCode: 1,
        output: 'Authentication failed',
      });
    const runCreateRayfin = vi
      .fn<CliRunners['runCreateRayfin']>()
      .mockResolvedValue(successResult);

    await expect(
      loginScaffoldAndDeploy({
        config: {
          clientId: 'test-client',
          clientSecret: 'test-secret',
          tenantId: 'test-tenant',
          artifactName: 'test-app',
          artifactId: 'test-item-id',
          workspaceId: 'test-workspace-id',
          workspaceName: 'Requested Workspace',
          baseApiUrl: 'https://example.test/v1',
        },
        tempDir: '/tmp/rayfin-scaffold-test',
        runners: { runCli, runCreateRayfin },
      })
    ).rejects.toThrow('Authentication failed');
    expect(runCli).toHaveBeenCalledTimes(2);
  });
});
