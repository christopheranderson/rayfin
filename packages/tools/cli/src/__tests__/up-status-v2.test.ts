import {
  noopCancellationToken,
  silentDiagnostics,
} from '@microsoft/rayfin-tools-common/_internal/adapters';
import type { UpStatusDeps } from '@microsoft/rayfin-tools-common/_internal/workflows';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureAuthenticated, isAuthenticated } from '../auth/index.js';
import * as statusDeps from '../commands/up/up-status-deps.js';
import { upStatusCommand } from '../commands/up/up-status.js';

vi.mock('../auth/index.js');

const realCreateDeps = statusDeps.createUpStatusDeps;
const record = {
  itemId: 'item',
  workspaceId: 'workspace',
  apiUrl: 'https://runtime.example',
  portalUrl: 'https://app.fabric.microsoft.com',
  tenantId: 'tenant',
  publishableKey: 'pk-saved',
  hostingUrl: 'https://app.example',
};

function fixture() {
  const client = {
    getWorkspace: vi
      .fn()
      .mockResolvedValue({ id: 'workspace', displayName: 'My workspace' }),
    getItem: vi.fn().mockResolvedValue({
      id: 'item',
      displayName: 'app',
      type: 'AppBackend',
    }),
    listDatabases: vi.fn().mockResolvedValue([]),
    checkManagementEndpoint: vi.fn().mockResolvedValue({
      url: 'https://api.fabric.example/key',
      reachable: true,
      httpStatus: 200,
      authenticated: true,
      publishableKey: 'pk-saved',
    }),
  };
  const deps = {
    project: {
      load: vi.fn().mockResolvedValue({
        projectRoot: '/fixture',
        id: 'app',
        services: { auth: { enabled: true }, data: { enabled: false } },
      }),
    },
    registry: {
      getActiveDeployment: vi
        .fn()
        .mockResolvedValue({ record, workspaceName: 'active' }),
      listDeployments: vi
        .fn()
        .mockResolvedValue({ deployments: [], warnings: [] }),
      readDeployment: vi.fn().mockResolvedValue({ record, warnings: [] }),
    },
    fabric: { tryConnect: vi.fn().mockResolvedValue(client) },
    cancellation: noopCancellationToken,
    diagnostics: silentDiagnostics,
    progress: { report: vi.fn() },
  } satisfies UpStatusDeps;
  return { deps, client };
}

describe('V2 up status boundary', () => {
  let current: ReturnType<typeof fixture>;
  let stdout: string[];
  let stderr: string[];
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    originalExitCode = process.exitCode;
    process.exitCode = 0;
    vi.stubEnv('RAYFIN_FEATURE_FLAGS', 'tools-arch-v2');
    vi.stubEnv('RAYFIN_WORKSPACE_ID', '');
    vi.stubEnv('RAYFIN_TOKEN', '');
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(console, 'log').mockImplementation((...args) =>
      stdout.push(args.join(' '))
    );
    vi.spyOn(console, 'warn').mockImplementation((...args) =>
      stderr.push(args.join(' '))
    );
    vi.spyOn(console, 'error').mockImplementation((...args) =>
      stderr.push(args.join(' '))
    );
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('V2 must not call process.exit');
    });
    upStatusCommand.setOptionValue('json', false);
    upStatusCommand.setOptionValue('verbose', false);
    current = fixture();
    vi.spyOn(statusDeps, 'createUpStatusDeps').mockImplementation(
      (diagnostics) => ({
        ...current.deps,
        diagnostics,
        progress: realCreateDeps(diagnostics).progress,
      })
    );
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function run(args: string[]) {
    const program = new Command('rayfin')
      .option('--json', 'JSON output', false)
      .option('--verbose', 'Verbose output', false)
      .option('--output <mode>', 'Output mode');
    program.addCommand(
      new Command('up')
        .option('--env-file <name>', 'Deployment name')
        .addCommand(upStatusCommand)
    );
    await program.parseAsync(args, { from: 'user' });
    expect(process.exit).not.toHaveBeenCalled();
  }

  it.each([
    ['--output', 'json', 'up', 'status'],
    ['--json', 'up', 'status'],
    ['up', 'status', '--json'],
  ])('emits one compatible JSON payload for %j', async (...args) => {
    await run(args);
    const status = JSON.parse(stdout.join(''));
    expect(status).toMatchObject({
      projectName: 'app',
      deployed: true,
      authenticated: true,
      deployment: {
        rayfinItemId: 'item',
        fabricPortalUrl:
          'https://app.fabric.microsoft.com/groups/workspace/appbackends/item?ctid=tenant',
        publishableKey: 'pk-saved',
      },
      endpointHealth: {
        scope: 'management',
        httpStatus: 200,
        error: null,
        metadata: { publishableKeyRetrieved: true, error: null },
      },
    });
    expect(stderr).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  it.each(['plain', 'interactive'])(
    'renders %s through the host logger',
    async (mode) => {
      await run(['--output', mode, 'up', 'status']);
      const text = [...stdout, ...stderr].join('\n');
      expect(text).toContain('Management Endpoint');
      expect(text).toContain('Status: Reachable');
      expect(text).toContain('Static app:      https://app.example');
      expect(text).not.toMatch(/Invalid JSON|Warning:|Metadata:|storage:/);
      expect(text).not.toContain('[up-status]');
      expect(process.exitCode).toBe(0);
    }
  );

  it('renders every inspection phase in verbose output without key or token diagnostics', async () => {
    current.deps.project.load.mockResolvedValue({
      projectRoot: '/fixture',
      id: 'app',
      services: { auth: { enabled: true }, data: { enabled: true } },
    });

    await run(['--verbose', '--output', 'plain', 'up', 'status']);

    const diagnostics = stderr
      .join('')
      .split('\n')
      .filter((line) => line.startsWith('[up-status]'))
      .join('\n');
    for (const phase of [
      'project',
      'deployment',
      'authentication',
      'workspace',
      'item',
      'database',
      'management',
    ]) {
      expect(diagnostics).toContain(`"phase":"${phase}"`);
    }
    expect(diagnostics).toContain('"httpStatus":200');
    expect(diagnostics).not.toContain('pk-saved');
    expect(diagnostics).not.toContain('Bearer');
    expect(process.exitCode).toBe(0);
  });

  it('rejects verbose JSON before project or authentication work', async () => {
    await expect(
      run(['--verbose', '--output', 'json', 'up', 'status'])
    ).rejects.toThrow();
    expect(JSON.stringify(JSON.parse(stdout.join('')))).toContain(
      'cannot be combined'
    );
    expect(current.deps.project.load).not.toHaveBeenCalled();
    expect(current.deps.fabric.tryConnect).not.toHaveBeenCalled();
  });

  it('keeps cached deployment data when no Fabric session is available', async () => {
    current.deps.fabric.tryConnect.mockResolvedValue(null);
    await run(['--json', 'up', 'status']);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      deployed: true,
      authenticated: false,
      endpointHealth: null,
      deployment: { publishableKey: 'pk-saved' },
    });
    expect(current.client.checkManagementEndpoint).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it('renders HTTP failure and recovery separately from reachability', async () => {
    current.client.checkManagementEndpoint.mockResolvedValue({
      url: 'https://api.fabric.example/key',
      reachable: true,
      httpStatus: 401,
      authenticated: false,
      errorCode: 'http',
      error: 'HTTP 401 Unauthorized',
    });
    await run(['--json', 'up', 'status']);
    expect(JSON.parse(stdout.join('')).endpointHealth).toMatchObject({
      reachable: true,
      authenticated: false,
      httpStatus: 401,
      error: 'HTTP 401 Unauthorized',
      hint: expect.stringContaining('rayfin login'),
    });
    expect(process.exitCode).toBe(2);
  });

  it('keeps optional metadata failures out of management access results', async () => {
    current.client.checkManagementEndpoint.mockResolvedValue({
      url: 'https://api.fabric.example/key',
      reachable: true,
      httpStatus: 200,
      authenticated: true,
      metadataError: 'unexpected-format',
    });
    await run(['--json', 'up', 'status']);
    expect(JSON.parse(stdout.join('')).endpointHealth).toMatchObject({
      error: null,
      publishableKey: null,
      metadata: {
        publishableKeyRetrieved: false,
        error: 'unexpected-format',
      },
    });
    expect(process.exitCode).toBe(0);
  });

  it('keeps metadata explanations in human output', async () => {
    current.client.checkManagementEndpoint.mockResolvedValue({
      url: 'https://api.fabric.example/key',
      reachable: true,
      httpStatus: 200,
      authenticated: true,
      metadataError: 'unexpected-format',
    });

    await run(['--output', 'plain', 'up', 'status']);

    const output = stderr.join('');
    expect(output).toContain(
      'Metadata: Publishable key unavailable: unexpected response format'
    );
    expect(output).not.toContain('Metadata: unexpected-format');
    expect(process.exitCode).toBe(0);
  });

  it('reports opaque redirects with a stable code and no HTTP 0', async () => {
    current.client.checkManagementEndpoint.mockResolvedValue({
      url: 'https://api.fabric.example/key',
      reachable: true,
      errorCode: 'redirect',
      error:
        'Management endpoint redirected; response details are unavailable in this host.',
    });

    await run(['--json', 'up', 'status']);

    expect(JSON.parse(stdout.join('')).endpointHealth).toMatchObject({
      errorCode: 'redirect',
      httpStatus: null,
      authenticated: null,
      hint: expect.stringContaining('configured Fabric endpoint'),
    });
    expect(stdout.join('')).not.toContain('HTTP 0');
    expect(process.exitCode).toBe(2);
  });

  it('uses the same command-error exit code when a project reader throws', async () => {
    current.deps.project.load.mockRejectedValue(
      new Error('Configuration read failed')
    );

    await run(['--json', 'up', 'status']);

    expect(JSON.parse(stdout.join(''))).toMatchObject({
      status: 'error',
      error: { code: 'status-unavailable' },
    });
    expect(process.exitCode).toBe(1);
    expect(current.deps.fabric.tryConnect).not.toHaveBeenCalled();
  });

  it('emits a structured missing-project failure before authentication', async () => {
    current.deps.project.load.mockResolvedValue(null);
    await run(['--json', 'up', 'status']);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      status: 'error',
      error: {
        code: 'project-not-found',
        hint: expect.stringContaining('rayfin init'),
      },
    });
    expect(current.deps.fabric.tryConnect).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('passes explicit deployment selection as request intent', async () => {
    await run(['--json', 'up', '--env-file', 'staging', 'status']);
    expect(current.deps.registry.readDeployment).toHaveBeenCalledWith(
      '/fixture',
      'staging'
    );
    expect(JSON.parse(stdout.join('')).envFabric.workspaceName).toBe('staging');
  });

  it('maps cancellation without terminating the host process', async () => {
    current.deps.cancellation = {
      ...noopCancellationToken,
      isCancellationRequested: true,
    };
    await run(['--json', 'up', 'status']);
    expect(JSON.parse(stdout.join(''))).toEqual({ status: 'cancelled' });
    expect(process.exitCode).toBe(2);
  });

  it('never acquires a token when there is no cached account', async () => {
    vi.mocked(isAuthenticated).mockResolvedValue(false);
    vi.mocked(ensureAuthenticated).mockClear();
    expect(
      await realCreateDeps(silentDiagnostics).fabric.tryConnect()
    ).toBeNull();
    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it('requires silent acquisition when a cached account is present', async () => {
    vi.mocked(isAuthenticated).mockResolvedValue(true);
    vi.mocked(ensureAuthenticated).mockResolvedValue({
      token: 'test-token',
      expiresOnTimestamp: Date.now() + 60_000,
      identityType: 'user',
    });
    expect(
      await realCreateDeps(silentDiagnostics).fabric.tryConnect()
    ).not.toBeNull();
    expect(ensureAuthenticated).toHaveBeenCalledWith(undefined, {
      silent: true,
    });
  });
});
