import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  getRayfinPackageDirs,
  REPO_ROOT,
  rewriteToLocalPackages,
  stripJsonComments,
} from './local-packages.js';

describe('stripJsonComments', () => {
  it('removes line comments', () => {
    const input = `{
  // this is a comment
  "key": "value"
}`;
    const result = JSON.parse(stripJsonComments(input));
    expect(result).toEqual({ key: 'value' });
  });

  it('removes block comments', () => {
    const input = `{
  /* block comment */
  "key": "value"
}`;
    const result = JSON.parse(stripJsonComments(input));
    expect(result).toEqual({ key: 'value' });
  });

  it('preserves slashes inside strings', () => {
    const input = `{
  "url": "https://example.com/path",
  // comment
  "other": "a /* not a comment */ b"
}`;
    const result = JSON.parse(stripJsonComments(input));
    expect(result.url).toBe('https://example.com/path');
    expect(result.other).toBe('a /* not a comment */ b');
  });

  it('handles escaped quotes in strings', () => {
    const input = `{
  "escaped": "he said \\"hello\\"",
  // comment
  "next": true
}`;
    const result = JSON.parse(stripJsonComments(input));
    expect(result.escaped).toBe('he said "hello"');
    expect(result.next).toBe(true);
  });
});

describe('getRayfinPackageDirs', () => {
  it('returns a non-empty map of @microsoft/* packages', () => {
    const dirs = getRayfinPackageDirs();

    expect(Object.keys(dirs).length).toBeGreaterThan(0);
  });

  it('only includes Rayfin packages and the Functions worker', () => {
    const dirs = getRayfinPackageDirs();

    for (const name of Object.keys(dirs)) {
      expect(
        name.startsWith('@microsoft/rayfin-') ||
          name === '@microsoft/fabric-user-data-functions'
      ).toBe(true);
    }
  });

  it('includes known SDK packages', () => {
    const dirs = getRayfinPackageDirs();

    expect(dirs['@microsoft/rayfin-core']).toBe('packages/typescript-sdk/core');
    expect(dirs['@microsoft/rayfin-data']).toBe('packages/typescript-sdk/data');
    expect(dirs['@microsoft/rayfin-cli']).toBe('packages/tools/cli');
    expect(dirs['@microsoft/fabric-user-data-functions']).toBe(
      'packages/udf/udf-worker-extension'
    );
  });

  it('excludes non-rayfin packages', () => {
    const dirs = getRayfinPackageDirs();

    expect(dirs['todo-app']).toBeUndefined();
    expect(dirs['eshop']).toBeUndefined();
    expect(dirs['@microsoft/create-rayfin']).toBeUndefined();
    expect(dirs['@microsoft/fabric-embedded-host']).toBeUndefined();
  });

  it('values are valid repo-relative paths that exist', async () => {
    const dirs = getRayfinPackageDirs();
    const { REPO_ROOT } = await import('./run-cli.js');

    for (const folder of Object.values(dirs)) {
      const absPath = join(REPO_ROOT, folder, 'package.json');
      expect(existsSync(absPath), `missing: ${absPath}`).toBe(true);
    }
  });
});

describe('rewriteToLocalPackages', () => {
  const tempDirs: string[] = [];
  function createProjectDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'rewrite-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rewrites @microsoft/* deps to file: protocol', () => {
    const projectDir = createProjectDir();
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({
        name: 'test-project',
        dependencies: {
          '@microsoft/rayfin-core': '^1.0.0',
          '@microsoft/fabric-user-data-functions': '1.36.0-alpha',
          'some-other-package': '^2.0.0',
        },
      }),
      'utf8'
    );

    rewriteToLocalPackages(projectDir);

    const pkg = JSON.parse(
      readFileSync(join(projectDir, 'package.json'), 'utf8')
    );

    expect(pkg.dependencies['@microsoft/rayfin-core']).toMatch(/^file:/);
    expect(
      fileURLToPath(pkg.dependencies['@microsoft/fabric-user-data-functions'])
    ).toBe(join(REPO_ROOT, 'packages', 'udf', 'udf-worker-extension'));
    expect(pkg.dependencies['some-other-package']).toBe('^2.0.0');
  });

  it('adds overrides for all @microsoft/* packages', () => {
    const projectDir = createProjectDir();
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({
        name: 'test-project',
        dependencies: { '@microsoft/rayfin-core': '^1.0.0' },
      }),
      'utf8'
    );

    rewriteToLocalPackages(projectDir);

    const pkg = JSON.parse(
      readFileSync(join(projectDir, 'package.json'), 'utf8')
    );

    expect(pkg.overrides).toBeDefined();
    expect(pkg.overrides['@microsoft/rayfin-core']).toMatch(/^file:/);
    expect(pkg.overrides['@microsoft/rayfin-data']).toMatch(/^file:/);
    expect(pkg.overrides['@microsoft/rayfin-client']).toMatch(/^file:/);
    expect(pkg.overrides['@microsoft/fabric-user-data-functions']).toMatch(
      /^file:/
    );
  });

  it('does not overwrite existing user overrides', () => {
    const projectDir = createProjectDir();
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({
        name: 'test-project',
        dependencies: {},
        overrides: { 'my-pkg': '1.0.0' },
      }),
      'utf8'
    );

    rewriteToLocalPackages(projectDir);

    const pkg = JSON.parse(
      readFileSync(join(projectDir, 'package.json'), 'utf8')
    );

    expect(pkg.overrides['my-pkg']).toBe('1.0.0');
  });

  it('writes workspace overrides at the root with location-independent URLs', () => {
    const projectDir = createProjectDir();
    const functionsDir = join(projectDir, 'packages', 'functions');
    mkdirSync(functionsDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({
        private: true,
        workspaces: ['packages/*'],
        overrides: { 'my-pkg': '1.0.0' },
      })
    );
    const rootTsconfig = JSON.stringify({ files: [], references: [] });
    writeFileSync(join(projectDir, 'tsconfig.json'), rootTsconfig);
    writeFileSync(
      join(functionsDir, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@microsoft/fabric-user-data-functions': '1.36.0-alpha',
        },
      })
    );
    writeFileSync(
      join(functionsDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'ES2022' } })
    );

    rewriteToLocalPackages(functionsDir, { workspaceRoot: projectDir });

    const root = JSON.parse(
      readFileSync(join(projectDir, 'package.json'), 'utf8')
    );
    const functions = JSON.parse(
      readFileSync(join(functionsDir, 'package.json'), 'utf8')
    );
    const worker = '@microsoft/fabric-user-data-functions';
    expect(fileURLToPath(functions.dependencies[worker])).toBe(
      join(REPO_ROOT, 'packages', 'udf', 'udf-worker-extension')
    );
    expect(fileURLToPath(root.overrides[worker])).toBe(
      join(REPO_ROOT, 'packages', 'udf', 'udf-worker-extension')
    );
    expect(fileURLToPath(root.overrides['@microsoft/rayfin-client'])).toBe(
      join(REPO_ROOT, getRayfinPackageDirs()['@microsoft/rayfin-client']!)
    );
    expect(root.overrides['my-pkg']).toBe('1.0.0');
    expect(functions.overrides).toBeUndefined();
    expect(readFileSync(join(projectDir, 'tsconfig.json'), 'utf8')).toBe(
      rootTsconfig
    );
    expect(
      JSON.parse(readFileSync(join(functionsDir, 'tsconfig.json'), 'utf8'))
        .compilerOptions.preserveSymlinks
    ).toBe(true);
  });
});
