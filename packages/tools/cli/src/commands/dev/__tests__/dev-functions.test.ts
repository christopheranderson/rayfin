/**
 * Tests for `rayfin dev functions apply` gates and owned runtime lifecycle.
 */

import type {
  RunOptions,
  RunResult,
} from '@microsoft/rayfin-tools-common/_internal/adapters';
import { InvocationContext } from '@microsoft/rayfin-tools-common/_internal/telemetry';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cliCommandRunner } from '../../../adapters/runner.js';
import { createCliDiagnosticSession } from '../../../diagnostics/session.js';
import {
  CliCancelledError,
  CliHandledError,
  classifyCliError,
} from '../../../errors.js';
import {
  FUNCTIONS_BUILD_WATCH_WARNING,
  createLocalFunctionsRuntimeService,
  runFunctionsBuild,
} from '../../../local-services/dev/functions-runtime.js';
import {
  getCurrentContext,
  setCurrentContext,
} from '../../../telemetry/context-store.js';
import {
  installCommanderHooks,
  markCurrentContextCancelled,
  markCurrentContextFailure,
} from '../../../telemetry/index.js';
import {
  modeError,
  modeWarn,
  resolveCommandFlags,
} from '../../../utils/output-mode.js';

vi.mock('../../../utils/version.js', () => ({
  getVersionString: () => 'test',
  getPackageVersion: () => 'test',
}));

vi.mock('../../../diagnostics/session.js', () => ({
  createCliDiagnosticSession: vi.fn(),
}));

vi.mock('../../../adapters/runner.js', () => ({
  cliCommandRunner: { run: vi.fn() },
}));

vi.mock(
  '../../../local-services/dev/functions-runtime.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../local-services/dev/functions-runtime.js')
      >();
    const runtime = {
      findAvailablePort: vi.fn(),
      upsertLocalSettings: vi.fn(),
      resolveCorsOrigins: vi.fn(),
      createBuildWatcher: vi.fn(),
      startTypegen: vi.fn(),
      ensureDebuggerConfig: vi.fn(),
    };
    return {
      ...actual,
      createLocalFunctionsRuntimeService: () => runtime,
      runFunctionsBuild: vi.fn(),
    };
  }
);

vi.mock('../../../utils/patch-client-for-functions.js', () => ({
  patchClientForFunctions: vi.fn(async () => ({ patched: false })),
}));

vi.mock('../../../utils/output-mode.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/output-mode.js')>()),
  resolveOutputMode: vi.fn(() => 'plain'),
  resolveCommandFlags: vi.fn(),
  modeLog: vi.fn(),
  modeWarn: vi.fn(),
  modeError: vi.fn(),
}));

// Common mock targets. Each test re-imports the SUT after configuring
// these so vitest's ESM mock resolution picks up the per-test setup.
vi.mock('../../../auth/index.js', () => ({
  ensureAuthenticated: vi.fn(),
}));

vi.mock('../../../utils/project-utils.js', () => ({
  findRayfinProjectRoot: vi.fn(() => '/fake/project/root'),
}));

vi.mock('../../../utils/config-utils.js', () => ({
  loadRayfinConfig: vi.fn(),
  readSecretNames: vi.fn(() => []),
  resolveServicePath: vi.fn((projectRoot: string, servicePath?: string) =>
    servicePath ? `${projectRoot}/${servicePath}` : projectRoot
  ),
  resolveServiceRoot: vi.fn(
    (projectRoot: string, _serviceName: string, servicePath?: string) =>
      servicePath ? `${projectRoot}/${servicePath}` : projectRoot
  ),
  validateServicePath: vi.fn(
    (projectRoot: string, _serviceName: string, servicePath?: string) =>
      servicePath ? `${projectRoot}/${servicePath}` : projectRoot
  ),
}));

// The pre-build secrets registry generation touches the real filesystem and is
// covered by its own tests; stub it so it cannot emit an extra warning here.
vi.mock('../../../utils/secrets-types-generator.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../utils/secrets-types-generator.js')
    >();
  return {
    ...actual,
    ensureSecretsTypes: vi.fn(),
  };
});

vi.mock('../../../utils/deployments-registry.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../utils/deployments-registry.js')
  >()),
  // Only the registry read is stubbed. `isDeployedRecord` is a pure predicate
  // over the record the stub returns, so the real one is used — a stubbed
  // version would let a placeholder record pass and hide the case these
  // tests exist to pin.
  getActiveDeployment: vi.fn(),
}));

vi.mock('../../../utils/functions-prereqs.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../utils/functions-prereqs.js')
  >()),
  inspectFunctionsPrereqs: vi.fn(() => ({
    node: {
      name: 'Node.js',
      command: 'node',
      version: 'v20.0.0',
      minimumMajor: 20,
      ok: true,
    },
    funcCoreTools: {
      name: 'Azure Functions Core Tools',
      command: 'func',
      version: '4.0.6280',
      ok: true,
    },
  })),
  planFunctionsInstall: vi.fn(() => []),
  formatPrereqsReport: vi.fn(
    () => '  ✅ Node.js v20.0.0\n  ✅ Azure Functions Core Tools 4.0.6280'
  ),
  promptAndInstall: vi.fn(() => Promise.resolve(true)),
  refreshPathFromOs: vi.fn(),
}));

vi.mock('../../../utils/publishable-key-utils.js', () => ({
  getPublishableKey: vi.fn(),
}));

vi.mock('../../../utils/env-file-utils.js', () => ({
  upsertEnvVariables: vi.fn(),
}));

vi.mock('../../env/env.js', () => ({
  writeFrameworkEnvFile: vi.fn(),
}));

vi.mock('../../../utils/frontend-detect.js', () => ({
  detectFrontendFramework: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(() =>
    Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
  ),
  writeFile: vi.fn(() => Promise.resolve()),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
}));

vi.mock('../../../config/constants.js', () => ({
  getFabricSettings: vi.fn(() => ({
    fabricApiBaseUrl: 'https://api.fabric.test',
  })),
  MONIKER_HEADER: 'x-ms-workload-resource-moniker',
}));

let processExitSpy: any;
let consoleErrorSpy: any;
let consoleLogSpy: any;
let stdoutWrites: string[];
let restoreStdout: () => void;

beforeEach(() => {
  vi.clearAllMocks();
  stdoutWrites = [];
  const stdout = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
  restoreStdout = () => stdout.mockRestore();
  vi.mocked(resolveCommandFlags).mockReturnValue({
    mode: 'plain',
    verbose: false,
    json: false,
    yes: false,
  });
  vi.mocked(createCliDiagnosticSession).mockResolvedValue({
    diagnostics: { debug: vi.fn() },
    close: vi.fn().mockResolvedValue(undefined),
  });
  // `process.exit` throws a labelled error so the SUT's `process.exit(1)`
  // can be caught and the test asserts on the call rather than letting the
  // exit propagate and kill the worker.
  processExitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`__exit__:${code}`);
    });
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  setCurrentContext(undefined);
  processExitSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  consoleLogSpy.mockRestore();
  restoreStdout();
});

async function runApply(argv = ['dev', 'functions', 'apply']): Promise<void> {
  const { devFunctionsCommand } = await import('../dev-functions.js');
  for (const flag of ['verbose', 'json', 'yes'])
    devFunctionsCommand.commands[0].setOptionValue(flag, false);
  const program = new Command('rayfin')
    .option('--verbose', 'Show detailed output')
    .option('--json', 'Output JSON')
    .option('--output <mode>', 'Output mode');
  program.command('dev').addCommand(devFunctionsCommand);
  installCommanderHooks(program);
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('__exit__:')) {
      throw err;
    }
  }
}

describe('rayfin dev functions apply — feature-gate', () => {
  it('refuses to run when services.functions.enabled is false', async () => {
    const { loadRayfinConfig } = await import('../../../utils/config-utils.js');
    (loadRayfinConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      services: { functions: { enabled: false } },
    });

    await expect(runApply()).rejects.toThrow(
      'Functions service is not enabled'
    );
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('refuses to run when functions config is entirely missing', async () => {
    const { loadRayfinConfig } = await import('../../../utils/config-utils.js');
    (loadRayfinConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      services: {},
    });

    await expect(runApply()).rejects.toThrow(
      'Functions service is not enabled'
    );
    expect(processExitSpy).not.toHaveBeenCalled();
  });
});

describe('rayfin dev functions apply — deployment gate', () => {
  beforeEach(async () => {
    // Functions are enabled, prereqs pass — the only remaining gate
    // should be the active-deployment check.
    const { loadRayfinConfig } = await import('../../../utils/config-utils.js');
    (loadRayfinConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      services: { functions: { enabled: true } },
    });
  });

  describe('rayfin dev functions apply — compiler supervision', () => {
    const runtime = createLocalFunctionsRuntimeService();
    const close = vi.fn();
    const functionsDir = '/fake/project/root/packages/custom functions';
    let originalExitCode: typeof process.exitCode;
    let sigintListeners: number;
    let sigtermListeners: number;

    function untilCancelled(options?: RunOptions): Promise<RunResult> {
      return new Promise((resolve) => {
        options?.signal?.onCancellationRequested(() =>
          resolve({
            launched: true,
            cancelled: true,
            exitCode: 0,
            stdout: '',
            stderr: '',
          })
        );
      });
    }

    beforeEach(async () => {
      originalExitCode = process.exitCode;
      process.exitCode = undefined;
      sigintListeners = process.listenerCount('SIGINT');
      sigtermListeners = process.listenerCount('SIGTERM');
      const { loadRayfinConfig } =
        await import('../../../utils/config-utils.js');
      vi.mocked(loadRayfinConfig).mockReturnValue({
        services: {
          functions: {
            enabled: true,
            path: 'packages/custom functions',
            buildCommand: 'custom-build && copy-assets',
          },
        },
      } as ReturnType<typeof loadRayfinConfig>);
      const { planFunctionsInstall } =
        await import('../../../utils/functions-prereqs.js');
      vi.mocked(planFunctionsInstall).mockReturnValue([]);
      const { getActiveDeployment } =
        await import('../../../utils/deployments-registry.js');
      vi.mocked(getActiveDeployment).mockReturnValue({
        record: {
          workspaceId: 'workspace',
          itemId: 'item',
          apiUrl: 'https://backend.example',
        },
      } as ReturnType<typeof getActiveDeployment>);
      const { ensureAuthenticated } = await import('../../../auth/index.js');
      vi.mocked(ensureAuthenticated).mockResolvedValue({
        token: 'test',
        identityType: 'user',
        expiresOnTimestamp: Date.now() + 60_000,
      });
      vi.mocked(runFunctionsBuild).mockResolvedValue(undefined);
      vi.mocked(runtime.findAvailablePort).mockResolvedValue({
        port: 7071,
        searched: { from: 7071, to: 7071 },
      });
      vi.mocked(runtime.resolveCorsOrigins).mockReturnValue([
        'http://localhost:5173',
      ]);
      vi.mocked(runtime.createBuildWatcher).mockResolvedValue({
        id: 'functions-build',
        label: 'functions compiler watcher',
        command: 'npm',
        args: ['run', 'build:watch'],
        cwd: functionsDir,
        required: true,
        inheritStdio: true,
      });
      vi.mocked(runtime.startTypegen).mockResolvedValue({ close });
      vi.mocked(runtime.ensureDebuggerConfig).mockResolvedValue({
        status: 'not-ready',
      });
      vi.mocked(cliCommandRunner.run).mockImplementation(
        (_command, _args, options) => untilCancelled(options)
      );
    });

    afterEach(() => {
      expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
      expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
      process.exitCode = originalExitCode;
    });

    it('runs both processes from the configured package and cleans up on host exit', async () => {
      vi.mocked(cliCommandRunner.run).mockImplementation(
        (command, _args, options) =>
          command === 'func'
            ? Promise.resolve({
                launched: true,
                exitCode: 0,
                stdout: '',
                stderr: '',
              })
            : untilCancelled(options)
      );
      await runApply();
      expect(runFunctionsBuild).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'custom-build && copy-assets',
          cwd: functionsDir,
        })
      );
      expect(
        vi.mocked(runFunctionsBuild).mock.invocationCallOrder[0]
      ).toBeLessThan(
        vi.mocked(runtime.createBuildWatcher).mock.invocationCallOrder[0]
      );
      expect(runtime.createBuildWatcher).toHaveBeenCalledWith(functionsDir);
      expect(cliCommandRunner.run).toHaveBeenCalledWith(
        'npm',
        ['run', 'build:watch'],
        expect.objectContaining({ cwd: functionsDir })
      );
      expect(cliCommandRunner.run).toHaveBeenCalledWith(
        'func',
        ['start', '--port', '7071', '--cors', 'http://localhost:5173'],
        expect.objectContaining({ cwd: functionsDir })
      );
      expect(close).toHaveBeenCalledOnce();
      expect(process.exitCode).toBeUndefined();
    });

    it.each([
      ['plain', false],
      ['interactive', false],
      ['json', false],
      ['plain', true],
    ] as const)(
      'captures Functions detail in %s with verbose=%s',
      async (mode, verbose) => {
        vi.mocked(resolveCommandFlags).mockReturnValue({
          mode,
          verbose,
          json: mode === 'json',
          yes: true,
        });
        const writes: string[] = [];
        const stderr = vi
          .spyOn(process.stderr, 'write')
          .mockImplementation((chunk) => {
            writes.push(String(chunk));
            return true;
          });
        vi.mocked(runFunctionsBuild).mockImplementation(
          async ({ onStdout, onStderr }) => {
            onStdout?.('build detail\n');
            onStderr?.('build trailing detail');
          }
        );
        vi.mocked(cliCommandRunner.run).mockImplementation(
          (command, _args, options) => {
            if (command !== 'func') return untilCancelled(options);
            options?.onStdout?.(
              '[2026-09-21T00:00:00.000Z] Building host: version spec: detail\n'
            );
            options?.onStdout?.(
              'Functions:\nhello: [GET] http://localhost:7071/api/hello\nApplication log\n'
            );
            options?.onStderr?.('Application stderr\n');
            return Promise.resolve({
              launched: true,
              exitCode: 0,
              stdout: '',
              stderr: '',
            });
          }
        );
        try {
          await runApply();
          const session = await vi.mocked(createCliDiagnosticSession).mock
            .results[0].value;
          const debug = vi.mocked(session.diagnostics.debug);
          expect(JSON.stringify(debug.mock.calls)).toContain('Building host');
          expect(JSON.stringify(debug.mock.calls)).toContain(
            'build trailing detail'
          );
          expect(writes.join('')).not.toContain('Building host');
          expect(writes.join('').includes('Application log')).toBe(
            mode === 'plain' && !verbose
          );
          expect(stdoutWrites.join('').includes('Application log')).toBe(
            mode === 'interactive' && !verbose
          );
          expect(writes.join('').includes('Application stderr')).toBe(
            mode !== 'json' && !verbose
          );
          expect([...writes, ...stdoutWrites].join('')).not.toContain(
            'build detail'
          );
          expect(session.close).toHaveBeenCalledExactlyOnceWith({
            status: 'success',
            exitCode: 0,
          });
          expect(close.mock.invocationCallOrder[0]).toBeLessThan(
            vi.mocked(session.close).mock.invocationCallOrder[0]
          );
          if (mode === 'json') {
            expect(stdoutWrites).toHaveLength(1);
            expect(JSON.parse(stdoutWrites[0])).toEqual({
              status: 'success',
              functionsUrl: 'http://localhost:7071',
            });
          }
        } finally {
          stderr.mockRestore();
        }
      }
    );

    it.each([
      ['--verbose', 'dev', 'functions', 'apply'],
      ['dev', 'functions', 'apply', '--verbose'],
    ])('honors verbosity flag placement: %j', async (...argv) => {
      const actual = await vi.importActual<
        typeof import('../../../utils/output-mode.js')
      >('../../../utils/output-mode.js');
      vi.mocked(resolveCommandFlags).mockImplementationOnce(
        actual.resolveCommandFlags
      );
      vi.mocked(cliCommandRunner.run).mockImplementation(
        (command, _args, options) =>
          command === 'func'
            ? Promise.resolve({
                launched: true,
                exitCode: 0,
                stdout: '',
                stderr: '',
              })
            : untilCancelled(options)
      );
      await runApply(argv);
      expect(createCliDiagnosticSession).toHaveBeenCalledWith(
        expect.objectContaining({ mirror: expect.any(Function) })
      );
    });

    it('rejects verbose JSON before creating a session or touching the backend', async () => {
      const actual = await vi.importActual<
        typeof import('../../../utils/output-mode.js')
      >('../../../utils/output-mode.js');
      vi.mocked(resolveCommandFlags).mockImplementationOnce(
        actual.resolveCommandFlags
      );
      await expect(
        runApply(['--json', '--verbose', 'dev', 'functions', 'apply'])
      ).rejects.toBeInstanceOf(CliHandledError);
      expect(createCliDiagnosticSession).not.toHaveBeenCalled();
      expect(cliCommandRunner.run).not.toHaveBeenCalled();
      expect(stdoutWrites).toHaveLength(1);
      expect(JSON.parse(stdoutWrites[0])).toMatchObject({ status: 'error' });
    });

    it('links and closes diagnostics for an initial build failure', async () => {
      const session = {
        diagnostics: { debug: vi.fn() },
        logPath: '/tmp/functions-test.log',
        close: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(createCliDiagnosticSession).mockResolvedValueOnce(session);
      vi.mocked(runFunctionsBuild).mockRejectedValue(
        new Error('compiler failed')
      );
      await expect(runApply()).rejects.toBeInstanceOf(CliHandledError);
      expect(modeError).toHaveBeenCalledWith(
        'plain',
        '   Diagnostic log: /tmp/functions-test.log'
      );
      expect(session.close).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed', exitCode: 1 })
      );
    });

    it.each([
      ['plain', false],
      ['interactive', false],
      ['json', false],
      ['plain', true],
    ] as const)(
      'surfaces compiler diagnostics in %s with verbose=%s',
      async (mode, verbose) => {
        vi.mocked(resolveCommandFlags).mockReturnValue({
          mode,
          verbose,
          json: mode === 'json',
          yes: true,
        });
        const writes: string[] = [];
        const stderr = vi
          .spyOn(process.stderr, 'write')
          .mockImplementation((chunk) => {
            writes.push(String(chunk));
            return true;
          });
        vi.mocked(runFunctionsBuild).mockImplementation(
          async ({ onStdout, onStderr }) => {
            onStdout?.(
              '/workspaces/app/src/file.ts(12,5): error TS2322: Compiler failure\n'
            );
            onStderr?.('Trailing compiler detail');
            throw new Error('build failed with exit code 1');
          }
        );
        try {
          await expect(runApply()).rejects.toBeInstanceOf(CliHandledError);
          if (mode === 'json') {
            expect(stdoutWrites).toHaveLength(1);
            expect(JSON.parse(stdoutWrites[0]).buildOutput).toBe(
              '/workspaces/app/src/file.ts(12,5): error TS2322: Compiler failure\nTrailing compiler detail\n'
            );
            expect(writes).toEqual([]);
          } else if (verbose) {
            expect(writes).toEqual([]);
          } else {
            expect(writes.join('')).toContain(
              '/workspaces/app/src/file.ts(12,5)'
            );
            expect(writes.join('').match(/Compiler failure/g)).toHaveLength(1);
            expect(writes.join('')).toContain('Trailing compiler detail');
          }
        } finally {
          stderr.mockRestore();
        }
      }
    );

    it.each([0, 7])(
      'fails and stops the host when the watcher exits with code %s',
      async (exitCode) => {
        vi.mocked(cliCommandRunner.run).mockImplementation(
          (command, _args, options) =>
            command === 'npm'
              ? Promise.resolve({
                  launched: true,
                  exitCode,
                  stdout: '',
                  stderr: '',
                })
              : untilCancelled(options)
        );
        await expect(runApply()).rejects.toBeInstanceOf(CliHandledError);
        expect(modeError).toHaveBeenCalledWith(
          'plain',
          expect.stringContaining(
            `compiler watcher exited with code ${exitCode}`
          )
        );
        expect(close).toHaveBeenCalledOnce();
      }
    );

    it.each(['npm', 'func'])(
      'cleans up when %s cannot launch',
      async (failedCommand) => {
        vi.mocked(cliCommandRunner.run).mockImplementation(
          (command, _args, options) =>
            command === failedCommand
              ? Promise.resolve({
                  launched: false,
                  spawnError: 'ENOENT',
                  exitCode: 0,
                  stdout: '',
                  stderr: '',
                })
              : untilCancelled(options)
        );
        await expect(runApply()).rejects.toBeInstanceOf(CliHandledError);
        expect(close).toHaveBeenCalledOnce();
      }
    );

    it('does not start watchers or host if the initial build fails', async () => {
      const error = new Error('build failed');
      vi.mocked(runFunctionsBuild).mockRejectedValue(error);
      await expect(runApply()).rejects.toMatchObject({
        name: 'CliHandledError',
        originalError: error,
      });
      expect(modeError).toHaveBeenCalledTimes(2);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(runtime.createBuildWatcher).not.toHaveBeenCalled();
      expect(runtime.startTypegen).not.toHaveBeenCalled();
      expect(cliCommandRunner.run).not.toHaveBeenCalled();
    });

    it.each(['host exit', 'host failure', 'SIGINT'] as const)(
      'warns and runs only the host without build:watch, handling %s',
      async (outcome) => {
        vi.mocked(runtime.createBuildWatcher).mockResolvedValue(undefined);
        vi.mocked(cliCommandRunner.run).mockImplementation(
          (_command, _args, options) => {
            if (outcome === 'SIGINT') {
              const result = untilCancelled(options);
              void Promise.resolve().then(() => process.emit('SIGINT'));
              return result;
            }
            return Promise.resolve({
              launched: true,
              exitCode: outcome === 'host failure' ? 1 : 0,
              stdout: '',
              stderr: '',
            });
          }
        );
        if (outcome === 'host exit') {
          await runApply();
        } else {
          await expect(runApply()).rejects.toBeInstanceOf(
            outcome === 'SIGINT' ? CliCancelledError : CliHandledError
          );
        }
        expect(runFunctionsBuild).toHaveBeenCalledOnce();
        expect(modeWarn).toHaveBeenCalledExactlyOnceWith(
          'plain',
          FUNCTIONS_BUILD_WATCH_WARNING
        );
        expect(cliCommandRunner.run).toHaveBeenCalledExactlyOnceWith(
          'func',
          ['start', '--port', '7071', '--cors', 'http://localhost:5173'],
          expect.objectContaining({ cwd: functionsDir })
        );
        expect(runtime.startTypegen).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
        if (outcome !== 'host failure') {
          expect(modeError).not.toHaveBeenCalled();
        }
      }
    );

    it('does not start the host if the watch configuration is invalid', async () => {
      vi.mocked(runtime.createBuildWatcher).mockRejectedValue(
        new Error('Invalid build:watch')
      );
      await expect(runApply()).rejects.toBeInstanceOf(CliHandledError);
      expect(runtime.startTypegen).not.toHaveBeenCalled();
      expect(cliCommandRunner.run).not.toHaveBeenCalled();
    });

    it.each(['SIGINT', 'SIGTERM'] as const)(
      'cancels both processes and debugger probe on %s',
      async (signal) => {
        let probeCancelled = false;
        vi.mocked(runtime.ensureDebuggerConfig).mockImplementation(
          ({ signal }) =>
            new Promise((resolve) => {
              signal?.onCancellationRequested(() => {
                probeCancelled = true;
                resolve({ status: 'not-ready' });
              });
            })
        );
        vi.mocked(cliCommandRunner.run).mockImplementation(
          (command, _args, options) => {
            const result = untilCancelled(options);
            if (command === 'func') {
              void Promise.resolve().then(() => process.emit(signal));
            }
            return result;
          }
        );
        await expect(runApply()).rejects.toBeInstanceOf(CliCancelledError);
        expect(probeCancelled).toBe(true);
        expect(close).toHaveBeenCalledOnce();
      }
    );

    it('does not start the host when cancelled during the one-shot build', async () => {
      vi.mocked(runFunctionsBuild).mockImplementation(async () => {
        process.emit('SIGINT');
        throw new Error('build cancelled');
      });
      await expect(runApply()).rejects.toBeInstanceOf(CliCancelledError);
      expect(cliCommandRunner.run).not.toHaveBeenCalled();
    });

    it('closes typegen when cancellation arrives during watcher startup', async () => {
      vi.mocked(runtime.startTypegen).mockImplementation(async () => {
        process.emit('SIGINT');
        return { close };
      });
      await expect(runApply()).rejects.toBeInstanceOf(CliCancelledError);
      expect(close).toHaveBeenCalledOnce();
      expect(cliCommandRunner.run).not.toHaveBeenCalled();
    });

    describe('Commander telemetry outcomes', () => {
      async function expectOutcome(
        resultCategory: 'Success' | 'Failure' | 'Canceled',
        exitCode: 0 | 1 | 2
      ): Promise<void> {
        // Seed a real context without initializing a network exporter.
        const context = new InvocationContext('rayfin-cli', 'test');
        context.setCommand('dev.functions.apply', []);
        const finalize = vi.spyOn(context, 'finalize');
        setCurrentContext(context);

        try {
          await runApply();
        } catch (error) {
          process.exitCode = classifyCliError(error).exitCode;
          if (error instanceof CliCancelledError) {
            markCurrentContextCancelled();
          } else if (error instanceof CliHandledError) {
            const underlying = error.originalError;
            markCurrentContextFailure(
              underlying instanceof Error
                ? underlying
                : new Error(String(underlying))
            );
          } else {
            throw error;
          }
        }

        expect(process.exitCode ?? 0).toBe(exitCode);
        expect(finalize).toHaveBeenCalledOnce();
        expect(finalize).toHaveReturnedWith(
          expect.objectContaining({ resultCategory })
        );
        expect(getCurrentContext()).toBeUndefined();
      }

      it('records an initial build failure as Failure', async () => {
        vi.mocked(runFunctionsBuild).mockRejectedValue(
          new Error('build failed')
        );
        await expectOutcome('Failure', 1);
        expect(cliCommandRunner.run).not.toHaveBeenCalled();
      });

      it.each([0, 7])(
        'records a compiler watcher exit with code %s as Failure',
        async (exitCode) => {
          vi.mocked(cliCommandRunner.run).mockImplementation(
            (command, _args, options) =>
              command === 'npm'
                ? Promise.resolve({
                    launched: true,
                    exitCode,
                    stdout: '',
                    stderr: '',
                  })
                : untilCancelled(options)
          );
          await expectOutcome('Failure', 1);
          expect(close).toHaveBeenCalledOnce();
        }
      );

      it.each([
        'initial build',
        'initial build rejection',
        'compiler watcher setup',
        'typegen setup',
        'running host',
        'cleanup',
      ])('records cancellation during %s as Canceled', async (phase) => {
        const cancel = (): void => {
          process.emit('SIGINT');
        };
        switch (phase) {
          case 'initial build':
            vi.mocked(runFunctionsBuild).mockImplementation(async () =>
              cancel()
            );
            break;
          case 'initial build rejection':
            vi.mocked(runFunctionsBuild).mockImplementation(async () => {
              cancel();
              throw new Error('build cancelled');
            });
            break;
          case 'compiler watcher setup':
            vi.mocked(runtime.createBuildWatcher).mockImplementation(
              async () => {
                cancel();
                return undefined;
              }
            );
            break;
          case 'typegen setup':
            vi.mocked(runtime.startTypegen).mockImplementation(async () => {
              cancel();
              return { close };
            });
            break;
          case 'cleanup':
            close.mockImplementationOnce(cancel);
            break;
        }
        vi.mocked(cliCommandRunner.run).mockImplementation(
          (command, _args, options) => {
            if (command === 'func') {
              if (phase === 'cleanup') {
                return Promise.resolve({
                  launched: true,
                  exitCode: 0,
                  stdout: '',
                  stderr: '',
                });
              }
              const result = untilCancelled(options);
              void Promise.resolve().then(cancel);
              return result;
            }
            return untilCancelled(options);
          }
        );

        await expectOutcome('Canceled', 2);
        expect(modeError).not.toHaveBeenCalled();
        if (['typegen setup', 'running host', 'cleanup'].includes(phase)) {
          expect(close).toHaveBeenCalledOnce();
        } else {
          expect(cliCommandRunner.run).not.toHaveBeenCalled();
        }
      });

      it.each([true, false])(
        'records normal host exit as Success with build:watch present: %s',
        async (hasBuildWatcher) => {
          if (!hasBuildWatcher) {
            vi.mocked(runtime.createBuildWatcher).mockResolvedValue(undefined);
          }
          vi.mocked(cliCommandRunner.run).mockImplementation(
            (command, _args, options) =>
              command === 'func'
                ? Promise.resolve({
                    launched: true,
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                  })
                : untilCancelled(options)
          );
          await expectOutcome('Success', 0);
          expect(close).toHaveBeenCalledOnce();
          expect(modeError).not.toHaveBeenCalled();
        }
      );
    });
  });

  it('exits with a clear message when no active deployment exists', async () => {
    const { getActiveDeployment } =
      await import('../../../utils/deployments-registry.js');
    (getActiveDeployment as ReturnType<typeof vi.fn>).mockReturnValue(null);

    await expect(runApply()).rejects.toThrow(
      "No active deployment found. Run 'rayfin up'"
    );
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a workspace-only pre-seed from `rayfin init --workspace-id`',
      { workspaceId: 'workspace', itemId: '', apiUrl: '' },
    ],
    [
      'a record naming an item that was never deployed',
      { workspaceId: 'workspace', itemId: 'item', apiUrl: '' },
    ],
  ])('reports that nothing is deployed yet for %s', async (_label, record) => {
    // Regression: these records are active, so testing only for existence
    // let them through and failed later on the empty `apiUrl`, reporting a
    // missing field instead of the real cause — `rayfin up` has not run.
    const { getActiveDeployment } =
      await import('../../../utils/deployments-registry.js');
    (getActiveDeployment as ReturnType<typeof vi.fn>).mockReturnValue({
      workspaceName: 'cg-ws',
      record,
    });

    await expect(runApply()).rejects.toThrow(
      "No active deployment found. Run 'rayfin up'"
    );
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('aborts when consent is denied for a missing prerequisite', async () => {
    const { inspectFunctionsPrereqs, planFunctionsInstall, promptAndInstall } =
      await import('../../../utils/functions-prereqs.js');
    (inspectFunctionsPrereqs as ReturnType<typeof vi.fn>).mockReturnValue({
      node: {
        name: 'Node.js',
        command: 'node',
        version: 'v20.0.0',
        minimumMajor: 20,
        ok: true,
      },
      funcCoreTools: {
        name: 'Azure Functions Core Tools',
        command: 'func',
        version: null,
        ok: false,
      },
    });
    (planFunctionsInstall as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        name: 'Azure Functions Core Tools (winget)',
        source: 'Microsoft via winget',
        command: 'winget',
        args: ['install', '--id', 'Microsoft.AzureFunctionsCoreTools'],
        description: '',
      },
    ]);
    // User declined the consent prompt.
    (promptAndInstall as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    await expect(runApply()).rejects.toBeInstanceOf(CliHandledError);
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it.each(['plain', 'json'] as const)(
    'provides exact missing-tool commands without prompts in %s',
    async (mode) => {
      const {
        inspectFunctionsPrereqs,
        planFunctionsInstall,
        promptAndInstall,
      } = await import('../../../utils/functions-prereqs.js');
      vi.mocked(resolveCommandFlags).mockReturnValue({
        mode,
        verbose: false,
        json: mode === 'json',
        yes: true,
      });
      vi.mocked(inspectFunctionsPrereqs).mockReturnValue({
        node: {
          name: 'Node.js',
          command: 'node',
          version: 'v20.0.0',
          minimumMajor: 20,
          ok: true,
        },
        funcCoreTools: {
          name: 'Azure Functions Core Tools',
          command: 'func',
          version: null,
          ok: false,
        },
      });
      vi.mocked(planFunctionsInstall).mockReturnValue([
        {
          name: 'tap',
          source: 'Homebrew',
          command: 'brew',
          args: ['tap', 'azure/functions'],
          description: '',
        },
        {
          name: 'Core Tools',
          source: 'Homebrew',
          command: 'brew',
          args: ['install', 'azure-functions-core-tools@4'],
          description: '',
        },
      ]);
      await expect(runApply()).rejects.toBeInstanceOf(CliHandledError);
      expect(promptAndInstall).not.toHaveBeenCalled();
      const output =
        mode === 'json'
          ? JSON.parse(stdoutWrites[0]).error
          : vi.mocked(modeError).mock.calls.flat().join(' ');
      expect(output).toContain('brew tap azure/functions');
      expect(output).toContain('brew install azure-functions-core-tools@4');
      expect(output).not.toContain('Install Node.js');
      expect(output).not.toContain('interactive terminal');
      if (mode === 'json') expect(stdoutWrites).toHaveLength(1);
    }
  );
});
