import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, join, isAbsolute, posix, relative, sep, win32 } from 'path';

import type { Diagnostics } from '@microsoft/rayfin-tools-common/_internal/adapters';
import {
  deepMerge,
  parseRayfinYamlInterpolated,
  type RayfinConfig,
} from '@microsoft/rayfin-tools-common/_internal/config';
import { config as loadDotenv } from 'dotenv';
import { parse, stringify } from 'yaml';

import { createDiagnosticOutput } from '../diagnostics/output.js';

import { findRayfinProjectRoot } from './project-utils.js';

// ── Service Path Resolution ───────────────────────────────────────────

/**
 * Resolve the directory for a service that has an optional `path` field.
 *
 * When `servicePath` is provided the returned path is `servicePath` resolved
 * against `projectRoot`, with both slash styles normalised to the host
 * separator first — a config authored on Windows carries backslashes, and on
 * POSIX `resolve` would otherwise treat those as ordinary filename characters
 * and produce a single directory named `packages\data`. When absent the
 * `projectRoot` itself is returned unchanged, preserving single-package
 * behaviour.
 *
 * This does **not** validate containment; use {@link resolveServiceRoot} or
 * {@link validateServicePath} when the path guards matter.
 *
 * @param projectRoot - Absolute path to the Rayfin project root (the directory
 *   containing `rayfin/rayfin.yml`).
 * @param servicePath - Optional relative path from `rayfin.yml` (e.g.
 *   `packages/data`).
 */
export function resolveServicePath(
  projectRoot: string,
  servicePath?: string
): string {
  if (!servicePath) return projectRoot;
  return resolve(projectRoot, servicePath.replace(/[\\/]/gu, sep));
}

/**
 * Resolve a service root from a project root and a service path.
 *
 * Validates that the path does not escape the project root, then returns
 * the resolved absolute path. Callers must supply a concrete path — use
 * the service's conventional default (e.g. `'rayfin/functions'` for
 * functions, `'.'` for services that build from the project root) when
 * the user's config does not specify one.
 */
export function resolveServiceRoot(
  projectRoot: string,
  serviceName: string,
  servicePath: string
): string {
  return validateAndResolveServicePath(projectRoot, serviceName, servicePath);
}

/**
 * Resolve a configured path relative to an already validated service root.
 *
 * Both slash styles are treated as separators so a config remains safe when
 * moved between Windows and POSIX. Absolute paths and values that resolve
 * outside `serviceRoot` are rejected before callers read or write files.
 */
export function resolveServiceSubpath(
  serviceRoot: string,
  serviceName: string,
  fieldName: string,
  configuredPath: string
): string {
  return resolveContainedPath(
    serviceRoot,
    serviceName,
    fieldName,
    configuredPath,
    'service root'
  );
}

function resolveContainedPath(
  containingRoot: string,
  serviceName: string,
  fieldName: string,
  configuredPath: string,
  boundaryName: string
): string {
  const normalizedConfiguredPath = configuredPath.replace(/[\\/]/gu, sep);
  const resolvedPath = resolve(containingRoot, normalizedConfiguredPath);
  if (
    isAbsolute(configuredPath) ||
    posix.isAbsolute(configuredPath) ||
    win32.isAbsolute(configuredPath)
  ) {
    throw new Error(
      `Service '${serviceName}' ${fieldName} '${configuredPath}' must be a relative path within the ${boundaryName}. ` +
        `Resolved: '${resolvedPath}'.`
    );
  }

  const relativePath = relative(resolve(containingRoot), resolvedPath);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(
      `Service '${serviceName}' ${fieldName} '${configuredPath}' escapes the ${boundaryName}. ` +
        `Resolved: '${resolvedPath}'.`
    );
  }

  return resolvedPath;
}

/**
 * Validate a resolved service path before any file operation is attempted.
 *
 * Checks (in order):
 * 1. The raw value must not be an absolute path.
 * 2. The resolved path must not escape `projectRoot` (path-traversal guard).
 * 3. The resolved directory must exist on disk.
 *
 * @throws `Error` with a user-facing message on the first failing check.
 *
 * @param projectRoot - Absolute path to the Rayfin project root.
 * @param serviceName - Human-readable service label used in error messages
 *   (e.g. `'data'`, `'staticHosting'`).
 * @param servicePath - The raw `path` value from `rayfin.yml`.
 * @param options - Set `requireExists: false` for scaffolding callers that are
 *   about to *create* the directory (e.g. `rayfin functions init` targeting a
 *   `packages/functions` workspace package that does not exist yet). The
 *   absolute-path and traversal guards still apply.
 * @returns The resolved absolute path, with both slash styles normalised to the
 *   host separator.
 *
 *   **Use this return value rather than re-resolving `servicePath`.** Validation
 *   normalises separators, so a Windows-authored `path: 'packages\functions'`
 *   validates as `<root>/packages/functions` on POSIX — but
 *   `resolve(projectRoot, servicePath)` there treats the backslash as an
 *   ordinary filename character and yields `<root>/packages\functions`. The
 *   caller then reads or writes a directory that validation never saw.
 */
export function validateServicePath(
  projectRoot: string,
  serviceName: string,
  servicePath: string,
  options: { requireExists?: boolean } = {}
): string {
  return validateAndResolveServicePath(
    projectRoot,
    serviceName,
    servicePath,
    options.requireExists
  );
}

function validateAndResolveServicePath(
  projectRoot: string,
  serviceName: string,
  servicePath: string,
  requireExists = true
): string {
  const resolvedPath = resolveContainedPath(
    projectRoot,
    serviceName,
    'path',
    servicePath,
    'project root'
  );

  if (requireExists && !existsSync(resolvedPath)) {
    throw new Error(
      `Service '${serviceName}' path '${servicePath}' does not exist at '${resolvedPath}'.`
    );
  }

  return resolvedPath;
}

export interface ServiceBuildOptions {
  output?: 'inherit' | 'on-failure' | 'capture';
  silent?: boolean;
  writeOutput?: (text: string) => void;
  diagnostics?: Diagnostics;
}

/**
 * Run an arbitrary service build command in the given directory.
 * Returns `true` when the command exits with code 0.
 *
 * By default the child inherits the parent's stdio (output streams live). Pass
 * `{ silent: true }` to capture the child's stdout/stderr instead — the output
 * is hidden on success (so it does not interleave with an active spinner) and
 * surfaced only on failure. `writeOutput` receives that failure output (e.g. a
 * spinner-aware writer that suspends the spinner); it defaults to a plain
 * `process.stderr` write.
 */
export function runServiceBuildCommand(
  cwd: string,
  buildCommand: string,
  options: ServiceBuildOptions = {}
): Promise<boolean> {
  const outputPolicy =
    options.output ?? (options.silent ? 'on-failure' : 'inherit');
  return new Promise<boolean>((done) => {
    if (outputPolicy === 'inherit' && !options.diagnostics) {
      const child = spawn(buildCommand, {
        cwd,
        stdio: 'inherit',
        shell: true,
      });
      child.on('close', (code) => done(code === 0));
      child.on('error', () => done(false));
      return;
    }

    const stdout =
      options.diagnostics &&
      createDiagnosticOutput(options.diagnostics, 'build.stdout');
    const stderr =
      options.diagnostics &&
      createDiagnosticOutput(options.diagnostics, 'build.stderr');
    options.diagnostics?.debug({ area: 'build', message: 'Build started' });
    const child = spawn(buildCommand, {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: true,
    });
    let output = '';
    const render = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      if (outputPolicy === 'inherit') process[stream].write(chunk);
      if (outputPolicy === 'on-failure') output += chunk.toString();
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout?.write(chunk);
      render(chunk, 'stdout');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr?.write(chunk);
      render(chunk, 'stderr');
    });
    child.on('close', (code) => {
      stdout?.end();
      stderr?.end();
      options.diagnostics?.debug({
        area: 'build',
        message: 'Build completed',
        data: { exitCode: code },
      });
      if (outputPolicy === 'on-failure' && code !== 0 && output.trim()) {
        if (options.writeOutput) {
          options.writeOutput(output);
        } else {
          process.stderr.write(output);
        }
      }
      done(code === 0);
    });
    child.on('error', (error) => {
      options.diagnostics?.debug({
        area: 'build',
        message: 'Build launch failed',
        data: { error },
      });
      done(false);
    });
  });
}

// ── Environment Variable Loading ───────────────────────────────────────

/**
 * Options for loading environment variables from .env files and shell.
 */
export interface EnvLoadOptions {
  /** Root directory of the project (where rayfin/ folder is located) */
  projectRoot: string;
  /** Optional path to .env file (from --env-file CLI arg or RAYFIN_ENV_FILE) */
  envFilePath?: string;
  /** Fail when an explicitly supplied env file does not exist. */
  requireExplicitEnvFile?: boolean;
  /** Command context for default file selection ('up' | 'dev') */
  command?: 'up' | 'dev';
  /** Process environment (injected for testability, defaults to process.env) */
  processEnv?: typeof process.env;
}

/**
 * Result of env file resolution, including the resolved path and its source
 * for transparency messaging.
 */
export interface EnvFileResolution {
  path: string | undefined;
  source:
    | 'cli-arg'
    | 'env-var'
    | 'default-fabric'
    | 'default-local'
    | 'default'
    | 'none';
}

/**
 * Loads environment variables from .env file and merges with shell environment.
 * Priority: shell environment \> .env file
 *
 * @param options - Configuration for environment loading
 * @returns Map of environment variable names to values
 */
export function loadEnvironmentVariables(
  options: EnvLoadOptions
): Map<string, string> {
  const {
    projectRoot,
    envFilePath,
    requireExplicitEnvFile = false,
    command,
    processEnv = process.env,
  } = options;
  const envVars = new Map<string, string>();

  // Resolve .env file path with priority: CLI arg > env var > command-specific default
  const resolution = resolveEnvFilePath(
    projectRoot,
    envFilePath,
    processEnv,
    command
  );

  if (
    resolution.path &&
    !existsSync(resolution.path) &&
    requireExplicitEnvFile &&
    resolution.source === 'cli-arg'
  ) {
    throw new Error(
      `Environment file not found: ${resolution.path}. Create the file or omit the explicit env-file setting.`
    );
  }

  // Load .env file if it exists
  if (resolution.path && existsSync(resolution.path)) {
    try {
      const result = loadDotenv({ path: resolution.path });
      if (result.error) {
        throw new Error(
          `Failed to parse .env file at ${resolution.path}: ${result.error.message}`
        );
      }
      // Add parsed variables from .env
      if (result.parsed) {
        for (const [key, value] of Object.entries(result.parsed)) {
          envVars.set(key, value);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `❌ Failed to load .env file at ${resolution.path}: ${message}`
      );
    }
  }

  // Merge shell environment (shell wins over .env)
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined) {
      envVars.set(key, value);
    }
  }

  return envVars;
}

/**
 * Resolves the path to the .env file following priority:
 * 1. Explicit path from --env-file CLI argument
 * 2. Path from RAYFIN_ENV_FILE environment variable
 * 3. Default: `rayfin/.env`
 *
 * Env-strategy v2 collapsed the previous `.env.fabric` / `.env.local`
 * fallbacks into the single `rayfin/.env` file. The `command` parameter is
 * retained for API compatibility but no longer affects resolution.
 */
/** @internal — exported for testability only */
export function resolveEnvFilePath(
  projectRoot: string,
  envFilePath: string | undefined,
  processEnv: typeof process.env,
  _command?: 'up' | 'dev'
): EnvFileResolution {
  if (envFilePath) {
    const resolved = isAbsolute(envFilePath)
      ? envFilePath
      : resolve(projectRoot, envFilePath);
    return { path: resolved, source: 'cli-arg' };
  }

  if (processEnv.RAYFIN_ENV_FILE) {
    const envPath = processEnv.RAYFIN_ENV_FILE;
    const resolved = isAbsolute(envPath)
      ? envPath
      : resolve(projectRoot, envPath);
    return { path: resolved, source: 'env-var' };
  }

  return { path: join(projectRoot, 'rayfin', '.env'), source: 'default' };
}

// ── Config Loading/Updating ────────────────────────────────────────────

/**
 * Options for {@link loadRayfinConfig}.
 */
export interface LoadRayfinConfigOptions {
  /** Whether to suppress log output when finding project root. */
  silent?: boolean;
  /** Optional path to .env file (from `--env-file` CLI argument). */
  envFile?: string;
  /** Fail when `envFile` is supplied but does not exist. */
  requireExplicitEnvFile?: boolean;
  /** Command context for default file selection (`'up'` | `'dev'`). */
  command?: 'up' | 'dev';
}

/**
 * Loads the Rayfin configuration from the rayfin.yml file with environment variable interpolation.
 *
 * @param startPath - The path to start searching from (defaults to current working directory)
 * @param options - Options for loading the config
 * @returns The Rayfin configuration object with interpolated values, or null if the file doesn't exist
 */
export const loadRayfinConfig = (
  startPath: string = process.cwd(),
  options: LoadRayfinConfigOptions = {}
): RayfinConfig | null => {
  const {
    silent = false,
    envFile,
    requireExplicitEnvFile = false,
    command,
  } = options;

  let projectRoot: string;
  try {
    // Find the project root directory
    projectRoot = findRayfinProjectRoot(startPath, {
      verbose: false,
      silent,
    });
  } catch (error) {
    // Project root not found
    return null;
  }

  // Load environment variables from .env file and shell
  const envVars = loadEnvironmentVariables({
    projectRoot,
    envFilePath: envFile,
    requireExplicitEnvFile,
    command,
  });

  // Construct the path to the rayfin.yml file
  const rayfinConfigPath = resolve(projectRoot, 'rayfin', 'rayfin.yml');

  // Check if the file exists
  if (!existsSync(rayfinConfigPath)) {
    return null;
  }

  // Read the YAML file and parse with interpolation
  const configContent = readFileSync(rayfinConfigPath, 'utf-8');
  return parseRayfinYamlInterpolated(configContent, envVars);
};

/**
 * Updates the Rayfin configuration in the rayfin.yml file
 *
 * @param updates - The properties to update in the configuration
 * @param startPath - The path to start searching from (defaults to current working directory)
 * @returns boolean indicating whether the update was successful
 */
export const updateRayfinConfig = (
  updates: Partial<RayfinConfig> & Record<string, any>,
  startPath: string = process.cwd()
): boolean => {
  try {
    // Find the project root directory
    const projectRoot = findRayfinProjectRoot(startPath, { verbose: false });
    const result = writeRayfinConfigUpdates(updates, projectRoot);
    if (result.status === 'failed') {
      console.error(`❌ ${result.error}`);
      return false;
    }

    console.log(`✅ Updated rayfin.yml configuration`);
    return true;
  } catch (error) {
    console.error(
      `❌ Failed to update rayfin.yml: ${(error as Error).message}`
    );
    return false;
  }
};

/** Result of an output-free `rayfin.yml` update. */
export type RayfinConfigUpdateResult =
  | { status: 'updated' }
  | { status: 'failed'; error: string };

/** Options for an atomic `rayfin.yml` update. */
export interface WriteRayfinConfigUpdatesOptions {
  /** Config paths to remove after applying the deep merge. */
  removePaths?: ReadonlyArray<readonly string[]>;
}

/** Update a config at a known project root without rendering output. */
export function writeRayfinConfigUpdates(
  updates: Partial<RayfinConfig> & Record<string, any>,
  projectRoot: string,
  options: WriteRayfinConfigUpdatesOptions = {}
): RayfinConfigUpdateResult {
  try {
    const rayfinConfigPath = resolve(projectRoot, 'rayfin', 'rayfin.yml');
    if (!existsSync(rayfinConfigPath)) {
      return {
        status: 'failed',
        error: 'Could not update rayfin.yml: Configuration file not found',
      };
    }

    // Read and parse the raw YAML without env-var interpolation so that
    // environment variable placeholders (e.g. ${AUTH_EMAIL_ENABLED:-true})
    // are preserved when writing back.
    const rawContent = readFileSync(rayfinConfigPath, 'utf-8');
    const existingConfig = parse(rawContent) as Record<string, any>;

    // Deep-merge the existing config with the updates (recursive, matches vscode behavior)
    const updatedConfig = deepMerge(existingConfig, updates) as RayfinConfig;
    for (const path of options.removePaths ?? []) {
      let parent: Record<string, any> = updatedConfig;
      for (const segment of path.slice(0, -1)) {
        const child = parent[segment];
        if (typeof child !== 'object' || child === null) {
          parent = {};
          break;
        }
        parent = child;
      }
      const key = path.at(-1);
      if (key !== undefined) {
        delete parent[key];
      }
    }

    // Convert the updated config to YAML
    const yamlContent = stringify(updatedConfig, {
      lineWidth: 0,
      doubleQuotedAsJSON: false,
    });

    // Write the updated config back to the file
    writeFileSync(rayfinConfigPath, yamlContent, 'utf-8');

    return { status: 'updated' };
  } catch (error) {
    return {
      status: 'failed',
      error: `Failed to update rayfin.yml: ${(error as Error).message}`,
    };
  }
}

export const SECRET_DESCRIPTION_PLACEHOLDER =
  'TODO: Add description for this secret';

/**
 * Read the secret names declared in `rayfin.yml`.
 *
 * Returns names only — descriptions and values are irrelevant to the generated
 * type, and values are never in the config to begin with. Malformed or missing
 * config yields an empty list rather than throwing, so typegen degrades to
 * "no secrets" instead of failing a build.
 */
export const readSecretNames = (
  startPath: string = process.cwd()
): string[] => {
  let projectRoot: string;
  try {
    projectRoot = findRayfinProjectRoot(startPath, {
      verbose: false,
      silent: true,
    });
  } catch {
    return [];
  }

  const rayfinConfigPath = resolve(projectRoot, 'rayfin', 'rayfin.yml');
  if (!existsSync(rayfinConfigPath)) {
    return [];
  }

  let parsedConfig: Record<string, unknown>;
  try {
    parsedConfig = (parse(readFileSync(rayfinConfigPath, 'utf-8')) ??
      {}) as Record<string, unknown>;
  } catch {
    return [];
  }

  if (!Array.isArray(parsedConfig.secrets)) {
    return [];
  }

  const names: string[] = [];
  for (const entry of parsedConfig.secrets as unknown[]) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).name === 'string'
    ) {
      const name = (entry as Record<string, unknown>).name as string;
      if (name.length > 0 && !names.includes(name)) names.push(name);
    }
  }
  return names;
};

export interface RemoveSecretMetadataResult {
  status: 'removed' | 'not-found' | 'skipped';
  reason?: 'project-root-not-found' | 'config-not-found' | 'invalid-shape';
}

/**
 * Remove a secret metadata entry from `rayfin.yml`.
 *
 * The counterpart to {@link upsertSecretMetadata}. Without it, a secret
 * deletion would leave the entry behind and the generated secrets type would
 * keep advertising a secret that no longer exists.
 */
export const removeSecretMetadata = (
  secretName: string,
  startPath: string = process.cwd()
): RemoveSecretMetadataResult => {
  let projectRoot: string;
  try {
    projectRoot = findRayfinProjectRoot(startPath, {
      verbose: false,
      silent: true,
    });
  } catch {
    return { status: 'skipped', reason: 'project-root-not-found' };
  }

  const rayfinConfigPath = resolve(projectRoot, 'rayfin', 'rayfin.yml');
  if (!existsSync(rayfinConfigPath)) {
    return { status: 'skipped', reason: 'config-not-found' };
  }

  const rawContent = readFileSync(rayfinConfigPath, 'utf-8');
  const parsedConfig = (parse(rawContent) ?? {}) as Record<string, unknown>;

  if (
    Object.prototype.hasOwnProperty.call(parsedConfig, 'secrets') &&
    !Array.isArray(parsedConfig.secrets)
  ) {
    return { status: 'skipped', reason: 'invalid-shape' };
  }

  const existingSecrets = Array.isArray(parsedConfig.secrets)
    ? (parsedConfig.secrets as Array<Record<string, unknown>>)
    : [];

  const remaining = existingSecrets.filter(
    (entry) =>
      !(
        typeof entry === 'object' &&
        entry !== null &&
        entry.name === secretName
      )
  );

  if (remaining.length === existingSecrets.length) {
    return { status: 'not-found' };
  }

  parsedConfig.secrets = remaining;

  writeFileSync(
    rayfinConfigPath,
    stringify(parsedConfig, { lineWidth: 0 }),
    'utf-8'
  );
  return { status: 'removed' };
};

export interface UpsertSecretMetadataResult {
  status: 'added' | 'exists' | 'skipped';
  reason?: 'project-root-not-found' | 'config-not-found' | 'invalid-shape';
}

/**
 * Add a secret metadata entry to rayfin.yml.
 *
 * Creates top-level `secrets` when missing, appends a `{name, description}`
 * entry when not present, and preserves existing entries.
 */
export const upsertSecretMetadata = (
  secretName: string,
  startPath: string = process.cwd(),
  description?: string
): UpsertSecretMetadataResult => {
  const normalizedDescription =
    typeof description === 'string' && description.trim().length > 0
      ? description.trim()
      : SECRET_DESCRIPTION_PLACEHOLDER;

  let projectRoot: string;
  try {
    projectRoot = findRayfinProjectRoot(startPath, {
      verbose: false,
      silent: true,
    });
  } catch {
    return { status: 'skipped', reason: 'project-root-not-found' };
  }

  const rayfinConfigPath = resolve(projectRoot, 'rayfin', 'rayfin.yml');
  if (!existsSync(rayfinConfigPath)) {
    return { status: 'skipped', reason: 'config-not-found' };
  }

  const rawContent = readFileSync(rayfinConfigPath, 'utf-8');
  const parsedConfig = (parse(rawContent) ?? {}) as Record<string, unknown>;

  if (
    Object.prototype.hasOwnProperty.call(parsedConfig, 'secrets') &&
    !Array.isArray(parsedConfig.secrets)
  ) {
    return { status: 'skipped', reason: 'invalid-shape' };
  }

  const existingSecrets = Array.isArray(parsedConfig.secrets)
    ? (parsedConfig.secrets as Array<Record<string, unknown>>)
    : [];

  const exists = existingSecrets.some(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof entry.name === 'string' &&
      entry.name === secretName
  );

  if (exists) {
    return { status: 'exists' };
  }

  existingSecrets.push({
    name: secretName,
    description: normalizedDescription,
  });

  parsedConfig.secrets = existingSecrets;

  writeFileSync(
    rayfinConfigPath,
    stringify(parsedConfig, { lineWidth: 0 }),
    'utf-8'
  );
  return { status: 'added' };
};
