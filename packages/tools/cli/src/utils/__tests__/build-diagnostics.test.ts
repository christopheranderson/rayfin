import { spawn } from 'child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBuildOutput } from '../../adapters/child-output.js';
import { createDiagnosticOutput } from '../../diagnostics/output.js';
import { runServiceBuildCommand } from '../config-utils.js';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

describe('build diagnostics', () => {
  it('retains a bounded tail of complete compiler lines after the diagnostic capture limit', () => {
    const debug = vi.fn();
    const output = createBuildOutput({ debug }, 'functions.build');
    output.stdout(`${'a'.repeat(2_000)}\n`.repeat(600));
    output.stdout(
      '/workspaces/app/src/hello.ts(12,5): error TS2322: Type mismatch\n'
    );
    output.stderr('Connection failed: Password=');
    output.stderr('private-password;\n');
    output.stderr('last diagnostic');
    output.end();
    const tail = output.tail();
    expect(tail).toContain('[Earlier build output omitted]');
    expect(Buffer.byteLength(tail)).toBeLessThan(65 * 1024);
    expect(tail).toContain('/workspaces/app/src/hello.ts(12,5): error TS2322');
    expect(tail).toContain('Password=[REDACTED]');
    expect(tail).not.toContain('private-password');
    expect(tail).toContain('last diagnostic\n');
    expect(JSON.stringify(debug.mock.calls)).toContain(
      '[Output capture truncated at 1 MiB]'
    );
  });

  it('marks oversized build lines and preserves later output', () => {
    const output = createBuildOutput({ debug: vi.fn() }, 'functions.build');
    output.stdout(`${'x'.repeat(20 * 1024)}\n`);
    output.stderr('src/file.ts:1:2 compiler error\n');
    expect(output.tail()).toBe(
      '[Build output line truncated]\nsrc/file.ts:1:2 compiler error\n'
    );
  });

  it.each([0, 1])(
    'captures both streams without terminal output for exit %s',
    async (exitCode) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      vi.mocked(spawn).mockReturnValue(
        child as unknown as ReturnType<typeof spawn>
      );
      const debug = vi.fn();
      const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const result = runServiceBuildCommand('.', 'build', {
        output: 'capture',
        diagnostics: { debug },
      });
      child.stdout.write('successful build detail\n');
      child.stderr.write('compiler failure detail');
      child.emit('close', exitCode);

      await expect(result).resolves.toBe(exitCode === 0);
      expect(debug).toHaveBeenCalledWith({
        area: 'build.stdout',
        message: 'successful build detail',
      });
      expect(debug).toHaveBeenCalledWith({
        area: 'build.stderr',
        message: 'compiler failure detail',
      });
      expect(write).not.toHaveBeenCalled();
    }
  );

  it.each(['inherit', 'on-failure', 'capture'] as const)(
    'keeps the %s rendering policy when a sink is supplied',
    async (output) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      vi.mocked(spawn).mockReturnValue(
        child as unknown as ReturnType<typeof spawn>
      );
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const writeOutput = vi.fn();
      const debug = vi.fn();
      const result = runServiceBuildCommand('.', 'build', {
        output,
        diagnostics: { debug },
        writeOutput,
      });
      child.stdout.write('output\n');
      child.stderr.write('error\n');
      expect(stdout).toHaveBeenCalledTimes(output === 'inherit' ? 1 : 0);
      expect(stderr).toHaveBeenCalledTimes(output === 'inherit' ? 1 : 0);
      expect(writeOutput).not.toHaveBeenCalled();
      child.emit('close', 1);
      await expect(result).resolves.toBe(false);
      expect(writeOutput).toHaveBeenCalledTimes(
        output === 'on-failure' ? 1 : 0
      );
      expect(debug).toHaveBeenCalledWith({
        area: 'build.stdout',
        message: 'output',
      });
      expect(debug).toHaveBeenCalledWith({
        area: 'build.stderr',
        message: 'error',
      });
    }
  );

  it('reassembles split credentials and bounds capture', () => {
    const debug = vi.fn();
    const output = createDiagnosticOutput({ debug }, 'build');
    output.write(Buffer.from('Bearer '));
    expect(debug).not.toHaveBeenCalled();
    output.write(Buffer.from('credential\n'));
    expect(debug).toHaveBeenCalledWith({
      area: 'build',
      message: 'Bearer credential',
    });
    output.write(Buffer.alloc(1024 * 1024, 'x'));
    output.write(Buffer.from('not captured\n'));
    output.end();
    expect(debug.mock.calls).toHaveLength(2);
    expect(debug).toHaveBeenLastCalledWith({
      area: 'build',
      message: '[Output capture truncated at 1 MiB]',
    });
  });

  it.each([false, true])(
    'keeps exact-cap output with trailing newline=%s',
    (newline) => {
      const debug = vi.fn();
      const output = createDiagnosticOutput({ debug }, 'build');
      const line = `${'x'.repeat(1023)}\n`;
      const lastLine = newline ? line : 'final line'.padEnd(1024, 'x');
      output.write(Buffer.from(line.repeat(1023) + lastLine));
      output.end();
      output.end();

      expect(debug).toHaveBeenCalledTimes(1024);
      expect(debug).toHaveBeenLastCalledWith({
        area: 'build',
        message: lastLine.trimEnd(),
      });
      expect(JSON.stringify(debug.mock.calls)).not.toContain('truncated');
    }
  );

  it('skips blank lines and retains UTF-8 split across chunks', () => {
    const debug = vi.fn();
    const output = createDiagnosticOutput({ debug }, 'build');
    const text = Buffer.from('\u{1f642}');
    output.write(Buffer.from('\n \r\n'));
    output.write(text.subarray(0, 2));
    output.write(text.subarray(2));
    output.end();

    expect(debug).toHaveBeenCalledOnce();
    expect(debug).toHaveBeenCalledWith({
      area: 'build',
      message: text.toString(),
    });
  });

  it('reports oversized lines at EOF and resumes after a line boundary', () => {
    const debug = vi.fn();
    const output = createDiagnosticOutput({ debug }, 'build');
    output.write(Buffer.from(`${'x'.repeat(16 * 1024 + 1)}\nuseful detail\n`));
    output.write(Buffer.alloc(16 * 1024 + 1, 'x'));
    output.end();

    expect(debug.mock.calls.map(([event]) => event.message)).toEqual([
      '[Output line truncated]',
      'useful detail',
      '[Output line truncated]',
    ]);
  });

  it('drops an incomplete record on overflow rather than exposing a split credential', () => {
    const debug = vi.fn();
    const output = createDiagnosticOutput({ debug }, 'build');
    output.write(Buffer.alloc(1024 * 1024 - 7, '\n'));
    output.write(Buffer.from('Bearer '));
    output.write(Buffer.from('credential\n'));
    output.end();

    expect(debug).toHaveBeenCalledOnce();
    expect(debug).toHaveBeenCalledWith({
      area: 'build',
      message: '[Output capture truncated at 1 MiB]',
    });
  });

  it.each([
    [
      'split text',
      ['\n \r\n', 'Bearer ', 'credential\n', '\u{1f642}', ' tail'],
    ],
    [
      'exact byte cap',
      [`${'x'.repeat(1023)}\n`.repeat(1023), '\u{1f642}'.repeat(256)],
    ],
    ['oversized line', ['x'.repeat(16 * 1024 + 1), '\nuseful detail\n']],
    [
      'overflow',
      ['\n'.repeat(1024 * 1024 - 7), 'Bearer ', 'credential\n', 'ignored'],
    ],
  ] as const)(
    'handles decoded %s using the same byte and line limits',
    (_name, chunks) => {
      const bytes = vi.fn();
      const text = vi.fn();
      const byteOutput = createDiagnosticOutput({ debug: bytes }, 'build');
      const textOutput = createDiagnosticOutput({ debug: text }, 'build');
      for (const chunk of chunks) {
        byteOutput.write(Buffer.from(chunk));
        textOutput.writeText(chunk);
      }
      byteOutput.end();
      textOutput.end();
      textOutput.writeText('ignored after close');
      expect(text.mock.calls).toEqual(bytes.mock.calls);
    }
  );

  it('does not allocate a buffer for decoded text within the capture budget', () => {
    const debug = vi.fn();
    const output = createDiagnosticOutput({ debug }, 'build');
    const from = vi.spyOn(Buffer, 'from');
    output.writeText('already decoded\n');
    output.end();
    const allocations = from.mock.calls.length;
    from.mockRestore();
    expect(allocations).toBe(0);
    expect(debug).toHaveBeenCalledWith({
      area: 'build',
      message: 'already decoded',
    });
  });
});
