import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The deploy build runs before `generateFunctionsMetadataFiles`, which is where
 * the secret registry would otherwise be written. A project with a secret
 * declared in `rayfin.yml` and no `secrets.generated.ts` yet — a fresh clone, or
 * a `rayfin secret set` made from another machine — would fail the build with
 * `TS2339: Property 'API_KEY' does not exist` and abort the deploy before the
 * generator it needs was ever reached.
 *
 * Only `runServiceBuildCommand` is stubbed; the rest of `config-utils` stays
 * real so path resolution behaves as it does in a deploy.
 */
const runServiceBuildCommand = vi.fn<() => Promise<boolean>>();

vi.mock('../../../utils/config-utils.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../utils/config-utils.js')
  >('../../../utils/config-utils.js');
  return { ...actual, runServiceBuildCommand };
});

const { buildFunctionsForDeploy } = await import('../up-functions.js');

describe('buildFunctionsForDeploy secret registry ordering', () => {
  let projectRoot: string;
  let functionsDir: string;
  let generatedPath: string;

  beforeEach(() => {
    projectRoot = join(
      tmpdir(),
      `rayfin-deploy-secrets-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    );
    functionsDir = join(projectRoot, 'rayfin', 'functions');
    generatedPath = join(functionsDir, 'src', 'secrets.generated.ts');
    mkdirSync(join(functionsDir, 'src'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0' }),
      'utf-8'
    );
    writeFileSync(
      join(projectRoot, 'rayfin', 'rayfin.yml'),
      [
        'id: fixture',
        'name: fixture',
        'version: 1.0.0',
        'services:',
        '  functions:',
        '    enabled: true',
        'secrets:',
        '  - name: API_KEY',
        '',
      ].join('\n'),
      'utf-8'
    );
    runServiceBuildCommand.mockReset();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('writes the registry before the build command runs', async () => {
    expect(existsSync(generatedPath)).toBe(false);

    let generatedWhenBuildStarted: string | undefined;
    runServiceBuildCommand.mockImplementation(async () => {
      generatedWhenBuildStarted = existsSync(generatedPath)
        ? readFileSync(generatedPath, 'utf-8')
        : undefined;
      return true;
    });

    await buildFunctionsForDeploy(functionsDir, {
      enabled: true,
      buildCommand: 'npm run build',
    } as Parameters<typeof buildFunctionsForDeploy>[1]);

    expect(runServiceBuildCommand).toHaveBeenCalled();
    expect(generatedWhenBuildStarted).toBeDefined();
    expect(generatedWhenBuildStarted).toContain('API_KEY: string;');
  });

  it('does not run the generator when the build is skipped', async () => {
    await buildFunctionsForDeploy(
      functionsDir,
      { enabled: true, buildCommand: 'npm run build' } as Parameters<
        typeof buildFunctionsForDeploy
      >[1],
      { skipBuild: true }
    );

    expect(runServiceBuildCommand).not.toHaveBeenCalled();
    expect(existsSync(generatedPath)).toBe(false);
  });

  it('still builds when the registry cannot be generated', async () => {
    // A misconfigured services.functions.path must not turn into a failed
    // deploy from this best-effort step; the authoritative generator inside
    // the metadata pass still reports it.
    writeFileSync(
      join(projectRoot, 'rayfin', 'rayfin.yml'),
      [
        'id: fixture',
        'name: fixture',
        'version: 1.0.0',
        'services:',
        '  functions:',
        '    enabled: true',
        "    path: '../../outside'",
        'secrets:',
        '  - name: API_KEY',
        '',
      ].join('\n'),
      'utf-8'
    );
    runServiceBuildCommand.mockResolvedValue(true);
    const warnings: string[] = [];

    await buildFunctionsForDeploy(
      functionsDir,
      { enabled: true, buildCommand: 'npm run build' } as Parameters<
        typeof buildFunctionsForDeploy
      >[1],
      { logger: (message: string) => warnings.push(message) }
    );

    expect(runServiceBuildCommand).toHaveBeenCalled();
    expect(warnings.some((w) => w.includes('secrets.generated.ts'))).toBe(true);
  });
});
