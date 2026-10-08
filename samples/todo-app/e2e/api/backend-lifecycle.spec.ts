import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildBackendStartInvocation,
  E2E_BACKEND_PID_FILE_ENV_VAR,
  forceRestartBackend,
} from '../shared/backend';

const spawnMock = vi.hoisted(() => vi.fn());
const frontendMocks = vi.hoisted(() => ({
  resolveFrontendUrl: vi.fn(() => 'http://localhost:5197'),
  waitForFrontend: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('child_process', async (importActual) => ({
  ...(await importActual<typeof import('child_process')>()),
  spawn: spawnMock,
}));
vi.mock('../shared/frontend', () => frontendMocks);

describe('backend lifecycle', () => {
  let originalPidFile: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    frontendMocks.resolveFrontendUrl.mockReturnValue('http://localhost:5197');
    frontendMocks.waitForFrontend.mockResolvedValue(undefined);
    originalPidFile = process.env[E2E_BACKEND_PID_FILE_ENV_VAR];
    tempDir = mkdtempSync(join(tmpdir(), 'rayfin-backend-lifecycle-'));
    process.env[E2E_BACKEND_PID_FILE_ENV_VAR] = join(tempDir, 'rayfin-dev.pid');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalPidFile === undefined) {
      delete process.env[E2E_BACKEND_PID_FILE_ENV_VAR];
    } else {
      process.env[E2E_BACKEND_PID_FILE_ENV_VAR] = originalPidFile;
    }
    rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps ordinary starts on the existing local-dev script', () => {
    const env = {
      COMPOSE_FILE: 'caller-compose.yml',
      NODE_OPTIONS: '--inspect',
      PATH: process.env.PATH,
    };

    const invocation = buildBackendStartInvocation({}, env);

    expect(invocation).toEqual({
      command: process.platform === 'win32' ? 'rushx.cmd' : 'rushx',
      args: ['rayfin:dev:local'],
      env: {
        COMPOSE_FILE: 'caller-compose.yml',
        PATH: process.env.PATH,
        CI: 'true',
      },
    });
    expect(env).toEqual({
      COMPOSE_FILE: 'caller-compose.yml',
      NODE_OPTIONS: '--inspect',
      PATH: process.env.PATH,
    });
  });

  it('appends the no-pull override only for opted-in starts', () => {
    const env = {
      NODE_OPTIONS: '--inspect',
      PATH: process.env.PATH,
    };

    const invocation = buildBackendStartInvocation(
      { reuseExistingImages: true },
      env
    );

    expect(invocation).toEqual({
      command: process.platform === 'win32' ? 'rayfin.cmd' : 'rayfin',
      args: ['dev', '--provider', 'docker'],
      env: {
        PATH: process.env.PATH,
        CI: 'true',
        RAYFIN_FEATURE_FLAGS: 'docker-local-dev',
        COMPOSE_FILE: [
          'docker-compose.override.yml',
          'e2e/docker-compose.restart-no-pull.yml',
        ].join(delimiter),
        COMPOSE_PROJECT_DIRECTORY: '../..',
      },
    });
    expect(env).toEqual({
      NODE_OPTIONS: '--inspect',
      PATH: process.env.PATH,
    });
  });

  it('uses confirmed Docker maintenance purge and aborts restart on failure', async () => {
    spawnMock.mockImplementationOnce(() => {
      const child = new EventEmitter() as ChildProcess;
      process.nextTick(() => child.emit('exit', 17));
      return child;
    });

    await expect(forceRestartBackend()).rejects.toThrow(
      'Purge exited with code 17'
    );

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenCalledWith(
      process.platform === 'win32' ? 'rayfin.cmd' : 'rayfin',
      ['--yes', 'dev', '--down', '--purge'],
      expect.objectContaining({
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: expect.objectContaining({
          RAYFIN_FEATURE_FLAGS: 'docker-local-dev',
          CI: 'true',
        }),
      })
    );
  });

  it('terminates the workflow-owned process group before purging', async () => {
    const pidFile = process.env[E2E_BACKEND_PID_FILE_ENV_VAR]!;
    writeFileSync(pidFile, '4242\n');
    const kill = vi
      .spyOn(process, 'kill')
      .mockImplementation((_pid, signal) => {
        if (signal === 0) {
          throw Object.assign(new Error('process exited'), { code: 'ESRCH' });
        }
        return true;
      });
    spawnMock.mockImplementationOnce(() => {
      const child = new EventEmitter() as ChildProcess;
      process.nextTick(() => child.emit('exit', 17));
      return child;
    });

    await expect(forceRestartBackend()).rejects.toThrow(
      'Purge exited with code 17'
    );

    const processGroup = process.platform === 'win32' ? 4242 : -4242;
    expect(kill).toHaveBeenNthCalledWith(1, processGroup, 'SIGTERM');
    expect(kill).toHaveBeenNthCalledWith(2, processGroup, 0);
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(existsSync(pidFile)).toBe(false);
  });

  it('rejects when the dev process exits after its progress marker', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('not running')));
    spawnMock
      .mockImplementationOnce(() => {
        const purge = new EventEmitter() as ChildProcess;
        process.nextTick(() => purge.emit('exit', 0));
        return purge;
      })
      .mockImplementationOnce(() => {
        const child = new EventEmitter() as ChildProcess;
        Object.assign(child, {
          pid: 5252,
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
          exitCode: null,
          signalCode: null,
          kill: vi.fn(),
        });
        process.nextTick(() => {
          child.stderr?.emit('data', 'Starting frontend dev server');
          setTimeout(() => {
            child.exitCode = 1;
            child.emit('exit', 1, null);
          }, 0);
        });
        return child;
      });
    frontendMocks.waitForFrontend.mockImplementationOnce(
      async (_url, options: { signal?: AbortSignal }) => {
        options.signal?.throwIfAborted();
        await new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true }
          );
        });
      }
    );

    await expect(
      forceRestartBackend({ reuseExistingImages: true })
    ).rejects.toThrow('Backend dev process exited with code 1.');

    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      process.platform === 'win32' ? 'rayfin.cmd' : 'rayfin',
      ['--yes', 'dev', '--down', '--purge'],
      expect.objectContaining({ stdio: 'inherit' })
    );
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      process.platform === 'win32' ? 'rayfin.cmd' : 'rayfin',
      ['dev', '--provider', 'docker'],
      expect.objectContaining({
        env: expect.objectContaining({
          COMPOSE_FILE: [
            'docker-compose.override.yml',
            'e2e/docker-compose.restart-no-pull.yml',
          ].join(delimiter),
        }),
      })
    );
    expect(frontendMocks.resolveFrontendUrl).toHaveBeenCalledOnce();
    expect(frontendMocks.waitForFrontend).toHaveBeenCalledWith(
      'http://localhost:5197',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(
      readFileSync(process.env[E2E_BACKEND_PID_FILE_ENV_VAR]!, 'utf8').trim()
    ).toBe('5252');
  });
});
