import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  detectWorkspaceFunctionsPath,
  resolveFunctionsTargetDir,
} from '../commands/functions/functions-init.js';

describe('resolveFunctionsTargetDir', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'rayfin-functions-target-'));
    await mkdir(join(projectRoot, 'rayfin'), { recursive: true });
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function writeConfig(body: string): Promise<void> {
    await writeFile(join(projectRoot, 'rayfin', 'rayfin.yml'), body, 'utf8');
  }

  async function writeManifest(manifest: unknown): Promise<void> {
    await writeFile(
      join(projectRoot, 'package.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );
  }

  it('defaults to rayfin/functions for a single-package project', async () => {
    await writeConfig('id: test-project\n');
    await writeManifest({ name: 'test-project' });

    const target = resolveFunctionsTargetDir(projectRoot);

    expect(target.dir).toBe(resolve(projectRoot, 'rayfin/functions'));
    expect(target.source).toBe('default');
    // The historical default is never written back — that would add noise to
    // every single-package project's config.
    expect(target.persist).toBe(false);
  });

  it('honours services.functions.path for workspace layouts', async () => {
    await writeConfig(
      [
        'id: universal-app',
        'services:',
        '  functions:',
        '    enabled: true',
        '    path: packages/functions',
      ].join('\n') + '\n'
    );

    const target = resolveFunctionsTargetDir(projectRoot);

    expect(target.dir).toBe(resolve(projectRoot, 'packages/functions'));
    expect(target.source).toBe('services.functions.path');
    // Already in the config — nothing to write back.
    expect(target.persist).toBe(false);
  });

  it('resolves the target before the directory exists', async () => {
    await writeConfig(
      [
        'id: universal-app',
        'services:',
        '  functions:',
        '    path: packages/functions',
      ].join('\n') + '\n'
    );

    // Nothing has been scaffolded yet — resolution must not require the
    // directory to be present.
    expect(() => resolveFunctionsTargetDir(projectRoot)).not.toThrow();
  });

  it('rejects a path that escapes the project root', async () => {
    await writeConfig(
      [
        'id: universal-app',
        'services:',
        '  functions:',
        '    path: ../outside',
      ].join('\n') + '\n'
    );

    expect(() => resolveFunctionsTargetDir(projectRoot)).toThrow();
  });

  it('rejects an absolute path', async () => {
    await writeConfig(
      [
        'id: universal-app',
        'services:',
        '  functions:',
        `    path: ${resolve(tmpdir(), 'elsewhere')}`,
      ].join('\n') + '\n'
    );

    expect(() => resolveFunctionsTargetDir(projectRoot)).toThrow();
  });

  it('rejects an escaping --path override', async () => {
    await writeConfig('id: universal-app\n');

    expect(() =>
      resolveFunctionsTargetDir(projectRoot, '../outside')
    ).toThrow();
  });

  it('rejects a --path override that resolves to the project root', async () => {
    await writeConfig('id: universal-app\n');
    await writeManifest({ name: 'app', workspaces: ['packages/*'] });

    // `validateServicePath` allows dir === projectRoot (staticHosting builds
    // from `.` legitimately). The functions scaffold does not: it writes
    // package.json/tsconfig.json unconditionally and would overwrite the
    // project's own manifest — including its `workspaces` globs.
    expect(() => resolveFunctionsTargetDir(projectRoot, '.')).toThrow(
      /resolves to the project root/
    );
  });

  it('rejects services.functions.path resolving to the project root', async () => {
    await writeConfig(
      ['id: universal-app', 'services:', '  functions:', '    path: .'].join(
        '\n'
      ) + '\n'
    );
    await writeManifest({ name: 'app' });

    expect(() => resolveFunctionsTargetDir(projectRoot)).toThrow(
      /resolves to the project root/
    );
  });

  it('rejects a non-string services.functions.path with a clear message', async () => {
    await writeConfig(
      ['id: universal-app', 'services:', '  functions:', '    path: 123'].join(
        '\n'
      ) + '\n'
    );
    await writeManifest({ name: 'app' });

    // Guards against the raw `TypeError: path must be a string` that
    // `isAbsolute`/`resolve` throw when a malformed YAML value (a number or
    // mapping) reaches them unnormalized — the outer catch renders that as
    // an opaque "Error scaffolding functions project: ...".
    expect(() => resolveFunctionsTargetDir(projectRoot)).toThrow(
      /must be a relative path string, but got number/
    );
  });

  it('normalises trailing slashes on a configured services.functions.path', async () => {
    await writeConfig(
      [
        'id: universal-app',
        'services:',
        '  functions:',
        '    path: packages/fn/',
      ].join('\n') + '\n'
    );
    await writeManifest({ name: 'app', workspaces: ['packages/*'] });

    const target = resolveFunctionsTargetDir(projectRoot);

    expect(target.servicePath).toBe('packages/fn');
    // The normalized value equals the resolved one, so there is nothing new
    // to persist — writing `packages/fn` back over `packages/fn/` would be
    // pure config-file churn for a cosmetic difference.
    expect(target.persist).toBe(false);
  });

  it('normalises trailing slashes on --path', async () => {
    await writeConfig('id: universal-app\n');
    await writeManifest({ name: 'app' });

    const target = resolveFunctionsTargetDir(projectRoot, 'packages/fn///');

    expect(target.servicePath).toBe('packages/fn');
    expect(target.dir).toBe(resolve(projectRoot, 'packages/fn'));
  });

  it('trims a pathological run of slashes in linear time', async () => {
    await writeConfig('id: universal-app\n');
    await writeManifest({ name: 'app' });

    // Guards the CodeQL js/polynomial-redos fix. The blowup case is a
    // *failing* match — many slashes followed by a non-slash — where
    // `replace(/\/+$/, '')` retries from every offset. Measured at ~1.6s
    // with the old regex versus ~0.07ms for the reverse scan, so a regex
    // regression trips this assertion instead of passing quietly.
    const pathological = 'packages/fn' + '/'.repeat(60_000) + 'x';
    const started = Date.now();

    const target = resolveFunctionsTargetDir(projectRoot, pathological);

    // Nothing to strip here: the string does not end in a slash.
    expect(target.servicePath).toBe(pathological);
    expect(Date.now() - started).toBeLessThan(500);
  });

  describe('workspace auto-detection', () => {
    it('derives packages/functions for a fresh workspace project', async () => {
      await writeConfig('id: universal-app\n');
      await writeManifest({
        name: 'universal-app',
        workspaces: ['packages/*'],
      });

      const target = resolveFunctionsTargetDir(projectRoot);

      expect(target.dir).toBe(resolve(projectRoot, 'packages/functions'));
      expect(target.servicePath).toBe('packages/functions');
      expect(target.source).toBe('npm workspaces');
      // Must be written back, or every other command keeps resolving
      // rayfin/functions while the package lives in packages/.
      expect(target.persist).toBe(true);
    });

    it('uses the container the project actually declares', async () => {
      await writeConfig('id: app\n');
      await writeManifest({ name: 'app', workspaces: ['apps/*'] });

      const target = resolveFunctionsTargetDir(projectRoot);

      expect(target.servicePath).toBe('apps/functions');
    });

    it('supports the object form of the workspaces field', async () => {
      await writeConfig('id: app\n');
      await writeManifest({
        name: 'app',
        workspaces: { packages: ['packages/*'] },
      });

      expect(resolveFunctionsTargetDir(projectRoot).servicePath).toBe(
        'packages/functions'
      );
    });

    it('keeps an existing rayfin/functions package instead of orphaning it', async () => {
      // A workspace project scaffolded before auto-detection existed. Moving
      // it would leave the original package behind, unreferenced.
      await writeConfig('id: app\n');
      await writeManifest({ name: 'app', workspaces: ['packages/*'] });
      await mkdir(join(projectRoot, 'rayfin', 'functions'), {
        recursive: true,
      });

      const target = resolveFunctionsTargetDir(projectRoot);

      expect(target.dir).toBe(resolve(projectRoot, 'rayfin/functions'));
      expect(target.source).toBe('existing rayfin/functions/');
      expect(target.persist).toBe(false);
    });

    it('lets an explicit config path win over detection', async () => {
      await writeConfig(
        ['id: app', 'services:', '  functions:', '    path: services/fn'].join(
          '\n'
        ) + '\n'
      );
      await writeManifest({ name: 'app', workspaces: ['packages/*'] });

      expect(resolveFunctionsTargetDir(projectRoot).servicePath).toBe(
        'services/fn'
      );
    });

    it('lets --path win over both config and detection', async () => {
      await writeConfig(
        [
          'id: app',
          'services:',
          '  functions:',
          '    path: packages/functions',
        ].join('\n') + '\n'
      );
      await writeManifest({ name: 'app', workspaces: ['packages/*'] });

      const target = resolveFunctionsTargetDir(projectRoot, 'custom/fn');

      expect(target.dir).toBe(resolve(projectRoot, 'custom/fn'));
      expect(target.source).toBe('--path');
      // Differs from the configured value, so it has to be persisted.
      expect(target.persist).toBe(true);
    });
  });
});

describe('detectWorkspaceFunctionsPath', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'rayfin-workspace-detect-'));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function writeManifest(manifest: unknown): Promise<void> {
    await writeFile(
      join(projectRoot, 'package.json'),
      JSON.stringify(manifest),
      'utf8'
    );
  }

  it('returns null when there is no manifest', () => {
    expect(detectWorkspaceFunctionsPath(projectRoot)).toBeNull();
  });

  it('returns null for a non-workspace manifest', async () => {
    await writeManifest({ name: 'single' });
    expect(detectWorkspaceFunctionsPath(projectRoot)).toBeNull();
  });

  it('returns null for an unparseable manifest', async () => {
    await writeFile(join(projectRoot, 'package.json'), '{ not json', 'utf8');
    expect(detectWorkspaceFunctionsPath(projectRoot)).toBeNull();
  });

  it('skips globs with no unambiguous container', async () => {
    // `packages/**` and exact entries give no single directory to create a
    // new package in.
    await writeManifest({ workspaces: ['packages/**', 'tools/build'] });
    expect(detectWorkspaceFunctionsPath(projectRoot)).toBeNull();
  });

  it('picks the first single-level wildcard container', async () => {
    await writeManifest({ workspaces: ['tools/build', 'packages/*'] });
    expect(detectWorkspaceFunctionsPath(projectRoot)).toBe(
      'packages/functions'
    );
  });
});
