import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDevWorkflow } from '@microsoft/rayfin-tools-common/_internal/workflows/dev';
import { runEnsureUserLicenseWorkflow } from '@microsoft/rayfin-tools-common/_internal/workflows/ensure-user-license';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cliCommandRunner } from '../adapters/runner.js';
import { cliUserInteraction } from '../adapters/user-interaction.js';
import { ensureAuthenticated } from '../auth/index.js';
import { createDevDeps } from '../commands/dev/dev-deps.js';
import { runDevV2 } from '../commands/dev/dev-v2.js';
import { createCliDiagnosticSession } from '../diagnostics/session.js';
import { CliHandledError } from '../errors.js';
import { createCliUserLicenseService } from '../services/user-license.js';

vi.mock('../diagnostics/session.js', () => ({
  createCliDiagnosticSession: vi.fn(),
}));

vi.mock('@microsoft/rayfin-tools-common/_internal/workflows/dev', () => ({
  runDevWorkflow: vi.fn(),
}));
vi.mock(
  '@microsoft/rayfin-tools-common/_internal/workflows/ensure-user-license',
  () => ({
    runEnsureUserLicenseWorkflow: vi.fn(),
  })
);
vi.mock('../commands/dev/dev-deps.js', () => ({
  DEV_PROVIDERS: ['fabric', 'docker'],
  createDevDeps: vi.fn().mockResolvedValue({}),
}));
vi.mock('../adapters/runner.js', () => ({
  cliCommandRunner: {
    run: vi.fn().mockResolvedValue({
      launched: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
    }),
  },
}));
vi.mock('../adapters/user-interaction.js', () => ({
  cliUserInteraction: { confirm: vi.fn(), prompt: vi.fn(), select: vi.fn() },
}));
vi.mock('../auth/index.js', () => ({
  ensureAuthenticated: vi.fn(),
}));
vi.mock('../services/user-license.js', () => ({
  createCliUserLicenseService: vi.fn(async () => ({
    ensureUserHasLicense: vi.fn(),
  })),
}));

const mockRunDevWorkflow = vi.mocked(runDevWorkflow);
const mockRunEnsureUserLicenseWorkflow = vi.mocked(
  runEnsureUserLicenseWorkflow
);
const mockCreateDevDeps = vi.mocked(createDevDeps);
const mockCliCommandRunner = vi.mocked(cliCommandRunner);
const mockEnsureAuthenticated = vi.mocked(ensureAuthenticated);

describe('runDevV2', () => {
  let projectRoot: string;
  let originalFeatureFlags: string | undefined;
  let originalWorkspaceId: string | undefined;
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let errorWrites: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    mockCliCommandRunner.run.mockResolvedValue({
      launched: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    vi.mocked(createCliDiagnosticSession).mockResolvedValue({
      diagnostics: { debug: vi.fn() },
      close: vi.fn().mockResolvedValue(undefined),
    });
    originalFeatureFlags = process.env.RAYFIN_FEATURE_FLAGS;
    originalWorkspaceId = process.env.RAYFIN_WORKSPACE_ID;
    delete process.env.RAYFIN_FEATURE_FLAGS;
    delete process.env.RAYFIN_WORKSPACE_ID;
    projectRoot = mkdtempSync(join(tmpdir(), 'rayfin-dev-v2-'));
    mkdirSync(join(projectRoot, 'rayfin'));
    writeFileSync(
      join(projectRoot, 'rayfin', 'rayfin.yml'),
      'id: test-project\nservices: {}\n'
    );
    stdoutWrites = [];
    stderrWrites = [];
    errorWrites = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      errorWrites.push(args.map(String).join(' '));
    });
    mockRunDevWorkflow.mockResolvedValue({
      status: 'ok',
      data: {
        provider: 'fabric',
        target: { displayName: 'Test workspace' },
        startedRuntimes: [],
        runtimeUrls: { functions: 'http://localhost:7072' },
        warnings: [],
      },
    });
    mockRunEnsureUserLicenseWorkflow.mockResolvedValue({
      status: 'ok',
      data: { outcome: 'licensed' },
    });
    mockEnsureAuthenticated.mockResolvedValue({
      token: 'fabric-token',
      expiresOnTimestamp: Date.now() + 60_000,
      identityType: 'user',
      tenantId: 'tenant-abc',
    });
  });

  afterEach(() => {
    if (originalFeatureFlags === undefined) {
      delete process.env.RAYFIN_FEATURE_FLAGS;
    } else {
      process.env.RAYFIN_FEATURE_FLAGS = originalFeatureFlags;
    }
    if (originalWorkspaceId === undefined) {
      delete process.env.RAYFIN_WORKSPACE_ID;
    } else {
      process.env.RAYFIN_WORKSPACE_ID = originalWorkspaceId;
    }
    vi.restoreAllMocks();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  async function useFileSession(configDir = projectRoot): Promise<void> {
    const actual = await vi.importActual<
      typeof import('../diagnostics/session.js')
    >('../diagnostics/session.js');
    vi.mocked(createCliDiagnosticSession).mockImplementationOnce((options) =>
      actual.createCliDiagnosticSession({ ...options, configDir })
    );
  }

  it.each([
    ['interactive', false],
    ['plain', false],
    ['json', false],
    ['interactive', true],
    ['plain', true],
  ] as const)(
    'persists build and runtime failures in %s with verbose=%s',
    async (output, verbose) => {
      await useFileSession();
      const cause = new TypeError('Runtime stopped');
      mockCliCommandRunner.run.mockImplementationOnce(
        async (_command, _args, options) => {
          options?.onStdout?.('frontend output\n');
          options?.onStderr?.('Bearer ');
          options?.onStderr?.('private-token');
          return { launched: true, exitCode: 1, stdout: '', stderr: '' };
        }
      );
      mockRunDevWorkflow.mockImplementationOnce(async () => {
        const deps = mockCreateDevDeps.mock.calls[0][0];
        deps.diagnostics.debug({
          area: 'dev',
          message: 'diagnostic-only detail',
        });
        deps.onBuildStdout?.('build output\n');
        deps.onBuildStderr?.('last build detail');
        await deps.runner?.run('node', ['private-argument']);
        return {
          status: 'failed',
          error: { code: 'runtime-exited', message: cause.message, cause },
        };
      });

      const error = await runDevV2(projectRoot, { output, verbose }).catch(
        (caught: unknown) => caught
      );
      expect(error).toBeInstanceOf(CliHandledError);
      expect((error as CliHandledError).originalError).toBe(cause);
      const session = await vi.mocked(createCliDiagnosticSession).mock
        .results[0].value;
      const log = readFileSync(session.logPath, 'utf8');
      expect(log).toContain('build output');
      expect(log).toContain('last build detail');
      expect(log).toContain('frontend output');
      expect(log).toContain('Bearer [REDACTED]');
      expect(log).toContain('"status":"failed"');
      expect(log).toContain('"code":"runtime-exited"');
      expect(log).not.toMatch(/private-token|private-argument/);
      expect(stderrWrites.join('').includes('diagnostic-only detail')).toBe(
        verbose
      );
      const terminalOutput = [...stdoutWrites, ...stderrWrites].join('');
      expect(terminalOutput.match(/build output/g) ?? []).toHaveLength(
        verbose ? 1 : 0
      );
      expect(terminalOutput.match(/last build detail/g) ?? []).toHaveLength(
        verbose ? 1 : 0
      );
      if (output === 'json') {
        expect(stdoutWrites).toHaveLength(1);
        expect(JSON.parse(stdoutWrites[0])).toMatchObject({
          diagnosticLog: session.logPath,
          code: 'runtime-exited',
        });
      } else {
        expect(errorWrites).toContain(`   Diagnostic log: ${session.logPath}`);
        expect([...stdoutWrites, ...stderrWrites].join('')).toContain(
          'frontend output'
        );
      }
    }
  );

  it('serializes capacity consent as action required', async () => {
    mockRunDevWorkflow.mockResolvedValueOnce({
      status: 'failed',
      error: {
        code: 'fabric-readiness:capacity_assignment_confirmation_required',
        message: 'Capacity assignment requires confirmation.',
      },
    });

    await expect(runDevV2(projectRoot, { output: 'json' })).rejects.toThrow(
      'Capacity assignment requires confirmation.'
    );

    expect(JSON.parse(stdoutWrites[0])).toMatchObject({
      status: 'action_required',
      code: 'fabric-readiness:capacity_assignment_confirmation_required',
      reason: 'capacity_assignment_confirmation_required',
      retryable: true,
      hint: expect.stringContaining('--capacity-id'),
    });
  });

  it.each(['ok', 'cancelled'] as const)(
    'closes and flushes a %s session after workflow cleanup',
    async (status) => {
      await useFileSession();
      const listeners = process.listenerCount('SIGINT');
      mockRunDevWorkflow.mockImplementationOnce(async (_request, deps) => {
        if (status === 'cancelled') {
          process.emit('SIGINT');
          expect(deps.signal?.isCancellationRequested).toBe(true);
          return { status: 'cancelled' };
        }
        return {
          status: 'ok',
          data: {
            provider: 'fabric',
            target: { displayName: 'Backend' },
            startedRuntimes: [],
            runtimeUrls: {},
            warnings: [],
          },
        };
      });
      const error = await runDevV2(projectRoot, { output: 'json' }).catch(
        (caught: unknown) => caught
      );
      expect(error instanceof Error).toBe(status === 'cancelled');
      expect(process.listenerCount('SIGINT')).toBe(listeners);
      const session = await vi.mocked(createCliDiagnosticSession).mock
        .results[0].value;
      const log = readFileSync(session.logPath, 'utf8');
      expect(log).toContain('Command completed');
      expect(log).toContain(
        `"status":"${status === 'ok' ? 'success' : 'cancelled'}"`
      );
      expect(log).toContain(`"exitCode":${status === 'ok' ? 0 : 2}`);
      expect(stdoutWrites).toHaveLength(1);
    }
  );

  it.each([
    ['interactive', false],
    ['plain', false],
    ['json', false],
    ['plain', true],
  ] as const)(
    'replays compiler failures once in %s with verbose=%s',
    async (output, verbose) => {
      await useFileSession();
      mockRunDevWorkflow.mockImplementationOnce(async () => {
        const deps = mockCreateDevDeps.mock.calls[0][0];
        deps.onBuildStdout?.(
          '/workspaces/app/src/file.ts(12,5): error TS2322: Compiler failure\n'
        );
        deps.onBuildStderr?.('Build stderr detail');
        return {
          status: 'failed',
          error: {
            code: 'functions-build-failed',
            message: 'build failed with exit code 1',
          },
        };
      });
      await expect(runDevV2(projectRoot, { output, verbose })).rejects.toThrow(
        'build failed'
      );
      if (output === 'json') {
        expect(stdoutWrites).toHaveLength(1);
        expect(JSON.parse(stdoutWrites[0])).toMatchObject({
          code: 'functions-build-failed',
          buildOutput:
            '/workspaces/app/src/file.ts(12,5): error TS2322: Compiler failure\nBuild stderr detail\n',
        });
        expect(stderrWrites).toEqual([]);
      } else {
        expect(stderrWrites.join('').match(/Compiler failure/g)).toHaveLength(
          1
        );
        expect(
          stderrWrites.join('').match(/Build stderr detail/g)
        ).toHaveLength(1);
        if (!verbose)
          expect(stderrWrites.join('')).toContain(
            '/workspaces/app/src/file.ts(12,5)'
          );
      }
    }
  );

  it('persists preflight failures without starting providers', async () => {
    await useFileSession();
    await expect(
      runDevV2(projectRoot, { output: 'json', provider: 'invalid' })
    ).rejects.toThrow('Unknown provider');
    expect(mockCreateDevDeps).not.toHaveBeenCalled();
    expect(stdoutWrites).toHaveLength(1);
    const result = JSON.parse(stdoutWrites[0]);
    expect(result.hint).toBe('Use `--provider fabric` or `--provider docker`.');
    expect(readFileSync(result.diagnosticLog, 'utf8')).toContain(
      'Unknown provider'
    );
  });

  it('rejects an invalid capacity ID before authentication', async () => {
    await expect(
      runDevV2(projectRoot, {
        output: 'json',
        capacityId: 'not-a-guid',
      })
    ).rejects.toThrow('--capacity-id must be a GUID');

    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
    expect(mockCreateDevDeps).not.toHaveBeenCalled();
    expect(JSON.parse(stdoutWrites[0])).toMatchObject({
      status: 'error',
      code: 'invalid-capacity-id',
    });
  });

  it.each([
    {
      workspaceOption: '--workspace',
      options: { workspace: 'My Workspace' },
    },
    {
      workspaceOption: '--workspace-id',
      options: { workspaceId: '11111111-1111-4111-8111-111111111111' },
    },
  ])(
    'rejects $workspaceOption with --capacity-id before authentication',
    async ({ workspaceOption, options }) => {
      await expect(
        runDevV2(projectRoot, {
          output: 'json',
          ...options,
          capacityId: '22222222-2222-4222-8222-222222222222',
        })
      ).rejects.toThrow(
        `${workspaceOption} and --capacity-id cannot be used together`
      );

      expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
      expect(mockCreateDevDeps).not.toHaveBeenCalled();
      expect(JSON.parse(stdoutWrites[0])).toMatchObject({
        status: 'error',
        code: 'capacity-target-conflict',
      });
    }
  );

  it('rejects RAYFIN_WORKSPACE_ID with --capacity-id before authentication', async () => {
    process.env.RAYFIN_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

    await expect(
      runDevV2(projectRoot, {
        output: 'json',
        capacityId: '22222222-2222-4222-8222-222222222222',
      })
    ).rejects.toThrow(
      'RAYFIN_WORKSPACE_ID and --capacity-id cannot be used together'
    );

    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
    expect(mockCreateDevDeps).not.toHaveBeenCalled();
    expect(JSON.parse(stdoutWrites[0])).toMatchObject({
      status: 'error',
      code: 'capacity-target-conflict',
      hint: expect.stringContaining('Unset RAYFIN_WORKSPACE_ID'),
    });
  });

  it('rejects --capacity-id when the env file supplies RAYFIN_WORKSPACE_ID', async () => {
    writeFileSync(
      join(projectRoot, 'rayfin', '.env.ambient'),
      'RAYFIN_WORKSPACE_ID=11111111-1111-4111-8111-111111111111\n'
    );

    await expect(
      runDevV2(projectRoot, {
        output: 'json',
        envFile: 'rayfin/.env.ambient',
        capacityId: '22222222-2222-4222-8222-222222222222',
      })
    ).rejects.toThrow(
      'RAYFIN_WORKSPACE_ID and --capacity-id cannot be used together'
    );

    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
    expect(mockCreateDevDeps).not.toHaveBeenCalled();
    expect(JSON.parse(stdoutWrites[0])).toMatchObject({
      status: 'error',
      code: 'capacity-target-conflict',
      hint: expect.stringContaining('Unset RAYFIN_WORKSPACE_ID'),
    });
  });

  it('rejects capacityId with the Docker provider', async () => {
    process.env.RAYFIN_FEATURE_FLAGS = 'docker-local-dev';

    await expect(
      runDevV2(projectRoot, {
        output: 'json',
        provider: 'docker',
        capacityId: '11111111-1111-4111-8111-111111111111',
      })
    ).rejects.toThrow(
      'Capacity assignment options are only available with the Fabric provider'
    );

    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
    expect(mockCreateDevDeps).not.toHaveBeenCalled();
    expect(JSON.parse(stdoutWrites[0])).toMatchObject({
      status: 'error',
      code: 'capacity-provider-conflict',
    });
  });

  it.each([
    'invalid-request',
    'fabric-workspace-required',
    'invalid-connectors',
    'functions-port-unavailable',
    'functions-build-failed',
    'runtime-exited',
  ])(
    'persists the typed workflow failure code %s before closing',
    async (code) => {
      await useFileSession();
      mockRunDevWorkflow.mockResolvedValueOnce({
        status: 'failed',
        error: { code, message: 'Session could not continue' },
      });
      await expect(runDevV2(projectRoot, { output: 'json' })).rejects.toThrow(
        'Session could not continue'
      );
      expect(stdoutWrites).toHaveLength(1);
      const result = JSON.parse(stdoutWrites[0]);
      const log = readFileSync(result.diagnosticLog, 'utf8');
      expect(log).toContain(`"code":"${code}"`);
      expect(log.indexOf(`"code":"${code}"`)).toBeLessThan(
        log.indexOf('Command completed')
      );
    }
  );

  it.each([{ json: true }, { output: 'json' as const }])(
    'rejects verbose plus JSON before authentication (%j)',
    async (options) => {
      await expect(
        runDevV2(projectRoot, { ...options, verbose: true })
      ).rejects.toThrow('--verbose cannot be combined');
      expect(mockCreateDevDeps).not.toHaveBeenCalled();
      expect(stdoutWrites).toHaveLength(1);
      expect(
        vi.mocked(createCliDiagnosticSession).mock.calls[0][0].mirror
      ).toBeUndefined();
    }
  );

  it('retains the command result when the log directory cannot be created', async () => {
    const blocker = join(projectRoot, 'not-a-directory');
    writeFileSync(blocker, 'file');
    await useFileSession(blocker);
    await runDevV2(projectRoot, { output: 'json' });
    expect(stdoutWrites).toHaveLength(1);
    expect(JSON.parse(stdoutWrites[0]).status).toBe('ready');
    const session = await vi.mocked(createCliDiagnosticSession).mock.results[0]
      .value;
    expect(session.logPath).toBeUndefined();
  });

  it('emits one JSON object when invoked with a project path outside cwd', async () => {
    await runDevV2(projectRoot, { output: 'json' });

    expect(mockCreateDevDeps).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'fabric',
      })
    );
    expect(createCliUserLicenseService).toHaveBeenCalledOnce();
    expect(mockRunDevWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'fabric' }),
      expect.anything()
    );

    expect(stdoutWrites).toHaveLength(1);
    expect(JSON.parse(stdoutWrites[0])).toEqual({
      status: 'ready',
      provider: 'fabric',
      target: {
        displayName: 'Test workspace',
        apiUrl: null,
      },
      startedRuntimes: [],
      runtimeUrls: { functions: 'http://localhost:7072' },
      warnings: [],
    });
  });

  it.each([true, false])(
    'rejects delegated auth before creating Fabric deps (enabled=%s)',
    async (enabled) => {
      writeFileSync(
        join(projectRoot, 'rayfin', 'rayfin.yml'),
        `id: test-project\nservices:\n  functions:\n    enabled: ${enabled}\n    auth:\n      type: delegated\n`
      );
      await expect(runDevV2(projectRoot, { output: 'json' })).rejects.toThrow(
        'Only application authentication is supported.'
      );
      expect(mockCreateDevDeps).not.toHaveBeenCalled();
      expect(mockRunDevWorkflow).not.toHaveBeenCalled();
      expect(stdoutWrites).toHaveLength(1);
      expect(JSON.parse(stdoutWrites[0])).toMatchObject({
        status: 'error',
        code: 'invalid-functions-config',
        error: expect.stringContaining(
          'Set services.functions.auth.type to "application".'
        ),
      });
    }
  );

  it('does not require application auth opt-in from the selected dev env file', async () => {
    writeFileSync(
      join(projectRoot, 'rayfin', 'rayfin.yml'),
      'id: test-project\nservices:\n  functions:\n    enabled: false\n    auth:\n      type: application\n'
    );
    writeFileSync(
      join(projectRoot, 'rayfin', '.env.custom'),
      'RAYFIN_FEATURE_FLAGS=\n'
    );
    await runDevV2(projectRoot, {
      output: 'json',
      envFile: 'rayfin/.env.custom',
    });
    expect(mockCreateDevDeps).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          services: expect.objectContaining({
            functions: expect.objectContaining({
              auth: { type: 'application' },
            }),
          }),
        }),
      })
    );
  });

  it.each([
    { enabled: true, auth: 'auth:\n      type: application' },
    { enabled: false, auth: '' },
  ])('allows Fabric dev without opt-in for %j', async ({ enabled, auth }) => {
    writeFileSync(
      join(projectRoot, 'rayfin', 'rayfin.yml'),
      `id: test-project\nservices:\n  functions:\n    enabled: ${enabled}\n    ${auth}\n`
    );
    await runDevV2(projectRoot, { output: 'json' });
    expect(mockCreateDevDeps).toHaveBeenCalledOnce();
    expect(mockRunDevWorkflow).toHaveBeenCalledOnce();
  });

  it.each(['', 'auth: {}'])(
    'requires explicit auth for enabled Functions: %s',
    async (auth) => {
      writeFileSync(
        join(projectRoot, 'rayfin', 'rayfin.yml'),
        `id: test-project\nservices:\n  functions:\n    enabled: true\n    ${auth}\n`
      );
      await expect(runDevV2(projectRoot, { output: 'json' })).rejects.toThrow(
        'Set services.functions.auth.type to "application".'
      );
      expect(mockCreateDevDeps).not.toHaveBeenCalled();
      expect(mockRunDevWorkflow).not.toHaveBeenCalled();
      expect(stdoutWrites).toHaveLength(1);
      expect(JSON.parse(stdoutWrites[0]).code).toBe('invalid-functions-config');
    }
  );

  it.each([
    'auth: null',
    'auth: application',
    'auth: []',
    'auth:\n      type: unknown',
  ])(
    'rejects malformed Functions auth before Fabric deps: %s',
    async (auth) => {
      writeFileSync(
        join(projectRoot, 'rayfin', 'rayfin.yml'),
        `id: test-project\nservices:\n  functions:\n    enabled: false\n    ${auth}\n`
      );
      await expect(runDevV2(projectRoot, { output: 'json' })).rejects.toThrow();
      expect(mockCreateDevDeps).not.toHaveBeenCalled();
      expect(mockRunDevWorkflow).not.toHaveBeenCalled();
      expect(stdoutWrites).toHaveLength(1);
      expect(JSON.parse(stdoutWrites[0]).code).toBe('invalid-functions-config');
    }
  );

  it.each([
    'enabled: true\n    auth: { type: application }',
    'enabled: false\n    auth: { type: application }',
    'enabled: false',
  ])('preserves login-free Docker emulation for %s', async (functions) => {
    process.env.RAYFIN_FEATURE_FLAGS = 'docker-local-dev';
    writeFileSync(
      join(projectRoot, 'rayfin', 'rayfin.yml'),
      `id: test-project\nservices:\n  functions:\n    ${functions}\n`
    );
    await runDevV2(projectRoot, { output: 'json', provider: 'docker' });
    expect(mockCreateDevDeps).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'docker',
      })
    );
    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
  });

  it.each([
    'enabled: true',
    'enabled: true\n    auth: {}',
    'enabled: true\n    auth: { type: delegated }',
    'enabled: false\n    auth: { type: delegated }',
    'enabled: false\n    auth: null',
    'enabled: false\n    auth: []',
    'enabled: true\n    auth: { type: Application }',
  ])(
    'rejects invalid Docker Functions before login or runtime preparation: %s',
    async (functions) => {
      process.env.RAYFIN_FEATURE_FLAGS =
        'docker-local-dev,functions-application-auth';
      writeFileSync(
        join(projectRoot, 'rayfin', 'rayfin.yml'),
        `id: test-project\nservices:\n  functions:\n    ${functions}\n`
      );

      await expect(
        runDevV2(projectRoot, { output: 'json', provider: 'docker' })
      ).rejects.toThrow('Set services.functions.auth.type to "application".');

      expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
      expect(mockCreateDevDeps).not.toHaveBeenCalled();
      expect(mockRunDevWorkflow).not.toHaveBeenCalled();
      expect(mockCliCommandRunner.run).not.toHaveBeenCalled();
      expect(stdoutWrites).toHaveLength(1);
      expect(JSON.parse(stdoutWrites[0])).toMatchObject({
        status: 'error',
        code: 'invalid-functions-config',
      });
    }
  );

  it('forwards skipDataApply to the workflow request', async () => {
    await runDevV2(projectRoot, {
      output: 'json',
      skipDataApply: true,
    });

    expect(mockRunDevWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ skipDataApply: true }),
      expect.anything()
    );
  });

  it('runs license checks for Fabric', async () => {
    await runDevV2(projectRoot, { output: 'json' });

    expect(createCliUserLicenseService).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'fabric',
        session: expect.objectContaining({ token: 'fabric-token' }),
        notify: expect.any(Function),
      })
    );
    expect(mockRunEnsureUserLicenseWorkflow).toHaveBeenCalledOnce();
    expect(
      mockRunEnsureUserLicenseWorkflow.mock.invocationCallOrder[0]
    ).toBeLessThan(mockCreateDevDeps.mock.invocationCallOrder[0]);
  });

  it('runs Fabric readiness for the Fabric provider', async () => {
    await runDevV2(projectRoot, {
      output: 'json',
      yes: true,
    });

    expect(mockCreateDevDeps).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'fabric',
        abortSignal: expect.any(AbortSignal),
        cancellationToken: expect.objectContaining({
          isCancellationRequested: false,
        }),
        ui: undefined,
      })
    );
  });

  it('does not construct Fabric readiness for the Docker provider', async () => {
    process.env.RAYFIN_FEATURE_FLAGS = 'docker-local-dev';

    await runDevV2(projectRoot, {
      output: 'json',
      provider: 'docker',
      yes: true,
    });

    expect(mockCreateDevDeps).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'docker',
      })
    );
  });

  it('serializes retained readiness resources when dev readiness fails', async () => {
    const notice = {
      kind: 'workspace-created' as const,
      workspaceId: 'retained-workspace',
      workspaceName: 'Retained Workspace',
    };
    mockRunDevWorkflow.mockImplementationOnce(async () => {
      mockCreateDevDeps.mock.calls[0][0].onReadinessNotice?.(notice);
      return {
        status: 'failed',
        error: {
          code: 'fabric-readiness:workspace_assignment_failed',
          message: 'Fabric workspace capacity assignment failed.',
        },
      };
    });

    await expect(
      runDevV2(projectRoot, { output: 'json', yes: true })
    ).rejects.toThrow('Fabric workspace capacity assignment failed.');

    expect(JSON.parse(stdoutWrites[0])).toMatchObject({
      status: 'error',
      code: 'fabric-readiness:workspace_assignment_failed',
      hint: expect.stringContaining('`rayfin dev`'),
      notices: [notice],
    });
  });

  it('does not use plain progress for an interactive license preflight', async () => {
    const originalIsTty = Object.getOwnPropertyDescriptor(
      process.stdin,
      'isTTY'
    );
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });

    try {
      await runDevV2(projectRoot, { output: 'interactive' });

      const licenseProgress =
        mockRunEnsureUserLicenseWorkflow.mock.calls[0][1].progress;
      const devProgress = mockCreateDevDeps.mock.calls[0][0].progress;
      expect(licenseProgress).toBe(devProgress);
      expect(stderrWrites).not.toContain(
        '[rayfin] license: Checking user license\n'
      );
    } finally {
      if (originalIsTty) {
        Object.defineProperty(process.stdin, 'isTTY', originalIsTty);
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
    }
  });

  it('uses one tenant-aware session for licensing and Fabric dependencies', async () => {
    await runDevV2(projectRoot, {
      output: 'json',
      tenant: 'tenant-requested',
      encryptionFallbackEnabled: true,
    });

    expect(mockEnsureAuthenticated).toHaveBeenCalledOnce();
    expect(mockEnsureAuthenticated).toHaveBeenCalledWith(undefined, {
      tenantId: 'tenant-requested',
      encryptionFallbackEnabled: true,
    });
    expect(createCliUserLicenseService).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ token: 'fabric-token' }),
      })
    );
    expect(mockCreateDevDeps).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ token: 'fabric-token' }),
      })
    );
  });

  it('uses the same license workflow surface for non-Fabric providers', async () => {
    process.env.RAYFIN_FEATURE_FLAGS = 'docker-local-dev';

    await runDevV2(projectRoot, { output: 'json', provider: 'docker' });

    expect(createCliUserLicenseService).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'docker', session: undefined })
    );
    expect(mockRunEnsureUserLicenseWorkflow).toHaveBeenCalledOnce();
    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
  });

  it('stops before dependency creation when the license preflight fails', async () => {
    mockRunEnsureUserLicenseWorkflow.mockResolvedValueOnce({
      status: 'failed',
      error: {
        code: 'fabric_license_enrollment_required',
        message:
          'A Fabric license is required. Rerun this command interactively to open Fabric license setup.',
      },
    });

    await expect(runDevV2(projectRoot, { output: 'json' })).rejects.toThrow(
      'A Fabric license is required'
    );

    expect(mockCreateDevDeps).not.toHaveBeenCalled();
    expect(mockRunDevWorkflow).not.toHaveBeenCalled();
  });

  it('forwards --yes as same-name backend reuse consent without prompting', async () => {
    await runDevV2(projectRoot, { output: 'plain', yes: true });

    expect(mockCreateDevDeps).toHaveBeenCalledWith(
      expect.objectContaining({
        autoConfirmReuse: true,
        ui: undefined,
      })
    );
  });

  it('forwards the explicit capacity ID to the Fabric provider', async () => {
    await runDevV2(projectRoot, {
      output: 'json',
      capacityId: '11111111-1111-4111-8111-111111111111',
    });

    expect(mockCreateDevDeps).toHaveBeenCalledWith(
      expect.objectContaining({
        capacityId: '11111111-1111-4111-8111-111111111111',
        autoConfirmReuse: false,
        ui: undefined,
      })
    );
  });

  it('never provides interactive reuse confirmation in JSON mode', async () => {
    await runDevV2(projectRoot, { output: 'json' });

    expect(mockCreateDevDeps).toHaveBeenCalledWith(
      expect.objectContaining({
        autoConfirmReuse: false,
        ui: undefined,
      })
    );
    expect(cliUserInteraction.confirm).not.toHaveBeenCalled();
  });

  it('removes the SIGINT listener when dependency creation fails', async () => {
    const initialListenerCount = process.listenerCount('SIGINT');
    mockCreateDevDeps.mockRejectedValueOnce(new Error('Authentication failed'));

    await expect(runDevV2(projectRoot, { output: 'json' })).rejects.toThrow(
      'Authentication failed'
    );

    expect(process.listenerCount('SIGINT')).toBe(initialListenerCount);
  });

  it('routes plain-mode child output to stderr', async () => {
    const originalIsTty = Object.getOwnPropertyDescriptor(
      process.stdin,
      'isTTY'
    );
    const originalCi = process.env.CI;
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });
    delete process.env.CI;

    try {
      await runDevV2(projectRoot, { output: 'plain' });

      const runner = mockCreateDevDeps.mock.calls[0][0].runner;
      if (!runner) throw new Error('Expected a streaming runner');
      await runner.run('func', [], { inheritStdio: true });
      const runOptions = mockCliCommandRunner.run.mock.calls[0][2];
      runOptions?.onStdout?.('functions log\n');

      expect(runOptions).toEqual(
        expect.objectContaining({ inheritStdio: false })
      );
      expect(stdoutWrites).toEqual([]);
      expect(stderrWrites).toContain('functions log\n');
    } finally {
      if (originalIsTty) {
        Object.defineProperty(process.stdin, 'isTTY', originalIsTty);
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
      if (originalCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = originalCi;
      }
    }
  });

  it.each(['func', 'npm'])(
    'preserves interactive input for %s while capturing Functions output',
    async (command) => {
      const originalIsTty = Object.getOwnPropertyDescriptor(
        process.stdin,
        'isTTY'
      );
      const originalCi = process.env.CI;
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: true,
      });
      delete process.env.CI;
      vi.spyOn(console, 'log').mockImplementation(() => {});

      try {
        await runDevV2(projectRoot, { output: 'interactive' });

        const runner = mockCreateDevDeps.mock.calls[0][0].runner;
        if (!runner) throw new Error('Expected a streaming runner');
        await runner.run(command, [], { inheritStdio: true });

        expect(mockCliCommandRunner.run).toHaveBeenCalledWith(
          command,
          [],
          expect.objectContaining(
            command === 'func'
              ? {
                  inheritStdio: false,
                  inheritStdin: true,
                  captureOutput: false,
                }
              : { inheritStdio: true }
          )
        );
      } finally {
        if (originalIsTty) {
          Object.defineProperty(process.stdin, 'isTTY', originalIsTty);
        } else {
          delete (process.stdin as { isTTY?: boolean }).isTTY;
        }
        if (originalCi === undefined) {
          delete process.env.CI;
        } else {
          process.env.CI = originalCi;
        }
      }
    }
  );

  it('keeps runtime stdio piped in JSON mode', async () => {
    await runDevV2(projectRoot, { output: 'json' });

    const runner = mockCreateDevDeps.mock.calls[0][0].runner;
    if (!runner) throw new Error('Expected a streaming runner');
    await runner.run('func', [], { inheritStdio: true });

    expect(mockCliCommandRunner.run).toHaveBeenCalledWith(
      'func',
      [],
      expect.objectContaining({ inheritStdio: false })
    );
  });

  it('keeps functions-build detail out of JSON terminal output', async () => {
    await runDevV2(projectRoot, { output: 'json' });

    const options = mockCreateDevDeps.mock.calls[0][0];
    options.onBuildStdout?.('build log\n');
    options.onBuildStderr?.('build warning\n');

    expect(stdoutWrites).toHaveLength(1);
    expect(() => JSON.parse(stdoutWrites[0])).not.toThrow();
    expect(stderrWrites).toEqual([]);
  });

  it.each([
    ['interactive', false],
    ['plain', false],
    ['json', false],
    ['interactive', true],
    ['plain', true],
  ] as const)(
    'persists Functions host detail with quiet %s output and verbose=%s',
    async (output, verbose) => {
      await useFileSession();
      mockCliCommandRunner.run.mockImplementationOnce(
        async (_command, _args, options) => {
          options?.onStdout?.(
            '[2026-09-21T00:00:00.000Z] Building host: version spec: details\n'
          );
          options?.onStdout?.(
            'Functions:\n    hello: [GET] http://localhost:7073/api/hello\n'
          );
          options?.onStdout?.('Application log\n');
          return { launched: true, exitCode: 0, stdout: '', stderr: '' };
        }
      );
      mockRunDevWorkflow.mockImplementationOnce(async () => {
        await mockCreateDevDeps.mock.calls[0][0].runner?.run(
          'func',
          ['start'],
          { inheritStdio: true }
        );
        return { status: 'cancelled' };
      });
      await expect(
        runDevV2(projectRoot, { output, verbose })
      ).rejects.toThrow();
      const session = await vi.mocked(createCliDiagnosticSession).mock
        .results[0].value;
      const log = readFileSync(session.logPath, 'utf8');
      expect(log).toContain('Building host');
      expect(log).toContain('Application log');
      const terminal = [...stdoutWrites, ...stderrWrites].join('');
      expect(terminal.includes('Building host')).toBe(verbose);
      expect(terminal.includes('http://localhost:7073/api/hello')).toBe(
        output !== 'json'
      );
      expect(terminal.match(/Application log/g) ?? []).toHaveLength(
        output === 'json' ? 0 : 1
      );
      if (output === 'json') {
        expect(stdoutWrites).toHaveLength(1);
        expect(JSON.parse(stdoutWrites[0])).toMatchObject({
          status: 'cancelled',
        });
      }
    }
  );

  it('renders a recovery hint for an unsupported provider', async () => {
    await expect(
      runDevV2(projectRoot, { output: 'plain', provider: 'unknown' })
    ).rejects.toThrow('Unknown provider: unknown');

    expect(errorWrites).toContain(
      '   Use `--provider fabric` or `--provider docker`.'
    );
  });

  it('rejects the Docker provider when docker-local-dev is unavailable', async () => {
    await expect(
      runDevV2(projectRoot, { output: 'plain', provider: 'docker' })
    ).rejects.toThrow('The `docker` provider is not available yet.');

    expect(mockCreateDevDeps).not.toHaveBeenCalled();
    expect(errorWrites).toContain(
      '   Enable `docker-local-dev`, or use `--provider fabric` to run against your deployed Fabric backend.'
    );
  });

  it('selects the Docker provider when docker-local-dev is enabled', async () => {
    process.env.RAYFIN_FEATURE_FLAGS = 'docker-local-dev';

    await runDevV2(projectRoot, { output: 'json', provider: 'docker' });

    expect(mockCreateDevDeps).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'docker' })
    );
    expect(mockRunDevWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'docker' }),
      expect.anything()
    );
  });

  it.each([true, false])(
    'composes dependencies from functions enabled=%s configuration',
    async (enabled) => {
      writeFileSync(
        join(projectRoot, 'rayfin', 'rayfin.yml'),
        `id: test-project\nservices:\n  functions:\n    enabled: ${enabled}\n    auth:\n      type: application\n`
      );

      await runDevV2(projectRoot, { output: 'json' });

      expect(mockCreateDevDeps).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            services: expect.objectContaining({
              functions: expect.objectContaining({ enabled }),
            }),
          }),
        })
      );
      expect(mockRunDevWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            services: expect.objectContaining({
              functions: expect.objectContaining({ enabled }),
            }),
          }),
        }),
        expect.anything()
      );
    }
  );

  it('maps known workflow failures to targeted recovery hints', async () => {
    mockRunDevWorkflow.mockResolvedValueOnce({
      status: 'failed',
      error: {
        code: 'fabric-provisioning-failed',
        message: 'Could not provision the Fabric backend.',
      },
    });

    await expect(runDevV2(projectRoot, { output: 'plain' })).rejects.toThrow(
      'Could not provision the Fabric backend'
    );

    expect(errorWrites).toContain(
      '   Set `RAYFIN_WORKSPACE_ID` to an accessible workspace, or run `rayfin up --workspace <name>` once to record another target, then retry `rayfin dev`.'
    );
  });

  it('renders dev-specific guidance when same-name reuse needs consent', async () => {
    mockRunDevWorkflow.mockResolvedValueOnce({
      status: 'failed',
      error: {
        code: 'fabric-item-reuse-required',
        message: 'A same-named Fabric backend already exists.',
      },
    });

    await expect(runDevV2(projectRoot, { output: 'plain' })).rejects.toThrow(
      'A same-named Fabric backend already exists.'
    );

    expect(errorWrites).toContain(
      '   Pass `--yes` to reuse that backend, change `id` in `rayfin/rayfin.yml`, or set `RAYFIN_WORKSPACE_ID` to target another workspace.'
    );
  });

  it('carries the recovery hint in the JSON error payload', async () => {
    mockRunDevWorkflow.mockResolvedValueOnce({
      status: 'failed',
      error: {
        code: 'fabric-item-reuse-required',
        message: 'A same-named Fabric backend already exists.',
      },
    });

    await expect(runDevV2(projectRoot, { output: 'json' })).rejects.toThrow(
      'A same-named Fabric backend already exists.'
    );

    expect(stdoutWrites).toHaveLength(1);
    expect(JSON.parse(stdoutWrites[0])).toEqual({
      status: 'error',
      error: 'A same-named Fabric backend already exists.',
      code: 'fabric-item-reuse-required',
      hint: 'Pass `--yes` to reuse that backend, change `id` in `rayfin/rayfin.yml`, or set `RAYFIN_WORKSPACE_ID` to target another workspace.',
    });
  });

  it('renders cancellation warnings in plain output', async () => {
    const warningWrites: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args) => {
      warningWrites.push(args.map(String).join(' '));
    });
    mockRunDevWorkflow.mockResolvedValueOnce({
      status: 'cancelled',
      warnings: ['Runtime failure during shutdown: func exited.'],
    });

    await expect(runDevV2(projectRoot, { output: 'plain' })).rejects.toThrow(
      'Operation cancelled by user'
    );

    expect(warningWrites).toContain(
      '⚠️  Runtime failure during shutdown: func exited.'
    );
  });

  it('includes cancellation warnings in the single JSON payload', async () => {
    mockRunDevWorkflow.mockResolvedValueOnce({
      status: 'cancelled',
      warnings: ['Runtime failure during shutdown: func exited.'],
    });

    await expect(runDevV2(projectRoot, { output: 'json' })).rejects.toThrow(
      'Operation cancelled by user'
    );

    expect(stdoutWrites).toHaveLength(1);
    expect(JSON.parse(stdoutWrites[0])).toEqual({
      status: 'cancelled',
      warnings: ['Runtime failure during shutdown: func exited.'],
    });
  });

  it.each([
    [
      'functions-node-unsupported',
      'Upgrade Node.js to a supported version, then retry `rayfin dev`.',
    ],
    [
      'functions-core-tools-missing',
      'Run `rayfin dev functions apply` once to install Azure Functions Core Tools with consent, then retry `rayfin dev`.',
    ],
    [
      'functions-path-invalid',
      'Fix `services.functions.path` in `rayfin/rayfin.yml`, then retry `rayfin dev`.',
    ],
    [
      'functions-port-unavailable',
      'Stop the process holding the reported functions port range, then retry `rayfin dev`.',
    ],
    [
      'functions-inspector-port-unavailable',
      'Stop the process holding the reported inspector port range, then retry `rayfin dev`.',
    ],
    [
      'functions-state-missing',
      'Restart `rayfin dev`; if the issue persists, report the failed functions reservation.',
    ],
    [
      'functions-build-failed',
      'Fix the functions build error above, then retry `rayfin dev`.',
    ],
    [
      'runtime-launch-failed',
      'Check that the reported runtime command is installed and runnable, then retry `rayfin dev`.',
    ],
    [
      'runtime-exited',
      'Check the runtime output above, then retry `rayfin dev`.',
    ],
    [
      'frontend-script-recursive',
      'Add a non-recursive `dev:frontend` script (for example, `"dev:frontend": "vite"`), then retry `rayfin dev`.',
    ],
    [
      'fabric-backend-setup-failed',
      'The backend already exists; retry with `--yes` to reuse it, and verify the workload is accessible if setup still fails.',
    ],
    [
      'fabric-backend-record-failed',
      'Resolve the reported local registry write issue, then retry with `--yes` to reuse and record the existing backend.',
    ],
    [
      'fabric-provisioning-consent-required',
      'Run `rayfin dev` in an interactive terminal, pass `--yes`, or pass `--capacity-id <id>` to create the workspace and backend without prompting.',
    ],
    [
      'fabric-workspace-required',
      'Pass `--workspace <name>` or `--workspace-id <id>`, set `RAYFIN_WORKSPACE_ID`, or run `rayfin dev` in an interactive terminal to pick one.',
    ],
    [
      'fabric-capacity-exhausted',
      'You must pass a valid workspace ID with `--workspace-id <id>` or a valid capacity ID with `--capacity-id <id>` to complete deployment.',
    ],
  ])('maps %s to an actionable recovery hint', async (code, hint) => {
    mockRunDevWorkflow.mockResolvedValueOnce({
      status: 'failed',
      error: { code, message: 'Functions runtime failed.' },
    });

    await expect(runDevV2(projectRoot, { output: 'plain' })).rejects.toThrow(
      'Functions runtime failed.'
    );

    expect(errorWrites).toContain(`   ${hint}`);
  });
});
