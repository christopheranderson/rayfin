import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock collaborators so the test exercises the real schema-discovery logic in
// generateDabConfig (directory glob + dynamic import + SchemaAnalyzer) while
// isolating it from the project root lookup, the TypeScript compile step, and
// feature-flag disk reads.
vi.mock('../project-utils.js', () => ({
  findRayfinProjectRoot: vi.fn(),
}));

vi.mock('../typescript-compiler.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../typescript-compiler.js')>();
  return {
    ...actual,
    compileRayfinDirectory: vi.fn(async () => ({ success: true, errors: [] })),
  };
});

vi.mock('../feature-flags.js', () => ({
  // Anonymous-access gate reads `get('anonymous-data-access')`; returning false
  // is safe because the fixture entities declare no anonymous permissions.
  createCliFeatureFlags: vi.fn(() => ({ get: () => false })),
}));

import {
  generateDabConfig,
  resolvePackageExports,
} from '../dab-config-generator';
import { findRayfinProjectRoot } from '../project-utils.js';
import { RAYFIN_COMPILED_DIR } from '../typescript-compiler.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Write a compiled (ESM .js) Rayfin entity fixture to disk that mirrors what the
 * TypeScript compiler emits for an `@entity()` class: a class whose
 * `Symbol.metadata` carries the Rayfin entity metadata and marker symbol.
 */
function writeEntityFixture(compiledDataDir: string, className: string): void {
  const content = `(Symbol).metadata ??= Symbol('Symbol.metadata');
const RAYFIN_ENTITY = Symbol.for('microsoft.rayfin.entity');
const RAYFIN_ENTITY_MARKER = Symbol.for('microsoft.rayfin.entity.marker');

export class ${className} {}
${className}[Symbol.metadata] = {
  [RAYFIN_ENTITY]: { name: '${className}', fields: {}, permissions: {}, roles: [] },
  [RAYFIN_ENTITY_MARKER]: true,
};
`;
  writeFileSync(join(compiledDataDir, `${className}.js`), content, 'utf-8');
}

describe('generateDabConfig entity discovery (ADO 2106840)', () => {
  let projectRoot: string;
  let compiledDataDir: string;

  beforeEach(() => {
    // Keep the temp project inside the package tree so Vite/vitest allows the
    // dynamic import() of the freshly written fixture files.
    projectRoot = mkdtempSync(join(here, 'tmp-dab-'));

    // generateDabConfig requires rayfin/data to exist on disk.
    mkdirSync(join(projectRoot, 'rayfin', 'data'), { recursive: true });

    // Compiled entities are discovered from rayfin/<RAYFIN_COMPILED_DIR>/data.
    compiledDataDir = join(projectRoot, 'rayfin', RAYFIN_COMPILED_DIR, 'data');
    mkdirSync(compiledDataDir, { recursive: true });

    vi.mocked(findRayfinProjectRoot).mockReturnValue(projectRoot);
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  // Regression test for ADO 2106840: the CLI discovers every `@entity()` class
  // found in the compiled rayfin/data directory, with no schema entry point to
  // scope discovery. An "orphaned" entity file left in the data directory is
  // still turned into a database table.
  //
  // This characterizes the CURRENT (buggy) behavior. When discovery is scoped
  // to an explicit schema, the `Todo` assertion below should flip to
  // `not.toContain('Todo')`.
  it('includes an orphaned entity file left in rayfin/data', async () => {
    writeEntityFixture(compiledDataDir, 'Book');
    writeEntityFixture(compiledDataDir, 'Shelf');
    // Orphaned: not part of the intended Book/Shelf schema, but still present
    // in the data directory.
    writeEntityFixture(compiledDataDir, 'Todo');

    const result = await generateDabConfig({ dialect: 'mssql' });

    const entityNames = result.entities.map((e) => e.name);

    expect(entityNames).toContain('Book');
    expect(entityNames).toContain('Shelf');
    // Bug: the orphaned entity is discovered and processed too.
    expect(entityNames).toContain('Todo');
    expect(result.entities).toHaveLength(3);
  });

  it('does not write schema diagnostics to stdout by default', async () => {
    writeEntityFixture(compiledDataDir, 'Book');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await generateDabConfig({ dialect: 'mssql' });

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('writes schema diagnostics to stdout when verbose is set', async () => {
    writeEntityFixture(compiledDataDir, 'Book');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await generateDabConfig({ dialect: 'mssql', verbose: true });

    expect(logSpy).toHaveBeenCalled();
  });

  it.each([false, true])(
    'collects schema diagnostics independently of legacy verbose=%s',
    async (verbose) => {
      writeEntityFixture(compiledDataDir, 'Book');
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const diagnostics = { debug: vi.fn() };
      try {
        await generateDabConfig({
          dialect: 'mssql',
          verbose,
          diagnostics,
          compileMode: 'silent',
        });
        expect(diagnostics.debug).toHaveBeenCalledWith(
          expect.objectContaining({
            area: 'data.generate',
            message: expect.stringContaining('Starting schema analysis'),
          })
        );
        expect(logSpy.mock.calls.length > 0).toBe(verbose);
      } finally {
        logSpy.mockRestore();
      }
    }
  );
});

describe('generateDabConfig workspace support', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(here, 'tmp-ws-'));
    // Create the rayfin project root structure
    mkdirSync(join(projectRoot, 'rayfin', 'data'), { recursive: true });
    vi.mocked(findRayfinProjectRoot).mockReturnValue(projectRoot);
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('discovers entities from serviceRoot when provided', async () => {
    // Set up a sub-package as the data service root
    const dataServiceRoot = join(projectRoot, 'packages', 'data');
    mkdirSync(join(dataServiceRoot, 'rayfin', 'data'), { recursive: true });
    const compiledDir = join(
      dataServiceRoot,
      'rayfin',
      RAYFIN_COMPILED_DIR,
      'data'
    );
    mkdirSync(compiledDir, { recursive: true });

    writeEntityFixture(compiledDir, 'Task');
    writeEntityFixture(compiledDir, 'Category');

    const result = await generateDabConfig({
      dialect: 'mssql',
      serviceRoot: dataServiceRoot,
    });

    const entityNames = result.entities.map((e) => e.name);
    expect(entityNames).toContain('Task');
    expect(entityNames).toContain('Category');
    expect(result.entities).toHaveLength(2);
  });

  it('falls back to project root when serviceRoot is omitted', async () => {
    const compiledDir = join(
      projectRoot,
      'rayfin',
      RAYFIN_COMPILED_DIR,
      'data'
    );
    mkdirSync(compiledDir, { recursive: true });
    writeEntityFixture(compiledDir, 'Widget');

    const result = await generateDabConfig({ dialect: 'mssql' });

    const entityNames = result.entities.map((e) => e.name);
    expect(entityNames).toContain('Widget');
    expect(result.entities).toHaveLength(1);
  });

  it('throws when buildCommand fails', async () => {
    mkdirSync(join(projectRoot, 'rayfin', RAYFIN_COMPILED_DIR, 'data'), {
      recursive: true,
    });

    await expect(
      generateDabConfig({
        dialect: 'mssql',
        buildCommand: 'false', // unix `false` exits 1
      })
    ).rejects.toThrow('Data build command failed');
  });

  it('runs buildCommand before compilation when provided', async () => {
    const dataServiceRoot = join(projectRoot, 'packages', 'data');
    mkdirSync(join(dataServiceRoot, 'rayfin', 'data'), { recursive: true });
    const compiledDir = join(
      dataServiceRoot,
      'rayfin',
      RAYFIN_COMPILED_DIR,
      'data'
    );
    mkdirSync(compiledDir, { recursive: true });
    writeEntityFixture(compiledDir, 'Order');

    // Use a buildCommand that creates a marker file so we can verify it ran
    const markerPath = join(dataServiceRoot, '.build-ran');
    const result = await generateDabConfig({
      dialect: 'mssql',
      serviceRoot: dataServiceRoot,
      buildCommand: `touch "${markerPath}"`,
    });

    expect(existsSync(markerPath)).toBe(true);
    expect(result.entities.map((e) => e.name)).toContain('Order');
  });

  it('skips buildCommand when not provided', async () => {
    const compiledDir = join(
      projectRoot,
      'rayfin',
      RAYFIN_COMPILED_DIR,
      'data'
    );
    mkdirSync(compiledDir, { recursive: true });
    writeEntityFixture(compiledDir, 'Item');

    // No buildCommand — should succeed without any build step
    const result = await generateDabConfig({ dialect: 'mssql' });
    expect(result.entities).toHaveLength(1);
  });

  it('discovers entities from package.json exports when available', async () => {
    const dataServiceRoot = join(projectRoot, 'packages', 'data');
    const distDir = join(dataServiceRoot, 'dist');
    mkdirSync(distDir, { recursive: true });

    // Write a package.json with an exports entry
    writeFileSync(
      join(dataServiceRoot, 'package.json'),
      JSON.stringify({
        name: '@test/data',
        exports: { '.': { import: './dist/index.js' } },
      })
    );

    // Write a compiled entry point that exports entities
    writeEntityFixture(distDir, 'Account');
    writeEntityFixture(distDir, 'Post');
    // Write an index.js that re-exports
    writeFileSync(
      join(distDir, 'index.js'),
      `export { Account } from './Account.js';\nexport { Post } from './Post.js';`
    );

    const result = await generateDabConfig({
      dialect: 'mssql',
      serviceRoot: dataServiceRoot,
    });

    const entityNames = result.entities.map((e) => e.name);
    expect(entityNames).toContain('Account');
    expect(entityNames).toContain('Post');
    expect(result.entities).toHaveLength(2);
  });

  it('falls back to rayfin/data when no package.json exports exist', async () => {
    const dataServiceRoot = join(projectRoot, 'packages', 'data-legacy');
    mkdirSync(join(dataServiceRoot, 'rayfin', 'data'), { recursive: true });
    const compiledDir = join(
      dataServiceRoot,
      'rayfin',
      RAYFIN_COMPILED_DIR,
      'data'
    );
    mkdirSync(compiledDir, { recursive: true });

    writeEntityFixture(compiledDir, 'Legacy');

    const result = await generateDabConfig({
      dialect: 'mssql',
      serviceRoot: dataServiceRoot,
    });

    const entityNames = result.entities.map((e) => e.name);
    expect(entityNames).toContain('Legacy');
    expect(result.entities).toHaveLength(1);
  });
});

describe('resolvePackageExports', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(here, 'tmp-pkg-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no package.json exists', () => {
    expect(resolvePackageExports(tmpDir)).toBeNull();
  });

  it('resolves conditional exports with import field', () => {
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        exports: {
          '.': { import: './dist/index.js', types: './dist/index.d.ts' },
        },
      })
    );
    expect(resolvePackageExports(tmpDir)).toEqual(['./dist/index.js']);
  });

  it('resolves string exports shorthand', () => {
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ exports: { '.': './lib/main.js' } })
    );
    expect(resolvePackageExports(tmpDir)).toEqual(['./lib/main.js']);
  });

  it('resolves top-level string exports', () => {
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ exports: './dist/index.js' })
    );
    expect(resolvePackageExports(tmpDir)).toEqual(['./dist/index.js']);
  });

  it('falls back to main when exports is absent', () => {
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ main: './dist/main.js' })
    );
    expect(resolvePackageExports(tmpDir)).toEqual(['./dist/main.js']);
  });

  it('returns null when neither exports nor main exist', () => {
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'bare' })
    );
    expect(resolvePackageExports(tmpDir)).toBeNull();
  });
});
