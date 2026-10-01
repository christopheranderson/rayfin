import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scaffoldFunctionsDirectory } from '../commands/functions/functions-scaffold.js';
import { getPackageVersion } from '../utils/version.js';

vi.mock('../utils/version.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/version.js')>();
  return { ...actual, getPackageVersion: vi.fn(actual.getPackageVersion) };
});

const assetsDir = resolve(import.meta.dirname, '..', '..', 'assets');
const functionsKitDir = resolve(
  assetsDir,
  '../../../../samples/universal-app/template/.agents/skills/functions-capability/kit/functions'
);

/** Read a scaffolded JSON file relative to the functions package. */
async function readJson<T = Record<string, unknown>>(
  ...segments: string[]
): Promise<T> {
  return JSON.parse(await readFile(join(...segments), 'utf8')) as T;
}

describe('functions scaffold', () => {
  let projectRoot: string;

  beforeEach(async () => {
    vi.mocked(getPackageVersion).mockReset();
    projectRoot = await mkdtemp(join(tmpdir(), 'rayfin-functions-scaffold-'));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Default `rayfin/functions` layout with a healthy composite project. */
  async function seedDefaultLayout(): Promise<string> {
    const rayfinDir = join(projectRoot, 'rayfin');
    await mkdir(rayfinDir, { recursive: true });
    await writeFile(join(rayfinDir, 'rayfin.yml'), 'id: test-project\n');
    await writeFile(
      join(projectRoot, 'tsconfig.json'),
      JSON.stringify({ files: [] })
    );
    await writeFile(
      join(rayfinDir, 'tsconfig.json'),
      JSON.stringify({
        extends: '../tsconfig.json',
        compilerOptions: { composite: true },
        include: ['**/*'],
      })
    );
    return rayfinDir;
  }

  /**
   * Workspace layout produced by the `universal-app` template plus the
   * functions capability pack: `services.functions.path: packages/functions`,
   * npm workspaces at the root, and no `rayfin/tsconfig.json` at all.
   */
  async function seedWorkspaceLayout(): Promise<string> {
    const rayfinDir = join(projectRoot, 'rayfin');
    await mkdir(rayfinDir, { recursive: true });
    await writeFile(
      join(rayfinDir, 'rayfin.yml'),
      [
        'id: universal-app',
        'services:',
        '  functions:',
        '    enabled: true',
        '    path: packages/functions',
      ].join('\n') + '\n'
    );
    await writeFile(
      join(projectRoot, 'package.json'),
      JSON.stringify({ name: 'universal-app', workspaces: ['packages/*'] })
    );
    return join(projectRoot, 'packages', 'functions');
  }

  it('does not require an Azurite instance for HTTP functions', async () => {
    const rayfinDir = await seedDefaultLayout();
    const functionsDir = join(rayfinDir, 'functions');

    await scaffoldFunctionsDirectory(projectRoot, functionsDir, [], assetsDir);

    const localSettings = await readJson<{ Values: Record<string, string> }>(
      functionsDir,
      'local.settings.json'
    );

    expect(localSettings.Values.AzureWebJobsStorage).toBe('');
  });

  it.each(['default', 'workspace'] as const)(
    'requires an AudienceScope-capable Preview bundle in the %s layout',
    async (layout) => {
      const functionsDir =
        layout === 'default'
          ? join(await seedDefaultLayout(), 'functions')
          : await seedWorkspaceLayout();
      const createdFiles: string[] = [];

      await scaffoldFunctionsDirectory(
        projectRoot,
        functionsDir,
        createdFiles,
        assetsDir
      );

      const host = await readJson(functionsDir, 'host.json');
      expect(host).toMatchObject({
        version: '2.0',
        extensionBundle: {
          id: 'Microsoft.Azure.Functions.ExtensionBundle.Preview',
          version: '[4.45.0, 5.0.0)',
        },
        watchDirectories: ['dist'],
      });
      const kitHost = await readJson(functionsKitDir, 'host.json');
      expect(host.extensionBundle).toEqual(kitHost.extensionBundle);
      expect(createdFiles).toContain(
        layout === 'default'
          ? 'rayfin/functions/host.json'
          : 'packages/functions/host.json'
      );
    }
  );

  it('requires an AudienceScope-capable stable bundle for deployment', async () => {
    const host = await readJson(assetsDir, 'functions', 'host.deploy.json');

    expect(host).toMatchObject({
      version: '2.0',
      extensionBundle: {
        id: 'Microsoft.Azure.Functions.ExtensionBundle',
        version: '[4.38.1, 5.0.0)',
      },
    });
    expect(host).not.toHaveProperty('watchDirectories');
  });

  it.each(['1.34.0', '1.35.0-beta.0', '1.36.0-alpha.1601'])(
    'pins the runtime to the running CLI version %s',
    async (version) => {
      vi.mocked(getPackageVersion).mockReturnValue(version);
      const rayfinDir = await seedDefaultLayout();
      const functionsDir = join(rayfinDir, 'functions');
      await writeFile(
        join(projectRoot, 'package.json'),
        JSON.stringify({
          dependencies: { '@microsoft/rayfin-client': '1.33.0' },
        })
      );

      const createdFiles: string[] = [];
      await scaffoldFunctionsDirectory(
        projectRoot,
        functionsDir,
        createdFiles,
        assetsDir
      );

      const manifest = await readJson<{
        dependencies: Record<string, string>;
      }>(functionsDir, 'package.json');
      expect(manifest.dependencies).toEqual({
        '@microsoft/fabric-user-data-functions': version,
      });
      expect(createdFiles).toContain('rayfin/functions/package.json');
    }
  );

  it.each(['1.34.0', '1.35.0-beta.0', '1.36.0-alpha.1601'])(
    'pins a workspace runtime to the running CLI version %s',
    async (version) => {
      vi.mocked(getPackageVersion).mockReturnValue(version);
      const functionsDir = await seedWorkspaceLayout();
      const createdFiles: string[] = [];

      await scaffoldFunctionsDirectory(
        projectRoot,
        functionsDir,
        createdFiles,
        assetsDir
      );

      const manifest = await readJson<{
        dependencies: Record<string, string>;
      }>(functionsDir, 'package.json');
      expect(manifest.dependencies).toEqual({
        '@microsoft/fabric-user-data-functions': version,
      });
      expect(createdFiles).toContain('packages/functions/package.json');
      expect(existsSync(join(projectRoot, 'rayfin', 'functions'))).toBe(false);
    }
  );

  it('fails before creating files when the CLI version is unavailable', async () => {
    vi.mocked(getPackageVersion).mockReturnValue('Unknown');
    const createdFiles: string[] = [];

    await expect(
      scaffoldFunctionsDirectory(
        projectRoot,
        join(projectRoot, 'rayfin', 'functions'),
        createdFiles,
        assetsDir
      )
    ).rejects.toThrow(
      'Could not read the CLI version from package.json, so the functions ' +
        'runtime cannot be pinned. Reinstall @microsoft/rayfin-cli.'
    );

    expect(await readdir(projectRoot)).toEqual([]);
    expect(createdFiles).toEqual([]);
  });

  it('does not overwrite existing files when the CLI version is unavailable', async () => {
    vi.mocked(getPackageVersion).mockReturnValue('Unknown');
    const rayfinDir = join(projectRoot, 'rayfin');
    const functionsDir = join(rayfinDir, 'functions');
    await mkdir(functionsDir, { recursive: true });
    const manifest =
      '{"name":"rayfin-functions","dependencies":{"@microsoft/fabric-user-data-functions":"1.34.0"}}\n';
    await writeFile(join(functionsDir, 'package.json'), manifest);

    await expect(
      scaffoldFunctionsDirectory(projectRoot, functionsDir, [], assetsDir)
    ).rejects.toThrow('runtime cannot be pinned');

    expect(await readFile(join(functionsDir, 'package.json'), 'utf8')).toBe(
      manifest
    );
    expect(await readdir(functionsDir)).toEqual(['package.json']);
  });

  it('refuses to scaffold into a directory owned by an unrelated package', async () => {
    const rayfinDir = await seedDefaultLayout();
    const functionsDir = join(rayfinDir, 'functions');
    await mkdir(functionsDir, { recursive: true });
    await writeFile(
      join(functionsDir, 'package.json'),
      JSON.stringify({ name: '@rayfin-app/frontend', private: true })
    );

    await expect(
      scaffoldFunctionsDirectory(projectRoot, functionsDir, [], assetsDir)
    ).rejects.toThrow(/@rayfin-app\/frontend/);

    // Refusal must happen before any file is touched.
    const pkg = await readJson<{ name: string }>(functionsDir, 'package.json');
    expect(pkg.name).toBe('@rayfin-app/frontend');
  });

  it('refuses to scaffold when the existing package.json cannot be parsed', async () => {
    const rayfinDir = await seedDefaultLayout();
    const functionsDir = join(rayfinDir, 'functions');
    await mkdir(functionsDir, { recursive: true });
    await writeFile(join(functionsDir, 'package.json'), '{not json');

    await expect(
      scaffoldFunctionsDirectory(projectRoot, functionsDir, [], assetsDir)
    ).rejects.toThrow(/could not be parsed/);
  });

  it('allows re-scaffolding a directory already owned by a prior functions scaffold', async () => {
    const rayfinDir = await seedDefaultLayout();
    const functionsDir = join(rayfinDir, 'functions');

    // First scaffold, then re-scaffold — the second call is the realistic
    // `--force` re-run and must not trip the ownership guard on its own output.
    await scaffoldFunctionsDirectory(projectRoot, functionsDir, [], assetsDir);
    await expect(
      scaffoldFunctionsDirectory(projectRoot, functionsDir, [], assetsDir)
    ).resolves.not.toThrow();
  });

  it('scaffolds into the configured services.functions.path', async () => {
    const functionsDir = await seedWorkspaceLayout();
    const createdFiles: string[] = [];

    await scaffoldFunctionsDirectory(
      projectRoot,
      functionsDir,
      createdFiles,
      assetsDir
    );

    const pkg = await readJson<{ name: string }>(functionsDir, 'package.json');
    expect(pkg.name).toBeDefined();

    // Reported paths are relative to the project root and POSIX-shaped, so the
    // CLI output matches the layout the user configured. `.vscode/settings.json`
    // is genuinely a project-root file and stays at the root.
    expect(createdFiles).toContain('packages/functions/package.json');
    expect(createdFiles).toContain('packages/functions/src/function_app.ts');
    for (const file of createdFiles) {
      expect(file).not.toContain('\\');
      expect(file.startsWith('rayfin/functions/')).toBe(false);
    }

    // The default location must be left alone entirely.
    expect(existsSync(join(projectRoot, 'rayfin', 'functions'))).toBe(false);
  });

  it('omits the composite reference when rayfin/tsconfig.json is missing', async () => {
    const functionsDir = await seedWorkspaceLayout();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await scaffoldFunctionsDirectory(projectRoot, functionsDir, [], assetsDir);

    const tsconfig = await readJson<{ references?: unknown }>(
      functionsDir,
      'tsconfig.json'
    );

    // A `references` entry pointing at a non-existent project is exactly what
    // makes `tsc --build` fail with TS5083 and takes `functions init` down.
    expect(tsconfig.references).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('omits the composite reference when rayfin/tsconfig.json has a dangling extends', async () => {
    const functionsDir = await seedWorkspaceLayout();
    const rayfinDir = join(projectRoot, 'rayfin');
    // Stock rayfin/tsconfig.json, but the root tsconfig.json it extends moved
    // under packages/* when the project adopted workspaces.
    await writeFile(
      join(rayfinDir, 'tsconfig.json'),
      JSON.stringify({ extends: '../tsconfig.json' })
    );
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await scaffoldFunctionsDirectory(projectRoot, functionsDir, [], assetsDir);

    const tsconfig = await readJson<{ references?: unknown }>(
      functionsDir,
      'tsconfig.json'
    );

    expect(tsconfig.references).toBeUndefined();
  });

  it('omits the composite reference for a workspace layout even when rayfin/tsconfig.json is usable', async () => {
    const functionsDir = await seedWorkspaceLayout();
    const rayfinDir = join(projectRoot, 'rayfin');
    await writeFile(
      join(rayfinDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { composite: true } })
    );

    await scaffoldFunctionsDirectory(projectRoot, functionsDir, [], assetsDir);

    const tsconfig = await readJson<{ references?: { path: string }[] }>(
      functionsDir,
      'tsconfig.json'
    );

    // The reference exists so UDF code can `import type` entity definitions
    // out of the data project. In a workspace layout those live in the
    // configured data package (e.g. packages/data), not in rayfin/ — so a
    // `../../rayfin` reference would point at the wrong project and enable
    // nothing. Omit it rather than emit a misleading entry.
    expect(tsconfig.references).toBeUndefined();
  });

  it('still emits the default composite reference for the rayfin/functions layout', async () => {
    const rayfinDir = await seedDefaultLayout();
    // A real project has entities under rayfin/data/ by the time functions
    // are added — the composite reference exists to `import type` these.
    await mkdir(join(rayfinDir, 'data'), { recursive: true });
    await writeFile(
      join(rayfinDir, 'data', 'GroceryItem.ts'),
      'export interface GroceryItem { id: string; }\n'
    );
    const functionsDir = join(rayfinDir, 'functions');

    await scaffoldFunctionsDirectory(projectRoot, functionsDir, [], assetsDir);

    const tsconfig = await readJson<{ references?: { path: string }[] }>(
      functionsDir,
      'tsconfig.json'
    );

    expect(tsconfig.references).toEqual([{ path: '..' }]);
  });

  it('omits the composite reference when rayfin/ has no entities yet (AB#2253308)', async () => {
    const rayfinDir = await seedDefaultLayout();
    const functionsDir = join(rayfinDir, 'functions');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // No rayfin/data/ entities at all — the repro from AB#2253308: the
    // composite project has zero compilable inputs, so tsc --build would
    // fail with TS18003 "No inputs were found" the moment the functions
    // package's tsconfig references it.
    await scaffoldFunctionsDirectory(projectRoot, functionsDir, [], assetsDir);

    const tsconfig = await readJson<{ references?: unknown }>(
      functionsDir,
      'tsconfig.json'
    );

    expect(tsconfig.references).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('emits the composite reference once entities exist anywhere under rayfin/ (excluding functions/)', async () => {
    const rayfinDir = await seedDefaultLayout();
    // An entity nested a few levels deep, and outside the eventual
    // functions/ subtree — should still count.
    await mkdir(join(rayfinDir, 'data', 'nested'), { recursive: true });
    await writeFile(
      join(rayfinDir, 'data', 'nested', 'Widget.ts'),
      'export interface Widget { id: string; }\n'
    );
    const functionsDir = join(rayfinDir, 'functions');

    await scaffoldFunctionsDirectory(projectRoot, functionsDir, [], assetsDir);

    const tsconfig = await readJson<{ references?: { path: string }[] }>(
      functionsDir,
      'tsconfig.json'
    );

    expect(tsconfig.references).toEqual([{ path: '..' }]);
  });

  it('excludes the nested functions package from rayfin/tsconfig.json', async () => {
    const rayfinDir = await seedDefaultLayout();
    const functionsDir = join(rayfinDir, 'functions');

    await scaffoldFunctionsDirectory(projectRoot, functionsDir, [], assetsDir);

    const parent = await readJson<{ exclude?: string[] }>(
      rayfinDir,
      'tsconfig.json'
    );

    expect(parent.exclude).toContain('functions/**/*');
  });

  it('leaves rayfin/tsconfig.json untouched when functions live outside rayfin/', async () => {
    const functionsDir = await seedWorkspaceLayout();
    const rayfinDir = join(projectRoot, 'rayfin');
    const original = JSON.stringify({
      compilerOptions: { composite: true },
      include: ['**/*'],
    });
    await writeFile(join(rayfinDir, 'tsconfig.json'), original);

    await scaffoldFunctionsDirectory(projectRoot, functionsDir, [], assetsDir);

    const parent = await readJson<{ exclude?: string[] }>(
      rayfinDir,
      'tsconfig.json'
    );

    // Nothing under rayfin/ needs excluding — the package is elsewhere.
    expect(parent.exclude).toBeUndefined();
  });
});
