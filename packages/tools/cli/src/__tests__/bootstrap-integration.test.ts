import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  RAYFIN_ENV_CONFIG_VARS,
  bootstrapEnvironmentConfig,
} from '@microsoft/rayfin-tools-common/_internal/auth';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Derived from the single source of truth in tools-common so this
// test stays in sync if the env-var set ever changes.
const ENV_KEYS = RAYFIN_ENV_CONFIG_VARS.map(({ envVar }) => envVar);

describe('bootstrap → getFabricSettings integration', () => {
  let tempHome: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'rayfin-bootstrap-int-'));
    await mkdir(join(tempHome, '.rayfin'), { recursive: true, mode: 0o700 });

    savedEnv = {};
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }

    vi.resetModules();
  });

  afterEach(async () => {
    vi.doUnmock('@microsoft/rayfin-tools-common/_internal/env-config');
    vi.doUnmock('../commands/dev/dev.js');
    vi.doUnmock('../commands/env/env.js');
    vi.doUnmock('../commands/functions/functions.js');
    vi.doUnmock('../commands/init.js');
    vi.doUnmock('../commands/login.js');
    vi.doUnmock('../commands/logout.js');
    vi.doUnmock('../commands/up/up.js');
    vi.doUnmock('../telemetry/index.js');
    vi.doUnmock('../utils/feature-flags.js');
    vi.doUnmock('../utils/version.js');

    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = savedEnv[k];
      }
    }
    vi.resetModules();
    await rm(tempHome, { recursive: true, force: true });
  });

  it('getFabricSettings reflects the persisted environmentConfig.fabricApiUrl after bootstrap', async () => {
    await writeFile(
      join(tempHome, '.rayfin', 'auth.json'),
      JSON.stringify({
        identityType: 'user',
        environmentConfig: {
          fabricApiUrl: 'https://api.example.invalid/v1',
        },
      }),
      'utf8'
    );

    bootstrapEnvironmentConfig({ configDir: join(tempHome, '.rayfin') });

    // Imported AFTER bootstrap so it observes the hydrated env var.
    const { getFabricSettings } = await import('../config/constants.js');
    expect(getFabricSettings().fabricApiBaseUrl).toBe(
      'https://api.example.invalid/v1'
    );
  });

  it('getFabricSettings reflects the persisted environmentConfig.fabricPortalUrl after bootstrap', async () => {
    await writeFile(
      join(tempHome, '.rayfin', 'auth.json'),
      JSON.stringify({
        identityType: 'user',
        environmentConfig: {
          fabricApiUrl: 'https://api.example.invalid/v1',
          fabricPortalUrl: 'https://portal.example.invalid/',
        },
      }),
      'utf8'
    );

    bootstrapEnvironmentConfig({ configDir: join(tempHome, '.rayfin') });

    // Imported AFTER bootstrap so it observes the hydrated env vars.
    const { getFabricSettings } = await import('../config/constants.js');
    const settings = getFabricSettings();
    expect(settings.fabricApiBaseUrl).toBe('https://api.example.invalid/v1');
    expect(settings.fabricPortalUrl).toBe('https://portal.example.invalid/');
  });

  it('bootstraps environment config before constructing init command options', async () => {
    const events: string[] = [];
    const bootstrapEnvironmentConfigMock = vi.fn(() => {
      events.push('bootstrap');
      process.env.RAYFIN_FABRIC_API_URL = 'https://api.example.invalid/v1';
    });
    const createInitCommandMock = vi.fn(() => {
      events.push('createInitCommand');
      expect(bootstrapEnvironmentConfigMock).toHaveBeenCalledOnce();
      return new Command('init');
    });

    // The mock must target the specifier the module-under-test (`index.ts`)
    // imports, which is the canonical `_internal/env-config` subpath. The
    // file's top-level import deliberately stays on the deprecated
    // `_internal/auth` shim so the other tests here exercise its runtime
    // re-export of the Node-only `bootstrapEnvironmentConfig`.
    vi.doMock(
      '@microsoft/rayfin-tools-common/_internal/env-config',
      async (importOriginal) => {
        const actual =
          await importOriginal<
            typeof import('@microsoft/rayfin-tools-common/_internal/env-config')
          >();

        return {
          ...actual,
          bootstrapEnvironmentConfig: bootstrapEnvironmentConfigMock,
        };
      }
    );

    vi.doMock('../commands/dev/dev.js', () => ({
      devCommand: new Command('dev'),
    }));
    vi.doMock('../commands/env/env.js', () => ({
      envCommand: new Command('env'),
    }));
    vi.doMock('../commands/functions/functions.js', () => ({
      functionsCommand: new Command('functions'),
    }));
    vi.doMock('../commands/init.js', () => ({
      createInitCommand: createInitCommandMock,
    }));
    vi.doMock('../commands/login.js', () => ({
      loginCommand: new Command('login'),
    }));
    vi.doMock('../commands/logout.js', () => ({
      logoutCommand: new Command('logout'),
    }));
    vi.doMock('../commands/up/up.js', () => ({
      upCommand: new Command('up'),
    }));
    vi.doMock('../telemetry/index.js', () => ({
      installCommanderHooks: vi.fn(),
    }));
    vi.doMock('../utils/feature-flags.js', () => ({
      createCliFeatureFlags: () => ({ get: () => false }),
    }));
    vi.doMock('../utils/version.js', () => ({
      getVersionString: () => '0.0.0-test',
    }));

    const { cli } = await import('../index.js');

    expect(events).toEqual(['bootstrap', 'createInitCommand']);
    expect(createInitCommandMock).toHaveBeenCalledOnce();
    expect(cli.commands.some((command) => command.name() === 'init')).toBe(
      true
    );
  });

  it('getFabricSettings preserves a credential-proxy path prefix end-to-end', async () => {
    // Locks in the proxy-mounted shape through bootstrap → process.env →
    // getFabricSettings → normalizeFabricApiUrl. If a future change
    // re-introduces the historical strip-to-/v1 behavior on non-Fabric
    // hosts this test will fail loudly.
    await writeFile(
      join(tempHome, '.rayfin', 'auth.json'),
      JSON.stringify({
        identityType: 'user',
        environmentConfig: {
          fabricApiUrl:
            'https://my-proxy.example.invalid/cli-proxy/fabric/conn-123',
          fabricPortalUrl: 'https://app.fabric.microsoft.com/',
        },
      }),
      'utf8'
    );

    bootstrapEnvironmentConfig({ configDir: join(tempHome, '.rayfin') });

    const { getFabricSettings } = await import('../config/constants.js');
    expect(getFabricSettings().fabricApiBaseUrl).toBe(
      'https://my-proxy.example.invalid/cli-proxy/fabric/conn-123/v1'
    );
  });

  it('getFabricSettings strips extra path on a canonical Fabric host end-to-end', async () => {
    // Round-trip back-compat guard: even if a stale auth.json carries a
    // copy-pasted REST URL with workspace/item segments, bootstrap should
    // still hydrate something the rest of the CLI can concatenate paths
    // onto. normalizeFabricApiUrl truncates Fabric hosts back to /v1.
    await writeFile(
      join(tempHome, '.rayfin', 'auth.json'),
      JSON.stringify({
        identityType: 'user',
        environmentConfig: {
          fabricApiUrl:
            'https://api.fabric.microsoft.com/v1/workspaces/abc/items/def',
        },
      }),
      'utf8'
    );

    bootstrapEnvironmentConfig({ configDir: join(tempHome, '.rayfin') });

    const { getFabricSettings } = await import('../config/constants.js');
    expect(getFabricSettings().fabricApiBaseUrl).toBe(
      'https://api.fabric.microsoft.com/v1'
    );
  });
});
