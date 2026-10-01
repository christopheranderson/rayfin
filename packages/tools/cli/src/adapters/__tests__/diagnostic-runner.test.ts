import type { CommandRunner } from '@microsoft/rayfin-tools-common/_internal/adapters';
import { describe, expect, it, vi } from 'vitest';

import { createDiagnosticRunner } from '../diagnostic-runner.js';

describe('diagnostic runner', () => {
  it.each([false, true])(
    'preserves terminal inheritance=%s and does not record arguments or environment',
    async (inheritStdio) => {
      const debug = vi.fn();
      const onStdout = vi.fn();
      const run = vi
        .fn<CommandRunner['run']>()
        .mockImplementation(async (_command, _args, options) => {
          expect(options?.inheritStdio).toBe(inheritStdio);
          expect(options?.env).toEqual({ TOKEN: 'private-token' });
          if (!inheritStdio) options?.onStdout?.('last line without newline');
          return { launched: true, exitCode: 0, stdout: '', stderr: '' };
        });
      await createDiagnosticRunner({ run }, { debug }).run(
        'private-command',
        ['private-argument'],
        {
          inheritStdio,
          env: { TOKEN: 'private-token' },
          onStdout,
        }
      );
      expect(onStdout).toHaveBeenCalledTimes(inheritStdio ? 0 : 1);
      expect(JSON.stringify(debug.mock.calls)).not.toContain('private-');
      expect(debug).toHaveBeenCalledWith(
        expect.objectContaining({
          message: inheritStdio
            ? 'Runtime started with inherited terminal; console output is not captured'
            : 'Runtime started with captured output',
          data: { command: 'other' },
        })
      );
      if (!inheritStdio)
        expect(debug).toHaveBeenLastCalledWith({
          area: 'runtime.1.stdout',
          message: 'last line without newline',
        });
    }
  );

  it.each([
    ['npm', 'npm'],
    ['/home/private-user/tools/node', 'node'],
    ['C:\\Users\\private-user\\npm.cmd', 'npm'],
    ['C:\\Tools\\FUNC.EXE', 'func'],
    ['npx.cmd', 'npx'],
    ['/home/private-user/private-command', 'other'],
  ])(
    'labels %s without recording paths or custom names',
    async (command, expected) => {
      const debug = vi.fn();
      const run = vi.fn<CommandRunner['run']>().mockResolvedValue({
        launched: true,
        exitCode: 0,
        stdout: '',
        stderr: '',
      });
      await createDiagnosticRunner({ run }, { debug }).run(command, [
        'private-argument',
      ]);
      expect(debug).toHaveBeenCalledWith({
        area: 'runtime.1',
        message: 'Runtime started with captured output',
        data: { command: expected },
      });
      expect(JSON.stringify(debug.mock.calls)).not.toContain('private-');
    }
  );

  it('associates concurrent runtime streams with their executable', async () => {
    const debug = vi.fn();
    const run = vi
      .fn<CommandRunner['run']>()
      .mockImplementation(async (command, _args, options) => {
        if (command === 'npm') await Promise.resolve();
        options?.onStdout?.('runtime output\n');
        return { launched: true, exitCode: 0, stdout: '', stderr: '' };
      });
    const runner = createDiagnosticRunner({ run }, { debug });
    await Promise.all([runner.run('npm', []), runner.run('func', [])]);
    for (const [area, command] of [
      ['runtime.1', 'npm'],
      ['runtime.2', 'func'],
    ]) {
      expect(debug).toHaveBeenCalledWith({
        area,
        message: 'Runtime started with captured output',
        data: { command },
      });
      expect(debug).toHaveBeenCalledWith({
        area: `${area}.stdout`,
        message: 'runtime output',
      });
    }
  });

  it('flushes a pending line and preserves a runner rejection', async () => {
    const debug = vi.fn();
    const error = new Error('runtime rejected');
    const run = vi
      .fn<CommandRunner['run']>()
      .mockImplementation(async (_command, _args, options) => {
        options?.onStderr?.('failure detail');
        throw error;
      });
    await expect(
      createDiagnosticRunner({ run }, { debug }).run('runtime', [])
    ).rejects.toBe(error);
    expect(debug).toHaveBeenLastCalledWith({
      area: 'runtime.1.stderr',
      message: 'failure detail',
    });
  });
});
