/**
 * Adds bounded diagnostics to a CLI runner without changing its terminal,
 * callbacks, or cancellation policy. Runtime IDs associate interleaved streams
 * with recognized executable names; custom names, paths, arguments, and
 * environment values are never included in lifecycle records.
 */
import { win32 } from 'node:path';

import type {
  CommandRunner,
  Diagnostics,
} from '@microsoft/rayfin-tools-common/_internal/adapters';

import { createDiagnosticOutput } from '../diagnostics/output.js';

export function createDiagnosticRunner(
  runner: CommandRunner,
  diagnostics: Diagnostics
): CommandRunner {
  let nextRunId = 0;
  return {
    async run(command, args, options) {
      const runId = ++nextRunId;
      const area = `runtime.${runId}`;
      const stdout = createDiagnosticOutput(diagnostics, `${area}.stdout`);
      const stderr = createDiagnosticOutput(diagnostics, `${area}.stderr`);
      diagnostics.debug({
        area,
        message: options?.inheritStdio
          ? 'Runtime started with inherited terminal; console output is not captured'
          : 'Runtime started with captured output',
        data: { command: diagnosticCommandName(command) },
      });
      try {
        const result = await runner.run(command, args, {
          ...options,
          onStdout(chunk) {
            stdout.writeText(chunk);
            options?.onStdout?.(chunk);
          },
          onStderr(chunk) {
            stderr.writeText(chunk);
            options?.onStderr?.(chunk);
          },
        });
        diagnostics.debug({
          area,
          message: 'Runtime ended',
          data: {
            launched: result.launched,
            exitCode: result.exitCode,
            cancelled: result.cancelled === true,
          },
        });
        return result;
      } catch (error) {
        diagnostics.debug({ area, message: 'Runtime execution failed' });
        throw error;
      } finally {
        stdout.end();
        stderr.end();
      }
    },
  };
}

function diagnosticCommandName(command: string): string {
  const executable = win32
    .basename(command)
    .replace(/\.(cmd|exe|bat)$/i, '')
    .toLowerCase();
  return (
    ['npm', 'npx', 'node', 'func'].find((name) => name === executable) ??
    'other'
  );
}
