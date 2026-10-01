/**
 * Node-only bootstrap helper that hydrates `process.env.RAYFIN_*` from
 * the persisted `environmentConfig` block in `~/.rayfin/auth.json`
 * before any downstream module reads those env vars.
 *
 * **This module imports Node built-ins (`fs`, `os`, `path`)** and is
 * therefore re-exported from the universal `./_internal/env-config` barrel
 * for convenience but should only be invoked from Node entry points
 * (CLI / `create-rayfin`). Browser/WebWorker consumers must not import
 * `bootstrapEnvironmentConfig`.
 *
 * The mapping of env var → persisted-state field is defined once in
 * the universal `RAYFIN_ENV_CONFIG_VARS` (in `./index.ts`) and shared
 * with CLI commands that read / write the same vars.
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { RAYFIN_ENV_CONFIG_VARS } from './index.js';

/** Directory for the CLI's persisted auth state and token cache. */
const RAYFIN_CONFIG_DIR = join(homedir(), '.rayfin');
/** Auth metadata file (identity type, tenant ID, user info, environmentConfig). */
const AUTH_STATE_FILE = 'auth.json';

/**
 * Hydrate `process.env.RAYFIN_*` from the persisted `environmentConfig`
 * block in `~/.rayfin/auth.json`.
 *
 * For each sub-field present in the persisted `environmentConfig`, sets
 * the matching `RAYFIN_*` env var **only if it is not already set** —
 * so an explicit `RAYFIN_*` export from the user's shell still wins.
 *
 * Reads the file synchronously because callers (CLI / `create-rayfin`)
 * invoke this at module load before commander parses argv. The file is
 * small (a few hundred bytes) so the cost is negligible.
 *
 * Failure modes:
 *   - missing file → silent no-op (the common case for users who never
 *     ran `rayfin login` against a non-default environment)
 *   - hydrated values → silent (no chatty per-invocation log)
 *   - unreadable / malformed JSON → warning to stderr, no-op; this
 *     signals a real problem (a corrupt or unreadable auth state means
 *     the user's persisted overrides will silently not take effect),
 *     and stderr is the right channel for diagnostics — it cannot
 *     corrupt the single JSON document a `--json`-mode command writes
 *     to stdout
 *
 * @param options - Bootstrap options
 */
export function bootstrapEnvironmentConfig(options?: {
  /**
   * Override the lookup directory. Defaults to `~/.rayfin`. Tests use
   * this to point at a temp dir without monkey-patching `os.homedir`.
   */
  configDir?: string;
}): void {
  const filePath = join(
    options?.configDir ?? RAYFIN_CONFIG_DIR,
    AUTH_STATE_FILE
  );
  let parsed: { environmentConfig?: unknown };

  try {
    const raw = readFileSync(filePath, 'utf8');
    try {
      parsed = JSON.parse(raw) as { environmentConfig?: unknown };
    } catch (error) {
      writeStderr(`could not parse auth state: ${(error as Error).message}`);
      return;
    }
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') {
      writeStderr(`could not read auth state: ${(error as Error).message}`);
    }
    return;
  }

  const envConfig = parsed.environmentConfig;
  if (envConfig === undefined) {
    return;
  }
  if (
    envConfig === null ||
    typeof envConfig !== 'object' ||
    Array.isArray(envConfig)
  ) {
    return;
  }

  const envConfigRecord = envConfig as Record<string, unknown>;
  // Bootstrap is a Node-only subpath; the package's universal ambient
  // `process` declaration types it as possibly undefined, so narrow once.
  const procEnv = process!.env;

  for (const { envVar, configField } of RAYFIN_ENV_CONFIG_VARS) {
    // Inherited shell value always wins.
    if (procEnv[envVar] !== undefined) {
      continue;
    }

    const value = envConfigRecord[configField];
    if (typeof value === 'string' && value.length > 0) {
      procEnv[envVar] = value;
    }
  }
}

/**
 * Write a diagnostic line to stderr. Bootstrap must never write to
 * stdout because the eventual single JSON document a `--json`-mode
 * command emits would be corrupted.
 */
function writeStderr(message: string): void {
  // Bootstrap is a Node-only subpath; the package's universal
  // ambient `process` declaration types `process` and `process.stderr`
  // as possibly undefined, so narrow.
  process!.stderr?.write(`${message}\n`);
}
