/**
 * Lockfile read/write for `rayfin/.lockfile.json`.
 *
 * The lockfile records which Rayfin-managed items have been installed, the CLI version
 * that wrote each, and a sha256 of the content as written. It also records explicit
 * user opt-outs.
 *
 * Schema and shape are defined in `./types.ts`.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { writeFileAtomic } from '../../utils/atomic-write.js';
import { canonicalizeJson } from '../../utils/canonical-json.js';

import { readIfPresent } from './strategies/strategy.js';
import { isItemId } from './types.js';
import type { ItemId, ItemRecord, ItemSource, Lockfile } from './types.js';

/** Project-relative path to the lockfile. */
export const LOCKFILE_RELATIVE_PATH = 'rayfin/.lockfile.json';

const SCHEMA_VERSION = 1;

/** A fresh, empty lockfile. */
export function emptyLockfile(cliVersion: string): Lockfile {
  return {
    version: SCHEMA_VERSION,
    cliVersion,
    items: {},
  };
}

/** Returns the absolute path to the lockfile inside `projectRoot`. */
export function lockfilePath(projectRoot: string): string {
  return join(projectRoot, LOCKFILE_RELATIVE_PATH);
}

/**
 * Reads the lockfile.
 *
 * - Returns `null` when the file is absent (caller decides whether to create one).
 * - Throws a clear error when the file is present but malformed; the manager surfaces
 *   the error rather than silently overwriting unknown state.
 */
export function readLockfile(projectRoot: string): Lockfile | null {
  const path = lockfilePath(projectRoot);
  let raw: string | null;
  try {
    raw = readIfPresent(path);
  } catch (err) {
    throw new Error(
      `Could not read ${LOCKFILE_RELATIVE_PATH}: ${(err as Error).message}`
    );
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${LOCKFILE_RELATIVE_PATH} is not valid JSON: ${(err as Error).message}. ` +
        `Either repair the file by hand or delete it and run \`rayfin init ai-files install\`.`
    );
  }
  return validateLockfile(parsed);
}

/**
 * Writes the lockfile with stable, deterministic formatting:
 * - 2-space indent
 * - keys sorted within each object
 * - trailing newline
 *
 * Creates `rayfin/` if it does not exist.
 */
export function writeLockfile(projectRoot: string, lockfile: Lockfile): void {
  const path = lockfilePath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, canonicalizeJson(lockfile) + '\n', 'utf8');
}

/** Creates a copy of the lockfile with one item updated. */
export function withItem(
  lockfile: Lockfile,
  id: ItemId,
  record: ItemRecord
): Lockfile {
  return {
    ...lockfile,
    items: { ...lockfile.items, [id]: record },
  };
}

/** Creates a copy of the lockfile with one item removed. */
export function withoutItem(lockfile: Lockfile, id: ItemId): Lockfile {
  const items = { ...lockfile.items };
  delete items[id];
  return { ...lockfile, items };
}

/** Returns a new lockfile with `cliVersion` updated. */
export function withCliVersion(lockfile: Lockfile, version: string): Lockfile {
  return { ...lockfile, cliVersion: version };
}

// ── Internals ──────────────────────────────────────────────────────────────

const KNOWN_LOCKFILE_KEYS = new Set(['version', 'cliVersion', 'items']);
const KNOWN_ITEM_KEYS = new Set(['sha256', 'disabled', 'source']);

/**
 * Default provenance for legacy lockfile records that don't have a `source`
 * field. Phase 1 only ships the CLI as a producer, so missing source is
 * normalized to this constant on read.
 */
export const CLI_PRODUCER_SOURCE = {
  kind: 'cli' as const,
  id: '@microsoft/rayfin-cli',
};

/**
 * Reports unrecognized keys in a parsed JSON object to stderr so accidental
 * corruption (or pre-Phase-2 hand-edits) is at least visible. The validator
 * is permissive (forward-compat with future fields); silent stripping was an
 * S3-2 concern from the round-4 deep review.
 */
function warnUnknownKeys(
  obj: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
  scopeLabel: string
): void {
  const extras: string[] = [];
  for (const key of Object.keys(obj)) {
    if (!knownKeys.has(key)) extras.push(key);
  }
  if (extras.length === 0) return;
  process.stderr.write(
    `[rayfin] ${LOCKFILE_RELATIVE_PATH}: ignoring unknown ${scopeLabel}: ${extras
      .map((k) => `"${k}"`)
      .join(', ')}. These will be stripped on next write.\n`
  );
}

function validateLockfile(value: unknown): Lockfile {
  if (typeof value !== 'object' || value === null) {
    throw new Error(
      `${LOCKFILE_RELATIVE_PATH} root must be a JSON object. Delete or repair the file.`
    );
  }
  const obj = value as Record<string, unknown>;
  warnUnknownKeys(obj, KNOWN_LOCKFILE_KEYS, 'top-level key(s)');

  if (obj['version'] !== SCHEMA_VERSION) {
    throw new Error(
      `${LOCKFILE_RELATIVE_PATH} has unsupported schema version ${String(
        obj['version']
      )}; expected ${SCHEMA_VERSION}.`
    );
  }

  const cliVersion = obj['cliVersion'];
  if (typeof cliVersion !== 'string' || cliVersion.length === 0) {
    throw new Error(
      `${LOCKFILE_RELATIVE_PATH}: missing or invalid "cliVersion".`
    );
  }

  const itemsRaw = obj['items'];
  if (
    typeof itemsRaw !== 'object' ||
    itemsRaw === null ||
    Array.isArray(itemsRaw)
  ) {
    throw new Error(`${LOCKFILE_RELATIVE_PATH}: "items" must be an object.`);
  }

  const items: Record<string, ItemRecord> = {};
  for (const [key, recordRaw] of Object.entries(
    itemsRaw as Record<string, unknown>
  )) {
    if (!isItemId(key)) {
      throw new Error(
        `${LOCKFILE_RELATIVE_PATH}: invalid item id "${key}" (expected "skill:..." or "mcp:...").`
      );
    }
    items[key] = validateItemRecord(key, recordRaw);
  }

  return {
    version: SCHEMA_VERSION,
    cliVersion,
    items: items as Lockfile['items'],
  };
}

function validateItemRecord(id: string, value: unknown): ItemRecord {
  if (typeof value !== 'object' || value === null) {
    throw new Error(
      `${LOCKFILE_RELATIVE_PATH}: item "${id}" must be an object.`
    );
  }
  const obj = value as Record<string, unknown>;
  warnUnknownKeys(obj, KNOWN_ITEM_KEYS, `key(s) on item "${id}"`);
  // sha256 is null when an item is recorded as disabled-from-install (no file written).
  const shaRaw = obj['sha256'];
  let sha256: string | null;
  if (shaRaw === null) {
    sha256 = null;
  } else if (typeof shaRaw === 'string' && shaRaw.length > 0) {
    sha256 = shaRaw;
  } else {
    throw new Error(
      `${LOCKFILE_RELATIVE_PATH}: item "${id}" has invalid "sha256" (must be a string or null).`
    );
  }
  const disabledRaw = obj['disabled'];
  if (disabledRaw !== undefined && typeof disabledRaw !== 'boolean') {
    throw new Error(
      `${LOCKFILE_RELATIVE_PATH}: item "${id}" has invalid "disabled" (must be a boolean).`
    );
  }

  // Provenance: optional in the on-disk schema. Legacy records without a
  // source are normalized to the CLI producer (Phase 1's only producer).
  const sourceRaw = obj['source'];
  const source = validateItemSource(id, sourceRaw);

  const record: ItemRecord =
    disabledRaw === true
      ? { sha256, disabled: true, source }
      : { sha256, source };
  return record;
}

function validateItemSource(id: string, value: unknown): ItemSource {
  if (value === undefined) {
    return CLI_PRODUCER_SOURCE;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      `${LOCKFILE_RELATIVE_PATH}: item "${id}" has invalid "source" (must be an object).`
    );
  }
  const obj = value as Record<string, unknown>;
  // Source-field schema is permissive — Phase 2 will add fields here so
  // unknown keys are silently ignored without a stderr warning.
  const kind = obj['kind'];
  if (kind !== 'cli' && kind !== 'template') {
    throw new Error(
      `${LOCKFILE_RELATIVE_PATH}: item "${id}" has invalid "source.kind" (must be "cli" or "template").`
    );
  }
  const sourceId = obj['id'];
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    throw new Error(
      `${LOCKFILE_RELATIVE_PATH}: item "${id}" has invalid "source.id" (must be a non-empty string).`
    );
  }
  const versionOrSha = obj['versionOrSha'];
  if (versionOrSha !== undefined && typeof versionOrSha !== 'string') {
    throw new Error(
      `${LOCKFILE_RELATIVE_PATH}: item "${id}" has invalid "source.versionOrSha" (must be a string if present).`
    );
  }
  return versionOrSha === undefined
    ? { kind, id: sourceId }
    : { kind, id: sourceId, versionOrSha };
}
