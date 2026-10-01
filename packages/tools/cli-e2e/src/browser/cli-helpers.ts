/**
 * CLI subprocess helpers for Playwright tests.
 * This is a standalone version that does not import vitest,
 * avoiding Symbol conflicts when running under Playwright.
 */
import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { parse as parseYaml } from 'yaml';

import { type CliResult } from '../helpers/local-packages.js';

const execFile = promisify(execFileCb);

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/** Repo root, resolved from packages/tools/cli-e2e/src/browser/ */
const REPO_ROOT = resolve(__dirname, '../../../../..');

/** Path to the rayfin CLI entry script (used when testing from source). */
const RAYFIN_MAIN = join(REPO_ROOT, 'packages/tools/cli/scripts/main');

/** Path to the create-rayfin entry script (used when testing from source). */
const CREATE_RAYFIN_MAIN = join(
  REPO_ROOT,
  'packages/tools/create-rayfin/dist/src/index.js'
);

function resolveCliPath(): string {
  if (process.env['E2E_CLI_SOURCE'] === 'published') {
    return 'rayfin';
  }
  return RAYFIN_MAIN;
}

export async function runCli(
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }
): Promise<CliResult> {
  const cliPath = resolveCliPath();
  const isGlobal = cliPath === 'rayfin';
  const command = isGlobal ? 'rayfin' : process.execPath;
  const fullArgs = isGlobal ? args : [cliPath, ...args];

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
    return { exitCode: e.code ?? 1, stdout, stderr, output: stdout + stderr };
  }
}

export async function runCreateRayfin(
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }
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
    return { exitCode: e.code ?? 1, stdout, stderr, output: stdout + stderr };
  }
}

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

export function readRayfinYml(projectDir: string): Record<string, unknown> {
  const ymlPath = join(projectDir, 'rayfin', 'rayfin.yml');
  if (!existsSync(ymlPath)) {
    throw new Error(`rayfin.yml not found at ${ymlPath}`);
  }
  const content = readFileSync(ymlPath, 'utf8');
  return parseYaml(content) as Record<string, unknown>;
}
