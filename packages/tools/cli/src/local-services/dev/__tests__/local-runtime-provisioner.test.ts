import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cancellationTokenFromSignal } from '@microsoft/rayfin-tools-common/_internal/adapters';
import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FUNCTIONS_BUILD_WATCH_WARNING,
  createLocalFunctionsRuntimeService,
  type LocalFunctionsRuntimeService,
} from '../functions-runtime.js';
import { createCliLocalRuntimeProvisioner } from '../local-runtime-provisioner.js';

function config(overrides: Record<string, unknown> = {}): RayfinConfig {
  return {
    id: 'my-app',
    name: 'My App',
    version: '1',
    services: {
      auth: { enabled: true },
      data: { enabled: true },
      functions: { enabled: true, path: 'rayfin/functions' },
      ...overrides,
    },
  } as unknown as RayfinConfig;
}

function fakeFunctionsRuntime(
  overrides: Partial<LocalFunctionsRuntimeService> = {}
): LocalFunctionsRuntimeService {
  return {
    findAvailablePort: vi
      .fn()
      .mockImplementation(async (startPort: number) => ({
        port: startPort,
        searched: { from: startPort, to: startPort + 7 },
      })),
    upsertLocalSettings: vi.fn().mockResolvedValue(undefined),
    resolveCorsOrigins: vi.fn().mockReturnValue(['http://localhost:5173']),
    createBuildWatcher: vi.fn(
      createLocalFunctionsRuntimeService().createBuildWatcher
    ),
    startTypegen: vi.fn().mockResolvedValue({ close: vi.fn() }),
    ensureDebuggerConfig: vi.fn().mockResolvedValue({ status: 'not-ready' }),
    ...overrides,
  };
}

describe('createCliLocalRuntimeProvisioner', () => {
  let projectRoot: string;

  const deps = (
    overrides: Partial<
      Parameters<typeof createCliLocalRuntimeProvisioner>[0]
    > = {}
  ): Parameters<typeof createCliLocalRuntimeProvisioner>[0] => ({
    config: config(),
    projectRoot,
    functionsRuntime: fakeFunctionsRuntime(),
    runBuild: vi.fn().mockResolvedValue(undefined),
    patchClient: vi.fn().mockResolvedValue({ patched: true, files: [] }),
    hasNpmScript: () => true,
    ...overrides,
  });

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(process.cwd(), '.rayfin-provisioner-'));
    await mkdir(join(projectRoot, 'rayfin', 'functions'), { recursive: true });
    await writeFile(
      join(projectRoot, 'rayfin', 'functions', 'package.json'),
      JSON.stringify({ scripts: { 'build:watch': 'custom-compiler --watch' } })
    );
    await writeFile(
      join(projectRoot, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' } })
    );
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('reserves a functions port and publishes its URL for the frontend env', async () => {
    const provisioner = createCliLocalRuntimeProvisioner(deps());

    const reserved = await provisioner.reserve({});

    expect(reserved).toEqual({
      status: 'reserved',
      reservations: [
        { id: 'frontend', label: 'frontend dev server' },
        {
          id: 'functions',
          label: 'functions runtime',
          url: 'http://localhost:7071',
        },
      ],
    });
  });

  it('claims functions and inspector ports in the session registry', async () => {
    const reservedPorts = new Set<number>();
    const functionsRuntime = createLocalFunctionsRuntimeService({
      isPortFree: vi.fn().mockResolvedValue(true),
      reservedPorts,
    });
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({ functionsRuntime, reservedPorts })
    );

    await provisioner.reserve({});

    expect(reservedPorts).toEqual(new Set([7071, 9229]));
  });

  it('reserves only the frontend when functions are not enabled', async () => {
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({ config: config({ functions: { enabled: false } }) })
    );

    const reserved = await provisioner.reserve({});

    expect(reserved.status).toBe('reserved');
    if (reserved.status !== 'reserved') return;
    expect(reserved.reservations.map((r) => r.id)).toEqual(['frontend']);
  });

  it('prepares a frontend-only reservation without functions state', async () => {
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({ config: config({ functions: { enabled: false } }) })
    );
    const prepared = await provisioner.prepare({
      env: {},
      reservations: [{ id: 'frontend', label: 'frontend dev server' }],
    });

    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;
    expect(prepared.runtimes.map((runtime) => runtime.id)).toEqual([
      'frontend',
    ]);
  });

  it('writes the secret registry before the functions build runs', async () => {
    // `generateFunctionsTypes` — which normally emits secrets.generated.ts —
    // only runs inside startTypegen, after the build. A project with a secret
    // declared in rayfin.yml but no generated file yet would therefore fail the
    // build with TS2339 before the generator was ever reached.
    await writeFile(
      join(projectRoot, 'rayfin', 'rayfin.yml'),
      [
        'id: fixture',
        'name: fixture',
        'version: 1.0.0',
        'services:',
        '  functions:',
        '    enabled: true',
        '    path: rayfin/functions',
        'secrets:',
        '  - name: API_KEY',
        '',
      ].join('\n')
    );
    const generatedPath = join(
      projectRoot,
      'rayfin',
      'functions',
      'src',
      'secrets.generated.ts'
    );
    expect(existsSync(generatedPath)).toBe(false);

    let generatedWhenBuildStarted: string | undefined;
    const runBuild = vi.fn().mockImplementation(async () => {
      generatedWhenBuildStarted = existsSync(generatedPath)
        ? readFileSync(generatedPath, 'utf-8')
        : undefined;
    });

    const provisioner = createCliLocalRuntimeProvisioner(deps({ runBuild }));
    const reserved = await provisioner.reserve({});
    if (reserved.status !== 'reserved') throw new Error('not reserved');
    await provisioner.prepare({ env: {}, reservations: reserved.reservations });

    expect(runBuild).toHaveBeenCalled();
    expect(generatedWhenBuildStarted).toBeDefined();
    expect(generatedWhenBuildStarted).toContain('API_KEY: string;');
  });

  it('prefers dev:frontend so the user-facing dev script can run rayfin dev', async () => {
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({
        config: config({ functions: { enabled: false } }),
        hasNpmScript: (_dir, name) => name === 'dev:frontend' || name === 'dev',
      })
    );
    const reserved = await provisioner.reserve({});
    if (reserved.status !== 'reserved') throw new Error('not reserved');

    const prepared = await provisioner.prepare({
      env: {},
      reservations: reserved.reservations,
    });

    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;
    expect(prepared.runtimes[0]).toMatchObject({
      command: 'npm',
      args: ['run', 'dev:frontend'],
      cwd: projectRoot,
    });
  });

  it('falls back to the legacy dev script for existing projects', async () => {
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({
        config: config({ functions: { enabled: false } }),
        hasNpmScript: (_dir, name) => name === 'dev',
      })
    );
    const reserved = await provisioner.reserve({});
    if (reserved.status !== 'reserved') throw new Error('not reserved');

    const prepared = await provisioner.prepare({
      env: {},
      reservations: reserved.reservations,
    });

    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;
    expect(prepared.runtimes[0]).toMatchObject({
      command: 'npm',
      args: ['run', 'dev'],
      cwd: projectRoot,
    });
  });

  it('rejects a legacy dev script that recursively invokes rayfin dev', async () => {
    await writeFile(
      join(projectRoot, 'package.json'),
      JSON.stringify({ scripts: { dev: 'rayfin dev' } })
    );
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({
        config: config({ functions: { enabled: false } }),
        hasNpmScript: undefined,
      })
    );

    const reserved = await provisioner.reserve({});

    expect(reserved).toEqual({
      status: 'unavailable',
      code: 'frontend-script-recursive',
      message:
        'The "dev" npm script invokes `rayfin dev`, which would recursively start another development session.',
    });
  });

  it('resolves scripts from the package selected by staticHosting.path', async () => {
    const frontendDir = join(projectRoot, 'packages', 'frontend');
    await mkdir(frontendDir, { recursive: true });
    await writeFile(
      join(projectRoot, 'package.json'),
      JSON.stringify({ scripts: { 'dev:frontend': 'root-vite' } })
    );
    await writeFile(
      join(frontendDir, 'package.json'),
      JSON.stringify({ scripts: { dev: 'nested-vite' } })
    );
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({
        config: config({
          functions: { enabled: false },
          staticHosting: {
            enabled: true,
            path: 'packages/frontend',
            folder: 'dist',
          },
        }),
        hasNpmScript: undefined,
      })
    );
    const reserved = await provisioner.reserve({});
    if (reserved.status !== 'reserved') throw new Error('not reserved');

    const prepared = await provisioner.prepare({
      env: {},
      reservations: reserved.reservations,
    });

    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;
    expect(prepared.runtimes[0]).toMatchObject({
      command: 'npm',
      args: ['run', 'dev'],
      cwd: frontendDir,
    });
  });

  it('fails when prepare receives a functions reservation before reserve', async () => {
    const provisioner = createCliLocalRuntimeProvisioner(deps());

    const prepared = await provisioner.prepare({
      env: {},
      reservations: [{ id: 'functions', label: 'functions runtime' }],
    });

    expect(prepared).toEqual({
      status: 'unavailable',
      code: 'functions-state-missing',
      message:
        'The functions runtime reservation is missing its prepared host state.',
    });
  });

  it('reports an exhausted port window as unavailable rather than throwing', async () => {
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({
        functionsRuntime: fakeFunctionsRuntime({
          findAvailablePort: vi.fn().mockResolvedValue({
            port: null,
            searched: { from: 7071, to: 7078 },
          }),
        }),
      })
    );

    const reserved = await provisioner.reserve({});

    expect(reserved).toMatchObject({
      status: 'unavailable',
      code: 'functions-port-unavailable',
    });
    expect(reserved.status === 'unavailable' ? reserved.message : '').toContain(
      '7071'
    );
  });

  it('notifies and reserves the slid functions host port', async () => {
    const notify = vi.fn();
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({
        notify,
        functionsRuntime: fakeFunctionsRuntime({
          findAvailablePort: vi
            .fn()
            .mockResolvedValueOnce({
              port: 7072,
              searched: { from: 7071, to: 7072 },
            })
            .mockResolvedValueOnce({
              port: 9229,
              searched: { from: 9229, to: 9229 },
            }),
        }),
      })
    );

    const reserved = await provisioner.reserve({});

    expect(reserved).toMatchObject({
      status: 'reserved',
      reservations: expect.arrayContaining([
        expect.objectContaining({
          id: 'functions',
          url: 'http://localhost:7072',
        }),
      ]),
    });
    expect(notify).toHaveBeenCalledWith(
      'ℹ️  Functions port 7071 is in use — using nearest free port 7072 instead.'
    );
  });

  it('slides an occupied inspector port and threads it through preparation', async () => {
    const notify = vi.fn();
    const functionsRuntime = fakeFunctionsRuntime({
      findAvailablePort: vi
        .fn()
        .mockResolvedValueOnce({
          port: 7071,
          searched: { from: 7071, to: 7078 },
        })
        .mockResolvedValueOnce({
          port: 9230,
          searched: { from: 9229, to: 9230 },
        }),
    });
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({ functionsRuntime, notify })
    );
    const reserved = await provisioner.reserve({});
    if (reserved.status !== 'reserved') throw new Error('not reserved');

    await provisioner.prepare({
      env: {},
      reservations: reserved.reservations,
    });

    expect(notify).toHaveBeenCalledWith(
      'ℹ️  Inspector port 9229 is in use — using nearest free port 9230 instead.'
    );
    expect(functionsRuntime.upsertLocalSettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        languageWorkers__node__arguments: '--inspect=9230',
      })
    );
    expect(functionsRuntime.ensureDebuggerConfig).toHaveBeenCalledWith(
      expect.objectContaining({ inspectPort: '9230', syncPort: true })
    );
  });

  it('reports an exhausted inspector port window as unavailable', async () => {
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({
        functionsRuntime: fakeFunctionsRuntime({
          findAvailablePort: vi
            .fn()
            .mockResolvedValueOnce({
              port: 7071,
              searched: { from: 7071, to: 7078 },
            })
            .mockResolvedValueOnce({
              port: null,
              searched: { from: 9229, to: 9236 },
            }),
        }),
      })
    );

    const reserved = await provisioner.reserve({});

    expect(reserved).toMatchObject({
      status: 'unavailable',
      code: 'functions-inspector-port-unavailable',
    });
    expect(reserved.status === 'unavailable' ? reserved.message : '').toContain(
      '9229'
    );
  });

  it('surfaces a missing toolchain as unavailable without probing a port', async () => {
    const findAvailablePort = vi.fn();
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({
        functionsRuntime: fakeFunctionsRuntime({ findAvailablePort }),
        ensureFunctionsPrereqs: vi.fn().mockResolvedValue({
          status: 'unavailable',
          code: 'functions-core-tools-missing',
          message: 'Azure Functions Core Tools is not installed.',
        }),
      })
    );

    const reserved = await provisioner.reserve({});

    expect(reserved).toMatchObject({
      status: 'unavailable',
      code: 'functions-core-tools-missing',
    });
    expect(findAvailablePort).not.toHaveBeenCalled();
  });

  it('writes backend wiring into local.settings.json and starts a required func host', async () => {
    const functionsRuntime = fakeFunctionsRuntime();
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({ functionsRuntime })
    );
    const reserved = await provisioner.reserve({});
    if (reserved.status !== 'reserved') throw new Error('not reserved');

    const prepared = await provisioner.prepare({
      env: {
        RAYFIN_PUBLIC_API_URL: 'https://baas.example',
        RAYFIN_PUBLIC_PUBLISHABLE_KEY: 'pk_test',
        RAYFIN_FABRIC_ITEM_ID: 'item-1',
      },
      reservations: reserved.reservations,
    });

    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;
    expect(functionsRuntime.upsertLocalSettings).toHaveBeenCalledWith(
      join(projectRoot, 'rayfin', 'functions'),
      expect.objectContaining({
        AZURE_FUNCTIONS_ENVIRONMENT: 'Development',
        RAYFIN_API_URL: 'https://baas.example',
        RAYFIN_PUBLISHABLE_KEY: 'pk_test',
        RAYFIN_FABRIC_ITEM_ID: 'item-1',
        languageWorkers__node__arguments: '--inspect=9229',
      })
    );

    const functions = prepared.runtimes.find((r) => r.id === 'functions');
    expect(functions).toMatchObject({
      label: 'functions runtime on port 7071',
      command: 'func',
      args: ['start', '--port', '7071', '--cors', 'http://localhost:5173'],
      inheritStdio: true,
      required: true,
    });
  });

  it('fails the session when the functions build fails', async () => {
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({ runBuild: vi.fn().mockRejectedValue(new Error('tsc exploded')) })
    );
    const reserved = await provisioner.reserve({});
    if (reserved.status !== 'reserved') throw new Error('not reserved');

    const prepared = await provisioner.prepare({
      env: {},
      reservations: reserved.reservations,
    });

    expect(prepared).toMatchObject({
      status: 'unavailable',
      code: 'functions-build-failed',
    });
  });

  it('supervises the package compiler alongside the host after the configured build', async () => {
    const functionsDir = join(projectRoot, 'packages', 'custom functions');
    await mkdir(functionsDir, { recursive: true });
    await writeFile(
      join(functionsDir, 'package.json'),
      JSON.stringify({ scripts: { 'build:watch': 'custom-compiler --watch' } })
    );
    const functionsRuntime = fakeFunctionsRuntime();
    const runBuild = vi.fn().mockResolvedValue(undefined);
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({
        config: config({
          functions: {
            enabled: true,
            path: 'packages/custom functions',
            buildCommand: 'custom-compiler && copy-assets',
          },
        }),
        functionsRuntime,
        runBuild,
      })
    );
    const reserved = await provisioner.reserve({});
    if (reserved.status !== 'reserved') throw new Error('not reserved');
    const prepared = await provisioner.prepare({
      env: {},
      reservations: reserved.reservations,
    });
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;
    expect(runBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'custom-compiler && copy-assets',
        cwd: functionsDir,
      })
    );
    expect(runBuild.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(functionsRuntime.createBuildWatcher).mock.invocationCallOrder[0]
    );
    expect(prepared.runtimes).toContainEqual({
      id: 'functions-build',
      label: 'functions compiler watcher (npm run build:watch)',
      command: 'npm',
      args: ['run', 'build:watch'],
      cwd: functionsDir,
      inheritStdio: true,
      required: true,
    });
    for (const runtime of prepared.runtimes) await runtime.dispose?.();
  });

  it('warns and prepares the host without a compiler watcher when build:watch is absent', async () => {
    await writeFile(
      join(projectRoot, 'rayfin', 'functions', 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc --build' } })
    );
    const functionsRuntime = fakeFunctionsRuntime();
    const runBuild = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn();
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({ functionsRuntime, runBuild, notify })
    );
    const reserved = await provisioner.reserve({});
    if (reserved.status !== 'reserved') throw new Error('not reserved');
    const prepared = await provisioner.prepare({
      env: {},
      reservations: reserved.reservations,
    });
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') throw new Error('not prepared');
    try {
      expect(runBuild).toHaveBeenCalledOnce();
      expect(prepared.runtimes.map((runtime) => runtime.id)).toEqual([
        'frontend',
        'functions',
      ]);
      expect(prepared.warnings).toContain(FUNCTIONS_BUILD_WATCH_WARNING);
      expect(notify).toHaveBeenCalledWith(
        `Warning: ${FUNCTIONS_BUILD_WATCH_WARNING}`
      );
      expect(functionsRuntime.startTypegen).toHaveBeenCalledOnce();
    } finally {
      for (const runtime of prepared.runtimes) await runtime.dispose?.();
    }
  });

  it('fails before starting typegen or the host if the watch configuration is invalid', async () => {
    const functionsRuntime = fakeFunctionsRuntime({
      createBuildWatcher: vi
        .fn()
        .mockRejectedValue(new Error('invalid build:watch')),
    });
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({ functionsRuntime })
    );
    const reserved = await provisioner.reserve({});
    if (reserved.status !== 'reserved') throw new Error('not reserved');
    await expect(
      provisioner.prepare({ env: {}, reservations: reserved.reservations })
    ).resolves.toMatchObject({
      status: 'unavailable',
      code: 'functions-watch-unavailable',
    });
    expect(functionsRuntime.startTypegen).not.toHaveBeenCalled();
  });

  it('closes typegen once when cancellation arrives during typegen startup', async () => {
    const controller = new AbortController();
    const close = vi.fn();
    const functionsRuntime = fakeFunctionsRuntime({
      startTypegen: vi.fn().mockImplementation(async () => {
        controller.abort();
        return { close };
      }),
    });
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({ functionsRuntime })
    );
    const reserved = await provisioner.reserve({});
    if (reserved.status !== 'reserved') throw new Error('not reserved');
    await expect(
      provisioner.prepare({
        env: {},
        reservations: reserved.reservations,
        signal: cancellationTokenFromSignal(controller.signal),
      })
    ).resolves.toEqual({ status: 'cancelled' });
    expect(close).toHaveBeenCalledOnce();
    expect(functionsRuntime.ensureDebuggerConfig).not.toHaveBeenCalled();
  });

  it('degrades a client-patch exception to a warning', async () => {
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({
        patchClient: vi.fn().mockRejectedValue(new Error('patch exploded')),
      })
    );
    const reserved = await provisioner.reserve({});
    if (reserved.status !== 'reserved') throw new Error('not reserved');

    const prepared = await provisioner.prepare({
      env: {},
      reservations: reserved.reservations,
    });

    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;
    expect(prepared.warnings).toContain(
      'Could not update client code for local functions: patch exploded'
    );
  });

  it('returns cancelled when Ctrl-C terminates the functions build', async () => {
    const controller = new AbortController();
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({
        runBuild: vi.fn().mockImplementation(async () => {
          controller.abort();
          throw new Error('build exited with code 143');
        }),
      })
    );
    const reserved = await provisioner.reserve({});
    if (reserved.status !== 'reserved') throw new Error('not reserved');

    const prepared = await provisioner.prepare({
      env: {},
      reservations: reserved.reservations,
      signal: cancellationTokenFromSignal(controller.signal),
    });

    expect(prepared).toEqual({ status: 'cancelled' });
  });

  it('captures build output through the injected sinks', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const buildCommand = `${JSON.stringify(
      process.execPath
    )} -e "process.stdout.write('build-out');process.stderr.write('build-err')"`;
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({
        config: config({
          functions: {
            enabled: true,
            path: 'rayfin/functions',
            buildCommand,
          },
        }),
        runBuild: undefined,
        onBuildStdout: (chunk) => stdout.push(chunk),
        onBuildStderr: (chunk) => stderr.push(chunk),
      })
    );
    const reserved = await provisioner.reserve({});
    if (reserved.status !== 'reserved') throw new Error('not reserved');

    const prepared = await provisioner.prepare({
      env: {},
      reservations: reserved.reservations,
    });

    expect(prepared.status).toBe('prepared');
    expect(stdout.join('')).toBe('build-out');
    expect(stderr.join('')).toBe('build-err');
  });

  it('provides EOF instead of inherited stdin to a detached build', async () => {
    const stdout: string[] = [];
    const buildScript = join(projectRoot, 'read-build-stdin.cjs');
    await writeFile(
      buildScript,
      [
        "process.stdin.setEncoding('utf8');",
        "let input = '';",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => process.stdout.write(input === '' ? 'eof' : input));",
      ].join('\n')
    );
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({
        config: config({
          functions: {
            enabled: true,
            path: 'rayfin/functions',
            buildCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(
              buildScript
            )}`,
          },
        }),
        runBuild: undefined,
        onBuildStdout: (chunk) => stdout.push(chunk),
      })
    );
    const reserved = await provisioner.reserve({});
    if (reserved.status !== 'reserved') throw new Error('not reserved');

    const prepared = await provisioner.prepare({
      env: {},
      reservations: reserved.reservations,
    });

    expect(prepared.status).toBe('prepared');
    expect(stdout.join('')).toBe('eof');
  });

  it('flushes trailing build stderr before returning a failure', async () => {
    const stderr: string[] = [];
    const buildScript = join(projectRoot, 'failing-build.cjs');
    const trailingOutput = 'compiler error\n'.repeat(4_096);
    await writeFile(
      buildScript,
      `process.stderr.write(${JSON.stringify(trailingOutput)}, () => process.exit(7));\n`
    );
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({
        config: config({
          functions: {
            enabled: true,
            path: 'rayfin/functions',
            buildCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(
              buildScript
            )}`,
          },
        }),
        runBuild: undefined,
        onBuildStderr: (chunk) => stderr.push(chunk),
      })
    );
    const reserved = await provisioner.reserve({});
    if (reserved.status !== 'reserved') throw new Error('not reserved');

    const prepared = await provisioner.prepare({
      env: {},
      reservations: reserved.reservations,
    });

    expect(prepared).toMatchObject({
      status: 'unavailable',
      code: 'functions-build-failed',
      message:
        'Could not build the functions package: build failed with exit code 7',
    });
    expect(stderr.join('')).toBe(trailingOutput);
  });

  it.skipIf(process.platform === 'win32')(
    'reports the signal that terminated a build',
    async () => {
      const provisioner = createCliLocalRuntimeProvisioner(
        deps({
          config: config({
            functions: {
              enabled: true,
              path: 'rayfin/functions',
              buildCommand: 'kill -TERM $$',
            },
          }),
          runBuild: undefined,
        })
      );
      const reserved = await provisioner.reserve({});
      if (reserved.status !== 'reserved') throw new Error('not reserved');

      const prepared = await provisioner.prepare({
        env: {},
        reservations: reserved.reservations,
      });

      expect(prepared).toEqual({
        status: 'unavailable',
        code: 'functions-build-failed',
        message:
          'Could not build the functions package: build terminated by SIGTERM',
      });
    }
  );

  it('terminates build descendants when cancellation fires', async () => {
    const controller = new AbortController();
    const buildScript = join(projectRoot, 'spawn-build-child.cjs');
    await writeFile(
      buildScript,
      [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        'console.log(child.pid);',
        'setInterval(() => {}, 1000);',
      ].join('\n')
    );
    let descendantPid: number | undefined;
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({
        config: config({
          functions: {
            enabled: true,
            path: 'rayfin/functions',
            buildCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(
              buildScript
            )}`,
          },
        }),
        runBuild: undefined,
        onBuildStdout: (chunk) => {
          descendantPid ??= Number.parseInt(chunk.trim(), 10);
          controller.abort();
        },
      })
    );
    const reserved = await provisioner.reserve({});
    if (reserved.status !== 'reserved') throw new Error('not reserved');

    const prepared = await provisioner.prepare({
      env: {},
      reservations: reserved.reservations,
      signal: cancellationTokenFromSignal(controller.signal),
    });

    expect(prepared).toEqual({ status: 'cancelled' });
    expect(descendantPid).toBeTypeOf('number');
    if (descendantPid === undefined) return;
    const pid = descendantPid;
    try {
      await vi.waitFor(
        () => {
          expect(isProcessAlive(pid)).toBe(false);
        },
        { timeout: 2_000, interval: 25 }
      );
    } finally {
      if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  it('degrades a failed initial typegen to a warning and closes the watcher on dispose', async () => {
    const close = vi.fn();
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({
        functionsRuntime: fakeFunctionsRuntime({
          startTypegen: vi.fn().mockResolvedValue({
            initialError: new Error('unresolvable udf type'),
            close,
          }),
        }),
      })
    );
    const reserved = await provisioner.reserve({});
    if (reserved.status !== 'reserved') throw new Error('not reserved');

    const prepared = await provisioner.prepare({
      env: {},
      reservations: reserved.reservations,
    });

    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;
    expect(prepared.warnings?.join('\n')).toContain('unresolvable udf type');

    const functions = prepared.runtimes.find((r) => r.id === 'functions');
    await functions?.dispose?.();
    await functions?.dispose?.();
    expect(close).toHaveBeenCalledOnce();
  });

  it('cancels an in-flight debugger probe during disposal', async () => {
    const close = vi.fn();
    const ensureDebuggerConfig = vi.fn().mockImplementation(
      async (input: {
        signal?: {
          isCancellationRequested: boolean;
          onCancellationRequested(listener: () => void): { dispose(): void };
        };
      }) =>
        new Promise<{ status: 'not-ready' }>((resolve) => {
          input.signal?.onCancellationRequested(() =>
            resolve({ status: 'not-ready' })
          );
        })
    );
    const provisioner = createCliLocalRuntimeProvisioner(
      deps({
        functionsRuntime: fakeFunctionsRuntime({
          startTypegen: vi.fn().mockResolvedValue({ close }),
          ensureDebuggerConfig,
        }),
      })
    );
    const reserved = await provisioner.reserve({});
    if (reserved.status !== 'reserved') throw new Error('not reserved');
    const prepared = await provisioner.prepare({
      env: {},
      reservations: reserved.reservations,
    });
    if (prepared.status !== 'prepared') throw new Error('not prepared');

    const functions = prepared.runtimes.find((r) => r.id === 'functions');
    await functions?.dispose?.();

    expect(close).toHaveBeenCalledOnce();
    expect(ensureDebuggerConfig).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.anything() })
    );
  });
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
