import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initFunctions } from './init-functions.js';
import { type CliResult, runNpmInstall } from './local-packages.js';
import type { CliRunners } from './scaffold-template.js';

const settings = vi.hoisted(() => ({ useLocalPackages: true }));
vi.mock('./scaffold-template.js', () => settings);
vi.mock('./local-packages.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./local-packages.js')>()),
  runNpmInstall: vi.fn(),
}));

const success: CliResult = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  output: '',
};
const version = '1.36.0-alpha';
let projectDir: string;
let runCli: ReturnType<typeof vi.fn<CliRunners['runCli']>>;

function writeScaffold(
  functionsPath = 'rayfin/functions',
  workerVersion = version,
  workspace = false
): string {
  const functionsDir = join(projectDir, functionsPath);
  mkdirSync(join(projectDir, 'rayfin'), { recursive: true });
  mkdirSync(functionsDir, { recursive: true });
  writeFileSync(
    join(projectDir, 'rayfin', 'rayfin.yml'),
    `name: test\nservices:\n  functions:\n    path: ${functionsPath}\n`
  );
  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify({
      name: 'test',
      ...(workspace ? { workspaces: ['packages/*'] } : {}),
    })
  );
  writeFileSync(
    join(functionsDir, 'package.json'),
    JSON.stringify({
      dependencies: { '@microsoft/fabric-user-data-functions': workerVersion },
    })
  );
  return functionsDir;
}

beforeEach(() => {
  settings.useLocalPackages = true;
  vi.mocked(runNpmInstall).mockReset().mockResolvedValue(success);
  projectDir = mkdtempSync(join(tmpdir(), 'init-functions-test-'));
  runCli = vi.fn<CliRunners['runCli']>().mockImplementation(async (args) =>
    args[0] === '--version'
      ? {
          ...success,
          stdout: `${version} (built Sep 18, 2026, 04:16 PM PDT)\n`,
          output: `${version} (built Sep 18, 2026, 04:16 PM PDT)\n`,
        }
      : success
  );
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('initFunctions', () => {
  it('scaffolds, checks the exact pin, rewrites local deps, then finishes init', async () => {
    const functionsDir = writeScaffold();
    writeFileSync(
      join(projectDir, 'rayfin', 'rayfin.yml'),
      'name: test\nservices:\n  functions:\n    enabled: true\n'
    );

    const result = await initFunctions({ projectDir, runners: { runCli } });

    expect(result).toBe(success);
    expect(runNpmInstall).not.toHaveBeenCalled();
    expect(runCli.mock.calls.map(([args]) => args)).toEqual([
      ['functions', 'init', '--skip-install'],
      ['--version'],
      ['functions', 'init'],
    ]);
    const pkg = JSON.parse(
      readFileSync(join(functionsDir, 'package.json'), 'utf8')
    );
    expect(pkg.dependencies['@microsoft/fabric-user-data-functions']).toMatch(
      /^file:/
    );
    expect(pkg.overrides['@microsoft/rayfin-client']).toMatch(/^file:/);
  });

  it('uses the configured or auto-detected path and npm workspace root', async () => {
    const functionsDir = writeScaffold('packages/functions', version, true);

    await initFunctions({ projectDir, runners: { runCli } });

    expect(runNpmInstall).toHaveBeenCalledExactlyOnceWith(projectDir);
    expect(vi.mocked(runNpmInstall).mock.invocationCallOrder[0]).toBeLessThan(
      runCli.mock.invocationCallOrder[2]!
    );
    const pkg = JSON.parse(
      readFileSync(join(functionsDir, 'package.json'), 'utf8')
    );
    const root = JSON.parse(
      readFileSync(join(projectDir, 'package.json'), 'utf8')
    );
    expect(pkg.dependencies['@microsoft/fabric-user-data-functions']).toMatch(
      /^file:/
    );
    expect(pkg.overrides).toBeUndefined();
    expect(root.overrides['@microsoft/rayfin-client']).toMatch(/^file:/);
  });

  it('returns workspace-root installation failures before finishing init', async () => {
    writeScaffold('packages/functions', version, true);
    const failure = {
      ...success,
      exitCode: 1,
      output: 'Workspace installation failed',
    };
    vi.mocked(runNpmInstall).mockResolvedValueOnce(failure);

    await expect(
      initFunctions({ projectDir, runners: { runCli } })
    ).resolves.toBe(failure);
    expect(runCli).toHaveBeenCalledTimes(2);
  });

  it('uses --force only for scaffolding and preserves the explicit target', async () => {
    writeScaffold('services/my-functions');

    await initFunctions({
      projectDir,
      force: true,
      path: 'services/my-functions',
      runners: { runCli },
    });

    expect(runCli.mock.calls.map(([args]) => args)).toEqual([
      [
        'functions',
        'init',
        '--force',
        '--path',
        'services/my-functions',
        '--skip-install',
      ],
      ['--version'],
      ['functions', 'init'],
    ]);
  });

  it.each(['^1.36.0-alpha', 'latest', '1.35.1'])(
    'rejects an incorrect worker pin (%s) before rewriting or installing',
    async (workerVersion) => {
      const functionsDir = writeScaffold('rayfin/functions', workerVersion);
      const pkgPath = join(functionsDir, 'package.json');
      const original = readFileSync(pkgPath, 'utf8');

      await expect(
        initFunctions({ projectDir, runners: { runCli } })
      ).rejects.toThrow(
        `Expected Functions worker to be pinned to CLI version "${version}"`
      );

      expect(readFileSync(pkgPath, 'utf8')).toBe(original);
      expect(runCli).toHaveBeenCalledTimes(2);
    }
  );

  it('returns scaffold failures without attempting install', async () => {
    const failure = { ...success, exitCode: 1, output: 'Scaffold failed' };
    runCli.mockResolvedValueOnce(failure);

    await expect(
      initFunctions({ projectDir, runners: { runCli } })
    ).resolves.toBe(failure);
    expect(runCli).toHaveBeenCalledTimes(1);
  });

  it('reports a version lookup failure without rewriting the manifest', async () => {
    const functionsDir = writeScaffold();
    const pkgPath = join(functionsDir, 'package.json');
    const original = readFileSync(pkgPath, 'utf8');
    runCli.mockResolvedValueOnce(success).mockResolvedValueOnce({
      ...success,
      exitCode: 1,
      output: 'Version failed',
    });

    await expect(
      initFunctions({ projectDir, runners: { runCli } })
    ).rejects.toThrow('CLI version lookup failed:\nVersion failed');
    expect(readFileSync(pkgPath, 'utf8')).toBe(original);
    expect(runCli).toHaveBeenCalledTimes(2);
  });

  it('returns install/build failures from the final init', async () => {
    writeScaffold();
    const failure = { ...success, exitCode: 1, output: 'Build failed' };
    runCli
      .mockResolvedValueOnce(success)
      .mockResolvedValueOnce({ ...success, stdout: version })
      .mockResolvedValueOnce(failure);

    await expect(
      initFunctions({ projectDir, runners: { runCli } })
    ).resolves.toBe(failure);
  });

  it('leaves the ordinary registry flow unchanged', async () => {
    settings.useLocalPackages = false;
    const functionsDir = writeScaffold();
    const pkgPath = join(functionsDir, 'package.json');
    const original = readFileSync(pkgPath, 'utf8');

    await initFunctions({
      projectDir,
      force: true,
      path: 'rayfin/functions',
      runners: { runCli },
    });

    expect(runCli).toHaveBeenCalledExactlyOnceWith(
      ['functions', 'init', '--force', '--path', 'rayfin/functions'],
      { cwd: projectDir, timeoutMs: 300_000 }
    );
    expect(readFileSync(pkgPath, 'utf8')).toBe(original);
    expect(runNpmInstall).not.toHaveBeenCalled();
  });
});
