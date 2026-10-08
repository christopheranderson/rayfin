import { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installAgentFilesAfterScaffold } from '../commands/ai-files/install-after-scaffold.js';
import { functionsInit } from '../commands/functions/functions-init.js';
import { scaffoldFunctionsDirectory } from '../commands/functions/functions-scaffold.js';
import { loadRayfinConfig, updateRayfinConfig } from '../utils/config-utils.js';
import { generateFunctionsTypes } from '../utils/functions-types-generator.js';
import { spawnSafe } from '../utils/platform-utils.js';
import { getPackageVersion } from '../utils/version.js';

vi.mock(
  '../commands/functions/functions-scaffold.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../commands/functions/functions-scaffold.js')
      >();
    return {
      ...actual,
      scaffoldFunctionsDirectory: vi.fn(actual.scaffoldFunctionsDirectory),
    };
  }
);

vi.mock('../utils/config-utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/config-utils.js')>();
  return { ...actual, updateRayfinConfig: vi.fn(actual.updateRayfinConfig) };
});

vi.mock('../utils/version.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/version.js')>();
  return { ...actual, getPackageVersion: vi.fn(actual.getPackageVersion) };
});

vi.mock('../utils/platform-utils.js', () => ({
  spawnSafe: vi.fn<typeof spawnSafe>(),
}));

vi.mock('../utils/functions-types-generator.js', () => ({
  generateFunctionsTypes: vi.fn<typeof generateFunctionsTypes>(),
}));

vi.mock('../commands/ai-files/install-after-scaffold.js', () => ({
  installAgentFilesAfterScaffold:
    vi.fn<typeof installAgentFilesAfterScaffold>(),
}));

const cliVersion = '1.36.0-alpha.1663';
const assetsDir = resolve(import.meta.dirname, '..', '..', 'assets');
const existingSource = 'export const userFunction = () => "keep me";\n';
const existingManifest = JSON.stringify({
  name: 'rayfin-functions',
  dependencies: {
    '@microsoft/fabric-user-data-functions': 'file:../../local-runtime.tgz',
  },
});

describe('functions init action', () => {
  let projectRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.mocked(getPackageVersion).mockReturnValue(cliVersion);
    vi.mocked(spawnSafe).mockImplementation(() => {
      const child = new ChildProcess();
      globalThis.queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    vi.mocked(generateFunctionsTypes).mockResolvedValue(undefined);
    vi.mocked(installAgentFilesAfterScaffold).mockReturnValue({
      installed: [],
      updated: [],
      warnings: [],
    });

    projectRoot = join(process.cwd(), `.functions-init-test-${randomUUID()}`);
    await mkdir(join(projectRoot, 'rayfin'), { recursive: true });
    await writeConfig('id: test-project\n');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function writeConfig(content: string): Promise<void> {
    await writeFile(join(projectRoot, 'rayfin', 'rayfin.yml'), content);
  }

  async function run(...args: string[]): Promise<void> {
    await functionsInit().parseAsync([projectRoot, ...args], { from: 'user' });
  }

  async function seedExisting(servicePath: string): Promise<string> {
    const functionsDir = resolve(projectRoot, servicePath);
    await mkdir(join(functionsDir, 'src'), { recursive: true });
    await writeFile(join(functionsDir, 'package.json'), existingManifest);
    await writeFile(
      join(functionsDir, 'src', 'function_app.ts'),
      existingSource
    );
    return functionsDir;
  }

  function output(): string {
    return [
      ...vi.mocked(console.log).mock.calls,
      ...vi.mocked(process.stderr.write).mock.calls,
    ]
      .map((args) => args.map(String).join(' '))
      .join('\n');
  }

  function expectSkipped(state: 'created' | 'preserved'): void {
    expect(spawnSafe).not.toHaveBeenCalled();
    expect(generateFunctionsTypes).not.toHaveBeenCalled();
    expect(installAgentFilesAfterScaffold).toHaveBeenCalledExactlyOnceWith(
      projectRoot,
      'interactive'
    );
    expect(output()).toContain(`Functions scaffold ${state}.`);
    expect(output()).toContain(
      'Dependency installation, build, and type generation were skipped.'
    );
    expect(output()).toContain(
      'rerun `rayfin functions init` without --skip-install or --force'
    );
    expect(output()).not.toContain('Functions project is ready');
    expect(output()).not.toContain('rayfin dev functions apply');
    expect(process.exit).not.toHaveBeenCalled();
  }

  function expectInstalled(functionsDir: string): void {
    expect(spawnSafe).toHaveBeenCalledTimes(2);
    expect(spawnSafe).toHaveBeenNthCalledWith(1, 'npm', ['install'], {
      cwd: functionsDir,
      stdio: 'inherit',
    });
    expect(spawnSafe).toHaveBeenNthCalledWith(2, 'npm', ['run', 'build'], {
      cwd: functionsDir,
      stdio: 'inherit',
    });
    expect(generateFunctionsTypes).toHaveBeenCalledExactlyOnceWith(
      functionsDir
    );
    expect(installAgentFilesAfterScaffold).toHaveBeenCalledExactlyOnceWith(
      projectRoot,
      'interactive'
    );
    expect(vi.mocked(spawnSafe).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(generateFunctionsTypes).mock.invocationCallOrder[0]
    );
    expect(
      vi.mocked(generateFunctionsTypes).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(installAgentFilesAfterScaffold).mock.invocationCallOrder[0]
    );
    expect(output()).toContain('Functions project is ready');
    expect(output()).toContain('rayfin dev functions apply');
    expect(process.exit).not.toHaveBeenCalled();
  }

  it('creates a pinned scaffold and enables functions without installing', async () => {
    await run('--skip-install');

    const functionsDir = join(projectRoot, 'rayfin', 'functions');
    expect(scaffoldFunctionsDirectory).toHaveBeenCalledExactlyOnceWith(
      projectRoot,
      functionsDir,
      expect.any(Array),
      assetsDir
    );
    expect(updateRayfinConfig).toHaveBeenCalledExactlyOnceWith(
      {
        services: {
          functions: {
            enabled: true,
            buildCommand: 'npm run build',
            auth: { type: 'application' },
          },
        },
      },
      projectRoot
    );
    expect(
      loadRayfinConfig(projectRoot, { silent: true })?.services?.functions
    ).toMatchObject({
      enabled: true,
      buildCommand: 'npm run build',
      auth: { type: 'application' },
    });
    const manifest: unknown = JSON.parse(
      await readFile(join(functionsDir, 'package.json'), 'utf8')
    );
    expect(manifest).toMatchObject({
      dependencies: { '@microsoft/fabric-user-data-functions': cliVersion },
    });
    expectSkipped('created');
  });

  it.each([
    { args: [], servicePath: 'packages/functions' },
    { args: ['--path', 'apps/functions'], servicePath: 'apps/functions' },
  ])('persists $servicePath before pausing', async ({ args, servicePath }) => {
    await writeConfig(
      'id: test-project\nservices:\n  functions:\n    enabled: false\n'
    );
    await writeFile(
      join(projectRoot, 'package.json'),
      JSON.stringify({ name: 'workspace-app', workspaces: ['packages/*'] })
    );

    await run('--skip-install', ...args);

    expect(scaffoldFunctionsDirectory).toHaveBeenCalledExactlyOnceWith(
      projectRoot,
      resolve(projectRoot, servicePath),
      expect.any(Array),
      assetsDir
    );
    expect(updateRayfinConfig).toHaveBeenNthCalledWith(
      1,
      { services: { functions: { path: servicePath } } },
      projectRoot
    );
    expect(
      loadRayfinConfig(projectRoot, { silent: true })?.services?.functions
    ).toMatchObject({
      enabled: true,
      buildCommand: 'npm run build',
      path: servicePath,
      auth: { type: 'application' },
    });
    expectSkipped('created');
  });

  it('keeps an explicit path override when adding application auth', async () => {
    await writeConfig(
      'id: test-project\nservices:\n  functions:\n' +
        '    enabled: false\n    path: packages/old-functions\n'
    );

    await run('--skip-install', '--path', 'apps/functions');

    expect(
      loadRayfinConfig(projectRoot, { silent: true })?.services?.functions
    ).toMatchObject({
      enabled: true,
      path: 'apps/functions',
      auth: { type: 'application' },
    });
    expect(existsSync(join(projectRoot, 'packages', 'old-functions'))).toBe(
      false
    );
    expectSkipped('created');
  });

  it.each([true, false])(
    'preserves an existing manifest, source, and config with skipInstall=%s',
    async (skipInstall) => {
      const functionsDir = await seedExisting('packages/functions');
      await writeConfig(
        'id: test-project\nservices:\n  functions:\n' +
          '    path: packages/functions\n    enabled: false\n    buildCommand: custom-build\n'
      );
      const configBefore = await readFile(
        join(projectRoot, 'rayfin', 'rayfin.yml'),
        'utf8'
      );

      await run(...(skipInstall ? ['--skip-install'] : []));

      expect(scaffoldFunctionsDirectory).not.toHaveBeenCalled();
      expect(updateRayfinConfig).not.toHaveBeenCalled();
      expect(await readFile(join(functionsDir, 'package.json'), 'utf8')).toBe(
        existingManifest
      );
      expect(
        await readFile(join(functionsDir, 'src', 'function_app.ts'), 'utf8')
      ).toBe(existingSource);
      expect(
        await readFile(join(projectRoot, 'rayfin', 'rayfin.yml'), 'utf8')
      ).toBe(configBefore);
      if (skipInstall) {
        expectSkipped('preserved');
      } else {
        expectInstalled(functionsDir);
      }
    }
  );

  it.each([true, false])(
    'preserves authored application auth on a re-run with enabled=%s',
    async (enabled) => {
      const functionsDir = await seedExisting('packages/functions');
      const config =
        'id: test-project\nservices:\n  functions:\n' +
        `    enabled: ${enabled}\n    path: packages/functions\n` +
        '    auth: { type: application } # authored setting\n';
      await writeConfig(config);

      await run('--skip-install');

      expect(updateRayfinConfig).not.toHaveBeenCalled();
      expect(scaffoldFunctionsDirectory).not.toHaveBeenCalled();
      expect(
        await readFile(join(projectRoot, 'rayfin', 'rayfin.yml'), 'utf8')
      ).toBe(config);
      expect(
        await readFile(join(functionsDir, 'src', 'function_app.ts'), 'utf8')
      ).toBe(existingSource);
      expectSkipped('preserved');
    }
  );

  it.each(
    [
      'auth: { type: delegated }',
      'auth: { type: Application }',
      'auth: { type: none }',
      'auth: { type: "" }',
      'auth: { type: null }',
      'auth: { type: [application] }',
      'auth: {}',
      'auth: null',
      'auth: []',
      'auth: application',
    ].flatMap((auth) =>
      [true, false].flatMap((enabled) =>
        ['fresh', 'rerun', 'force'].map((mode) => ({ auth, enabled, mode }))
      )
    )
  )(
    'rejects $auth before writes on $mode with enabled=$enabled',
    async ({ auth, enabled, mode }) => {
      const functionsDir = join(projectRoot, 'apps', 'functions');
      if (mode !== 'fresh') {
        await seedExisting('apps/functions');
      }
      const config =
        'id: test-project\nservices:\n  functions:\n' +
        `    enabled: ${enabled}\n    ${auth}\n`;
      await writeConfig(config);

      await expect(
        run(
          '--path',
          'apps/functions',
          ...(mode === 'force' ? ['--force'] : [])
        )
      ).rejects.toThrow('process.exit(1)');

      expect(console.error).toHaveBeenCalledWith(
        '❌ Error scaffolding functions project:',
        expect.objectContaining({
          message: expect.stringContaining(
            'Set services.functions.auth.type to "application".'
          ),
        })
      );
      expect(
        await readFile(join(projectRoot, 'rayfin', 'rayfin.yml'), 'utf8')
      ).toBe(config);
      expect(updateRayfinConfig).not.toHaveBeenCalled();
      expect(scaffoldFunctionsDirectory).not.toHaveBeenCalled();
      expect(spawnSafe).not.toHaveBeenCalled();
      expect(generateFunctionsTypes).not.toHaveBeenCalled();
      expect(installAgentFilesAfterScaffold).not.toHaveBeenCalled();
      if (mode === 'fresh') {
        expect(existsSync(functionsDir)).toBe(false);
      } else {
        expect(await readFile(join(functionsDir, 'package.json'), 'utf8')).toBe(
          existingManifest
        );
        expect(
          await readFile(join(functionsDir, 'src', 'function_app.ts'), 'utf8')
        ).toBe(existingSource);
      }
    }
  );

  it('re-scaffolds with --force --skip-install but does not install or generate types', async () => {
    const functionsDir = await seedExisting('rayfin/functions');

    await run('--force', '--skip-install');

    expect(scaffoldFunctionsDirectory).toHaveBeenCalledOnce();
    expect(updateRayfinConfig).toHaveBeenCalledOnce();
    expect(
      await readFile(join(functionsDir, 'package.json'), 'utf8')
    ).toContain(cliVersion);
    expect(
      await readFile(join(functionsDir, 'src', 'function_app.ts'), 'utf8')
    ).not.toBe(existingSource);
    expect(
      loadRayfinConfig(projectRoot, { silent: true })?.services?.functions
    ).toMatchObject({ enabled: true, auth: { type: 'application' } });
    expectSkipped('created');
  });

  it('does not report success when the application auth setting cannot be saved', async () => {
    vi.mocked(updateRayfinConfig).mockReturnValueOnce(false);

    await expect(run()).rejects.toThrow('process.exit(1)');

    expect(console.error).toHaveBeenCalledWith(
      '❌ Error scaffolding functions project:',
      expect.objectContaining({
        message: expect.stringContaining(
          'Could not save application authentication'
        ),
      })
    );
    expect(spawnSafe).not.toHaveBeenCalled();
    expect(generateFunctionsTypes).not.toHaveBeenCalled();
    expect(installAgentFilesAfterScaffold).not.toHaveBeenCalled();
    expect(output()).not.toContain('Functions project scaffolded successfully');
  });

  it('installs, builds, generates types, then installs agent files by default', async () => {
    await run();

    expect(scaffoldFunctionsDirectory).toHaveBeenCalledOnce();
    expect(updateRayfinConfig).toHaveBeenCalledOnce();
    expectInstalled(join(projectRoot, 'rayfin', 'functions'));
  });

  it('still rejects an unavailable CLI version in skip mode', async () => {
    vi.mocked(getPackageVersion).mockReturnValue('Unknown');

    await expect(run('--skip-install')).rejects.toThrow('process.exit(1)');

    expect(console.error).toHaveBeenCalledWith(
      '❌ Error scaffolding functions project:',
      expect.objectContaining({
        message: expect.stringContaining('runtime cannot be pinned'),
      })
    );
    expect(existsSync(join(projectRoot, 'rayfin', 'functions'))).toBe(false);
    expect(updateRayfinConfig).not.toHaveBeenCalled();
    expect(spawnSafe).not.toHaveBeenCalled();
    expect(generateFunctionsTypes).not.toHaveBeenCalled();
    expect(installAgentFilesAfterScaffold).not.toHaveBeenCalled();
  });

  it('does not overwrite another package with --force --skip-install', async () => {
    const functionsDir = await seedExisting('packages/frontend');
    const manifest = JSON.stringify({ name: 'frontend' });
    await writeFile(join(functionsDir, 'package.json'), manifest);

    await expect(
      run('--path', 'packages/frontend', '--force', '--skip-install')
    ).rejects.toThrow('process.exit(1)');

    expect(console.error).toHaveBeenCalledWith(
      '❌ Error scaffolding functions project:',
      expect.objectContaining({
        message: expect.stringContaining('Refusing to scaffold functions'),
      })
    );
    expect(await readFile(join(functionsDir, 'package.json'), 'utf8')).toBe(
      manifest
    );
    expect(
      await readFile(join(functionsDir, 'src', 'function_app.ts'), 'utf8')
    ).toBe(existingSource);
    expect(spawnSafe).not.toHaveBeenCalled();
    expect(generateFunctionsTypes).not.toHaveBeenCalled();
    expect(installAgentFilesAfterScaffold).not.toHaveBeenCalled();
  });

  it('does not advertise --skip-install in help', () => {
    const help = functionsInit().helpInformation();

    expect(help).toContain('--force');
    expect(help).toContain('--path');
    expect(help).not.toContain('--skip-install');
  });
});
