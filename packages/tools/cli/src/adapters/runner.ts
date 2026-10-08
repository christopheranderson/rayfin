/**
 * CLI implementation of the {@link CommandRunner} adapter.
 *
 * Backs shell execution with `node:child_process` through
 * {@link spawnSafe}, which resolves Windows `.cmd` shims (`npm.cmd`) and
 * PATHEXT-only executables (`func`) that a bare `spawn` cannot find, and
 * streams stdout/stderr to the optional callbacks as chunks arrive before
 * resolving with a typed {@link RunResult}.
 *
 * The result distinguishes three outcomes the interface cares about:
 *   - **never launched** (`launched: false`, `spawnError` set) — e.g. the
 *     binary is missing (`ENOENT`);
 *   - **cancelled** (`cancelled: true`) — terminated via the `signal` token
 *     rather than exiting on its own;
 *   - **ran** (`launched: true`) — `exitCode` is then meaningful.
 *
 * A non-zero `exitCode` is therefore never conflated with "tool not found"
 * or "user cancelled", which have different remediation paths.
 */
import { constants } from 'node:os';

import type {
  CommandRunner,
  RunOptions,
  RunResult,
} from '@microsoft/rayfin-tools-common/_internal/adapters';

import {
  isWindows,
  spawnSafe,
  terminateProcessTree,
} from '../utils/platform-utils.js';

/**
 * Resolve a numeric exit code from a child process's `close` event.
 *
 * Node reports `(code, signal)`: a normal exit carries a numeric `code` and a
 * null `signal`; a signal-terminated process carries a null `code` and the
 * signal name. Mapping the latter to the shell convention `128 + signalNumber`
 * ensures an externally killed subprocess (SIGTERM, SIGKILL) is never mistaken
 * for a clean `0` success. For a run cancelled via the cancellation token the
 * caller checks `cancelled` first, for which this value is documented as
 * unreliable.
 *
 * Exported for direct unit testing of the signal-to-exit-code mapping, which
 * is otherwise hard to exercise deterministically through `spawn`.
 */
export function resolveExitCode(
  code: number | null,
  signal: string | null
): number {
  if (code !== null) {
    return code;
  }
  if (signal) {
    const signalNumber = (constants.signals as Record<string, number>)[signal];
    return signalNumber ? 128 + signalNumber : 1;
  }
  return 1;
}

/** `child_process`-backed {@link CommandRunner} implementation for the CLI. */
export const cliCommandRunner: CommandRunner = {
  run(
    command: string,
    args: string[],
    options?: RunOptions
  ): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
      const child = spawnSafe(command, args, {
        cwd: options?.cwd,
        // Own process group on POSIX so `terminateProcessTree` can stop descendants.
        detached: !isWindows,
        env: options?.env ? { ...process.env, ...options.env } : process.env,
        stdio: options?.inheritStdio
          ? 'inherit'
          : [options?.inheritStdin ? 'inherit' : 'pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let cancelled = false;

      const subscription = options?.signal?.onCancellationRequested(() => {
        cancelled = true;
        terminateProcessTree(child, 'SIGTERM', (message) => {
          const text = `${message}\n`;
          if (options?.captureOutput !== false) stderr += text;
          options?.onStderr?.(text);
        });
      });

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (text: string) => {
        if (options?.captureOutput !== false) stdout += text;
        options?.onStdout?.(text);
      });

      child.stderr?.on('data', (text: string) => {
        if (options?.captureOutput !== false) stderr += text;
        options?.onStderr?.(text);
      });

      child.on('error', (error: Error & { code?: string }) => {
        subscription?.dispose();
        resolve({
          launched: false,
          spawnError:
            error.code === 'ENOENT'
              ? `${command}: command not found`
              : error.message,
          exitCode: 0,
          stdout,
          stderr,
        });
      });

      child.on('close', (code: number | null, signal: string | null) => {
        subscription?.dispose();
        resolve({
          launched: true,
          cancelled,
          exitCode: resolveExitCode(code, signal),
          stdout,
          stderr,
        });
      });
    });
  },
};
