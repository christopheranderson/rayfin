import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Flattened runtime configuration serialized to `rayfin.config.json`. The SPA
 * fetches this at startup via `loadRayfinConfig()` from `@microsoft/rayfin-client`
 * so the same compiled bundle works across environments without a rebuild.
 */
export interface RuntimeConfigFile {
  /** BaaS / workload endpoint the client calls (required). */
  apiUrl: string;
  publishableKey?: string;
  workspaceId?: string;
  itemId?: string;
  portalUrl?: string;
  tenantId?: string;
}

const RUNTIME_CONFIG_FIELDS = [
  'apiUrl',
  'publishableKey',
  'workspaceId',
  'itemId',
  'portalUrl',
  'tenantId',
] as const;

/** Result of {@link writeRuntimeConfigFile}. */
export interface WriteRuntimeConfigResult {
  /** Absolute path of the file that was written (or left in place). */
  path: string;
  /**
   * True when a `rayfin.config.json` already existed at the path. The
   * existing file is left untouched — not overwritten — and reused as-is for
   * this deploy. Callers must not remove the file afterward: it is normally
   * a CLI-managed transient, so a pre-existing copy is either a leftover from
   * an interrupted `rayfin up` or a hand-committed file that should be
   * gitignored. See {@link differences} for whether callers should warn.
   */
  preexisting: boolean;
  /**
   * Fields where a preexisting file's value differs from what this run would
   * have written, formatted as `"field: existing=... vs this deploy=..."`.
   * Always empty when `preexisting` is false. Callers should warn only when
   * this is non-empty — a preexisting file that already matches is the
   * expected steady state (e.g. an intentionally hand-committed file) and
   * warning on every run trains people to ignore the warning.
   */
  differences: string[];
}

/**
 * Compares a preexisting `rayfin.config.json` against the values this run
 * would have written, field by field. Returns a single explanatory entry
 * (rather than a per-field diff) when the existing file can't be parsed,
 * since there's nothing more specific to compare.
 */
async function diffAgainstExisting(
  path: string,
  config: RuntimeConfigFile
): Promise<string[]> {
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return ['existing file could not be parsed to compare against this deploy'];
  }
  const differences: string[] = [];
  for (const field of RUNTIME_CONFIG_FIELDS) {
    const existingValue = existing[field];
    const expectedValue = config[field];
    if (existingValue !== expectedValue) {
      differences.push(
        `${field}: existing=${JSON.stringify(existingValue)} vs this deploy=${JSON.stringify(expectedValue)}`
      );
    }
  }
  return differences;
}

/** Canonical name of the runtime config file. */
export const RUNTIME_CONFIG_FILENAME = 'rayfin.config.json';

/**
 * Write `rayfin.config.json` into `dir` (created if missing), unless a file
 * already exists at that path — in that case the existing file is left
 * untouched and reused as-is, and `preexisting` reports so callers can warn.
 *
 * When this function does write the file, it is a CLI-managed transient: it
 * is emitted here so the static build bundles it, then removed via
 * {@link removeRuntimeConfigFile} in a `finally` so it is never left on disk
 * — a stray copy would shadow local-dev `VITE_*` values on the next
 * `rayfin dev`. Callers must skip that removal when `preexisting` is true,
 * since the file was not written by this run and is not theirs to delete.
 */
export async function writeRuntimeConfigFile(
  dir: string,
  config: RuntimeConfigFile
): Promise<WriteRuntimeConfigResult> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, RUNTIME_CONFIG_FILENAME);
  const preexisting = existsSync(path);
  if (preexisting) {
    const differences = await diffAgainstExisting(path, config);
    return { path, preexisting, differences };
  }
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return { path, preexisting, differences: [] };
}

/**
 * Best-effort removal of a runtime config file written by
 * {@link writeRuntimeConfigFile}. A `undefined` path is a no-op (nothing was
 * emitted). Never throws — cleanup must not mask the command's original outcome.
 */
export async function removeRuntimeConfigFile(
  path: string | undefined
): Promise<void> {
  if (!path) return;
  try {
    await rm(path, { force: true });
  } catch {
    // Best-effort cleanup — never mask the original outcome.
  }
}
