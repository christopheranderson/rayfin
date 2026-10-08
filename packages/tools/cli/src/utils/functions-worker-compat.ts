/**
 * @packageDocumentation Detect whether the installed UDF worker can read the
 * runtime metadata this CLI writes.
 *
 * ## Why this check exists
 *
 * Every worker published before the `2.0` schema compares `schemaVersion`
 * with `===` and, when it does not match, falls back to analysing the
 * TypeScript sources at runtime. That fallback statically imports the
 * `astparser` module, which pulls in `typescript`.
 *
 * The deploy bundler deliberately keeps `typescript` out of the bundle. So a
 * new CLI paired with one of those older workers produces a zip whose entry
 * point does a top-level `import "typescript"` that cannot resolve. The host
 * fails to load `function_app.js` and reports "No job functions found" — the
 * deploy itself reports success, and the app is simply dead.
 *
 * `rayfin dev` is unaffected (source analysis still runs locally), so nothing
 * surfaces until deploy. Failing the deploy up front with an actionable
 * message is far better than shipping a broken app.
 *
 * ## Why capability detection rather than a version floor
 *
 * The worker is published as `1.36.0-alpha.<build>`, where the build stamp is
 * assigned at release time. There is no version number that can be written
 * down here today and still be correct after this change ships, so comparing
 * package versions would be guesswork.
 *
 * Instead we read the schema constants out of the installed worker's own
 * compiled `runtimeMetadata.js` and apply the worker's acceptance rule to the
 * version this CLI is about to write. That stays correct no matter how the
 * package is versioned.
 */

import { existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';

/** The worker package a functions project depends on. */
export const WORKER_PACKAGE_NAME = '@microsoft/fabric-user-data-functions';

/**
 * Escape hatch for a detection false positive.
 *
 * The check parses a file out of `node_modules`, so an unexpected build shape
 * could in principle misreport a perfectly good worker. This lets a user get
 * unblocked without waiting for a CLI fix. It does not make an old worker
 * work — it only suppresses the guard.
 */
export const SKIP_WORKER_CHECK_ENV = 'RAYFIN_FUNCTIONS_SKIP_WORKER_CHECK';

/**
 * Compiled location of the worker's metadata contract. Included in the
 * package's published `files` list, so it is present in any install that has
 * runtime metadata at all.
 */
const RUNTIME_METADATA_DIST_PATH = join('dist', 'runtimeMetadata.js');

export type WorkerSchemaCompatibility =
  /** The installed worker accepts the schema version the CLI writes. */
  | { status: 'compatible' }
  /**
   * The installed worker rejects it. `workerFloor` is the oldest schema that
   * worker accepts, or `undefined` when it predates runtime metadata
   * entirely.
   */
  | {
      status: 'incompatible';
      workerFloor?: string;
      workerPackageVersion?: string;
    }
  /**
   * Compatibility could not be determined — typically the worker is not
   * installed yet. Callers should not block on this; other checks cover a
   * missing or broken install, and guessing would block valid deploys.
   */
  | { status: 'unknown'; reason: string };

interface SchemaVersion {
  major: number;
  minor: number;
}

function parseSchemaVersion(version: string): SchemaVersion | undefined {
  const match = /^(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * Locate the installed worker package, wherever npm put it.
 *
 * Resolution starts from the functions folder and walks up, so a copy hoisted
 * into the app root is found — which is the norm in the multi-package layout
 * that motivated bundling in the first place.
 */
function resolveWorkerPackageRoot(functionsDir: string): string | undefined {
  try {
    const requireFromFunctions = createRequire(
      join(functionsDir, 'package.json')
    );
    return dirname(
      requireFromFunctions.resolve(`${WORKER_PACKAGE_NAME}/package.json`)
    );
  } catch {
    return undefined;
  }
}

function readWorkerPackageVersion(packageRoot: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf8')
    );
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      typeof (parsed as { version: unknown }).version === 'string'
    ) {
      return (parsed as { version: string }).version;
    }
  } catch {
    /* fall through — the version is only used to enrich the message */
  }
  return undefined;
}

/**
 * Read the oldest schema version the installed worker accepts.
 *
 * Workers on `2.0` and later publish an explicit minimum. Older ones only
 * declare the single version they compare against with `===`, which is both
 * their floor and their ceiling, so reading it as the floor gives the right
 * answer under the major-match rule below.
 */
function readWorkerSchemaFloor(source: string): string | undefined {
  const minimum =
    /export const MINIMUM_RUNTIME_METADATA_SCHEMA_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(
      source
    );
  if (minimum) return minimum[1];

  const exact =
    /export const RUNTIME_METADATA_SCHEMA_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(
      source
    );
  return exact?.[1];
}

/**
 * Decide whether `cliSchemaVersion` is readable by a worker whose floor is
 * `workerFloor`.
 *
 * Mirrors the worker's own gate: the major must match exactly, and the minor
 * is a floor. Keep this in step with `isCompatibleSchemaVersion` in the
 * worker's `runtimeMetadata.ts`.
 */
function workerAcceptsSchema(
  cliSchemaVersion: string,
  workerFloor: string
): boolean {
  const written = parseSchemaVersion(cliSchemaVersion);
  const floor = parseSchemaVersion(workerFloor);
  if (!written || !floor) return false;
  if (written.major !== floor.major) return false;
  return written.minor >= floor.minor;
}

/**
 * Check the installed worker against the metadata schema this CLI writes.
 *
 * @param functionsDir - Resolved `rayfin/functions/` root.
 * @param cliSchemaVersion - Schema version the CLI will write.
 */
export function checkWorkerSchemaCompatibility(
  functionsDir: string,
  cliSchemaVersion: string
): WorkerSchemaCompatibility {
  if (process.env[SKIP_WORKER_CHECK_ENV]) {
    return { status: 'unknown', reason: `${SKIP_WORKER_CHECK_ENV} is set` };
  }

  const packageRoot = resolveWorkerPackageRoot(functionsDir);
  if (!packageRoot) {
    // Almost always "npm install has not run yet". Bundling fails right after
    // this with a far clearer message, so do not pre-empt it.
    return {
      status: 'unknown',
      reason: `${WORKER_PACKAGE_NAME} could not be resolved from ${functionsDir}`,
    };
  }

  const workerPackageVersion = readWorkerPackageVersion(packageRoot);
  const metadataModule = join(packageRoot, RUNTIME_METADATA_DIST_PATH);
  if (!existsSync(metadataModule)) {
    // No metadata contract at all: this worker can only discover functions by
    // analysing sources, which the bundle does not support.
    return { status: 'incompatible', workerPackageVersion };
  }

  let source: string;
  try {
    source = readFileSync(metadataModule, 'utf8');
  } catch (error) {
    return {
      status: 'unknown',
      reason: `${metadataModule} could not be read: ${String(error)}`,
    };
  }

  const workerFloor = readWorkerSchemaFloor(source);
  if (!workerFloor) {
    // Present but shaped unexpectedly. Treat as undetermined rather than
    // blocking a deploy on a parse miss.
    return {
      status: 'unknown',
      reason: `no schema version constant found in ${metadataModule}`,
    };
  }

  if (workerAcceptsSchema(cliSchemaVersion, workerFloor)) {
    return { status: 'compatible' };
  }
  return { status: 'incompatible', workerFloor, workerPackageVersion };
}

/**
 * Explain an incompatible worker in terms the user can act on.
 */
export function describeIncompatibleWorker(
  result: Extract<WorkerSchemaCompatibility, { status: 'incompatible' }>,
  cliSchemaVersion: string
): string {
  const installed = result.workerPackageVersion
    ? `${WORKER_PACKAGE_NAME}@${result.workerPackageVersion}`
    : WORKER_PACKAGE_NAME;
  const reads = result.workerFloor
    ? `only reads runtime metadata schema '${result.workerFloor}'`
    : 'predates runtime metadata entirely';
  return (
    `The installed ${installed} ${reads}, but this CLI writes '${cliSchemaVersion}'. ` +
    `Deploying would produce an app the Functions host cannot start, reported as "No job functions found".`
  );
}
