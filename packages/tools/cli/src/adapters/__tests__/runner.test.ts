import { spawn } from 'node:child_process';
import { constants } from 'node:os';

import { cancellationTokenFromSignal } from '@microsoft/rayfin-tools-common/_internal/adapters';
import { describe, expect, it, vi } from 'vitest';

import * as platformUtils from '../../utils/platform-utils.js';
import { cliCommandRunner, resolveExitCode } from '../runner.js';

describe('resolveExitCode', () => {
  it('returns the numeric code verbatim when the process exited normally', () => {
    expect(resolveExitCode(0, null)).toBe(0);
    expect(resolveExitCode(3, null)).toBe(3);
    expect(resolveExitCode(137, null)).toBe(137);
  });

  it('maps a signal-terminated process to 128 + signal number', () => {
    expect(resolveExitCode(null, 'SIGTERM')).toBe(
      128 + constants.signals.SIGTERM
    );
    expect(resolveExitCode(null, 'SIGKILL')).toBe(
      128 + constants.signals.SIGKILL
    );
    expect(resolveExitCode(null, 'SIGINT')).toBe(
      128 + constants.signals.SIGINT
    );
  });

  it('never reports a clean 0 for a signal kill', () => {
    expect(resolveExitCode(null, 'SIGKILL')).not.toBe(0);
  });

  it('falls back to 1 for an unknown signal name', () => {
    expect(resolveExitCode(null, 'SIGMADEUP')).toBe(1);
  });

  it('falls back to 1 when neither a code nor a signal is reported', () => {
    expect(resolveExitCode(null, null)).toBe(1);
  });
});

describe('cliCommandRunner.run', () => {
  // Use the running Node binary as a portable, always-present subprocess
  // so these cases work identically on Linux, macOS, and Windows CI.
  const node = process.execPath;

  it('reports launched:true with the child exit code for a normal run', async () => {
    const result = await cliCommandRunner.run(node, ['-e', 'process.exit(3)']);

    expect(result.launched).toBe(true);
    expect(result.exitCode).toBe(3);
    expect(result.cancelled).toBeFalsy();
  });

  it('streams stdout to the onStdout callback and captures it', async () => {
    const chunks: string[] = [];
    const result = await cliCommandRunner.run(
      node,
      ['-e', 'process.stdout.write("hello")'],
      { onStdout: (chunk) => chunks.push(chunk) }
    );

    expect(result.launched).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello');
    expect(chunks.join('')).toContain('hello');
  });

  it('inherits stdio when requested', async () => {
    const spawnSafe = vi.spyOn(platformUtils, 'spawnSafe');

    try {
      const result = await cliCommandRunner.run(
        node,
        ['-e', 'process.exit(0)'],
        { inheritStdio: true }
      );

      expect(result.exitCode).toBe(0);
      expect(spawnSafe).toHaveBeenCalledWith(
        node,
        ['-e', 'process.exit(0)'],
        expect.objectContaining({
          stdio: 'inherit',
        })
      );
    } finally {
      spawnSafe.mockRestore();
    }
  });

  it('reports launched:false with a spawnError when the binary is missing', async () => {
    const result = await cliCommandRunner.run(
      '__rayfin_definitely_not_a_real_binary__',
      []
    );

    expect(result.launched).toBe(false);
    expect(result.spawnError).toContain('command not found');
  });

  it('keeps stdin attached while streaming both outputs without retaining them', async () => {
    const spawnSafe = vi.spyOn(platformUtils, 'spawnSafe');
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      const result = await cliCommandRunner.run(
        node,
        [
          '-e',
          'process.stdout.write("output"); process.stderr.write("warning")',
        ],
        {
          inheritStdin: true,
          captureOutput: false,
          onStdout: (chunk) => stdout.push(chunk),
          onStderr: (chunk) => stderr.push(chunk),
        }
      );
      expect(spawnSafe).toHaveBeenCalledWith(
        node,
        expect.any(Array),
        expect.objectContaining({ stdio: ['inherit', 'pipe', 'pipe'] })
      );
      expect(stdout.join('')).toBe('output');
      expect(stderr.join('')).toBe('warning');
      expect(result).toMatchObject({ exitCode: 0, stdout: '', stderr: '' });
    } finally {
      spawnSafe.mockRestore();
    }
  });

  it('reports cancelled:true when terminated via the cancellation token', async () => {
    const controller = new AbortController();
    const token = cancellationTokenFromSignal(controller.signal);

    // A long-lived child the test will cancel rather than let exit on its own.
    const promise = cliCommandRunner.run(
      node,
      ['-e', 'setTimeout(() => {}, 60000)'],
      { signal: token, inheritStdin: true, captureOutput: false }
    );
    controller.abort();

    const result = await promise;

    expect(result.cancelled).toBe(true);
    // exitCode is documented as unreliable for a cancelled run; callers must
    // check `cancelled` first, so we intentionally do not assert on it here.
  });

  it('passes inherited keyboard input to a child while capturing its output', async () => {
    const runnerUrl = new URL('../runner.ts', import.meta.url).href;
    const childScript =
      'process.stdin.once("data", (chunk) => { process.stdout.write(chunk); process.exit(0); }); setTimeout(() => process.exit(2), 3000).unref();';
    const parentScript = [
      `import { cliCommandRunner } from ${JSON.stringify(runnerUrl)};`,
      `const result = await cliCommandRunner.run(process.execPath, ['-e', ${JSON.stringify(childScript)}], {`,
      'inheritStdin: true, captureOutput: false, onStdout: (chunk) => process.stdout.write(chunk)',
      '}); process.exitCode = result.exitCode;',
    ].join('\n');
    const parent = spawn(
      node,
      ['--import', 'tsx', '--input-type=module', '-e', parentScript],
      {
        cwd: new URL('../../../', import.meta.url),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );
    let output = '';
    let errors = '';
    parent.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    parent.stderr.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
    });
    try {
      const exited = new Promise((resolve, reject) => {
        parent.once('close', resolve);
        parent.once('error', reject);
      });
      parent.stdin.end('keyboard input\n');
      expect(await exited, errors).toBe(0);
      expect(errors).toBe('');
      expect(output).toBe('keyboard input\n');
    } finally {
      parent.kill();
    }
  });

  it('terminates descendants when the cancellation token fires', async () => {
    const controller = new AbortController();
    const token = cancellationTokenFromSignal(controller.signal);
    let descendantPid: number | undefined;

    const parentScript = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      'console.log(child.pid);',
      'setInterval(() => {}, 1000);',
    ].join(' ');
    const resultPromise = cliCommandRunner.run(node, ['-e', parentScript], {
      signal: token,
      onStdout: (chunk) => {
        descendantPid ??= Number.parseInt(chunk.trim(), 10);
        controller.abort();
      },
    });

    const result = await resultPromise;

    expect(result.cancelled).toBe(true);
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
      if (isProcessAlive(pid)) {
        process.kill(pid, 'SIGKILL');
      }
    }
  });

  it('force-kills a process tree that ignores graceful termination', async () => {
    const controller = new AbortController();
    let descendantPid: number | undefined;
    const resistantScript = [
      "process.on('SIGTERM', () => {});",
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });",
      'console.log(child.pid);',
      'setInterval(() => {}, 1000);',
    ].join(' ');
    const resultPromise = cliCommandRunner.run(node, ['-e', resistantScript], {
      signal: cancellationTokenFromSignal(controller.signal),
      onStdout: (chunk) => {
        descendantPid ??= Number.parseInt(chunk.trim(), 10);
        controller.abort();
      },
    });

    const result = await resultPromise;

    expect(result.cancelled).toBe(true);
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
      if (isProcessAlive(pid)) {
        process.kill(pid, 'SIGKILL');
      }
    }
  });

  it('kills a resistant descendant when its group leader exits', async () => {
    const controller = new AbortController();
    let descendantPid: number | undefined;
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });",
      'console.log(child.pid);',
      'setInterval(() => {}, 1000);',
    ].join(' ');
    const resultPromise = cliCommandRunner.run(node, ['-e', parentScript], {
      signal: cancellationTokenFromSignal(controller.signal),
      onStdout: (chunk) => {
        descendantPid ??= Number.parseInt(chunk.trim(), 10);
        controller.abort();
      },
    });

    const result = await resultPromise;

    expect(result.cancelled).toBe(true);
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
      if (isProcessAlive(pid)) {
        process.kill(pid, 'SIGKILL');
      }
    }
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
