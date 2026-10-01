import { stripVTControlCharacters } from 'node:util';

import type { Diagnostics } from '@microsoft/rayfin-tools-common/_internal/adapters';

import { createDiagnosticOutput } from '../diagnostics/output.js';
import { redactTerminalText } from '../diagnostics/sanitize.js';
import type { OutputMode } from '../utils/output-mode.js';

export interface ChildOutputSinks {
  stdout(chunk: string): void;
  stderr(chunk: string): void;
}

export function createChildOutputSinks(
  mode: OutputMode,
  onOutputStart: () => void = () => {}
): ChildOutputSinks {
  let started = false;
  const beginOutput = (): void => {
    if (started) return;
    started = true;
    onOutputStart();
  };
  return {
    stdout: (chunk) => {
      beginOutput();
      if (mode === 'interactive') process.stdout.write(chunk);
      else process.stderr.write(chunk);
    },
    stderr: (chunk) => {
      beginOutput();
      process.stderr.write(chunk);
    },
  };
}

export function createBuildOutput(diagnostics: Diagnostics, area: string) {
  const lines: string[] = [];
  let bytes = 0;
  let omitted = false;
  const append = (line: string): void => {
    const text = `${redactTerminalText(stripVTControlCharacters(line).replace(/\r$/, ''))}\n`;
    lines.push(text);
    bytes += Buffer.byteLength(text);
    while (bytes > 64 * 1024 || lines.length > 100) {
      bytes -= Buffer.byteLength(lines.shift()!);
      omitted = true;
    }
  };

  const stream = (name: string) => {
    const output = createDiagnosticOutput(diagnostics, `${area}.${name}`);
    let pending = '';
    let oversized = false;
    let ended = false;
    const flush = (): void => {
      if (oversized) append('[Build output line truncated]');
      else if (pending.trim()) append(pending);
      pending = '';
      oversized = false;
    };
    return {
      write(chunk: string): void {
        if (ended) return;
        output.writeText(chunk);
        const fragments = chunk.split('\n');
        for (const [index, fragment] of fragments.entries()) {
          if (!oversized) {
            pending += fragment;
            if (Buffer.byteLength(pending) > 16 * 1024) {
              pending = '';
              oversized = true;
            }
          }
          if (index < fragments.length - 1) flush();
        }
      },
      end(): void {
        if (ended) return;
        ended = true;
        output.end();
        flush();
      },
    };
  };

  const stdout = stream('stdout');
  const stderr = stream('stderr');
  const end = (): void => {
    stdout.end();
    stderr.end();
  };
  return {
    stdout: stdout.write,
    stderr: stderr.write,
    end,
    tail(): string {
      end();
      return `${omitted ? '[Earlier build output omitted]\n' : ''}${lines.join('')}`;
    },
  };
}
