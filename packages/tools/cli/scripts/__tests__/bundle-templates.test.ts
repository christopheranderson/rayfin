import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const require = createRequire(import.meta.url);
const cliRoot = resolve(import.meta.dirname, '../..');
const samplesRoot = resolve(cliRoot, '../../../samples');
const functionsManifestPath = join(
  '.agents',
  'skills',
  'functions-capability',
  'kit',
  'functions',
  'package.json'
);

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

describe('template bundling', () => {
  let root: string;
  let sample: string;
  let output: string;
  let bundler: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rayfin-bundle-'));
    const scripts = join(root, 'packages', 'tools', 'cli', 'scripts');
    mkdirSync(scripts, { recursive: true });
    for (const file of [
      'bundle-templates.ts',
      'templateignore.ts',
      '.templateignore',
    ]) {
      copyFileSync(join(cliRoot, 'scripts', file), join(scripts, file));
    }
    symlinkSync(
      join(cliRoot, 'node_modules'),
      join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    bundler = join(scripts, 'bundle-templates.ts');
    sample = join(root, 'samples', 'example-app');
    output = join(root, 'packages', 'tools', 'cli', 'templates', 'example-app');
    writeJson(join(sample, 'package.json'), {
      name: 'example-app',
      template: { name: 'example-app' },
      scripts: { build: 'node ../scripts/build-shared.js' },
      dependencies: { '@example/shared': 'workspace:*' },
    });
    writeJson(join(root, 'packages', 'sdk', 'shared', 'package.json'), {
      name: '@example/shared',
      version: '1.2.3',
    });
    mkdirSync(join(root, 'samples', 'scripts'), { recursive: true });
    writeFileSync(
      join(root, 'samples', 'scripts', 'build-shared.js'),
      'export {};\n'
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function bundle() {
    const result = spawnSync(
      process.execPath,
      [require.resolve('tsx/cli'), bundler],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
      }
    );
    if (result.error) throw result.error;
    return result;
  }

  function linkManifest(directory: string, target: string): string {
    const path = join(sample, directory, 'package.json');
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path, 'file');
    return path;
  }

  it('preserves literal nested manifests while rewriting only root scripts', () => {
    const nested =
      '{ "name": "nested", "scripts": { "build": "tsc --build" } }\n';
    mkdirSync(join(sample, 'api'), { recursive: true });
    writeFileSync(join(sample, 'api', 'package.json'), nested);

    const result = bundle();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(output, 'api', 'package.json'), 'utf8')).toBe(
      nested
    );
    const rootPackage = JSON.parse(
      readFileSync(join(output, 'package.json'), 'utf8')
    );
    expect(rootPackage.dependencies['@example/shared']).toBe('^1.2.3');
    expect(rootPackage.scripts.build).toBe('node scripts/build-shared.js');
    expect(existsSync(join(output, 'scripts', 'build-shared.js'))).toBe(true);
    expect(lstatSync(join(output, 'api', 'package.json')).isFile()).toBe(true);
    rmSync(sample, { recursive: true });
    expect(readFileSync(join(output, 'api', 'package.json'), 'utf8')).toBe(
      nested
    );
  });

  it('resolves nested workspace dependencies without changing literal pins or other metadata', () => {
    const original = {
      name: 'nested',
      scripts: { build: 'node ../scripts/custom.js' },
      dependencies: { '@example/shared': 'workspace:*', literal: '~2.0.0' },
      devDependencies: { '@example/shared': 'workspace:*' },
      optionalDependencies: { '@example/shared': 'workspace:*' },
      peerDependencies: { '@example/shared': 'workspace:*' },
      peerDependenciesMeta: { '@example/shared': { optional: true } },
    };
    writeJson(join(sample, 'api', 'package.json'), original);

    const result = bundle();
    expect(result.status, result.stderr).toBe(0);
    expect(
      JSON.parse(readFileSync(join(output, 'api', 'package.json'), 'utf8'))
    ).toEqual({
      ...original,
      dependencies: { '@example/shared': '^1.2.3', literal: '~2.0.0' },
      devDependencies: { '@example/shared': '^1.2.3' },
      optionalDependencies: { '@example/shared': '^1.2.3' },
      peerDependencies: { '@example/shared': '^1.2.3' },
    });
  });

  it.each(['workspace:*', '~2.0.0'])(
    'rejects linked manifests with %s pins without changing the input',
    (version) => {
      const target = join(root, 'linked-manifest-source.json');
      writeJson(target, {
        name: 'linked-project',
        dependencies: { '@example/shared': version },
      });
      const original = readFileSync(target, 'utf8');
      const sourceLink = linkManifest('api', target);

      const result = bundle();
      expect(readFileSync(target, 'utf8')).toBe(original);
      expect(lstatSync(sourceLink).isSymbolicLink()).toBe(true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `Cannot bundle nested manifest ${join('api', 'package.json')}`
      );
      expect(result.stderr).toContain('Symbolic links are not supported');
      expect(result.stderr).toContain('Replace the link with a regular file');
      expect(() => lstatSync(join(output, 'api', 'package.json'))).toThrow(
        /ENOENT/u
      );
    }
  );

  it('rejects dangling linked manifests with relative-path context', () => {
    const target = join(root, 'missing-manifest.json');
    const sourceLink = linkManifest('api', target);

    const result = bundle();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Cannot bundle nested manifest ${join('api', 'package.json')}`
    );
    expect(result.stderr).toContain('Symbolic links are not supported');
    expect(lstatSync(sourceLink).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(() => lstatSync(join(output, 'api', 'package.json'))).toThrow(
      /ENOENT/u
    );
  });

  it('skips ignored linked manifests without following dangling targets', () => {
    writeFileSync(
      join(sample, '.templateignore'),
      'private-api/package.json\n'
    );
    const target = join(root, 'missing-manifest.json');
    const sourceLink = linkManifest('private-api', target);

    const result = bundle();
    expect(result.status, result.stderr).toBe(0);
    expect(lstatSync(sourceLink).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(() =>
      lstatSync(join(output, 'private-api', 'package.json'))
    ).toThrow(/ENOENT/u);
  });

  it('preserves directory ignore rules for linked dependency trees', () => {
    const target = join(root, 'excluded-modules');
    writeJson(join(target, 'dependency', 'package.json'), {
      dependencies: { '@example/missing': 'workspace:*' },
    });
    symlinkSync(
      target,
      join(sample, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    const result = bundle();
    expect(result.status, result.stderr).toBe(0);
    expect(() => lstatSync(join(output, 'node_modules'))).toThrow(/ENOENT/u);
  });

  it('bundles an authoring template without its harness and preserves pack-safe ignore files', () => {
    writeJson(join(sample, 'package.json'), {
      name: 'example-harness',
      private: true,
      scripts: { build: 'node scripts/build.js' },
    });
    const template = join(sample, 'template');
    writeJson(join(template, 'package.json'), {
      name: 'example-app',
      template: { name: 'example-app' },
      workspaces: ['packages/*'],
      dependencies: { '@example/shared': 'workspace:*' },
    });
    writeJson(join(template, 'packages', 'frontend', 'package.json'), {
      name: '@example/frontend',
      dependencies: { '@example/shared': 'workspace:*' },
    });
    writeFileSync(join(template, '.gitignore'), 'node_modules/\n');
    writeFileSync(
      join(template, 'packages', 'frontend', '.gitignore'),
      'dist/\n'
    );
    writeFileSync(join(sample, 'harness-only.txt'), 'not Builder source');
    writeJson(join(sample, 'target', 'package.json'), {
      name: 'generated-output',
    });

    const result = bundle();
    expect(result.status, result.stderr).toBe(0);
    expect(
      JSON.parse(readFileSync(join(output, 'package.json'), 'utf8'))
    ).toMatchObject({
      name: 'example-app',
      workspaces: ['packages/*'],
      dependencies: { '@example/shared': '^1.2.3' },
    });
    expect(
      JSON.parse(
        readFileSync(
          join(output, 'packages', 'frontend', 'package.json'),
          'utf8'
        )
      ).dependencies['@example/shared']
    ).toBe('^1.2.3');
    expect(existsSync(join(output, 'harness-only.txt'))).toBe(false);
    expect(existsSync(join(output, 'target'))).toBe(false);
    expect(existsSync(join(output, 'template'))).toBe(false);
    expect(readFileSync(join(output, '.gitignore.template'), 'utf8')).toBe(
      'node_modules/\n'
    );
    expect(
      readFileSync(
        join(output, 'packages', 'frontend', '.gitignore.template'),
        'utf8'
      )
    ).toBe('dist/\n');
    expect(readFileSync(join(template, '.gitignore'), 'utf8')).toBe(
      'node_modules/\n'
    );
    expect(existsSync(join(template, '.gitignore.template'))).toBe(false);
  });

  it('does not restore or parse manifests excluded by global or template ignore rules', () => {
    writeFileSync(
      join(sample, '.templateignore'),
      'private-api/package.json\n'
    );
    for (const directory of [
      join('api', 'node_modules', 'ignored'),
      join('api', '.temp'),
      'private-api',
    ]) {
      mkdirSync(join(sample, directory), { recursive: true });
      writeFileSync(join(sample, directory, 'package.json'), 'not JSON');
    }
    writeJson(join(sample, 'public-api', 'package.json'), {
      name: 'public-api',
    });

    const result = bundle();
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(output, 'api', 'node_modules'))).toBe(false);
    expect(existsSync(join(output, 'api', '.temp'))).toBe(false);
    expect(existsSync(join(output, 'private-api', 'package.json'))).toBe(false);
    expect(existsSync(join(output, 'public-api', 'package.json'))).toBe(true);
  });

  it('fails the bundle for an unresolved nested workspace dependency', () => {
    writeJson(join(sample, 'api', 'package.json'), {
      dependencies: { '@example/missing': 'workspace:*' },
    });

    const result = bundle();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Cannot resolve workspace dependency @example/missing'
    );
    expect(result.stdout).not.toContain('Bundled 1 template(s) successfully');
  });

  it.each(['not JSON', 'null', '[]'])(
    'fails the bundle for an invalid included nested manifest: %s',
    (content) => {
      mkdirSync(join(sample, 'api'), { recursive: true });
      writeFileSync(join(sample, 'api', 'package.json'), content);

      const result = bundle();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Failed to bundle example-app');
      expect(result.stderr).toContain(
        `Cannot bundle nested manifest ${join('api', 'package.json')}`
      );
    }
  );

  it('ships the real Universal App functions kit and can apply it from bundled output', () => {
    const universal = join(root, 'samples', 'universal-app');
    const template = join(universal, 'template');
    cpSync(join(samplesRoot, 'universal-app', 'template'), template, {
      recursive: true,
      filter: (path) =>
        !/[\\/](node_modules|dist|target|\.rush|\.temp)([\\/]|$)/u.test(path),
    });
    copyFileSync(
      join(samplesRoot, 'universal-app', 'package.json'),
      join(universal, 'package.json')
    );
    // The kit tracks the worker via workspace:*, so the fake workspace has to
    // expose the real package for the bundler to resolve it.
    const worker = JSON.parse(
      readFileSync(
        resolve(cliRoot, '../../udf/udf-worker-extension/package.json'),
        'utf8'
      )
    );
    writeJson(
      join(root, 'packages', 'udf', 'udf-worker-extension', 'package.json'),
      { name: worker.name, version: worker.version }
    );
    const sourcePaths = [
      'package.json',
      join('rayfin', 'rayfin.yml'),
      join('scripts', 'scaffold.mjs'),
      join('.agents', 'skills', 'functions-capability', 'pack.json'),
      join(dirname(functionsManifestPath), 'src', 'function_app.ts'),
      join(dirname(functionsManifestPath), 'host.json'),
      functionsManifestPath,
      ...['frontend', 'data', 'shared'].map((name) =>
        join('packages', name, 'package.json')
      ),
    ];
    const before = sourcePaths.map((path) =>
      readFileSync(join(template, path), 'utf8')
    );

    const result = bundle();
    expect(result.status, result.stderr).toBe(0);
    const bundled = join(
      root,
      'packages',
      'tools',
      'cli',
      'templates',
      'universal-app'
    );
    // The worker range is resolved from workspace:* while bundling, so the
    // shipped kit intentionally differs from the template source here.
    const expectedManifest = readFileSync(
      join(bundled, functionsManifestPath),
      'utf8'
    );
    expect(
      JSON.parse(expectedManifest).dependencies[
        '@microsoft/fabric-user-data-functions'
      ]
    ).toMatch(/^\^\d+\.\d+\.\d+/u);
    const rootManifest = JSON.parse(
      readFileSync(join(bundled, 'package.json'), 'utf8')
    );
    expect(rootManifest.workspaces).toEqual(['packages/*']);
    expect(rootManifest.scripts['pack:add']).toBe('node scripts/scaffold.mjs');
    for (const name of ['frontend', 'data', 'shared']) {
      const path = join('packages', name, 'package.json');
      expect(readFileSync(join(bundled, path), 'utf8')).toBe(
        readFileSync(join(template, path), 'utf8')
      );
    }
    expect(existsSync(join(bundled, 'template'))).toBe(false);
    expect(existsSync(join(bundled, 'target'))).toBe(false);
    expect(existsSync(join(bundled, '.gitignore.template'))).toBe(true);
    const apply = spawnSync(
      process.execPath,
      [join(bundled, 'scripts', 'scaffold.mjs'), 'functions', '--no-install'],
      { cwd: bundled, encoding: 'utf8', timeout: 30_000 }
    );
    if (apply.error) throw apply.error;
    expect(apply.status, apply.stderr).toBe(0);
    const config = parse(
      readFileSync(join(bundled, 'rayfin', 'rayfin.yml'), 'utf8')
    );
    expect(config.services.functions.enabled).toBe(true);
    expect(config.services.functions.auth).toEqual({ type: 'application' });
    const host = JSON.parse(
      readFileSync(join(bundled, 'packages', 'functions', 'host.json'), 'utf8')
    );
    expect(host).toMatchObject({
      version: '2.0',
      extensionBundle: {
        id: 'Microsoft.Azure.Functions.ExtensionBundle.Preview',
        version: '[4.49.0, 5.0.0)',
      },
      watchDirectories: ['dist'],
    });
    expect(
      readFileSync(
        join(bundled, 'packages', 'functions', 'package.json'),
        'utf8'
      )
    ).toBe(expectedManifest);
    expect(
      existsSync(
        join(bundled, 'packages', 'functions', 'src', 'function_app.ts')
      )
    ).toBe(true);
    expect(
      JSON.parse(
        readFileSync(
          join(bundled, 'packages', 'frontend', 'package.json'),
          'utf8'
        )
      ).dependencies['@rayfin-app/functions']
    ).toBe('*');
    expect(
      sourcePaths.map((path) => readFileSync(join(template, path), 'utf8'))
    ).toEqual(before);
  });
});
