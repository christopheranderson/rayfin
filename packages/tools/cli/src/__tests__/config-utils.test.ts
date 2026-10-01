import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('updateRayfinConfig', () => {
  let testProjectDir: string;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    testProjectDir = join(
      tmpdir(),
      `rayfin-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    );
    mkdirSync(join(testProjectDir, 'rayfin'), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(testProjectDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should deep-merge services fields instead of replacing the object', async () => {
    const initialConfig = `id: test-project
name: test-project
version: 1.0.0
services:
  auth:
    enabled: true
  data:
    enabled: true
    dialect: mssql
  storage:
    enabled: false
`;
    writeFileSync(join(testProjectDir, 'rayfin', 'rayfin.yml'), initialConfig);

    const { updateRayfinConfig } = await import('../utils/config-utils.js');

    updateRayfinConfig(
      { services: { storage: { enabled: true } } } as any,
      testProjectDir
    );

    const { loadRayfinConfig } = await import('../utils/config-utils.js');
    const config = loadRayfinConfig(testProjectDir);

    // Updated field
    expect(config?.services?.storage?.enabled).toBe(true);
    // Preserved fields
    expect(config?.services?.auth?.enabled).toBe(true);
    expect(config?.services?.data?.enabled).toBe(true);
  });

  it('should overwrite top-level scalar fields', async () => {
    const initialConfig = `id: test-project
name: test-project
version: 1.0.0
services:
  auth:
    enabled: true
`;
    writeFileSync(join(testProjectDir, 'rayfin', 'rayfin.yml'), initialConfig);

    const { updateRayfinConfig } = await import('../utils/config-utils.js');

    updateRayfinConfig({ version: '2.0.0' }, testProjectDir);

    const { loadRayfinConfig } = await import('../utils/config-utils.js');
    const config = loadRayfinConfig(testProjectDir);

    expect(config?.version).toBe('2.0.0');
    expect(config?.id).toBe('test-project');
  });

  it('returns update facts without console output', async () => {
    writeFileSync(
      join(testProjectDir, 'rayfin', 'rayfin.yml'),
      'id: test-project\nversion: 1.0.0\n'
    );
    const { writeRayfinConfigUpdates } =
      await import('../utils/config-utils.js');
    vi.mocked(console.log).mockClear();
    vi.mocked(console.error).mockClear();

    expect(
      writeRayfinConfigUpdates({ version: '2.0.0' }, testProjectDir)
    ).toEqual({ status: 'updated' });

    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe('upsertSecretMetadata', () => {
  let testProjectDir: string;

  beforeEach(() => {
    testProjectDir = join(
      tmpdir(),
      `rayfin-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    );
    mkdirSync(join(testProjectDir, 'rayfin'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testProjectDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('creates the secrets section when missing', async () => {
    writeFileSync(
      join(testProjectDir, 'rayfin', 'rayfin.yml'),
      `id: test-project
name: test-project
version: 1.0.0
`
    );

    const { upsertSecretMetadata, loadRayfinConfig } =
      await import('../utils/config-utils.js');

    const result = upsertSecretMetadata('API_KEY', testProjectDir);
    expect(result).toEqual({ status: 'added' });

    const config = loadRayfinConfig(testProjectDir) as any;
    expect(config.secrets).toEqual([
      {
        name: 'API_KEY',
        description: 'TODO: Add description for this secret',
      },
    ]);
  });

  it('adds a new secret entry when secrets already exist', async () => {
    writeFileSync(
      join(testProjectDir, 'rayfin', 'rayfin.yml'),
      `id: test-project
name: test-project
version: 1.0.0
secrets:
  - name: EXISTING_SECRET
    description: Existing description
`
    );

    const { upsertSecretMetadata, loadRayfinConfig } =
      await import('../utils/config-utils.js');

    const result = upsertSecretMetadata('NEW_SECRET', testProjectDir);
    expect(result).toEqual({ status: 'added' });

    const config = loadRayfinConfig(testProjectDir) as any;
    expect(config.secrets).toEqual([
      {
        name: 'EXISTING_SECRET',
        description: 'Existing description',
      },
      {
        name: 'NEW_SECRET',
        description: 'TODO: Add description for this secret',
      },
    ]);
  });

  it('does not add duplicate entries when secret already exists', async () => {
    writeFileSync(
      join(testProjectDir, 'rayfin', 'rayfin.yml'),
      `id: test-project
name: test-project
version: 1.0.0
secrets:
  - name: API_KEY
    description: Existing description
`
    );

    const { upsertSecretMetadata, loadRayfinConfig } =
      await import('../utils/config-utils.js');

    const result = upsertSecretMetadata('API_KEY', testProjectDir);
    expect(result).toEqual({ status: 'exists' });

    const config = loadRayfinConfig(testProjectDir) as any;
    expect(config.secrets).toEqual([
      {
        name: 'API_KEY',
        description: 'Existing description',
      },
    ]);
  });

  it('uses a provided description when adding a new secret', async () => {
    writeFileSync(
      join(testProjectDir, 'rayfin', 'rayfin.yml'),
      `id: test-project
name: test-project
version: 1.0.0
`
    );

    const { upsertSecretMetadata, loadRayfinConfig } =
      await import('../utils/config-utils.js');

    const result = upsertSecretMetadata(
      'API_KEY',
      testProjectDir,
      'Used by upstream API authentication'
    );
    expect(result).toEqual({ status: 'added' });

    const config = loadRayfinConfig(testProjectDir) as any;
    expect(config.secrets).toEqual([
      {
        name: 'API_KEY',
        description: 'Used by upstream API authentication',
      },
    ]);
  });

  it('falls back to placeholder when description is blank', async () => {
    writeFileSync(
      join(testProjectDir, 'rayfin', 'rayfin.yml'),
      `id: test-project
name: test-project
version: 1.0.0
`
    );

    const { upsertSecretMetadata, loadRayfinConfig } =
      await import('../utils/config-utils.js');

    const result = upsertSecretMetadata('API_KEY', testProjectDir, '   ');
    expect(result).toEqual({ status: 'added' });

    const config = loadRayfinConfig(testProjectDir) as any;
    expect(config.secrets).toEqual([
      {
        name: 'API_KEY',
        description: 'TODO: Add description for this secret',
      },
    ]);
  });
});

describe('resolveEnvFilePath', () => {
  let testProjectDir: string;

  beforeEach(() => {
    testProjectDir = join(
      tmpdir(),
      `rayfin-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    );
    mkdirSync(join(testProjectDir, 'rayfin'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testProjectDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should prefer --env-file over everything', async () => {
    const { resolveEnvFilePath } = await import('../utils/config-utils.js');
    const result = resolveEnvFilePath(
      testProjectDir,
      'custom/.env',
      { RAYFIN_ENV_FILE: 'other/.env' },
      'up'
    );
    expect(result.source).toBe('cli-arg');
    expect(result.path).toBeDefined();
    expect(result.path!.replace(/\\/g, '/')).toContain('custom/.env');
  });

  it('should prefer RAYFIN_ENV_FILE when no --env-file', async () => {
    const { resolveEnvFilePath } = await import('../utils/config-utils.js');
    const result = resolveEnvFilePath(
      testProjectDir,
      undefined,
      { RAYFIN_ENV_FILE: 'from-env/.env' },
      'up'
    );
    expect(result.source).toBe('env-var');
    expect(result.path).toBeDefined();
    expect(result.path!.replace(/\\/g, '/')).toContain('from-env/.env');
  });

  it('ignores a missing explicitly selected env file by default', async () => {
    const { loadEnvironmentVariables } =
      await import('../utils/config-utils.js');

    expect(
      loadEnvironmentVariables({
        projectRoot: testProjectDir,
        envFilePath: 'missing.env',
        processEnv: {},
      })
    ).toEqual(new Map());
  });

  it('rejects a missing explicitly selected env file when required', async () => {
    const { loadEnvironmentVariables } =
      await import('../utils/config-utils.js');

    expect(() =>
      loadEnvironmentVariables({
        projectRoot: testProjectDir,
        envFilePath: 'missing.env',
        requireExplicitEnvFile: true,
        processEnv: {},
      })
    ).toThrow(/Environment file not found: .*missing\.env/);
  });

  it('does not throw for a missing env-var-sourced path even when requireExplicitEnvFile is set', async () => {
    // The require-explicit guard is deliberately scoped to `cli-arg`
    // sources. A missing RAYFIN_ENV_FILE (source: 'env-var') must still
    // resolve silently so the env var stays optional.
    const { loadEnvironmentVariables } =
      await import('../utils/config-utils.js');

    expect(() =>
      loadEnvironmentVariables({
        projectRoot: testProjectDir,
        requireExplicitEnvFile: true,
        command: 'up',
        processEnv: { RAYFIN_ENV_FILE: 'missing-from-env.env' },
      })
    ).not.toThrow();
  });

  it('always resolves to rayfin/.env for command=up regardless of legacy .env.fabric', async () => {
    // env-strategy v2: legacy `.env.fabric` preference was dropped.
    writeFileSync(join(testProjectDir, 'rayfin', '.env.fabric'), 'X=1\n');
    const { resolveEnvFilePath } = await import('../utils/config-utils.js');
    const result = resolveEnvFilePath(testProjectDir, undefined, {}, 'up');
    expect(result.source).toBe('default');
    expect(result.path).toContain(join('rayfin', '.env'));
    expect(result.path).not.toContain('.env.fabric');
  });

  it('always resolves to rayfin/.env for command=dev regardless of legacy .env.local', async () => {
    // env-strategy v2: legacy `.env.local` preference was dropped.
    writeFileSync(join(testProjectDir, 'rayfin', '.env.local'), 'X=1\n');
    const { resolveEnvFilePath } = await import('../utils/config-utils.js');
    const result = resolveEnvFilePath(testProjectDir, undefined, {}, 'dev');
    expect(result.source).toBe('default');
    expect(result.path).toContain(join('rayfin', '.env'));
    expect(result.path).not.toContain('.env.local');
  });

  it('falls back to rayfin/.env when no command specified', async () => {
    const { resolveEnvFilePath } = await import('../utils/config-utils.js');
    const result = resolveEnvFilePath(testProjectDir, undefined, {});
    expect(result.source).toBe('default');
    expect(result.path).toContain(join('rayfin', '.env'));
  });
});

describe('resolveServicePath/resolveServiceRoot and validateServicePath', () => {
  let testProjectDir: string;

  beforeEach(() => {
    testProjectDir = join(
      tmpdir(),
      `rayfin-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    );
    mkdirSync(testProjectDir, { recursive: true });
    mkdirSync(join(testProjectDir, 'packages', 'data'), { recursive: true });
    mkdirSync(join(testProjectDir, 'packages', 'functions'), {
      recursive: true,
    });
  });

  afterEach(() => {
    try {
      rmSync(testProjectDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('resolveServicePath falls back to project root when path is absent', async () => {
    const { resolveServicePath } = await import('../utils/config-utils.js');
    expect(resolveServicePath(testProjectDir, undefined)).toBe(testProjectDir);
  });

  it('resolveServicePath resolves relative path from project root', async () => {
    const { resolveServicePath } = await import('../utils/config-utils.js');
    const resolved = resolveServicePath(testProjectDir, 'packages/data');
    expect(resolved.replace(/\\/g, '/')).toBe(
      `${testProjectDir.replace(/\\/g, '/')}/packages/data`
    );
  });

  it('resolveServicePath treats both separator styles the same', async () => {
    const { resolveServicePath } = await import('../utils/config-utils.js');
    const { join, resolve } = await import('path');

    // Same normalisation requirement as validateServicePath: a Windows-authored
    // `path: 'packages\data'` must not become one directory of that literal
    // name on POSIX.
    const expected = resolve(join(testProjectDir, 'packages', 'data'));
    expect(resolveServicePath(testProjectDir, 'packages/data')).toBe(expected);
    expect(resolveServicePath(testProjectDir, 'packages\\data')).toBe(expected);
  });

  it('resolveServiceRoot validates and resolves relative path from project root', async () => {
    const { resolveServiceRoot } = await import('../utils/config-utils.js');
    const resolved = resolveServiceRoot(
      testProjectDir,
      'data',
      'packages/data'
    );
    expect(resolved.replace(/\\/g, '/')).toBe(
      `${testProjectDir.replace(/\\/g, '/')}/packages/data`
    );
  });

  it('resolveServiceRoot resolves to project root when path is "."', async () => {
    const { resolveServiceRoot } = await import('../utils/config-utils.js');
    expect(resolveServiceRoot(testProjectDir, 'data', '.')).toBe(
      testProjectDir
    );
  });

  it('resolveServiceRoot resolves rayfin/functions for functions service default', async () => {
    const { resolve } = await import('node:path');
    const { resolveServiceRoot } = await import('../utils/config-utils.js');
    mkdirSync(join(testProjectDir, 'rayfin', 'functions'), { recursive: true });
    expect(
      resolveServiceRoot(
        testProjectDir,
        'functions',
        'rayfin/functions'
      ).replace(/\\/g, '/')
    ).toBe(resolve(testProjectDir, 'rayfin', 'functions').replace(/\\/g, '/'));
  });

  it('resolveServiceRoot uses explicit path for functions when provided', async () => {
    const { resolveServiceRoot } = await import('../utils/config-utils.js');
    const resolved = resolveServiceRoot(
      testProjectDir,
      'functions',
      'packages/functions'
    );
    expect(resolved.replace(/\\/g, '/')).toBe(
      `${testProjectDir.replace(/\\/g, '/')}/packages/functions`
    );
  });

  it('resolveServiceRoot rejects invalid paths with the same validation rules', async () => {
    const { resolveServiceRoot } = await import('../utils/config-utils.js');
    expect(() =>
      resolveServiceRoot(testProjectDir, 'data', '../../outside')
    ).toThrow('escapes the project root');
  });

  it('validateServicePath accepts existing in-root relative path', async () => {
    const { validateServicePath } = await import('../utils/config-utils.js');
    expect(() =>
      validateServicePath(testProjectDir, 'data', 'packages/data')
    ).not.toThrow();
  });

  it('validateServicePath accepts "." (project root)', async () => {
    const { validateServicePath } = await import('../utils/config-utils.js');
    expect(() =>
      validateServicePath(testProjectDir, 'staticHosting', '.')
    ).not.toThrow();
  });

  it('validateServicePath rejects absolute paths', async () => {
    const { validateServicePath } = await import('../utils/config-utils.js');
    expect(() =>
      validateServicePath(testProjectDir, 'data', '/tmp/absolute')
    ).toThrow('must be a relative path');
  });

  it('validateServicePath rejects project-root traversal', async () => {
    const { validateServicePath } = await import('../utils/config-utils.js');
    expect(() =>
      validateServicePath(testProjectDir, 'data', '../../outside')
    ).toThrow('escapes the project root');
  });

  it('validateServicePath rejects missing directories', async () => {
    const { validateServicePath } = await import('../utils/config-utils.js');
    expect(() =>
      validateServicePath(testProjectDir, 'data', 'packages/missing')
    ).toThrow('does not exist');
  });

  it('validateServicePath allows missing directories when requireExists is false', async () => {
    const { validateServicePath } = await import('../utils/config-utils.js');
    // Scaffolding callers validate the target *before* creating it.
    expect(() =>
      validateServicePath(testProjectDir, 'functions', 'packages/functions', {
        requireExists: false,
      })
    ).not.toThrow();
  });

  it('validateServicePath still enforces the guards when requireExists is false', async () => {
    const { validateServicePath } = await import('../utils/config-utils.js');
    expect(() =>
      validateServicePath(testProjectDir, 'functions', '/tmp/absolute', {
        requireExists: false,
      })
    ).toThrow('must be a relative path');
    expect(() =>
      validateServicePath(testProjectDir, 'functions', '../../outside', {
        requireExists: false,
      })
    ).toThrow('escapes the project root');
  });

  it('validateServicePath returns the same resolved path for both separator styles', async () => {
    const { validateServicePath } = await import('../utils/config-utils.js');
    const { join, resolve } = await import('path');

    // A config authored on Windows carries backslashes. Callers must take this
    // return value rather than re-resolving the raw string: on POSIX
    // `resolve(root, 'packages\\functions')` yields a single directory literally
    // named `packages\functions`, which validation never inspected.
    const expected = resolve(join(testProjectDir, 'packages', 'functions'));

    expect(
      validateServicePath(testProjectDir, 'functions', 'packages/functions', {
        requireExists: false,
      })
    ).toBe(expected);
    expect(
      validateServicePath(testProjectDir, 'functions', 'packages\\functions', {
        requireExists: false,
      })
    ).toBe(expected);
  });

  it('demonstrates why the raw path cannot be re-resolved on POSIX', async () => {
    const { posix } = await import('path');

    // The assertion above cannot fail on Windows, where both characters are
    // separators. Pin the POSIX behaviour explicitly so the reason the
    // normalisation exists is executable on any host: without it, a
    // Windows-authored path becomes one directory whose name contains a
    // backslash, and the file lands somewhere nothing else looks.
    expect(posix.resolve('/app', 'packages\\functions')).toBe(
      '/app/packages\\functions'
    );

    // Replacing both slash styles with the host separator — what
    // `resolveContainedPath` does before resolving — is what makes the two
    // agree, and why its result must be the one callers use.
    expect(
      posix.resolve('/app', 'packages\\functions'.replace(/[\\/]/gu, posix.sep))
    ).toBe('/app/packages/functions');
  });
});
