/**
 * Pure Docker-lifecycle helpers for the `dev` Docker backend provider.
 *
 * Reproduces the compose-profile selection and `rayfin/.env` variable
 * generation the local Docker stack needs, kept free of output rendering and
 * module state so {@link createDockerDevProvider} stays self-contained (the
 * legacy `commands/dev/dev.ts` — which holds the original copies — is removed
 * while the retained maintenance flags remain available. Container lifecycle itself is
 * delegated to `utils/docker-utils.ts`.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { DOCKER_DB_CREDENTIALS } from '../../constants/docker-credentials.js';
import type { RayfinConfig } from '../../types/config.js';
import {
  allocateServicePorts,
  type ServicePortAllocation,
  type ServiceReadinessResult,
} from '../../utils/docker-utils.js';
import { type EnvVariable, readEnvFile } from '../../utils/env-file-utils.js';
import { pathListSeparator } from '../../utils/platform-utils.js';

const DatabaseDialect = {
  MsSql: 'mssql',
  PostgreSql: 'postgresql',
} as const;

/** Docker Compose path overrides inherited from the host environment. */
export interface DockerComposeOverrides {
  additionalComposePaths: string[];
  projectDirectory?: string;
}

/**
 * Resolve the legacy Docker contributor overrides for the provider path.
 * Throws before any Docker mutation when an override file is missing.
 */
export function resolveDockerComposeOverrides(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env
): DockerComposeOverrides {
  const additionalComposePaths = (env.COMPOSE_FILE ?? '')
    .split(pathListSeparator)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(projectRoot, entry));

  for (const composePath of additionalComposePaths) {
    if (!existsSync(composePath)) {
      throw new Error(`Compose override file not found: ${composePath}`);
    }
  }

  return {
    additionalComposePaths,
    projectDirectory: env.COMPOSE_PROJECT_DIRECTORY
      ? resolve(projectRoot, env.COMPOSE_PROJECT_DIRECTORY)
      : undefined,
  };
}

/**
 * Map the enabled `rayfin.yml` services to Docker Compose profiles. The
 * telemetry (Aspire dashboard) profile is always enabled, matching the legacy
 * Docker dev stack.
 */
export function getEnabledProfiles(config: RayfinConfig | null): string[] {
  const profiles: string[] = [];
  const services = config?.services;
  if (services) {
    if (services.data?.enabled) {
      const dialect = services.data.dialect ?? DatabaseDialect.MsSql;
      profiles.push(
        dialect === DatabaseDialect.PostgreSql
          ? 'data-api-postgresql'
          : 'data-api-mssql'
      );
    }
    if (services.storage?.enabled) {
      profiles.push('storage');
    }
    if (services.auth?.email?.enabled) {
      profiles.push('email');
    }
  }
  profiles.push('telemetry');
  return profiles;
}

/**
 * Build the `rayfin/.env` variables the Docker Compose stack reads: service
 * enablement flags, dev auth-key bootstrap, DB passwords (preserving any the
 * Builder already set), allocated service ports (only when starting fresh), the
 * derived public API URL.
 *
 * Preserves the legacy `generateEnvironmentVariables` behavior without its
 * status logging; the provider reports progress instead.
 */
export async function generateDevEnvVariables(
  config: RayfinConfig,
  profiles: string[],
  existingHealthyServiceResult: ServiceReadinessResult | null,
  rayfinDir: string,
  reservedPorts?: Set<number>
): Promise<EnvVariable[]> {
  const existingEnv = new Map<string, string>();
  for (const entry of await readEnvFile(rayfinDir)) {
    existingEnv.set(entry.key, entry.value);
  }

  const defaultPassword = DOCKER_DB_CREDENTIALS.password;
  const services = config.services;
  const storageEnabled = boolStr(services.storage?.enabled);
  const envVariables: EnvVariable[] = [
    { key: 'Auth__Enabled', value: boolStr(services.auth?.enabled) },
    { key: 'Data__Enabled', value: boolStr(services.data?.enabled) },
    { key: 'Storage__Enabled', value: storageEnabled },
    // The storage controller sits behind two independent server-side gates:
    // `RequireServiceEnabled(Storage)` reads `Storage:Enabled`, and
    // `ExperimentalFeature(EnableStorage)` reads `FeatureFlags:EnableStorage`.
    // Setting only the first produces a stack that advertises storage and then
    // answers `rayfin dev storage apply` with a 404, because the experimental
    // filter short-circuits before the service gate is ever consulted. A
    // Builder who declared `services.storage` asked for the preview feature, so
    // both gates move together — there is no useful stack with one on and the
    // other off.
    { key: 'FeatureFlags__EnableStorage', value: storageEnabled },
    { key: 'Auth__AsymmetricKeys__Provider', value: 'local-file' },
    { key: 'Auth__AsymmetricKeys__Algorithm', value: 'ES256' },
    { key: 'Auth__AsymmetricKeys__KeySize', value: '256' },
    { key: 'Auth__AsymmetricKeys__LocalFile__AutoGenerateKeys', value: 'true' },
    {
      key: 'RAYFIN_POSTGRES_PASSWORD',
      value: existingEnv.get('RAYFIN_POSTGRES_PASSWORD') ?? defaultPassword,
    },
    {
      key: 'RAYFIN_POSTGRES_DATAAPI_PASSWORD',
      value:
        existingEnv.get('RAYFIN_POSTGRES_DATAAPI_PASSWORD') ?? defaultPassword,
    },
    {
      key: 'RAYFIN_SQLSERVER_PASSWORD',
      value: existingEnv.get('RAYFIN_SQLSERVER_PASSWORD') ?? defaultPassword,
    },
  ];

  // Allocate fresh ports only when no healthy stack is already running; reuse
  // the recorded ports otherwise (the running containers still own them).
  let portAllocation: ServicePortAllocation | null = null;
  if (!existingHealthyServiceResult) {
    portAllocation = await allocateServicePorts(profiles, reservedPorts);
    for (const [key, value] of Object.entries(portAllocation)) {
      if (value !== undefined && value !== null) {
        envVariables.push({ key, value: String(value) });
      }
    }
  }

  const httpPort =
    portAllocation?.RAYFIN_WEBSERVICE_HTTP_PORT ??
    existingEnv.get('RAYFIN_WEBSERVICE_HTTP_PORT') ??
    '5168';
  envVariables.push({
    key: 'RAYFIN_PUBLIC_API_URL',
    value: `http://localhost:${httpPort}`,
  });

  return envVariables;
}

function boolStr(value: boolean | undefined): string {
  return value ? 'true' : 'false';
}
