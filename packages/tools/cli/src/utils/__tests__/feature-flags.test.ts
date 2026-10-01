import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, it, expect, afterEach } from 'vitest';

const createTestProject = (
  configContent: string,
  options: {
    envFileContent?: string;
    envFileName?: string;
  } = {}
): string => {
  const testProjectDir = join(
    tmpdir(),
    `rayfin-feature-flags-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );

  mkdirSync(join(testProjectDir, 'rayfin'), { recursive: true });
  writeFileSync(join(testProjectDir, 'rayfin', 'rayfin.yml'), configContent);

  if (options.envFileContent) {
    writeFileSync(
      join(testProjectDir, 'rayfin', options.envFileName ?? '.env'),
      options.envFileContent
    );
  }

  return testProjectDir;
};

const testProjectDirs = new Set<string>();

describe('CLI feature flag context', () => {
  afterEach(() => {
    for (const testProjectDir of testProjectDirs) {
      rmSync(testProjectDir, { recursive: true, force: true });
    }

    testProjectDirs.clear();
  });

  it.each([true, false])(
    'does not register an application-auth gate (enabled=%s)',
    async (enabled) => {
      const project = createTestProject(
        `id: test-project\nservices:\n  functions:\n    enabled: ${enabled}\n    auth:\n      type: application\n`
      );
      testProjectDirs.add(project);
      const { createCliFeatureFlags } = await import('../feature-flags.js');
      for (const flags of [
        '',
        'functions',
        'storage,functions',
        'functions-application-auth',
      ]) {
        expect(
          createCliFeatureFlags(project, {
            processEnv: { RAYFIN_FEATURE_FLAGS: flags },
          }).get('functions-application-auth')
        ).toBeNull();
      }
    }
  );

  it.each(['up', 'dev'] as const)(
    'resolves Docker local dev from the selected %s environment',
    async (command) => {
      const project = createTestProject('id: test-project\nservices: {}\n', {
        envFileName: '.env.optin',
        envFileContent: 'RAYFIN_FEATURE_FLAGS=functions,docker-local-dev\n',
      });
      testProjectDirs.add(project);
      const { createCliFeatureFlags } = await import('../feature-flags.js');
      expect(
        createCliFeatureFlags(project, { command, processEnv: {} }).get(
          'docker-local-dev'
        )
      ).toBe(false);
      expect(
        createCliFeatureFlags(project, {
          command,
          envFile: 'rayfin/.env.optin',
          processEnv: {},
        }).get('docker-local-dev')
      ).toBe(true);
      expect(
        createCliFeatureFlags(project, {
          command,
          envFile: 'rayfin/.env.optin',
          processEnv: { RAYFIN_FEATURE_FLAGS: '' },
        }).get('docker-local-dev')
      ).toBe(false);
      expect(
        createCliFeatureFlags(project, {
          command,
          processEnv: { RAYFIN_FEATURE_FLAGS: 'docker-local-dev' },
        }).get('docker-local-dev')
      ).toBe(true);
    }
  );

  it('resolves storage from shell environment flags', async () => {
    const testProjectDir = createTestProject(`id: test-project
name: Test Project
version: 1.0.0
services:
  auth:
    enabled: true
  data:
    enabled: false
  storage:
    enabled: false
`);
    testProjectDirs.add(testProjectDir);

    const { createCliFeatureFlags } = await import('../feature-flags.js');
    const featureFlags = createCliFeatureFlags(testProjectDir, {
      command: 'dev',
      processEnv: { RAYFIN_FEATURE_FLAGS: 'storage' },
    });

    expect(featureFlags.get('storage')).toBe(true);
  });

  it('resolves storage from rayfin/.env when shell is unset', async () => {
    const testProjectDir = createTestProject(
      `id: test-project
name: Test Project
version: 1.0.0
services:
  auth:
    enabled: true
  data:
    enabled: false
  storage:
    enabled: false
`,
      {
        envFileContent: 'RAYFIN_FEATURE_FLAGS=storage\n',
      }
    );
    testProjectDirs.add(testProjectDir);

    const { createCliFeatureFlags } = await import('../feature-flags.js');
    const featureFlags = createCliFeatureFlags(testProjectDir, {
      command: 'dev',
      processEnv: {},
    });

    expect(featureFlags.get('storage')).toBe(true);
  });

  it('uses shell environment precedence over rayfin/.env', async () => {
    const testProjectDir = createTestProject(
      `id: test-project
name: Test Project
version: 1.0.0
services:
  auth:
    enabled: true
  data:
    enabled: false
  storage:
    enabled: false
`,
      {
        envFileContent: 'RAYFIN_FEATURE_FLAGS=storage\n',
      }
    );
    testProjectDirs.add(testProjectDir);

    const { createCliFeatureFlags } = await import('../feature-flags.js');
    const featureFlags = createCliFeatureFlags(testProjectDir, {
      command: 'dev',
      processEnv: { RAYFIN_FEATURE_FLAGS: '' },
    });

    expect(featureFlags.get('storage')).toBe(false);
  });

  it('supports custom env files for feature evaluation', async () => {
    const testProjectDir = createTestProject(
      `id: test-project
name: Test Project
version: 1.0.0
services:
  auth:
    enabled: true
  data:
    enabled: false
  storage:
    enabled: false
`,
      {
        envFileName: '.env.custom',
        envFileContent: 'RAYFIN_FEATURE_FLAGS=storage\n',
      }
    );
    testProjectDirs.add(testProjectDir);

    const { createCliFeatureFlags } = await import('../feature-flags.js');
    const featureFlags = createCliFeatureFlags(testProjectDir, {
      command: 'dev',
      envFile: 'rayfin/.env.custom',
      processEnv: {},
    });

    expect(featureFlags.get('storage')).toBe(true);
  });

  it('treats storage as enabled when rayfin.yml enables storage', async () => {
    const testProjectDir = createTestProject(`id: test-project
name: Test Project
version: 1.0.0
services:
  auth:
    enabled: true
  data:
    enabled: false
  storage:
    enabled: true
`);
    testProjectDirs.add(testProjectDir);

    const { createCliFeatureFlags } = await import('../feature-flags.js');
    const featureFlags = createCliFeatureFlags(testProjectDir, {
      command: 'dev',
      processEnv: {},
    });

    expect(featureFlags.get('storage')).toBe(true);
  });

  it('treats storage as disabled when config and flags both disable it', async () => {
    const testProjectDir = createTestProject(`id: test-project
name: Test Project
version: 1.0.0
services:
  auth:
    enabled: true
  data:
    enabled: false
  storage:
    enabled: false
`);
    testProjectDirs.add(testProjectDir);

    const { createCliFeatureFlags } = await import('../feature-flags.js');
    const featureFlags = createCliFeatureFlags(testProjectDir, {
      command: 'dev',
      processEnv: {},
    });

    expect(featureFlags.get('storage')).toBe(false);
  });

  it('resolves postgresql to true when rayfin.yml dialect is postgresql', async () => {
    const testProjectDir = createTestProject(`id: test-project
name: Test Project
version: 1.0.0
services:
  auth:
    enabled: true
  data:
    enabled: true
    dialect: postgresql
`);
    testProjectDirs.add(testProjectDir);

    const { createCliFeatureFlags } = await import('../feature-flags.js');
    const featureFlags = createCliFeatureFlags(testProjectDir, {
      command: 'dev',
      processEnv: {},
    });

    expect(featureFlags.get('postgresql')).toBe(true);
  });

  it('resolves postgresql to true from RAYFIN_FEATURE_FLAGS env var', async () => {
    const testProjectDir = createTestProject(`id: test-project
name: Test Project
version: 1.0.0
services:
  auth:
    enabled: true
  data:
    enabled: true
    dialect: mssql
`);
    testProjectDirs.add(testProjectDir);

    const { createCliFeatureFlags } = await import('../feature-flags.js');
    const featureFlags = createCliFeatureFlags(testProjectDir, {
      command: 'dev',
      processEnv: { RAYFIN_FEATURE_FLAGS: 'postgresql' },
    });

    expect(featureFlags.get('postgresql')).toBe(true);
  });

  it('resolves postgresql to false when dialect is mssql and env var absent', async () => {
    const testProjectDir = createTestProject(`id: test-project
name: Test Project
version: 1.0.0
services:
  auth:
    enabled: true
  data:
    enabled: true
    dialect: mssql
`);
    testProjectDirs.add(testProjectDir);

    const { createCliFeatureFlags } = await import('../feature-flags.js');
    const featureFlags = createCliFeatureFlags(testProjectDir, {
      command: 'dev',
      processEnv: {},
    });

    expect(featureFlags.get('postgresql')).toBe(false);
  });

  it('resolves postgresql to true from env var without rayfin.yml', async () => {
    const { createCliFeatureFlags } = await import('../feature-flags.js');
    const featureFlags = createCliFeatureFlags('/nonexistent-path', {
      processEnv: { RAYFIN_FEATURE_FLAGS: 'postgresql' },
    });

    expect(featureFlags.get('postgresql')).toBe(true);
  });

  it('treats docker-local-dev as enabled when RAYFIN_FEATURE_FLAGS contains docker-local-dev', async () => {
    const testProjectDir = createTestProject(`id: test-project
name: Test Project
version: 1.0.0
`);
    testProjectDirs.add(testProjectDir);

    const { createCliFeatureFlags } = await import('../feature-flags.js');
    const featureFlags = createCliFeatureFlags(testProjectDir, {
      command: 'dev',
      processEnv: { RAYFIN_FEATURE_FLAGS: 'docker-local-dev' },
    });

    expect(featureFlags.get('docker-local-dev')).toBe(true);
  });

  it('treats cli-up-anonstatic as enabled by default', async () => {
    const testProjectDir = createTestProject(`id: test-project
name: Test Project
version: 1.0.0
services:
  staticHosting:
    enabled: true
    folder: dist
`);
    testProjectDirs.add(testProjectDir);

    const { createCliFeatureFlags } = await import('../feature-flags.js');
    const featureFlags = createCliFeatureFlags(testProjectDir, {
      command: 'up',
      processEnv: {},
    });

    expect(featureFlags.get('cli-up-anonstatic')).toBe(true);
  });

  it('treats docker-local-dev as disabled when RAYFIN_FEATURE_FLAGS does not contain it', async () => {
    const testProjectDir = createTestProject(`id: test-project
name: Test Project
version: 1.0.0
`);
    testProjectDirs.add(testProjectDir);

    const { createCliFeatureFlags } = await import('../feature-flags.js');
    const featureFlags = createCliFeatureFlags(testProjectDir, {
      command: 'dev',
      processEnv: { RAYFIN_FEATURE_FLAGS: 'storage,functions' },
    });

    expect(featureFlags.get('docker-local-dev')).toBe(false);
  });

  it('treats docker-local-dev as disabled when RAYFIN_FEATURE_FLAGS is unset', async () => {
    const testProjectDir = createTestProject(`id: test-project
name: Test Project
version: 1.0.0
`);
    testProjectDirs.add(testProjectDir);

    const { createCliFeatureFlags } = await import('../feature-flags.js');
    const featureFlags = createCliFeatureFlags(testProjectDir, {
      command: 'dev',
      processEnv: {},
    });

    expect(featureFlags.get('docker-local-dev')).toBe(false);
  });

  it('treats tools-arch-v2 as enabled when RAYFIN_FEATURE_FLAGS contains tools-arch-v2', async () => {
    const testProjectDir = createTestProject(`id: test-project
name: Test Project
version: 1.0.0
`);
    testProjectDirs.add(testProjectDir);

    const { createCliFeatureFlags } = await import('../feature-flags.js');
    const featureFlags = createCliFeatureFlags(testProjectDir, {
      processEnv: { RAYFIN_FEATURE_FLAGS: 'tools-arch-v2' },
    });

    expect(featureFlags.get('tools-arch-v2')).toBe(true);
  });

  it('treats tools-arch-v2 as disabled when RAYFIN_FEATURE_FLAGS is unset', async () => {
    const testProjectDir = createTestProject(`id: test-project
name: Test Project
version: 1.0.0
`);
    testProjectDirs.add(testProjectDir);

    const { createCliFeatureFlags } = await import('../feature-flags.js');
    const featureFlags = createCliFeatureFlags(testProjectDir, {
      processEnv: {},
    });

    expect(featureFlags.get('tools-arch-v2')).toBe(false);
  });

  it('treats up-legacy as enabled when RAYFIN_FEATURE_FLAGS contains up-legacy', async () => {
    const testProjectDir = createTestProject(`id: test-project
name: Test Project
version: 1.0.0
`);
    testProjectDirs.add(testProjectDir);

    const { createCliFeatureFlags } = await import('../feature-flags.js');
    const featureFlags = createCliFeatureFlags(testProjectDir, {
      processEnv: { RAYFIN_FEATURE_FLAGS: 'up-legacy' },
    });

    expect(featureFlags.get('up-legacy')).toBe(true);
  });

  it('treats up-legacy as disabled when RAYFIN_FEATURE_FLAGS is unset', async () => {
    const testProjectDir = createTestProject(`id: test-project
name: Test Project
version: 1.0.0
`);
    testProjectDirs.add(testProjectDir);

    const { createCliFeatureFlags } = await import('../feature-flags.js');
    const featureFlags = createCliFeatureFlags(testProjectDir, {
      processEnv: {},
    });

    expect(featureFlags.get('up-legacy')).toBe(false);
  });
});
