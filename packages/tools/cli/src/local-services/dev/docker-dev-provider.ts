/**
 * `DockerDevProvider` — the self-hosted (`--provider docker`) `dev` backend.
 *
 * Implements the universal {@link DevBackendProvider} seam against a local
 * Docker Compose stack (the OSS Rayfin host), wrapping the existing
 * `utils/docker-utils.ts` lifecycle and applying declared schema/storage to the
 * *local* backend. Host-only and gated behind the `docker-local-dev` flag until
 * the Rayfin Local Docker image is GA; a host without a Docker daemon resolves
 * to a typed `unavailable` outcome rather than throwing.
 *
 * Unlike the legacy detached `rayfin dev`, the v2 Docker path is a session:
 * `ensureReady` brings the stack up, the workflow starts the local frontend,
 * and Ctrl-C runs `teardown` (compose stop, or `down -v` under `--purge`).
 * Connectors front external services with no local implementation, so
 * `syncConnectors` is a no-op here (the workflow still validates them).
 */
import { join, resolve } from 'node:path';

import type {
  ConnectorEntry,
  RayfinConfig,
} from '@microsoft/rayfin-tools-common/_internal/config';
import { withoutLocalConnectorsOptIn } from '@microsoft/rayfin-tools-common/_internal/external/fabric';
import type { DataService } from '@microsoft/rayfin-tools-common/_internal/services/data';
import type {
  DevRedirectService,
  FrontendDevPortResolution,
} from '@microsoft/rayfin-tools-common/_internal/services/dev-redirect';
import type { FrameworkEnvService } from '@microsoft/rayfin-tools-common/_internal/services/framework-env';
import { toRuntimeSettingsServices } from '@microsoft/rayfin-tools-common/_internal/services/runtime-settings';
import type {
  ApplyDataConfigInput,
  ApplyStorageConfigInput,
  DevBackendProvider,
  DevProviderRequest,
  DevTarget,
  EnsureBackendReadyOutcome,
  LocalDevWiring,
  PrepareLocalFrontendOptions,
  TeardownOptions,
} from '@microsoft/rayfin-tools-common/_internal/workflows/dev';

import { applyStorageConfig } from '../../utils/apply-storage-config.js';
import { copyOrOverwriteDockerComposeFile } from '../../utils/docker-compose-utils.js';
import {
  checkDockerAvailable,
  checkDockerComposeAvailable,
  getAllCurrentHealthyServicesIfExist,
  monitorServiceHealth,
  purgeDockerServices,
  reserveServicePortsFromEnv,
  type ServiceConfig,
  startDockerServices,
  stopDockerServices,
} from '../../utils/docker-utils.js';
import {
  getWebServicePort,
  readEnvMap,
  removePortVariables,
} from '../../utils/env-file-utils.js';
import { FRONTEND_DEV_PORT_ENV_VAR } from '../../utils/frontend-dev-port.js';
import { postJson, throwIfNotOk } from '../../utils/http-client.js';

import {
  generateDevEnvVariables,
  getEnabledProfiles,
  resolveDockerComposeOverrides,
} from './docker-lifecycle.js';

const COMPOSE_RELATIVE_PATH = 'rayfin/.temp/docker-compose.yml';
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_INTERVAL_MS = 2_000;
const BACKEND_READY_ATTEMPTS = 180;
const BACKEND_READY_DELAY_MS = 1_000;
const LOCAL_DB_APPLY_ATTEMPTS = 7;
const LOCAL_DB_APPLY_DELAY_MS = 3_000;

/**
 * A {@link DevTarget} extended with the compose coordinates the Docker provider
 * threads from `resolveTarget` through `teardown`.
 */
export interface DockerDevTarget extends DevTarget {
  readonly composePath: string;
  readonly additionalComposePaths: string[];
  readonly projectName: string;
  readonly projectDirectory?: string;
  readonly envFilePath: string;
  readonly composeCommand: string;
  readonly profiles: string[];
}

/** Collaborators for {@link createDockerDevProvider}. */
export interface DockerDevProviderDeps {
  /** DAB schema generation + local apply. */
  data: DataService;
  /** Stable local frontend-port resolution. */
  devRedirect: DevRedirectService;
  /** Framework `.env.local` (re)writer. */
  frameworkEnv: FrameworkEnvService;
  /** The loaded `rayfin.yml`. */
  config: RayfinConfig;
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
  /** Invocation-scoped ports claimed by local runtimes and Docker services. */
  reservedPorts?: Set<number>;
  /** Persist `RAYFIN_PUBLIC_*` values into `rayfin/.env`. Injected for testability. */
  persistPublicEnv: (
    rayfinDir: string,
    vars: { key: string; value: string | null }[]
  ) => Promise<void>;
  /**
   * Fetch the local backend's publishable key. Injected so local-wiring is
   * testable without a running container; defaults in the factory to a
   * best-effort `fetch` of the local `/api/publishable-key`.
   */
  fetchLocalPublishableKey: (webServicePort: number) => Promise<string>;
  /** Pause between local DB-apply retries; injected so tests don't wait. */
  delay?: (ms: number) => Promise<void>;
  /**
   * Whether to regenerate the framework `.env.local` during local wiring.
   * `false` mirrors `--no-emit-env`; defaults to `true`.
   */
  emitFrameworkEnv?: boolean;
}

/** Construct the Docker `dev` backend provider. */
export function createDockerDevProvider(
  deps: DockerDevProviderDeps
): DevBackendProvider<DockerDevTarget> {
  const {
    data,
    devRedirect,
    frameworkEnv,
    config,
    projectRoot,
    reservedPorts = new Set<number>(),
    persistPublicEnv,
    fetchLocalPublishableKey,
    delay = defaultDelay,
    emitFrameworkEnv = true,
  } = deps;
  const rayfinDir = join(projectRoot, 'rayfin');
  const composePath = join(projectRoot, COMPOSE_RELATIVE_PATH);
  const composeOverrides = resolveDockerComposeOverrides(projectRoot);
  const envFilePath = join(rayfinDir, '.env');
  const profiles = getEnabledProfiles(config);
  let frontendDevPort: FrontendDevPortResolution | undefined;
  const resolveFrontendDevPort =
    async (): Promise<FrontendDevPortResolution> => {
      // `dev` cannot safely start a strict-port frontend without one
      // authoritative port, so resolution failures abort the session.
      frontendDevPort ??= await devRedirect.resolveFrontendDevPort(projectRoot);
      reservedPorts.add(frontendDevPort.port);
      return frontendDevPort;
    };

  return {
    async resolveTarget(
      _request: DevProviderRequest
    ): Promise<DockerDevTarget> {
      const compose = checkDockerComposeAvailable();
      return {
        provider: 'docker',
        displayName: 'local Docker',
        composePath,
        additionalComposePaths: composeOverrides.additionalComposePaths,
        projectName: config.id || 'rayfin',
        projectDirectory: composeOverrides.projectDirectory,
        envFilePath,
        composeCommand: compose.command ?? 'docker compose',
        profiles,
      };
    },

    async ensureReady(
      target: DockerDevTarget
    ): Promise<EnsureBackendReadyOutcome<DockerDevTarget>> {
      const docker = checkDockerAvailable();
      if (!docker.available) {
        return {
          status: 'unavailable',
          code: 'docker-unavailable',
          message: `Docker is not available: ${docker.error ?? 'unknown error'}. Start Docker and retry.`,
        };
      }
      const compose = checkDockerComposeAvailable();
      if (!compose.available) {
        return {
          status: 'unavailable',
          code: 'docker-compose-unavailable',
          message: `Docker Compose is not available: ${compose.error ?? 'unknown error'}.`,
        };
      }

      await copyOrOverwriteDockerComposeFile(rayfinDir);
      const existingHealthy = await getAllCurrentHealthyServicesIfExist(
        target.projectName,
        target.profiles
      );
      if (existingHealthy) {
        reserveServicePortsFromEnv(await readEnvMap(rayfinDir), reservedPorts);
      }
      await resolveFrontendDevPort();
      const envVars = await generateDevEnvVariables(
        config,
        target.profiles,
        existingHealthy,
        rayfinDir,
        reservedPorts
      );
      await persistPublicEnv(rayfinDir, envVars);

      if (!existingHealthy) {
        const serviceConfig: ServiceConfig = {
          composePath: target.composePath,
          additionalComposePaths: target.additionalComposePaths,
          composeCommand: target.composeCommand,
          projectName: target.projectName,
          projectDirectory: target.projectDirectory,
          envFilePath: target.envFilePath,
          detach: true,
          pull: false,
          verbose: false,
          profiles: target.profiles,
        };
        await startDockerServices(serviceConfig);
        const readiness = await monitorServiceHealth(serviceConfig, {
          timeout: HEALTH_TIMEOUT_MS,
          pollingInterval: HEALTH_POLL_INTERVAL_MS,
        });
        if (!readiness.ready) {
          return {
            status: 'unavailable',
            code: 'docker-not-ready',
            message:
              'The local Docker services did not become healthy in time. ' +
              'Run `rayfin dev status` to inspect them.',
          };
        }
      }

      const webServicePort = await getWebServicePort(rayfinDir);
      const backendReady = await waitForInitializedBackend(
        webServicePort,
        fetchLocalPublishableKey,
        delay
      );
      if (!backendReady) {
        return {
          status: 'unavailable',
          code: 'docker-not-ready',
          message:
            'The local Rayfin backend did not finish initializing in time. ' +
            'Run `rayfin dev status` and inspect the WebService logs.',
        };
      }
      return { status: 'ready', target };
    },

    async applyDataConfig(
      _target: DockerDevTarget,
      input: ApplyDataConfigInput
    ): Promise<void> {
      // The local DAB server needs a moment to accept connections after the
      // container reports healthy; retry transient connection failures, matching
      // the legacy `applyDbConfigWithRetries`.
      let lastError: unknown;
      for (let attempt = 1; attempt <= LOCAL_DB_APPLY_ATTEMPTS; attempt++) {
        try {
          await data.applyDatabaseConfig({
            projectRoot: input.projectRoot,
            target: 'local',
            dialect: input.data.dialect,
            servicePath: input.data.path,
            buildCommand: input.data.buildCommand,
          });
          return;
        } catch (error) {
          if (!isRetriableApplyError(error)) throw error;
          lastError = error;
          if (attempt < LOCAL_DB_APPLY_ATTEMPTS) {
            await delay(LOCAL_DB_APPLY_DELAY_MS);
          }
        }
      }
      throw lastError;
    },

    async applyStorageConfig(
      _target: DockerDevTarget,
      _input: ApplyStorageConfigInput
    ): Promise<void> {
      await applyStorageConfig({ remote: false, mode: 'silent' });
    },

    async syncConnectors(
      _target: DockerDevTarget,
      _connectors: ConnectorEntry[] | undefined
    ): Promise<void> {
      // Connectors have no local implementation, but this provider method also
      // owns the services runtime-settings sync. Apply those settings before
      // schema/storage so service-gated endpoints are available.
      let services = config.services;
      if (services.auth?.enabled) {
        const { redirectPorts } = await resolveFrontendDevPort();
        for (const port of redirectPorts) {
          services = devRedirect.appendLocalDevRedirectUris(services, port);
        }
      }
      const webServicePort = await getWebServicePort(rayfinDir);
      const response = await postJson({
        url: `http://localhost:${webServicePort}/api/projectRuntimeSettings`,
        // The local backend rejects the opt-in boolean for the same reason the
        // workload does, and reads the same `anonymousAccess` wire field.
        body: toRuntimeSettingsServices(withoutLocalConnectorsOptIn(services)),
      });
      await throwIfNotOk(response, 'Failed to sync local runtime settings');
    },

    async prepareForLocalFrontend(
      _target: DockerDevTarget,
      options?: PrepareLocalFrontendOptions
    ): Promise<LocalDevWiring> {
      const warnings: string[] = [];
      const webServicePort = await getWebServicePort(rayfinDir);
      const apiUrl = `http://localhost:${webServicePort}`;

      let publishableKey = '';
      try {
        publishableKey = await fetchLocalPublishableKey(webServicePort);
      } catch (error) {
        warnings.push(
          `Could not read the local publishable key: ${messageOf(error)}`
        );
      }

      const { port } = await resolveFrontendDevPort();
      const functionsUrl = options?.runtimeUrls?.functions;
      await persistPublicEnv(rayfinDir, [
        { key: 'RAYFIN_PUBLIC_API_URL', value: apiUrl },
        ...(publishableKey
          ? [{ key: 'RAYFIN_PUBLIC_PUBLISHABLE_KEY', value: publishableKey }]
          : []),
        // Projected to `VITE_RAYFIN_FUNCTIONS_URL` (and framework equivalents)
        // by `rayfin env`, so browser code calls the local functions host.
        {
          key: 'RAYFIN_PUBLIC_FUNCTIONS_URL',
          value: functionsUrl ?? null,
        },
      ]);

      if (emitFrameworkEnv) {
        try {
          const frontendDir = config.services.staticHosting?.path
            ? resolve(projectRoot, config.services.staticHosting.path)
            : projectRoot;
          const framework = await frameworkEnv.detectFramework(frontendDir);
          if (framework) {
            await frameworkEnv.writeEnvFile({
              projectRoot,
              framework,
              outputDir: config.services.staticHosting?.path ?? '.',
            });
          }
        } catch (error) {
          warnings.push(
            `Could not regenerate the framework .env.local: ${messageOf(error)}`
          );
        }
      }

      const env: Record<string, string> = {
        RAYFIN_PUBLIC_API_URL: apiUrl,
        [FRONTEND_DEV_PORT_ENV_VAR]: String(port),
        ...(publishableKey
          ? { RAYFIN_PUBLIC_PUBLISHABLE_KEY: publishableKey }
          : {}),
        ...(functionsUrl ? { RAYFIN_PUBLIC_FUNCTIONS_URL: functionsUrl } : {}),
      };
      return { env, warnings };
    },

    async teardown(
      target: DockerDevTarget,
      options: TeardownOptions
    ): Promise<void> {
      const serviceConfig: ServiceConfig = {
        composePath: target.composePath,
        additionalComposePaths: target.additionalComposePaths,
        composeCommand: target.composeCommand,
        projectName: target.projectName,
        projectDirectory: target.projectDirectory,
        envFilePath: target.envFilePath,
        detach: true,
        pull: false,
        verbose: false,
        profiles: target.profiles,
      };
      if (options.purge) {
        await purgeDockerServices(serviceConfig);
      } else {
        await stopDockerServices(serviceConfig);
      }
      await removePortVariables(rayfinDir);
    },
  };
}

/**
 * A best-effort GET of the local backend's publishable key. Resolves to an
 * empty string when the endpoint is unreachable or returns no key, so a missing
 * key is a warning rather than a failed session.
 */
export async function fetchLocalPublishableKey(
  webServicePort: number
): Promise<string> {
  const response = await fetch(
    `http://localhost:${webServicePort}/api/publishable-key`
  );
  if (!response.ok) return '';
  const body = (await response.json()) as { publishableKey?: string };
  return body.publishableKey ?? '';
}

/**
 * Whether a local DB-apply error is a transient connection failure worth
 * retrying (the container is up but the DAB server is still warming up), as
 * opposed to a configuration error that will fail every attempt.
 */
function isRetriableApplyError(error: unknown): boolean {
  const message = messageOf(error).toLowerCase();
  return (
    message.includes('fetch failed') ||
    message.includes('econnrefused') ||
    message.includes('cannot connect') ||
    message.includes('connection refused')
  );
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForInitializedBackend(
  webServicePort: number,
  fetchKey: (port: number) => Promise<string>,
  wait: (ms: number) => Promise<void>
): Promise<boolean> {
  for (let attempt = 1; attempt <= BACKEND_READY_ATTEMPTS; attempt++) {
    try {
      if (await fetchKey(webServicePort)) return true;
    } catch {
      // The watched WebService may still be building or initializing its DB.
    }
    if (attempt < BACKEND_READY_ATTEMPTS) {
      await wait(BACKEND_READY_DELAY_MS);
    }
  }
  return false;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
