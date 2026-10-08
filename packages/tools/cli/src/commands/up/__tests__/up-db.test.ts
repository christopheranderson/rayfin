import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  applyDbConfig: vi.fn(),
  loadRayfinConfig: vi.fn(),
  resolveServicePath: vi.fn(),
  resolveDeploymentEnvFile: vi.fn(),
  findRayfinProjectRoot: vi.fn(),
}));

vi.mock('../../../utils/apply-db-config.js', () => ({
  applyDbConfig: mocks.applyDbConfig,
}));

vi.mock('../../../utils/config-utils.js', () => ({
  loadRayfinConfig: mocks.loadRayfinConfig,
  resolveServicePath: mocks.resolveServicePath,
}));

vi.mock('../../../utils/env-fabric-utils.js', () => ({
  resolveDeploymentEnvFile: mocks.resolveDeploymentEnvFile,
}));

vi.mock('../../../utils/project-utils.js', () => ({
  findRayfinProjectRoot: mocks.findRayfinProjectRoot,
}));

async function runApply(args: string[] = []): Promise<void> {
  const { upDbCommand } = await import('../up-db.js');
  await upDbCommand.parseAsync(['apply', ...args], { from: 'user' });
}

describe('rayfin up db apply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findRayfinProjectRoot.mockReturnValue('/repo');
    mocks.loadRayfinConfig.mockReturnValue({
      services: {
        data: { path: 'packages/data', buildCommand: 'npm run build' },
      },
    });
    mocks.resolveServicePath.mockReturnValue('/repo/packages/data');
    mocks.resolveDeploymentEnvFile.mockResolvedValue({
      deployment: { rayfinApiUrl: 'https://example.test/workload' },
    });
    mocks.applyDbConfig.mockResolvedValue(undefined);
  });

  it('enables transient-error retry on the remote apply', async () => {
    await runApply();

    expect(mocks.applyDbConfig).toHaveBeenCalledTimes(1);
    expect(mocks.applyDbConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        remote: true,
        retryTransientErrors: true,
        serviceRoot: '/repo/packages/data',
        buildCommand: 'npm run build',
      })
    );
  });

  it('keeps retry enabled when --force is passed', async () => {
    await runApply(['--force']);

    expect(mocks.applyDbConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        remote: true,
        force: true,
        retryTransientErrors: true,
      })
    );
  });

  it('forwards the configured postgresql dialect to applyDbConfig', async () => {
    mocks.loadRayfinConfig.mockReturnValue({
      services: { data: { enabled: true, dialect: 'postgresql' } },
    });

    await runApply();

    expect(mocks.applyDbConfig).toHaveBeenCalledWith(
      expect.objectContaining({ dialect: 'postgresql' })
    );
  });

  it('defaults to mssql when no dialect is configured', async () => {
    await runApply();

    expect(mocks.applyDbConfig).toHaveBeenCalledWith(
      expect.objectContaining({ dialect: 'mssql' })
    );
  });
});
