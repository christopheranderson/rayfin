import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';

import {
  cancellationTokenFromSignal,
  createLinkedCancellation,
} from '@microsoft/rayfin-tools-common/_internal/adapters';
import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/functions-types-generator.js', () => ({
  generateFunctionsTypes: vi.fn(),
  watchAndGenerateTypes: vi.fn(),
}));

import { cliCommandRunner } from '../../../adapters/runner.js';
import {
  generateFunctionsTypes,
  watchAndGenerateTypes,
} from '../../../utils/functions-types-generator.js';
import {
  createLocalFunctionsRuntimeService,
  runFunctionsBuild,
} from '../functions-runtime.js';

const mockGenerateFunctionsTypes = vi.mocked(generateFunctionsTypes);
const mockWatchAndGenerateTypes = vi.mocked(watchAndGenerateTypes);

describe('localFunctionsRuntimeService', () => {
  let tempDir: string;
  let closeWatcher: ReturnType<typeof vi.fn>;
  let service: ReturnType<typeof createLocalFunctionsRuntimeService>;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(process.cwd(), '.rayfin-functions-runtime-'));
    closeWatcher = vi.fn();
    service = createLocalFunctionsRuntimeService();
    mockGenerateFunctionsTypes.mockResolvedValue(undefined);
    mockWatchAndGenerateTypes.mockReturnValue({
      close: closeWatcher,
    } as unknown as ReturnType<typeof watchAndGenerateTypes>);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('preserves user settings while replacing managed values', async () => {
    const settingsPath = join(tempDir, 'local.settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify({
        IsEncrypted: true,
        Values: { USER_VALUE: 'keep', RAYFIN_API_URL: 'old' },
      })
    );

    await service.upsertLocalSettings(tempDir, {
      RAYFIN_API_URL: 'https://new.example',
    });

    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      IsEncrypted: boolean;
      Values: Record<string, string>;
    };
    expect(settings).toEqual({
      IsEncrypted: true,
      Values: {
        FUNCTIONS_WORKER_RUNTIME: 'node',
        USER_VALUE: 'keep',
        RAYFIN_API_URL: 'https://new.example',
      },
    });
  });

  it.each(['127.0.0.1', '0.0.0.0'])(
    'reports a function port occupied on %s as unavailable',
    async (host) => {
      const server = createServer();
      await new Promise<void>((resolve) =>
        server.listen(0, host, () => resolve())
      );
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('No TCP port');

      try {
        await expect(
          service.findAvailablePort(address.port, 1)
        ).resolves.toEqual({
          port: null,
          searched: { from: address.port, to: address.port },
        });
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  );

  it('normalizes declared redirect URIs and includes standard origins', () => {
    const config = {
      services: {
        auth: {
          enabled: true,
          allowedRedirectUris: ['https://app.example/callback', 'not-a-url'],
        },
      },
    } as unknown as RayfinConfig;

    const origins = service.resolveCorsOrigins(config);

    expect(origins[0]).toBe('https://app.example');
    expect(origins).toContain('https://app.example');
    expect(origins).toContain('http://localhost:5173');
    expect(origins).not.toContain('not-a-url');
  });

  it('includes standard origins when config is unavailable', () => {
    const origins = service.resolveCorsOrigins(null);

    expect(origins).toContain('http://localhost:5173');
  });

  it('returns the initial typegen failure and closes its watcher once', async () => {
    mockGenerateFunctionsTypes.mockRejectedValue(new Error('invalid schema'));

    const session = await service.startTypegen({
      functionsDir: tempDir,
      onRegenerate: vi.fn(),
      onError: vi.fn(),
    });
    session.close();
    session.close();

    expect(session.initialError?.message).toBe('invalid schema');
    expect(mockWatchAndGenerateTypes).toHaveBeenCalledOnce();
    expect(closeWatcher).toHaveBeenCalledOnce();
  });

  it('uses the package watch script without replacing custom tooling', async () => {
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({ scripts: { 'build:watch': 'custom-bundler --watch' } })
    );
    await expect(service.createBuildWatcher(tempDir)).resolves.toEqual({
      id: 'functions-build',
      label: 'functions compiler watcher (npm run build:watch)',
      command: 'npm',
      args: ['run', 'build:watch'],
      cwd: tempDir,
      inheritStdio: true,
      required: true,
    });
  });

  it.each([{}, { scripts: {} }, { scripts: { build: 'tsc --build' } }])(
    'omits the compiler watcher when build:watch is not configured (%j)',
    async (pkg) => {
      await writeFile(join(tempDir, 'package.json'), JSON.stringify(pkg));
      await expect(
        service.createBuildWatcher(tempDir)
      ).resolves.toBeUndefined();
    }
  );

  it.each(['', '   ', 123, null])(
    'rejects an invalid watch script (%s) with a recovery hint',
    async (script) => {
      await writeFile(
        join(tempDir, 'package.json'),
        JSON.stringify({ scripts: { 'build:watch': script } })
      );
      await expect(service.createBuildWatcher(tempDir)).rejects.toThrow(
        /Add a long-running build:watch script/
      );
    }
  );

  it('does not treat unreadable or malformed package.json as a missing watch script', async () => {
    await expect(service.createBuildWatcher(tempDir)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await writeFile(join(tempDir, 'package.json'), '{ invalid json');
    await expect(service.createBuildWatcher(tempDir)).rejects.toBeInstanceOf(
      SyntaxError
    );
  });

  it('runs real TypeScript watch, recovers after diagnostics, and stops on cancellation', async () => {
    const functionsDir = join(tempDir, 'custom functions');
    await mkdir(join(functionsDir, 'src'), { recursive: true });
    const compiler = createRequire(import.meta.url).resolve(
      'typescript/bin/tsc'
    );
    const buildCommand = `"${process.execPath}" "${compiler}" --build`;
    await writeFile(
      join(functionsDir, 'package.json'),
      JSON.stringify({
        scripts: {
          'build:watch': `node "${compiler}" --build --watch --preserveWatchOutput`,
        },
      })
    );
    await writeFile(
      join(functionsDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'CommonJS',
          rootDir: 'src',
          outDir: 'dist',
          types: [],
          composite: true,
          noEmitOnError: true,
        },
        include: ['src/**/*.ts'],
      })
    );
    const source = join(functionsDir, 'src', 'handler.ts');
    const emitted = join(functionsDir, 'dist', 'handler.js');
    await writeFile(source, 'export const marker: number = 1;\n');
    await runFunctionsBuild({ command: buildCommand, cwd: functionsDir });
    expect(await readFile(emitted, 'utf8')).toContain('marker = 1');
    const watcher = await service.createBuildWatcher(functionsDir);
    if (!watcher) throw new Error('Expected a compiler watcher');
    const cancellation = createLinkedCancellation();
    let output = '';
    let stopped = false;
    const running = cliCommandRunner
      .run(watcher.command, watcher.args, {
        cwd: watcher.cwd,
        signal: cancellation.token,
        onStdout: (chunk) => {
          output += chunk;
        },
        onStderr: (chunk) => {
          output += chunk;
        },
      })
      .then((result) => {
        stopped = true;
        return result;
      });
    try {
      await vi.waitFor(
        () => expect(output).toContain('Watching for file changes'),
        { timeout: 15_000 }
      );
      await writeFile(source, 'export const marker: number = "invalid";\n');
      await vi.waitFor(() => expect(output).toContain('TS2322'), {
        timeout: 10_000,
      });
      expect(stopped).toBe(false);
      expect(await readFile(emitted, 'utf8')).toContain('marker = 1');
      await writeFile(source, 'export const marker: number = 2;\n');
      await vi.waitFor(
        async () => {
          expect(await readFile(emitted, 'utf8')).toContain('marker = 2');
        },
        { timeout: 10_000 }
      );
      expect(stopped).toBe(false);
    } finally {
      cancellation.cancel();
      await running;
      cancellation.dispose();
    }
    expect((await running).cancelled).toBe(true);
    const before = await readFile(emitted, 'utf8');
    await writeFile(source, 'export const marker: number = 3;\n');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await readFile(emitted, 'utf8')).toBe(before);
  });

  it('creates a debugger config once the functions host is ready', async () => {
    const service = createLocalFunctionsRuntimeService({
      waitForHostReady: vi.fn().mockResolvedValue(true),
    });
    const functionsDir = join(tempDir, 'functions');
    const input = {
      projectRoot: tempDir,
      functionsDir,
      port: '7071',
      inspectPort: '9230',
    };

    await expect(service.ensureDebuggerConfig(input)).resolves.toEqual({
      status: 'written',
      path: join(tempDir, '.vscode', 'launch.json'),
    });
    await expect(service.ensureDebuggerConfig(input)).resolves.toEqual({
      status: 'unchanged',
      path: join(tempDir, '.vscode', 'launch.json'),
    });

    const launch = JSON.parse(
      await readFile(join(tempDir, '.vscode', 'launch.json'), 'utf8')
    ) as { configurations: Array<Record<string, unknown>> };
    expect(launch).not.toHaveProperty('FUNCTIONS_WORKER_RUNTIME');
    expect(launch.configurations).toContainEqual(
      expect.objectContaining({
        name: 'Functions: Attach',
        port: 9230,
        localRoot: '${workspaceFolder}/functions',
      })
    );
  });

  it('preserves existing launch config entries and the legacy runtime key', async () => {
    const vscodeDir = join(tempDir, '.vscode');
    await mkdir(vscodeDir);
    const launchPath = join(vscodeDir, 'launch.json');
    await writeFile(
      launchPath,
      '{"version":"0.1.0","configurations":[{"name":"Other","type":"node"}]}'
    );
    const service = createLocalFunctionsRuntimeService({
      waitForHostReady: vi.fn().mockResolvedValue(true),
    });

    await service.ensureDebuggerConfig({
      projectRoot: tempDir,
      functionsDir: join(tempDir, 'functions'),
      port: '7071',
      inspectPort: '9229',
    });

    const raw = await readFile(launchPath, 'utf8');
    const launch = JSON.parse(raw) as {
      version: string;
      configurations: Array<{ name: string }>;
    };
    expect(Object.keys(launch)).toEqual([
      'FUNCTIONS_WORKER_RUNTIME',
      'version',
      'configurations',
    ]);
    expect(launch.version).toBe('0.1.0');
    expect(
      launch.configurations.map((configuration) => configuration.name)
    ).toEqual(['Other', 'Functions: Attach']);
    expect(raw.endsWith('}\n')).toBe(true);
  });

  describe('existing Functions: Attach entry', () => {
    const existing = {
      version: '0.2.0',
      configurations: [
        { name: 'Other', type: 'node' },
        {
          type: 'node',
          request: 'attach',
          name: 'Functions: Attach',
          port: 9229,
          restart: true,
          localRoot: '${workspaceFolder}/custom',
        },
      ],
    };
    let launchPath: string;
    let readyService: ReturnType<typeof createLocalFunctionsRuntimeService>;
    const ensure = (
      overrides: Partial<
        Parameters<typeof readyService.ensureDebuggerConfig>[0]
      >
    ): ReturnType<typeof readyService.ensureDebuggerConfig> =>
      readyService.ensureDebuggerConfig({
        projectRoot: tempDir,
        functionsDir: join(tempDir, 'functions'),
        port: '7071',
        inspectPort: '9230',
        ...overrides,
      });

    beforeEach(async () => {
      const vscodeDir = join(tempDir, '.vscode');
      await mkdir(vscodeDir);
      launchPath = join(vscodeDir, 'launch.json');
      await writeFile(launchPath, JSON.stringify(existing));
      readyService = createLocalFunctionsRuntimeService({
        waitForHostReady: vi.fn().mockResolvedValue(true),
      });
    });

    it('syncs only the port when the inspector moved', async () => {
      await expect(ensure({ syncPort: true })).resolves.toEqual({
        status: 'updated',
        path: launchPath,
        port: 9230,
      });

      const raw = await readFile(launchPath, 'utf8');
      expect(JSON.parse(raw)).toEqual({
        version: '0.2.0',
        configurations: [
          existing.configurations[0],
          { ...existing.configurations[1], port: 9230 },
        ],
      });
      expect(raw.endsWith('}\n')).toBe(true);
    });

    it('leaves a matching port untouched', async () => {
      await expect(
        ensure({ inspectPort: '9229', syncPort: true })
      ).resolves.toEqual({ status: 'unchanged', path: launchPath });
      await expect(readFile(launchPath, 'utf8')).resolves.toBe(
        JSON.stringify(existing)
      );
    });

    it('leaves the port alone without an active inspector', async () => {
      await expect(ensure({ syncPort: false })).resolves.toEqual({
        status: 'unchanged',
        path: launchPath,
      });
      await expect(readFile(launchPath, 'utf8')).resolves.toBe(
        JSON.stringify(existing)
      );
    });
  });

  it('does not overwrite a debugger config containing JSONC', async () => {
    const vscodeDir = join(tempDir, '.vscode');
    const launchPath = join(vscodeDir, 'launch.json');
    await mkdir(vscodeDir);
    await writeFile(launchPath, '{ // keep this comment\n}');
    const service = createLocalFunctionsRuntimeService({
      waitForHostReady: vi.fn().mockResolvedValue(true),
    });

    await expect(
      service.ensureDebuggerConfig({
        projectRoot: tempDir,
        functionsDir: join(tempDir, 'functions'),
        port: '7071',
        inspectPort: '9229',
      })
    ).resolves.toEqual({ status: 'invalid-json', path: launchPath });
    await expect(readFile(launchPath, 'utf8')).resolves.toBe(
      '{ // keep this comment\n}'
    );
  });

  it('skips debugger configuration while the functions host is unavailable', async () => {
    const service = createLocalFunctionsRuntimeService({
      waitForHostReady: vi.fn().mockResolvedValue(false),
    });

    await expect(
      service.ensureDebuggerConfig({
        projectRoot: tempDir,
        functionsDir: join(tempDir, 'functions'),
        port: '7071',
        inspectPort: '9229',
      })
    ).resolves.toEqual({ status: 'not-ready' });
  });

  it('forwards cancellation to the debugger health probe', async () => {
    const waitForHostReady = vi.fn().mockResolvedValue(false);
    const service = createLocalFunctionsRuntimeService({ waitForHostReady });
    const controller = new AbortController();
    const signal = cancellationTokenFromSignal(controller.signal);

    await service.ensureDebuggerConfig({
      projectRoot: tempDir,
      functionsDir: join(tempDir, 'functions'),
      port: '7071',
      inspectPort: '9229',
      signal,
    });

    expect(waitForHostReady).toHaveBeenCalledWith('7071', signal);
  });

  it('interrupts the default debugger readiness wait on cancellation', async () => {
    const controller = new AbortController();
    const resultPromise = service.ensureDebuggerConfig({
      projectRoot: tempDir,
      functionsDir: join(tempDir, 'functions'),
      port: '7071',
      inspectPort: '9229',
      signal: cancellationTokenFromSignal(controller.signal),
    });

    controller.abort();

    await expect(resultPromise).resolves.toEqual({ status: 'not-ready' });
  });

  it('creates local settings when the file does not exist', async () => {
    const functionsDir = join(tempDir, 'functions');

    await service.upsertLocalSettings(functionsDir, {
      AZURE_FUNCTIONS_ENVIRONMENT: 'Development',
    });

    await expect(
      readFile(join(functionsDir, 'local.settings.json'), 'utf8')
    ).resolves.toBe(
      `${JSON.stringify(
        {
          IsEncrypted: false,
          Values: {
            FUNCTIONS_WORKER_RUNTIME: 'node',
            AZURE_FUNCTIONS_ENVIRONMENT: 'Development',
          },
        },
        null,
        2
      )}\n`
    );
  });

  it('scans forward to the first available port', async () => {
    const isPortFree = vi
      .fn<(port: number) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const scanningService = createLocalFunctionsRuntimeService({ isPortFree });

    await expect(scanningService.findAvailablePort(7071, 3)).resolves.toEqual({
      port: 7073,
      searched: { from: 7071, to: 7073 },
    });
    expect(isPortFree.mock.calls).toEqual([[7071], [7072], [7073]]);
  });

  it('keeps consecutive runtime allocations exclusive within a session', async () => {
    const reservedPorts = new Set([7071]);
    const isPortFree = vi
      .fn<(port: number) => Promise<boolean>>()
      .mockResolvedValue(true);
    const scanningService = createLocalFunctionsRuntimeService({
      isPortFree,
      reservedPorts,
    });

    await expect(scanningService.findAvailablePort(7071, 3)).resolves.toEqual({
      port: 7072,
      searched: { from: 7071, to: 7072 },
    });
    await expect(scanningService.findAvailablePort(7071, 3)).resolves.toEqual({
      port: 7073,
      searched: { from: 7071, to: 7073 },
    });
    expect(isPortFree.mock.calls).toEqual([[7072], [7073]]);
    expect(reservedPorts).toEqual(new Set([7071, 7072, 7073]));
  });

  it('uses the default bounded port scan window', async () => {
    const isPortFree = vi
      .fn<(port: number) => Promise<boolean>>()
      .mockResolvedValue(false);
    const scanningService = createLocalFunctionsRuntimeService({ isPortFree });

    await expect(scanningService.findAvailablePort(7071)).resolves.toEqual({
      port: null,
      searched: { from: 7071, to: 7078 },
    });
    expect(isPortFree.mock.calls).toEqual([
      [7071],
      [7072],
      [7073],
      [7074],
      [7075],
      [7076],
      [7077],
      [7078],
    ]);
  });

  it('deduplicates CORS origins', () => {
    const config = {
      services: {
        auth: {
          enabled: true,
          allowedRedirectUris: [
            'http://localhost:5173/callback',
            'http://localhost:5173/other',
          ],
        },
      },
    } as unknown as RayfinConfig;

    const origins = service.resolveCorsOrigins(config);

    expect(
      origins.filter((origin) => origin === 'http://localhost:5173')
    ).toHaveLength(1);
  });

  it('uses standard CORS origins when services are missing', () => {
    const origins = service.resolveCorsOrigins({} as RayfinConfig);

    expect(origins).toContain('http://localhost:5173');
  });
});
