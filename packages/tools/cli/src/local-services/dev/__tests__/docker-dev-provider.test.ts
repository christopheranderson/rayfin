import { resolve } from 'node:path';

import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import type { DataService } from '@microsoft/rayfin-tools-common/_internal/services/data';
import type { DevRedirectService } from '@microsoft/rayfin-tools-common/_internal/services/dev-redirect';
import type { FrameworkEnvService } from '@microsoft/rayfin-tools-common/_internal/services/framework-env';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/docker-utils.js', () => ({
  checkDockerAvailable: vi.fn().mockReturnValue({ available: true }),
  checkDockerComposeAvailable: vi
    .fn()
    .mockReturnValue({ available: true, command: 'docker compose' }),
  getAllCurrentHealthyServicesIfExist: vi.fn().mockResolvedValue(null),
  monitorServiceHealth: vi.fn().mockResolvedValue({ ready: true }),
  purgeDockerServices: vi.fn().mockResolvedValue(undefined),
  reserveServicePortsFromEnv: vi.fn(
    (envVars: ReadonlyMap<string, string>, reservedPorts: Set<number>) => {
      for (const value of envVars.values()) {
        const port = Number.parseInt(value, 10);
        if (Number.isInteger(port)) reservedPorts.add(port);
      }
    }
  ),
  startDockerServices: vi.fn().mockResolvedValue(undefined),
  stopDockerServices: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../utils/docker-compose-utils.js', () => ({
  copyOrOverwriteDockerComposeFile: vi.fn().mockResolvedValue({
    path: '/p/rayfin/.temp/docker-compose.yml',
    updated: false,
  }),
}));
vi.mock('../../../utils/env-file-utils.js', () => ({
  getWebServicePort: vi.fn().mockResolvedValue(5168),
  readEnvMap: vi.fn().mockResolvedValue(new Map()),
  removePortVariables: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../utils/frontend-dev-port.js', () => ({
  FRONTEND_DEV_PORT_ENV_VAR: 'RAYFIN_PUBLIC_FRONTEND_PORT',
}));
vi.mock('../../../utils/http-client.js', () => ({
  postJson: vi.fn().mockResolvedValue({ ok: true }),
  throwIfNotOk: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../utils/apply-storage-config.js', () => ({
  applyStorageConfig: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../docker-lifecycle.js', () => ({
  getEnabledProfiles: vi.fn().mockReturnValue(['telemetry']),
  generateDevEnvVariables: vi.fn().mockResolvedValue([]),
  resolveDockerComposeOverrides: vi.fn().mockReturnValue({
    additionalComposePaths: [],
    projectDirectory: undefined,
  }),
}));

import {
  getAllCurrentHealthyServicesIfExist,
  purgeDockerServices,
  startDockerServices,
  stopDockerServices,
} from '../../../utils/docker-utils.js';
import { readEnvMap } from '../../../utils/env-file-utils.js';
import { postJson } from '../../../utils/http-client.js';
import { createDockerDevProvider } from '../docker-dev-provider.js';
import {
  generateDevEnvVariables,
  resolveDockerComposeOverrides,
} from '../docker-lifecycle.js';

function config(): RayfinConfig {
  return {
    id: 'my-app',
    name: 'My App',
    version: '1',
    services: { auth: { enabled: true }, data: { enabled: true } },
  } as unknown as RayfinConfig;
}

const frameworkEnv = {
  detectFramework: vi.fn().mockResolvedValue('vite'),
  writeEnvFile: vi.fn().mockResolvedValue('/p/.env.local'),
} as unknown as FrameworkEnvService;

const devRedirect = {
  resolveFrontendDevPort: vi
    .fn()
    .mockResolvedValue({ port: 5173, redirectPorts: [5173] }),
  appendLocalDevRedirectUris: vi
    .fn()
    .mockImplementation((services) => services),
} as DevRedirectService;

function build(data: DataService) {
  return createDockerDevProvider({
    data,
    devRedirect,
    frameworkEnv,
    config: config(),
    projectRoot: '/p',
    persistPublicEnv: vi.fn().mockResolvedValue(undefined),
    fetchLocalPublishableKey: vi.fn().mockResolvedValue('pk_local'),
    delay: vi.fn().mockResolvedValue(undefined),
  });
}

const dockerTarget = {
  provider: 'docker' as const,
  displayName: 'local Docker',
  composePath: '/p/rayfin/.temp/docker-compose.yml',
  additionalComposePaths: [],
  projectName: 'my-app',
  envFilePath: '/p/rayfin/.env',
  composeCommand: 'docker compose',
  profiles: ['telemetry'],
};

describe('createDockerDevProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retries a transient local DB-apply connection failure, then succeeds', async () => {
    const applyDatabaseConfig = vi
      .fn()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:5168'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(undefined);
    const provider = build({ applyDatabaseConfig });

    await provider.applyDataConfig(dockerTarget, {
      projectRoot: '/p',
      data: { enabled: true },
    });

    expect(applyDatabaseConfig).toHaveBeenCalledTimes(3);
    expect(applyDatabaseConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: 'local' })
    );
  });

  it('does not retry a non-transient apply error', async () => {
    const applyDatabaseConfig = vi
      .fn()
      .mockRejectedValue(new Error('Invalid entity configuration'));
    const provider = build({ applyDatabaseConfig });

    await expect(
      provider.applyDataConfig(dockerTarget, {
        projectRoot: '/p',
        data: { enabled: true },
      })
    ).rejects.toThrow('Invalid entity configuration');
    expect(applyDatabaseConfig).toHaveBeenCalledOnce();
  });

  it('fails the session after exhausting transient DB-apply retries', async () => {
    const applyDatabaseConfig = vi
      .fn()
      .mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5168'));
    const provider = build({ applyDatabaseConfig });

    await expect(
      provider.applyDataConfig(dockerTarget, {
        projectRoot: '/p',
        data: { enabled: true },
      })
    ).rejects.toThrow('ECONNREFUSED');
    expect(applyDatabaseConfig).toHaveBeenCalledTimes(7);
  });

  it('syncs local services without sending unsupported connectors', async () => {
    const provider = build({ applyDatabaseConfig: vi.fn() });
    await expect(
      provider.syncConnectors(dockerTarget, [
        { name: 'c1', type: 'fabric-sqldatabase' },
      ] as unknown as RayfinConfig['connectors'])
    ).resolves.toBeUndefined();
    expect(postJson).toHaveBeenCalledWith({
      url: 'http://localhost:5168/api/projectRuntimeSettings',
      body: config().services,
    });
  });

  it('drops the local connectors opt-in from the runtime-settings body', async () => {
    // The case above uses a fixture with no opt-in, so it passes either way.
    const optedIn = {
      ...config(),
      services: {
        auth: { enabled: true },
        data: { enabled: true },
        connectors: { enabled: true },
      },
    } as unknown as RayfinConfig;
    const provider = createDockerDevProvider({
      data: { applyDatabaseConfig: vi.fn() } as unknown as DataService,
      devRedirect,
      frameworkEnv,
      config: optedIn,
      projectRoot: '/p',
      persistPublicEnv: vi.fn().mockResolvedValue(undefined),
      fetchLocalPublishableKey: vi.fn().mockResolvedValue('pk_local'),
    });

    await provider.syncConnectors(dockerTarget, undefined);

    expect(postJson).toHaveBeenCalledWith({
      url: 'http://localhost:5168/api/projectRuntimeSettings',
      body: { auth: { enabled: true }, data: { enabled: true } },
    });
    const [{ body }] = vi.mocked(postJson).mock.calls.at(-1)!;
    expect(body).not.toHaveProperty('connectors');
  });

  it('syncs primary and retained frontend redirect ports in resolution order', async () => {
    const rayfinConfig = config();
    const servicesWithPrimary = {
      ...rayfinConfig.services,
      redirectStep: 'primary',
    } as unknown as RayfinConfig['services'];
    const servicesWithRetained = {
      ...rayfinConfig.services,
      redirectStep: 'retained',
    } as unknown as RayfinConfig['services'];
    const appendLocalDevRedirectUris = vi
      .fn()
      .mockReturnValueOnce(servicesWithPrimary)
      .mockReturnValueOnce(servicesWithRetained);
    const provider = createDockerDevProvider({
      data: { applyDatabaseConfig: vi.fn() },
      devRedirect: {
        resolveFrontendDevPort: vi
          .fn()
          .mockResolvedValue({ port: 5174, redirectPorts: [5174, 5173] }),
        appendLocalDevRedirectUris,
      },
      frameworkEnv,
      config: rayfinConfig,
      projectRoot: '/p',
      persistPublicEnv: vi.fn().mockResolvedValue(undefined),
      fetchLocalPublishableKey: vi.fn().mockResolvedValue('pk_local'),
    });

    await provider.syncConnectors(dockerTarget, undefined);

    expect(appendLocalDevRedirectUris).toHaveBeenNthCalledWith(
      1,
      rayfinConfig.services,
      5174
    );
    expect(appendLocalDevRedirectUris).toHaveBeenNthCalledWith(
      2,
      servicesWithPrimary,
      5173
    );
    expect(postJson).toHaveBeenCalledWith({
      url: 'http://localhost:5168/api/projectRuntimeSettings',
      body: servicesWithRetained,
    });
  });

  it('translates static-hosting asset access for the local host', async () => {
    const rayfinConfig = config();
    rayfinConfig.services.staticHosting = {
      enabled: true,
      folder: 'dist',
      assetAccess: 'protected',
    };
    const provider = createDockerDevProvider({
      data: { applyDatabaseConfig: vi.fn() },
      devRedirect,
      frameworkEnv,
      config: rayfinConfig,
      projectRoot: '/p',
      persistPublicEnv: vi.fn().mockResolvedValue(undefined),
      fetchLocalPublishableKey: vi.fn().mockResolvedValue('pk_local'),
      delay: vi.fn().mockResolvedValue(undefined),
    });

    await provider.syncConnectors(dockerTarget, undefined);

    expect(postJson).toHaveBeenCalledWith({
      url: 'http://localhost:5168/api/projectRuntimeSettings',
      body: {
        ...rayfinConfig.services,
        staticHosting: {
          enabled: true,
          folder: 'dist',
          anonymousAccess: false,
        },
      },
    });
    expect(rayfinConfig.services.staticHosting.assetAccess).toBe('protected');
  });

  it('teardown stops containers by default and purges volumes with --purge', async () => {
    const provider = build({ applyDatabaseConfig: vi.fn() });

    await provider.teardown(dockerTarget, {});
    expect(stopDockerServices).toHaveBeenCalledOnce();
    expect(purgeDockerServices).not.toHaveBeenCalled();

    await provider.teardown(dockerTarget, { purge: true });
    expect(purgeDockerServices).toHaveBeenCalledOnce();
  });

  it('forwards Compose overrides through start and teardown', async () => {
    vi.mocked(resolveDockerComposeOverrides).mockReturnValueOnce({
      additionalComposePaths: ['/p/docker-compose.override.yml'],
      projectDirectory: '/workspace',
    });
    const provider = build({ applyDatabaseConfig: vi.fn() });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    await provider.ensureReady(target);
    await provider.teardown(target, { purge: true });

    const expected = expect.objectContaining({
      additionalComposePaths: ['/p/docker-compose.override.yml'],
      projectDirectory: '/workspace',
      envFilePath: '/p/rayfin/.env',
    });
    expect(startDockerServices).toHaveBeenCalledWith(expected);
    expect(purgeDockerServices).toHaveBeenCalledWith(expected);
  });

  it('reports unavailable when Docker is not running', async () => {
    const { checkDockerAvailable } =
      await import('../../../utils/docker-utils.js');
    (checkDockerAvailable as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      available: false,
      error: 'daemon not running',
    });
    const provider = build({ applyDatabaseConfig: vi.fn() });

    const outcome = await provider.ensureReady(dockerTarget);

    expect(outcome.status).toBe('unavailable');
    if (outcome.status === 'unavailable') {
      expect(outcome.code).toBe('docker-unavailable');
    }
  });

  it('reserves and caches the frontend port before fresh Docker allocation', async () => {
    const reservedPorts = new Set<number>();
    const resolveFrontendDevPort = vi.fn().mockImplementation(async () => {
      reservedPorts.add(5168);
      return { port: 5168, redirectPorts: [5168] };
    });
    const rayfinConfig = config();
    const provider = createDockerDevProvider({
      data: { applyDatabaseConfig: vi.fn() },
      devRedirect: {
        resolveFrontendDevPort,
        appendLocalDevRedirectUris: vi.fn(),
      },
      frameworkEnv,
      config: rayfinConfig,
      projectRoot: '/p',
      reservedPorts,
      persistPublicEnv: vi.fn().mockResolvedValue(undefined),
      fetchLocalPublishableKey: vi.fn().mockResolvedValue('pk_local'),
    });

    await provider.ensureReady(dockerTarget);
    await provider.prepareForLocalFrontend(dockerTarget);

    expect(generateDevEnvVariables).toHaveBeenCalledWith(
      rayfinConfig,
      ['telemetry'],
      null,
      '/p/rayfin',
      reservedPorts
    );
    expect(reservedPorts).toContain(5168);
    expect(resolveFrontendDevPort).toHaveBeenCalledOnce();
  });

  it('seeds running Docker service ports before resolving the frontend', async () => {
    const existingHealthy = { ready: true } as never;
    vi.mocked(getAllCurrentHealthyServicesIfExist).mockResolvedValueOnce(
      existingHealthy
    );
    vi.mocked(readEnvMap).mockResolvedValueOnce(
      new Map([
        ['RAYFIN_WEBSERVICE_HTTP_PORT', '5168'],
        ['RAYFIN_POSTGRES_PORT', '5432'],
      ])
    );
    const reservedPorts = new Set<number>();
    const resolveFrontendDevPort = vi.fn().mockImplementation(async () => {
      expect(reservedPorts).toEqual(new Set([5168, 5432]));
      reservedPorts.add(5169);
      return { port: 5169, redirectPorts: [5169] };
    });
    const provider = createDockerDevProvider({
      data: { applyDatabaseConfig: vi.fn() },
      devRedirect: {
        resolveFrontendDevPort,
        appendLocalDevRedirectUris: vi.fn(),
      },
      frameworkEnv,
      config: config(),
      projectRoot: '/p',
      reservedPorts,
      persistPublicEnv: vi.fn().mockResolvedValue(undefined),
      fetchLocalPublishableKey: vi.fn().mockResolvedValue('pk_local'),
    });

    await provider.ensureReady(dockerTarget);

    expect(reservedPorts).toEqual(new Set([5168, 5432, 5169]));
    expect(startDockerServices).not.toHaveBeenCalled();
  });

  it('waits for initialized project context after Compose health', async () => {
    const fetchLocalPublishableKey = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('pk_ready');
    const delay = vi.fn().mockResolvedValue(undefined);
    const provider = createDockerDevProvider({
      data: { applyDatabaseConfig: vi.fn() },
      devRedirect,
      frameworkEnv,
      config: config(),
      projectRoot: '/p',
      persistPublicEnv: vi.fn().mockResolvedValue(undefined),
      fetchLocalPublishableKey,
      delay,
    });

    const outcome = await provider.ensureReady(dockerTarget);

    expect(outcome.status).toBe('ready');
    expect(fetchLocalPublishableKey).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
  });

  it('skips framework .env.local regeneration when emitFrameworkEnv is false', async () => {
    const fw = {
      detectFramework: vi.fn().mockResolvedValue('vite'),
      writeEnvFile: vi.fn().mockResolvedValue('/p/.env.local'),
    } as unknown as FrameworkEnvService;
    const persistPublicEnv = vi.fn().mockResolvedValue(undefined);
    const provider = createDockerDevProvider({
      data: { applyDatabaseConfig: vi.fn() },
      devRedirect,
      frameworkEnv: fw,
      config: config(),
      projectRoot: '/p',
      persistPublicEnv,
      fetchLocalPublishableKey: vi.fn().mockResolvedValue('pk_local'),
      delay: vi.fn().mockResolvedValue(undefined),
      emitFrameworkEnv: false,
    });

    const wiring = await provider.prepareForLocalFrontend(dockerTarget);

    expect(devRedirect.resolveFrontendDevPort).toHaveBeenCalledWith('/p');
    expect(wiring.env.RAYFIN_PUBLIC_FRONTEND_PORT).toBe('5173');
    expect(persistPublicEnv).toHaveBeenCalledWith('/p/rayfin', [
      { key: 'RAYFIN_PUBLIC_API_URL', value: 'http://localhost:5168' },
      { key: 'RAYFIN_PUBLIC_PUBLISHABLE_KEY', value: 'pk_local' },
      { key: 'RAYFIN_PUBLIC_FUNCTIONS_URL', value: null },
    ]);
    expect(persistPublicEnv.mock.calls[0]?.[1]).not.toContainEqual({
      key: 'RAYFIN_PUBLIC_FRONTEND_PORT',
      value: '5173',
    });
    expect(fw.writeEnvFile).not.toHaveBeenCalled();
  });

  it('writes framework env into the configured frontend package', async () => {
    const fw = {
      detectFramework: vi.fn(async (directory: string) =>
        directory === resolve('/p', 'apps/web') ? 'vite' : undefined
      ),
      writeEnvFile: vi.fn().mockResolvedValue('/p/apps/web/.env.local'),
    } as unknown as FrameworkEnvService;
    const nestedConfig = config();
    nestedConfig.services.staticHosting = {
      enabled: true,
      path: 'apps/web',
      folder: 'dist',
    };
    const provider = createDockerDevProvider({
      data: { applyDatabaseConfig: vi.fn() },
      devRedirect,
      frameworkEnv: fw,
      config: nestedConfig,
      projectRoot: '/p',
      persistPublicEnv: vi.fn().mockResolvedValue(undefined),
      fetchLocalPublishableKey: vi.fn().mockResolvedValue('pk_local'),
      delay: vi.fn().mockResolvedValue(undefined),
    });

    await provider.prepareForLocalFrontend(dockerTarget);

    expect(fw.detectFramework).toHaveBeenCalledWith(resolve('/p', 'apps/web'));
    expect(fw.writeEnvFile).toHaveBeenCalledWith({
      projectRoot: '/p',
      framework: 'vite',
      outputDir: 'apps/web',
    });
  });

  it('clears a stale persisted functions URL when no runtime is reserved', async () => {
    const persistPublicEnv = vi.fn().mockResolvedValue(undefined);
    const provider = createDockerDevProvider({
      data: { applyDatabaseConfig: vi.fn() },
      devRedirect,
      frameworkEnv,
      config: config(),
      projectRoot: '/p',
      persistPublicEnv,
      fetchLocalPublishableKey: vi.fn().mockResolvedValue('pk_local'),
      delay: vi.fn().mockResolvedValue(undefined),
    });

    const wiring = await provider.prepareForLocalFrontend(dockerTarget);

    expect(wiring.env.RAYFIN_PUBLIC_FUNCTIONS_URL).toBeUndefined();
    expect(persistPublicEnv).toHaveBeenCalledWith(
      '/p/rayfin',
      expect.arrayContaining([
        { key: 'RAYFIN_PUBLIC_FUNCTIONS_URL', value: null },
      ])
    );
  });
});
