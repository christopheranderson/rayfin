/** Tests workspace targeting and `--workspace-id` recovery for `rayfin up switch`. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  findRayfinProjectRoot: vi.fn<() => string>(() => '/tmp/proj'),
  listDeployments: vi.fn<
    () => Array<{
      workspaceName: string;
      record: { workspaceId: string; itemId: string; tenantId?: string };
      active: boolean;
    }>
  >(() => []),
  getDeployment: vi.fn(),
  getActiveDeployment: vi.fn(() => null),
  setActiveDeployment: vi.fn(() => true),
  sanitizeWorkspaceName: vi.fn((s: string) => s.toLowerCase()),
  deploymentToPublicEnv: vi.fn(() => ({})),
  replaceDeploymentEnvInFile: vi.fn(async () => undefined),
  detectFrontendFramework: vi.fn(() => undefined),
  loadAuthState: vi.fn(async () => null),
  writeFrameworkEnvFile: vi.fn(async () => '/tmp/proj/.env.local'),
}));

vi.mock('../utils/project-utils.js', () => ({
  findRayfinProjectRoot: mocks.findRayfinProjectRoot,
}));
vi.mock('../utils/deployments-registry.js', () => ({
  listDeployments: mocks.listDeployments,
  getDeployment: mocks.getDeployment,
  getActiveDeployment: mocks.getActiveDeployment,
  setActiveDeployment: mocks.setActiveDeployment,
  sanitizeWorkspaceName: mocks.sanitizeWorkspaceName,
  deploymentToPublicEnv: mocks.deploymentToPublicEnv,
}));
vi.mock('../utils/env-file-utils.js', () => ({
  replaceDeploymentEnvInFile: mocks.replaceDeploymentEnvInFile,
}));
vi.mock('../utils/frontend-detect.js', () => ({
  detectFrontendFramework: mocks.detectFrontendFramework,
}));
vi.mock('../auth/state.js', () => ({
  loadAuthState: mocks.loadAuthState,
}));
vi.mock('../commands/env/env.js', () => ({
  writeFrameworkEnvFile: mocks.writeFrameworkEnvFile,
}));
vi.mock('../utils/feature-flags.js', () => ({
  createCliFeatureFlags: vi.fn(() => ({
    get: vi.fn((name: string) => name === 'cli-minor-fixes'),
  })),
}));

import { upSwitchCommand } from '../commands/up/up-switch.js';

describe('rayfin up switch', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset Commander singleton parse state so options from one test do not
    // leak into the next parseAsync call.
    interface CommanderInternals {
      _optionValues: Record<string, unknown>;
      _optionValueSources: Record<string, unknown>;
      processedArgs: unknown[];
      rawArgs: unknown[];
      args: unknown[];
    }
    const internals = upSwitchCommand as unknown as CommanderInternals;
    internals._optionValues = {};
    internals._optionValueSources = {};
    internals.processedArgs = [];
    internals.rawArgs = [];
    internals.args = [];
    // Re-establish mock implementations after clearAllMocks() wipes them.
    mocks.findRayfinProjectRoot.mockReturnValue('/tmp/proj');
    mocks.listDeployments.mockReturnValue([]);
    mocks.getActiveDeployment.mockReturnValue(null);
    mocks.setActiveDeployment.mockReturnValue(true);
    mocks.sanitizeWorkspaceName.mockImplementation((s: string) =>
      s.toLowerCase()
    );
    mocks.deploymentToPublicEnv.mockReturnValue({});
    mocks.replaceDeploymentEnvInFile.mockResolvedValue(undefined);
    mocks.detectFrontendFramework.mockReturnValue(undefined);
    mocks.loadAuthState.mockResolvedValue(null);
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((msg: unknown) =>
      logs.push(String(msg))
    );
    vi.spyOn(console, 'error').mockImplementation((msg: unknown) =>
      errors.push(String(msg))
    );
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Throw on exit so we can assert exit codes without killing the runner.
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`__EXIT__:${code ?? 0}`);
      }) as unknown as ReturnType<typeof vi.spyOn>;
  });

  it('describes --list as listing recorded deployments for this project', () => {
    const listOption = upSwitchCommand.options.find(
      (option) => option.long === '--list'
    );

    expect(listOption?.description).toBe(
      'List recorded deployments for this project'
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('with no workspace argument and no --list, fails with "please provide a workspace" message', async () => {
    await expect(
      upSwitchCommand.parseAsync([], { from: 'user' })
    ).rejects.toThrow('__EXIT__:1');

    expect(
      errors.some((e) =>
        /Please provide a workspace to switch the deployment to\./i.test(e)
      )
    ).toBe(true);
    // Old behavior: dumped "Recorded workspaces" + "Active:" — must NOT appear.
    expect(logs.some((l) => /Recorded workspaces/.test(l))).toBe(false);
  });

  it('with --list, prints recorded workspaces and exits 0', async () => {
    mocks.listDeployments.mockReturnValue([
      {
        workspaceName: 'my-ws',
        record: { workspaceId: 'ws-1', itemId: 'it-1' },
        active: true,
      },
    ]);
    mocks.getActiveDeployment.mockReturnValue({
      workspaceName: 'my-ws',
      record: { workspaceId: 'ws-1', itemId: 'it-1' },
    } as never);

    await upSwitchCommand.parseAsync(['--list'], { from: 'user' });

    expect(logs.some((l) => /Recorded workspaces/.test(l))).toBe(true);
    expect(logs.some((l) => /\* my-ws/.test(l))).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('with --workspace-id matching a recorded deployment, switches successfully', async () => {
    const record = { workspaceId: 'ws-target', itemId: 'it-1' };
    mocks.listDeployments.mockReturnValue([
      { workspaceName: 'target-ws', record, active: false },
    ]);

    await upSwitchCommand.parseAsync(['--workspace-id', 'ws-target'], {
      from: 'user',
    });

    expect(mocks.setActiveDeployment).toHaveBeenCalledWith(
      '/tmp/proj',
      'target-ws'
    );
    expect(logs.some((l) => /Active deployment: target-ws/.test(l))).toBe(true);
  });

  it('reads --workspace-id from global-aware Commander options', async () => {
    const record = { workspaceId: 'ws-target', itemId: 'it-1' };
    mocks.listDeployments.mockReturnValue([
      { workspaceName: 'target-ws', record, active: false },
    ]);
    vi.spyOn(upSwitchCommand, 'optsWithGlobals').mockReturnValue({
      emitEnv: true,
      workspaceId: 'ws-target',
    });

    await upSwitchCommand.parseAsync([], { from: 'user' });

    expect(mocks.setActiveDeployment).toHaveBeenCalledWith(
      '/tmp/proj',
      'target-ws'
    );
    expect(logs.some((l) => /Active deployment: target-ws/.test(l))).toBe(true);
  });

  it('with --workspace-id matching nothing, fails with actionable error listing workspace-ids', async () => {
    mocks.listDeployments.mockReturnValue([
      {
        workspaceName: 'other',
        record: { workspaceId: 'ws-other', itemId: 'it-1' },
        active: false,
      },
    ]);

    await expect(
      upSwitchCommand.parseAsync(['--workspace-id', 'ws-missing'], {
        from: 'user',
      })
    ).rejects.toThrow('__EXIT__:1');

    expect(
      errors.some((e) =>
        /No deployment found for workspace-id "ws-missing"/.test(e)
      )
    ).toBe(true);
    expect(errors.some((e) => /other \(workspace-id: ws-other\)/.test(e))).toBe(
      true
    );
  });

  it('with no matching deployment and none recorded, hints to run `rayfin up`', async () => {
    mocks.listDeployments.mockReturnValue([]);

    await expect(
      upSwitchCommand.parseAsync(['missing-ws'], { from: 'user' })
    ).rejects.toThrow('__EXIT__:1');

    expect(
      errors.some((e) =>
        /No deployment found for workspace "missing-ws"/.test(e)
      )
    ).toBe(true);
    expect(
      errors.some((e) =>
        /No deployments recorded yet\. Run `rayfin up`/.test(e)
      )
    ).toBe(true);
  });

  it('when the requested workspace is already active, short-circuits without rewriting env', async () => {
    const record = { workspaceId: 'ws-1', itemId: 'it-1' };
    mocks.getDeployment.mockReturnValue(record);
    mocks.getActiveDeployment.mockReturnValue({
      workspaceName: 'my-ws',
      record,
    } as never);

    await upSwitchCommand.parseAsync(['my-ws'], { from: 'user' });

    expect(logs.some((l) => /Already active: my-ws/.test(l))).toBe(true);
    expect(mocks.setActiveDeployment).not.toHaveBeenCalled();
    expect(mocks.replaceDeploymentEnvInFile).not.toHaveBeenCalled();
  });
});
