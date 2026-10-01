import { execFile as execFileCb, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach } from 'vitest';
import { parse as parseYaml } from 'yaml';

const execFile = promisify(execFileCb);

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/** Repo root, resolved from packages/tools/cli-e2e/src/helpers/ */
export const REPO_ROOT = resolve(__dirname, '../../../../..');

/** Path to the rayfin CLI entry script (used when testing from source). */
const RAYFIN_MAIN = join(REPO_ROOT, 'packages/tools/cli/scripts/main');

import type { CliResult } from './local-packages.js';

/**
 * Resolve the CLI executable path. When `E2E_CLI_SOURCE=published`, uses
 * the globally installed `rayfin` binary. Otherwise uses the repo build.
 */
function resolveCliPath(): string {
  if (process.env['E2E_CLI_SOURCE'] === 'published') {
    // The globally installed `rayfin` command
    return 'rayfin';
  }
  return RAYFIN_MAIN;
}

/**
 * Run a command, piping `input` to its stdin. Used for CLI flags such as
 * `secret set --stdin` that read a value from stdin rather than prompting.
 *
 * Uses the sync API because the promisified `execFile` cannot write stdin.
 * On success stderr is not separately recoverable; it is captured on failure,
 * which is the case that matters for diagnosing a failed assertion.
 */
function runWithStdin(
  command: string,
  args: string[],
  input: string,
  opts: {
    cwd?: string;
    env: Record<string, string | undefined>;
    timeoutMs: number;
  }
): CliResult {
  try {
    const stdout = execFileSync(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      input,
      timeout: opts.timeoutMs,
      encoding: 'utf8',
    });
    return { exitCode: 0, stdout, stderr: '', output: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    const stdout = e.stdout ?? '';
    const stderr = e.stderr ?? '';
    return {
      exitCode: e.status ?? 1,
      stdout,
      stderr,
      output: stdout + stderr,
    };
  }
}

/**
 * Run a `rayfin` CLI command as a subprocess and capture the result.
 *
 * @param args - CLI arguments (e.g. `['login', '--service-principal']`)
 * @param opts - Additional options for the subprocess. Pass `input` to
 *   write to the command's stdin (for flags like `secret set --stdin`).
 */
export async function runCli(
  args: string[],
  opts?: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    input?: string;
  }
): Promise<CliResult> {
  const cliPath = resolveCliPath();
  const isGlobal = cliPath === 'rayfin';

  const execArgs = isGlobal ? args : args;
  const command = isGlobal ? 'rayfin' : process.execPath;
  const fullArgs = isGlobal ? execArgs : [cliPath, ...execArgs];

  const env: Record<string, string | undefined> = {
    ...process.env,
    // Prevent telemetry from running in E2E
    RAYFIN_TELEMETRY_OPTOUT: '1',
    // Override HOME to isolate from dev machine state
    ...(opts?.env ?? {}),
  };

  if (opts?.input !== undefined) {
    return runWithStdin(command, fullArgs, opts.input, {
      cwd: opts.cwd,
      env,
      timeoutMs: opts.timeoutMs ?? 60_000,
    });
  }

  try {
    const { stdout, stderr } = await execFile(command, fullArgs, {
      cwd: opts?.cwd,
      env,
      timeout: opts?.timeoutMs ?? 60_000,
    });
    return { exitCode: 0, stdout, stderr, output: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    const stdout = e.stdout ?? '';
    const stderr = e.stderr ?? '';
    return {
      exitCode: e.code ?? 1,
      stdout,
      stderr,
      output: stdout + stderr,
    };
  }
}

/**
 * Create a temporary directory for test isolation. Returns the path and
 * a cleanup function to call in `afterEach`.
 */
export function createTempDir(prefix = 'rayfin-e2e-'): {
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Path to the create-rayfin entry script (used when testing from source). */
const CREATE_RAYFIN_MAIN = join(
  REPO_ROOT,
  'packages/tools/create-rayfin/dist/src/index.js'
);

/**
 * Run `create-rayfin` as a subprocess and capture the result.
 *
 * @param args - CLI arguments (e.g. `['my-app', '--template', 'todoapp']`)
 * @param opts - Additional options for the subprocess.
 */
export async function runCreateRayfin(
  args: string[],
  opts?: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }
): Promise<CliResult> {
  const isPublished = process.env['E2E_CLI_SOURCE'] === 'published';
  const command = isPublished ? 'create-rayfin' : process.execPath;
  const fullArgs = isPublished ? args : [CREATE_RAYFIN_MAIN, ...args];

  const env: Record<string, string | undefined> = {
    ...process.env,
    RAYFIN_TELEMETRY_OPTOUT: '1',
    ...(opts?.env ?? {}),
  };

  try {
    const { stdout, stderr } = await execFile(command, fullArgs, {
      cwd: opts?.cwd,
      env,
      timeout: opts?.timeoutMs ?? 60_000,
    });
    return { exitCode: 0, stdout, stderr, output: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    const stdout = e.stdout ?? '';
    const stderr = e.stderr ?? '';
    return {
      exitCode: e.code ?? 1,
      stdout,
      stderr,
      output: stdout + stderr,
    };
  }
}

/**
 * Read and parse rayfin.yml from a scaffolded project directory.
 * Uses full YAML parsing to support nested structures.
 */
export function readRayfinYml(projectDir: string): Record<string, unknown> {
  const ymlPath = join(projectDir, 'rayfin', 'rayfin.yml');
  if (!existsSync(ymlPath)) {
    throw new Error(`rayfin.yml not found at ${ymlPath}`);
  }
  const content = readFileSync(ymlPath, 'utf8');
  return parseYaml(content) as Record<string, unknown>;
}

/**
 * Run `rayfin init` as a subprocess and capture the result.
 */
export async function runRayfinInit(
  args: string[],
  opts?: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }
): Promise<CliResult> {
  return runCli(['init', ...args], opts);
}

/**
 * Recursively list all files in a directory, returning workspace-relative
 * paths (e.g. `src/index.ts`). Directories are not included.
 */
export function listFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => {
      const parent =
        (e as unknown as { parentPath?: string }).parentPath ?? dir;
      const full = join(parent, e.name);
      return relative(dir, full).replace(/\\/g, '/');
    });
}

/**
 * Track multiple cleanup callbacks and run them all in `afterEach`.
 * Useful for tests that create multiple temp resources.
 */
export function useTrackedCleanup(): { track: (fn: () => void) => void } {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        // best-effort
      }
    }
  });

  return { track: (fn) => cleanups.push(fn) };
}

/**
 * Create a fake `npm` executable on PATH that responds to
 * `npm view <pkg> version` with `999.0.0-test`. Used to test
 * version-update logic without hitting the real registry.
 *
 * Returns a `restorePath()` function that undoes the PATH modification.
 */
export function prependFakeNpmToPath(binDir: string): () => void {
  mkdirSync(binDir, { recursive: true });

  if (process.platform === 'win32') {
    writeFileSync(join(binDir, 'npm.cmd'), '@echo 999.0.0-test\n', {
      mode: 0o755,
    });
  } else {
    writeFileSync(join(binDir, 'npm'), '#!/bin/sh\necho "999.0.0-test"\n', {
      mode: 0o755,
    });
  }

  const originalPath = process.env['PATH'] ?? '';
  process.env['PATH'] =
    `${binDir}${process.platform === 'win32' ? ';' : ':'}${originalPath}`;

  return () => {
    process.env['PATH'] = originalPath;
  };
}
