import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SKIP_WORKER_CHECK_ENV,
  WORKER_PACKAGE_NAME,
  checkWorkerSchemaCompatibility,
  describeIncompatibleWorker,
} from '../functions-worker-compat.js';

/**
 * The guard reads the worker's compiled `runtimeMetadata.js`, so fixtures
 * reproduce what `tsc` actually emits rather than a hand-written stand-in.
 *
 * A pre-`2.0` worker declares only `RUNTIME_METADATA_SCHEMA_VERSION` and
 * compares it with `===`; `2.0` and later add an explicit minimum.
 */
const LEGACY_DIST = `export const RUNTIME_METADATA_FILENAME = 'runtimemetadata.json';
export const RUNTIME_METADATA_SCHEMA_VERSION = '1.0';
export function validateRuntimeMetadata(value) {
    if (value.schemaVersion !== RUNTIME_METADATA_SCHEMA_VERSION) {
        return { status: 'unsupported-version', version: value.schemaVersion };
    }
}
`;

function currentDist(version: string, minimum: string): string {
  return `export const RUNTIME_METADATA_FILENAME = 'runtimemetadata.json';
export const RUNTIME_METADATA_SCHEMA_VERSION = '${version}';
export const MINIMUM_RUNTIME_METADATA_SCHEMA_VERSION = '${minimum}';
`;
}

const temporaryRoots: string[] = [];

afterEach(() => {
  delete process.env[SKIP_WORKER_CHECK_ENV];
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop() as string, { recursive: true, force: true });
  }
});

/**
 * Build a functions folder with the worker installed under it.
 *
 * @param dist - Contents of the worker's `dist/runtimeMetadata.js`, or
 *   `undefined` to install a worker that ships no metadata module at all.
 */
function createProject(options: {
  dist?: string;
  version?: string;
  installWorker?: boolean;
}): string {
  const root = mkdtempSync(join(tmpdir(), 'rayfin-worker-compat-'));
  temporaryRoots.push(root);

  const functionsDir = join(root, 'functions');
  mkdirSync(functionsDir, { recursive: true });
  writeFileSync(join(functionsDir, 'package.json'), '{"name":"functions"}');

  if (options.installWorker !== false) {
    const packageRoot = join(
      functionsDir,
      'node_modules',
      '@microsoft',
      'fabric-user-data-functions'
    );
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: WORKER_PACKAGE_NAME,
        version: options.version ?? '1.36.0-alpha.1756',
        main: 'dist/index.js',
      })
    );
    if (options.dist !== undefined) {
      writeFileSync(
        join(packageRoot, 'dist', 'runtimeMetadata.js'),
        options.dist
      );
    }
  }

  return functionsDir;
}

describe('checkWorkerSchemaCompatibility', () => {
  it('rejects a worker that predates the 2.0 schema', () => {
    // The case Anna hit: the worker falls back to source analysis, which
    // statically imports typescript, which the bundle deliberately excludes.
    const functionsDir = createProject({ dist: LEGACY_DIST });

    const result = checkWorkerSchemaCompatibility(functionsDir, '2.0');

    expect(result).toEqual({
      status: 'incompatible',
      workerFloor: '1.0',
      workerPackageVersion: '1.36.0-alpha.1756',
    });
  });

  it('rejects a worker that ships no runtime metadata module', () => {
    // Older still: no metadata contract at all, so it can only discover
    // functions by analysing sources.
    const functionsDir = createProject({ version: '1.20.0' });

    expect(checkWorkerSchemaCompatibility(functionsDir, '2.0')).toEqual({
      status: 'incompatible',
      workerPackageVersion: '1.20.0',
    });
  });

  it('accepts a worker whose minimum matches the written schema', () => {
    const functionsDir = createProject({ dist: currentDist('2.0', '2.0') });

    expect(checkWorkerSchemaCompatibility(functionsDir, '2.0')).toEqual({
      status: 'compatible',
    });
  });

  it('accepts a worker that predates an additive minor bump', () => {
    // Minors are additive, so a CLI writing 2.3 is readable by a worker whose
    // floor is 2.0 -- the closed key allowlists decide the rest.
    const functionsDir = createProject({ dist: currentDist('2.0', '2.0') });

    expect(checkWorkerSchemaCompatibility(functionsDir, '2.3')).toEqual({
      status: 'compatible',
    });
  });

  it('rejects a worker whose minor floor is above the written schema', () => {
    const functionsDir = createProject({ dist: currentDist('2.5', '2.5') });

    expect(checkWorkerSchemaCompatibility(functionsDir, '2.1')).toMatchObject({
      status: 'incompatible',
      workerFloor: '2.5',
    });
  });

  it('rejects a worker on a different major', () => {
    // Mirrors the worker's own gate: a major bump means incompatible in
    // either direction, so a higher major is not evidence it can read 2.0.
    const functionsDir = createProject({ dist: currentDist('3.0', '3.0') });

    expect(checkWorkerSchemaCompatibility(functionsDir, '2.0')).toMatchObject({
      status: 'incompatible',
      workerFloor: '3.0',
    });
  });

  it('does not block when the worker is not installed', () => {
    // Almost always "npm install has not run yet". Bundling fails immediately
    // after with a clearer message, so blocking here would only confuse.
    const functionsDir = createProject({ installWorker: false });

    expect(checkWorkerSchemaCompatibility(functionsDir, '2.0')).toMatchObject({
      status: 'unknown',
    });
  });

  it('does not block when the metadata module has an unexpected shape', () => {
    const functionsDir = createProject({ dist: 'export const nothing = 1;\n' });

    expect(checkWorkerSchemaCompatibility(functionsDir, '2.0')).toMatchObject({
      status: 'unknown',
    });
  });

  it('can be suppressed for a detection false positive', () => {
    const functionsDir = createProject({ dist: LEGACY_DIST });
    process.env[SKIP_WORKER_CHECK_ENV] = '1';

    expect(checkWorkerSchemaCompatibility(functionsDir, '2.0')).toMatchObject({
      status: 'unknown',
    });
  });

  it('finds a worker hoisted above the functions folder', () => {
    // The layout this whole change exists for: npm hoists the worker to the
    // app root, outside the folder being zipped.
    const root = mkdtempSync(join(tmpdir(), 'rayfin-worker-hoisted-'));
    temporaryRoots.push(root);
    const functionsDir = join(root, 'packages', 'functions');
    mkdirSync(functionsDir, { recursive: true });
    writeFileSync(join(functionsDir, 'package.json'), '{"name":"functions"}');

    const hoisted = join(
      root,
      'node_modules',
      '@microsoft',
      'fabric-user-data-functions'
    );
    mkdirSync(join(hoisted, 'dist'), { recursive: true });
    writeFileSync(
      join(hoisted, 'package.json'),
      JSON.stringify({ name: WORKER_PACKAGE_NAME, version: '1.36.0-alpha.1' })
    );
    writeFileSync(join(hoisted, 'dist', 'runtimeMetadata.js'), LEGACY_DIST);

    expect(checkWorkerSchemaCompatibility(functionsDir, '2.0')).toMatchObject({
      status: 'incompatible',
      workerFloor: '1.0',
    });
  });
});

describe('describeIncompatibleWorker', () => {
  it('names the installed version and the schema mismatch', () => {
    const message = describeIncompatibleWorker(
      {
        status: 'incompatible',
        workerFloor: '1.0',
        workerPackageVersion: '1.36.0-alpha.1756',
      },
      '2.0'
    );

    expect(message).toContain('1.36.0-alpha.1756');
    expect(message).toContain("schema '1.0'");
    expect(message).toContain("writes '2.0'");
    // Naming the symptom is what makes this message actionable: it is the
    // string the user would otherwise be left googling.
    expect(message).toContain('No job functions found');
  });

  it('explains a worker with no metadata support at all', () => {
    const message = describeIncompatibleWorker(
      { status: 'incompatible', workerPackageVersion: '1.20.0' },
      '2.0'
    );

    expect(message).toContain('predates runtime metadata entirely');
  });
});
