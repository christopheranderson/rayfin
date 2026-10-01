import { describe, expect, it, vi } from 'vitest';

import {
  cancellationTokenFromSignal,
  type CancellationToken,
  type CommandRunner,
  type RunResult,
} from '../../../adapters/index.js';
import type { RayfinConfig } from '../../../config/index.js';
import type { DevBackendProvider } from '../providers/index.js';
import type { LocalRuntimeProvisioner, LocalRuntimeSpec } from '../runtimes.js';
import type { DevDeps, DevRequest } from '../types.js';
import { runDevWorkflow } from '../workflow.js';

function config(
  services: Partial<RayfinConfig['services']> = {},
  connectors?: RayfinConfig['connectors']
): RayfinConfig {
  return {
    id: 'my-app',
    name: 'My App',
    version: '1',
    services: {
      auth: { enabled: true },
      data: { enabled: true },
      storage: { enabled: true },
      ...services,
    },
    connectors,
  } as unknown as RayfinConfig;
}

const runtime: LocalRuntimeSpec = {
  id: 'frontend',
  label: 'frontend dev server',
  command: 'npm',
  args: ['run', 'dev'],
  cwd: '/p',
};

function baseRequest(overrides: Partial<DevRequest> = {}): DevRequest {
  return {
    config: config(),
    projectRoot: '/p',
    provider: 'fabric',
    ...overrides,
  };
}

function fakeProvisioner(
  overrides: Partial<LocalRuntimeProvisioner> = {}
): LocalRuntimeProvisioner {
  return {
    reserve: vi.fn().mockResolvedValue({
      status: 'reserved',
      reservations: [{ id: 'frontend', label: 'frontend dev server' }],
    }),
    prepare: vi.fn().mockResolvedValue({
      status: 'prepared',
      runtimes: [runtime],
    }),
    ...overrides,
  };
}

function fakeProvider(
  overrides: Partial<DevBackendProvider> = {}
): DevBackendProvider {
  return {
    resolveTarget: vi.fn().mockResolvedValue({
      provider: 'fabric',
      displayName: 'My Workspace',
      apiUrl: 'https://baas.example',
    }),
    ensureReady: vi.fn().mockImplementation(async (target) => ({
      status: 'ready',
      target,
    })),
    applyDataConfig: vi.fn().mockResolvedValue(undefined),
    applyStorageConfig: vi.fn().mockResolvedValue(undefined),
    syncConnectors: vi.fn().mockResolvedValue(undefined),
    prepareForLocalFrontend: vi.fn().mockResolvedValue({
      env: { VITE_RAYFIN_API_URL: 'https://baas.example' },
    }),
    teardown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function launched(exitCode = 0): RunResult {
  return { launched: true, exitCode, stdout: '', stderr: '' };
}

function fakeRunner(result: RunResult = launched()): CommandRunner {
  return { run: vi.fn().mockResolvedValue(result) };
}

function fakeDeps(overrides: Partial<DevDeps> = {}): DevDeps {
  return {
    diagnostics: { debug: vi.fn() },
    backend: fakeProvider(),
    runtimes: fakeProvisioner(),
    runner: fakeRunner(),
    progress: { report: vi.fn() },
    ...overrides,
  };
}

describe('runDevWorkflow', () => {
  it('runs the full pipeline and returns a structured result', async () => {
    const deps = fakeDeps();

    const result = await runDevWorkflow(baseRequest(), deps);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data).toMatchObject({
      provider: 'fabric',
      target: { displayName: 'My Workspace', apiUrl: 'https://baas.example' },
      startedRuntimes: ['frontend'],
      runtimeUrls: {},
    });

    expect(deps.backend.resolveTarget).toHaveBeenCalledOnce();
    expect(deps.backend.ensureReady).toHaveBeenCalledOnce();
    expect(deps.backend.applyDataConfig).toHaveBeenCalledOnce();
    expect(deps.backend.applyStorageConfig).toHaveBeenCalledOnce();
    expect(deps.backend.syncConnectors).toHaveBeenCalledOnce();
    expect(
      vi.mocked(deps.backend.syncConnectors).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(deps.backend.applyDataConfig).mock.invocationCallOrder[0]
    );
    expect(deps.backend.prepareForLocalFrontend).toHaveBeenCalledOnce();
    expect(deps.runner.run).toHaveBeenCalledWith(
      'npm',
      ['run', 'dev'],
      expect.objectContaining({
        cwd: '/p',
        env: { VITE_RAYFIN_API_URL: 'https://baas.example' },
      })
    );
    expect(deps.backend.teardown).toHaveBeenCalledOnce();
    expect(deps.diagnostics.debug).toHaveBeenCalledWith({
      area: 'dev',
      message: 'Workflow phase',
      data: { phase: 'declared-state' },
    });
    expect(deps.diagnostics.debug).toHaveBeenLastCalledWith({
      area: 'dev',
      message: 'Session cleanup completed',
    });
  });

  it('never branches on the provider id — a docker provider drives the same steps', async () => {
    const deps = fakeDeps({
      backend: fakeProvider({
        resolveTarget: vi.fn().mockResolvedValue({
          provider: 'docker',
          displayName: 'local Docker',
        }),
      }),
    });

    const result = await runDevWorkflow(
      baseRequest({ provider: 'docker' }),
      deps
    );

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.provider).toBe('docker');
    expect(deps.backend.applyDataConfig).toHaveBeenCalledOnce();
    expect(deps.backend.syncConnectors).toHaveBeenCalledOnce();
  });

  it('keeps host-supplied runtime labels out of persisted phase events', async () => {
    const deps = fakeDeps({
      runtimes: fakeProvisioner({
        prepare: vi.fn().mockResolvedValue({
          status: 'prepared',
          runtimes: [{ ...runtime, label: 'private-user@example.com runtime' }],
        }),
      }),
    });

    await runDevWorkflow(baseRequest(), deps);

    expect(deps.progress.report).toHaveBeenCalledWith({
      phase: 'runtimes',
      message: 'Starting private-user@example.com runtime',
    });
    expect(deps.diagnostics.debug).toHaveBeenCalledWith({
      area: 'dev',
      message: 'Workflow phase',
      data: { phase: 'runtimes' },
    });
    expect(
      JSON.stringify(vi.mocked(deps.diagnostics.debug).mock.calls)
    ).not.toContain('private-user');
  });

  it('uses the effective target returned while making the backend ready', async () => {
    const provisionalTarget = {
      provider: 'fabric',
      displayName: '(provisioning)',
    };
    const readyTarget = {
      provider: 'fabric',
      displayName: 'My Workspace',
      apiUrl: 'https://baas.example/provisioned',
    };
    const deps = fakeDeps({
      backend: fakeProvider({
        resolveTarget: vi.fn().mockResolvedValue(provisionalTarget),
        ensureReady: vi.fn().mockResolvedValue({
          status: 'ready',
          target: readyTarget,
        }),
      }),
    });

    const result = await runDevWorkflow(baseRequest(), deps);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.target).toEqual({
      displayName: 'My Workspace',
      apiUrl: 'https://baas.example/provisioned',
    });
    expect(deps.backend.applyDataConfig).toHaveBeenCalledWith(
      readyTarget,
      expect.anything()
    );
    expect(deps.backend.applyStorageConfig).toHaveBeenCalledWith(
      readyTarget,
      expect.anything()
    );
    expect(deps.backend.syncConnectors).toHaveBeenCalledWith(
      readyTarget,
      undefined
    );
    expect(deps.backend.prepareForLocalFrontend).toHaveBeenCalledWith(
      readyTarget,
      expect.anything()
    );
    expect(deps.backend.teardown).toHaveBeenCalledWith(
      readyTarget,
      expect.anything()
    );
  });

  it('skips data and storage apply when those services are disabled', async () => {
    const deps = fakeDeps();
    const req = baseRequest({
      config: config({
        data: { enabled: false },
        storage: { enabled: false },
      }),
    });

    const result = await runDevWorkflow(req, deps);

    expect(result.status).toBe('ok');
    expect(deps.backend.applyDataConfig).not.toHaveBeenCalled();
    expect(deps.backend.applyStorageConfig).not.toHaveBeenCalled();
    // Connectors always sync regardless of data/storage.
    expect(deps.backend.syncConnectors).toHaveBeenCalledOnce();
  });

  it('skips data apply when requested while still applying storage', async () => {
    const deps = fakeDeps();

    const result = await runDevWorkflow(
      baseRequest({ skipDataApply: true }),
      deps
    );

    expect(result.status).toBe('ok');
    expect(deps.backend.applyDataConfig).not.toHaveBeenCalled();
    expect(deps.backend.applyStorageConfig).toHaveBeenCalledOnce();
  });

  it('fails when the backend is unavailable, surfacing the provider remediation', async () => {
    const deps = fakeDeps({
      backend: fakeProvider({
        ensureReady: vi.fn().mockResolvedValue({
          status: 'unavailable',
          code: 'backend-unavailable',
          message: 'The selected backend is unavailable. Resolve it and retry.',
        }),
      }),
    });

    const result = await runDevWorkflow(baseRequest(), deps);

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error.code).toBe('backend-unavailable');
    expect(result.error.message).toContain('Resolve it and retry');
    // Backend was resolved, so teardown must still run.
    expect(deps.backend.teardown).toHaveBeenCalledOnce();
    expect(deps.backend.applyDataConfig).not.toHaveBeenCalled();
  });

  it('returns cancelled when backend reuse is declined', async () => {
    const deps = fakeDeps({
      backend: fakeProvider({
        ensureReady: vi.fn().mockResolvedValue({ status: 'cancelled' }),
      }),
    });

    const result = await runDevWorkflow(baseRequest(), deps);

    expect(result.status).toBe('cancelled');
    expect(deps.backend.syncConnectors).not.toHaveBeenCalled();
    expect(deps.backend.applyDataConfig).not.toHaveBeenCalled();
  });

  it('prefers cancellation requested during backend readiness over an unavailable result', async () => {
    let cancelled = false;
    const deps = fakeDeps({
      backend: fakeProvider({
        ensureReady: vi.fn().mockImplementation(async () => {
          cancelled = true;
          return {
            status: 'unavailable',
            code: 'backend-unavailable',
            message: 'Request aborted.',
          };
        }),
      }),
      signal: {
        get isCancellationRequested() {
          return cancelled;
        },
        onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
      },
    });

    const result = await runDevWorkflow(baseRequest(), deps);

    expect(result.status).toBe('cancelled');
    expect(deps.backend.syncConnectors).not.toHaveBeenCalled();
  });

  it('fails with invalid-connectors without syncing', async () => {
    const deps = fakeDeps();
    // A structurally valid array whose entry is missing `name` — validation
    // returns an error (it does not throw).
    const req = baseRequest({
      config: config({}, [
        { name: '' },
      ] as unknown as RayfinConfig['connectors']),
    });

    const result = await runDevWorkflow(req, deps);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('invalid-connectors');
    }
    expect(deps.backend.syncConnectors).not.toHaveBeenCalled();
    expect(deps.backend.applyDataConfig).not.toHaveBeenCalled();
    expect(deps.backend.applyStorageConfig).not.toHaveBeenCalled();
  });

  it('returns cancelled when the token is already cancelled', async () => {
    const signal: CancellationToken = {
      isCancellationRequested: true,
      onCancellationRequested: () => ({ dispose() {} }),
    };
    const deps = fakeDeps({ signal });

    const result = await runDevWorkflow(baseRequest(), deps);

    expect(result.status).toBe('cancelled');
    expect(deps.backend.resolveTarget).not.toHaveBeenCalled();
    // No target was resolved, so there is nothing to tear down.
    expect(deps.backend.teardown).not.toHaveBeenCalled();
  });

  it('tears the backend down even when a step throws', async () => {
    const error = new Error('apply boom with Bearer private-token');
    const deps = fakeDeps({
      backend: fakeProvider({
        applyDataConfig: vi.fn().mockRejectedValue(error),
      }),
    });

    const result = await runDevWorkflow(baseRequest(), deps);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('dev-failed');
      expect(result.error.cause).toBe(error);
    }
    expect(deps.backend.teardown).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(vi.mocked(deps.diagnostics.debug).mock.calls)
    ).not.toContain('private-token');
  });

  it('forwards --purge to the provider teardown', async () => {
    const deps = fakeDeps();

    await runDevWorkflow(baseRequest({ purge: true }), deps);

    expect(deps.backend.teardown).toHaveBeenCalledWith(expect.anything(), {
      purge: true,
    });
  });

  it('a teardown failure does not mask the session result', async () => {
    const deps = fakeDeps({
      backend: fakeProvider({
        teardown: vi.fn().mockRejectedValue(new Error('teardown boom')),
      }),
    });

    const result = await runDevWorkflow(baseRequest(), deps);

    expect(result.status).toBe('ok');
    expect(deps.diagnostics.debug).toHaveBeenCalledWith({
      area: 'dev',
      message: 'Backend teardown failed',
    });
  });

  it('surfaces a runtime that failed to launch as a warning, not a failure', async () => {
    const deps = fakeDeps({
      runner: fakeRunner({
        launched: false,
        spawnError: 'npm: command not found',
        exitCode: 0,
        stdout: '',
        stderr: '',
      }),
    });

    const result = await runDevWorkflow(baseRequest(), deps);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.startedRuntimes).toEqual([]);
    expect(result.data.warnings.join('\n')).toContain('command not found');
  });

  it('reserves runtimes before wiring and hands their URLs to the provider', async () => {
    const deps = fakeDeps({
      runtimes: fakeProvisioner({
        reserve: vi.fn().mockResolvedValue({
          status: 'reserved',
          reservations: [
            { id: 'frontend', label: 'frontend dev server' },
            {
              id: 'functions',
              label: 'functions runtime',
              url: 'http://localhost:7071',
            },
          ],
        }),
      }),
    });

    const result = await runDevWorkflow(baseRequest(), deps);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.runtimeUrls).toEqual({
      functions: 'http://localhost:7071',
    });
    expect(deps.runtimes.reserve).toHaveBeenCalledOnce();
    expect(deps.backend.prepareForLocalFrontend).toHaveBeenCalledWith(
      expect.anything(),
      { runtimeUrls: { functions: 'http://localhost:7071' } }
    );
    // The wiring env is what `prepare` gets, so the ordering is observable.
    expect(deps.runtimes.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { VITE_RAYFIN_API_URL: 'https://baas.example' },
      })
    );
  });

  it('fails without starting anything when a runtime cannot be reserved', async () => {
    const deps = fakeDeps({
      runtimes: fakeProvisioner({
        reserve: vi.fn().mockResolvedValue({
          status: 'unavailable',
          code: 'functions-port-unavailable',
          message: 'No free port available between 7071 and 7078.',
        }),
      }),
    });

    const result = await runDevWorkflow(baseRequest(), deps);

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error.code).toBe('functions-port-unavailable');
    expect(deps.runtimes.prepare).not.toHaveBeenCalled();
    expect(deps.runner.run).not.toHaveBeenCalled();
    expect(deps.backend.teardown).toHaveBeenCalledOnce();
  });

  it('fails when preparing a runtime is impossible, e.g. a missing toolchain', async () => {
    const deps = fakeDeps({
      runtimes: fakeProvisioner({
        prepare: vi.fn().mockResolvedValue({
          status: 'unavailable',
          code: 'functions-core-tools-missing',
          message: 'Azure Functions Core Tools is not installed.',
        }),
      }),
    });

    const result = await runDevWorkflow(baseRequest(), deps);

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error.code).toBe('functions-core-tools-missing');
    expect(deps.runner.run).not.toHaveBeenCalled();
  });

  it('returns cancelled when runtime preparation is cancelled', async () => {
    const deps = fakeDeps({
      runtimes: fakeProvisioner({
        prepare: vi.fn().mockResolvedValue({ status: 'cancelled' }),
      }),
    });

    const result = await runDevWorkflow(baseRequest(), deps);

    expect(result.status).toBe('cancelled');
    expect(deps.runner.run).not.toHaveBeenCalled();
    expect(deps.backend.teardown).toHaveBeenCalledOnce();
  });

  it('returns cancelled when Ctrl-C stops active runtimes', async () => {
    const controller = new AbortController();
    const deps = fakeDeps({
      signal: cancellationTokenFromSignal(controller.signal),
      runner: {
        run: vi.fn().mockImplementation(async () => {
          controller.abort();
          return {
            launched: true,
            cancelled: true,
            exitCode: 143,
            stdout: '',
            stderr: '',
          };
        }),
      },
    });

    const result = await runDevWorkflow(baseRequest(), deps);

    expect(result.status).toBe('cancelled');
    expect(deps.backend.teardown).toHaveBeenCalledOnce();
  });

  it('preserves a runtime failure that races with cancellation as a warning', async () => {
    const controller = new AbortController();
    const deps = fakeDeps({
      signal: cancellationTokenFromSignal(controller.signal),
      runtimes: fakeProvisioner({
        prepare: vi.fn().mockResolvedValue({
          status: 'prepared',
          runtimes: [
            {
              ...runtime,
              label: 'functions runtime on port 7071',
              required: true,
            },
          ],
        }),
      }),
      runner: {
        run: vi.fn().mockImplementation(async () => {
          controller.abort();
          return {
            launched: true,
            exitCode: 1,
            stdout: '',
            stderr: '',
          };
        }),
      },
    });

    const result = await runDevWorkflow(baseRequest(), deps);

    expect(result).toEqual({
      status: 'cancelled',
      warnings: [
        'Runtime failure during shutdown: functions runtime on port 7071 exited with code 1.',
      ],
    });
  });

  it('fails the session when a required runtime dies, rather than warning', async () => {
    const required: LocalRuntimeSpec = {
      ...runtime,
      id: 'functions',
      label: 'functions runtime',
      required: true,
    };
    const deps = fakeDeps({
      runtimes: fakeProvisioner({
        prepare: vi
          .fn()
          .mockResolvedValue({ status: 'prepared', runtimes: [required] }),
      }),
      runner: fakeRunner({
        launched: false,
        spawnError: 'func: command not found',
        exitCode: 0,
        stdout: '',
        stderr: '',
      }),
    });

    const result = await runDevWorkflow(baseRequest(), deps);

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error.code).toBe('runtime-launch-failed');
    expect(result.error.message).toContain('command not found');
  });

  it('disposes prepared runtimes when the session ends, however it ends', async () => {
    const dispose = vi.fn();
    const provisioner = (): LocalRuntimeProvisioner =>
      fakeProvisioner({
        prepare: vi.fn().mockResolvedValue({
          status: 'prepared',
          runtimes: [{ ...runtime, dispose }],
        }),
      });

    await runDevWorkflow(baseRequest(), fakeDeps({ runtimes: provisioner() }));
    expect(dispose).toHaveBeenCalledOnce();

    dispose.mockClear();
    await runDevWorkflow(
      baseRequest(),
      fakeDeps({
        runtimes: provisioner(),
        backend: fakeProvider({
          teardown: vi.fn().mockRejectedValue(new Error('teardown boom')),
        }),
        runner: fakeRunner({
          launched: true,
          cancelled: true,
          exitCode: 137,
          stdout: '',
          stderr: '',
        }),
      })
    );
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('does not reserve runtimes once the session is already cancelled', async () => {
    const signal: CancellationToken = {
      isCancellationRequested: true,
      onCancellationRequested: () => ({ dispose() {} }),
    };
    const deps = fakeDeps({ signal });

    const result = await runDevWorkflow(baseRequest(), deps);

    expect(result.status).toBe('cancelled');
    expect(deps.runtimes.reserve).not.toHaveBeenCalled();
    expect(deps.runtimes.prepare).not.toHaveBeenCalled();
  });
});
