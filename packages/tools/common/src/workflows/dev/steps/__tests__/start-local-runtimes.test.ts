import { describe, expect, it, vi } from 'vitest';

import {
  cancellationTokenFromSignal,
  type CommandRunner,
  type RunResult,
} from '../../../../adapters/index.js';
import type { LocalRuntimeSpec } from '../../runtimes.js';
import { startLocalRuntimes } from '../start-local-runtimes.js';

const frontend: LocalRuntimeSpec = {
  id: 'frontend',
  label: 'frontend dev server',
  command: 'npm',
  args: ['run', 'dev'],
  cwd: '/p/web',
};
const functions: LocalRuntimeSpec = {
  id: 'functions',
  label: 'functions runtime',
  command: 'func',
  args: ['start'],
  cwd: '/p/rayfin/functions',
};

function runnerReturning(...results: RunResult[]): CommandRunner {
  const run = vi.fn();
  for (const r of results) run.mockResolvedValueOnce(r);
  return { run };
}

const deps = (runner: CommandRunner) => ({
  runner,
  progress: { report: vi.fn() },
});

describe('startLocalRuntimes', () => {
  it('starts every runtime with the injected env and reports launched ids', async () => {
    const runner = runnerReturning(
      { launched: true, exitCode: 0, stdout: '', stderr: '' },
      { launched: true, exitCode: 0, stdout: '', stderr: '' }
    );

    const result = await startLocalRuntimes(
      { runtimes: [frontend, functions], env: { API: 'x' } },
      deps(runner)
    );

    expect(result.started).toEqual(['frontend', 'functions']);
    expect(result.warnings).toEqual([]);
    expect(runner.run).toHaveBeenCalledWith(
      'npm',
      ['run', 'dev'],
      expect.objectContaining({ cwd: '/p/web', env: { API: 'x' } })
    );
  });

  it('warns when a runtime never launches', async () => {
    const runner = runnerReturning({
      launched: false,
      spawnError: 'func: command not found',
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    const result = await startLocalRuntimes(
      { runtimes: [functions], env: {} },
      deps(runner)
    );

    expect(result.started).toEqual([]);
    expect(result.warnings[0]).toContain('command not found');
  });

  it('warns on a self-terminated non-zero exit but not on cancellation', async () => {
    const runner = runnerReturning(
      { launched: true, exitCode: 1, stdout: '', stderr: '' },
      { launched: true, cancelled: true, exitCode: 137, stdout: '', stderr: '' }
    );

    const result = await startLocalRuntimes(
      { runtimes: [frontend, functions], env: {} },
      deps(runner)
    );

    expect(result.started).toEqual(['frontend', 'functions']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('exited with code 1');
  });

  it('merges per-runtime env over the shared backend wiring', async () => {
    const runner = runnerReturning({
      launched: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    await startLocalRuntimes(
      {
        runtimes: [{ ...functions, env: { API: 'override', EXTRA: 'y' } }],
        env: { API: 'shared', KEEP: 'x' },
      },
      deps(runner)
    );

    expect(runner.run).toHaveBeenCalledWith(
      'func',
      ['start'],
      expect.objectContaining({
        env: { API: 'override', KEEP: 'x', EXTRA: 'y' },
      })
    );
  });

  it('forwards inherited stdio for an interactive runtime', async () => {
    const runner = runnerReturning({
      launched: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    await startLocalRuntimes(
      {
        runtimes: [{ ...functions, inheritStdio: true }],
        env: {},
      },
      deps(runner)
    );

    expect(runner.run).toHaveBeenCalledWith(
      'func',
      ['start'],
      expect.objectContaining({ inheritStdio: true })
    );
  });

  it('fails and cancels siblings when a required runtime never launches', async () => {
    const run = vi
      .fn()
      .mockImplementationOnce(
        async (_c: string, _a: string[], options: { signal?: unknown }) =>
          // The frontend outlives the failed sibling only until the linked
          // token fires, which is what a real long-running dev server does.
          new Promise((resolve) => {
            (
              options.signal as {
                onCancellationRequested(cb: () => void): void;
              }
            ).onCancellationRequested(() =>
              resolve({
                launched: true,
                cancelled: true,
                exitCode: 137,
                stdout: '',
                stderr: '',
              })
            );
          })
      )
      .mockResolvedValueOnce({
        launched: false,
        spawnError: 'func: command not found',
        exitCode: 0,
        stdout: '',
        stderr: '',
      });

    const result = await startLocalRuntimes(
      {
        runtimes: [frontend, { ...functions, required: true }],
        env: {},
      },
      deps({ run })
    );

    expect(result.failure).toEqual({
      code: 'runtime-launch-failed',
      message: expect.stringContaining(
        'command not found'
      ) as unknown as string,
    });
    expect(result.started).toEqual(['frontend']);
  });

  it('fails when a required runtime exits on its own', async () => {
    const runner = runnerReturning({
      launched: true,
      exitCode: 1,
      stdout: '',
      stderr: '',
    });

    const result = await startLocalRuntimes(
      { runtimes: [{ ...functions, required: true }], env: {} },
      deps(runner)
    );

    expect(result.failure?.code).toBe('runtime-exited');
    expect(result.failure?.message).toContain('exited with code 1');
    expect(result.warnings).toEqual([]);
  });

  it.each([
    [
      {
        launched: false,
        spawnError: 'port already claimed',
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'Could not start functions runtime on port 7071: port already claimed',
    ],
    [
      { launched: true, exitCode: 1, stdout: '', stderr: '' },
      'functions runtime on port 7071 exited with code 1.',
    ],
  ])(
    'includes the runtime port in failure diagnostics',
    async (result, message) => {
      const runner = runnerReturning(result);

      const outcome = await startLocalRuntimes(
        {
          runtimes: [
            {
              ...functions,
              label: 'functions runtime on port 7071',
              required: true,
            },
          ],
          env: {},
        },
        deps(runner)
      );

      expect(outcome.failure?.message).toBe(message);
    }
  );

  it('treats a cancelled required runtime as a clean shutdown', async () => {
    const runner = runnerReturning({
      launched: true,
      cancelled: true,
      exitCode: 137,
      stdout: '',
      stderr: '',
    });

    const result = await startLocalRuntimes(
      { runtimes: [{ ...functions, required: true }], env: {} },
      deps(runner)
    );

    expect(result.failure).toBeUndefined();
    expect(result.started).toEqual(['functions']);
  });

  it('reports parent cancellation while runtimes are active', async () => {
    const controller = new AbortController();
    const runner: CommandRunner = {
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
    };

    const result = await startLocalRuntimes(
      { runtimes: [frontend], env: {} },
      {
        ...deps(runner),
        signal: cancellationTokenFromSignal(controller.signal),
      }
    );

    expect(result.cancelled).toBe(true);
    expect(result.failure).toBeUndefined();
  });

  it('cancels already-started siblings when a runner rejects', async () => {
    const siblingCancelled = vi.fn();
    const run = vi
      .fn()
      .mockImplementationOnce(
        async (
          _command: string,
          _args: string[],
          options: { signal?: unknown }
        ) =>
          new Promise((resolve) => {
            (
              options.signal as {
                onCancellationRequested(listener: () => void): void;
              }
            ).onCancellationRequested(() => {
              siblingCancelled();
              resolve({
                launched: true,
                cancelled: true,
                exitCode: 143,
                stdout: '',
                stderr: '',
              });
            });
          })
      )
      .mockRejectedValueOnce(new Error('runner failed unexpectedly'));

    await expect(
      startLocalRuntimes(
        { runtimes: [frontend, functions], env: {} },
        deps({ run })
      )
    ).rejects.toThrow('runner failed unexpectedly');
    expect(siblingCancelled).toHaveBeenCalledOnce();
  });
});
