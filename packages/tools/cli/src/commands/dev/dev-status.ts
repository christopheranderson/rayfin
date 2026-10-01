import { join } from 'path';

import { Command } from 'commander';

import { DOCKER_DB_CREDENTIALS } from '../../constants/docker-credentials.js';
import { loadRayfinConfig } from '../../utils/config-utils.js';
import { getDockerServices, ServiceInfo } from '../../utils/docker-utils.js';
import {
  readEnvFile,
  getWebServicePort,
  getSqlServerPort,
  getPostgresPort,
  getAzuriteBlobPort,
  getAzuriteQueuePort,
  getAzuriteTablePort,
  envFileExists,
} from '../../utils/env-file-utils.js';
import {
  emitJson,
  modeLog,
  modeError,
  resolveOutputMode,
  resolveRootOutputFlags,
  type OutputMode,
} from '../../utils/output-mode.js';
import { findRayfinProjectRoot } from '../../utils/project-utils.js';

/**
 * Exit codes for `rayfin dev status` command
 */
const EXIT_CODES = {
  /** All containers are healthy or have no health checks */
  HEALTHY: 0,
  /** No containers running or .env missing */
  NO_CONTAINERS: 1,
  /** Containers running but unhealthy */
  UNHEALTHY: 2,
} as const;

/**
 * Service run status values
 */
const SERVICE_STATUS = {
  RUNNING: 'running',
  STOPPED: 'stopped',
  UNKNOWN: 'unknown',
} as const;

type ServiceStatusValue = (typeof SERVICE_STATUS)[keyof typeof SERVICE_STATUS];

/**
 * Service health values
 */
const SERVICE_HEALTH = {
  HEALTHY: 'healthy',
  UNHEALTHY: 'unhealthy',
  STARTING: 'starting',
  NOT_APPLICABLE: 'n/a',
} as const;

type ServiceHealthValue = (typeof SERVICE_HEALTH)[keyof typeof SERVICE_HEALTH];

/**
 * Represents a service's status based on .env port configuration
 */
interface ServiceStatus {
  name: string;
  port: number;
  status: ServiceStatusValue;
  health: ServiceHealthValue;
}

interface StatusInfo {
  services: {
    auth: boolean;
    data: boolean;
    storage: boolean;
  };
  serviceStatuses: ServiceStatus[];
  ports: {
    webservice: number;
    postgres: number;
    sqlserver: number;
    azuriteBlob: number;
    azuriteQueue: number;
    azuriteTable: number;
  };
  publishableKey?: string;
  publishableKeyError?: string;
}

interface PublishableKeyResult {
  key?: string;
  error?:
    | 'timeout'
    | 'connection_refused'
    | 'invalid_json'
    | 'service_error'
    | 'not_found';
}

/**
 * Fetch the publishable key from the WebService API
 */
async function fetchPublishableKeyFromApi(
  port: number
): Promise<PublishableKeyResult> {
  try {
    const url = `http://localhost:${port}/api/publishable-key`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second timeout

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      if (response.status === 503) {
        return { error: 'service_error' };
      }
      return { error: 'not_found' };
    }

    try {
      const data = (await response.json()) as { publishableKey: string };
      if (!data.publishableKey) {
        return { error: 'not_found' };
      }
      return { key: data.publishableKey };
    } catch {
      return { error: 'invalid_json' };
    }
  } catch (error: any) {
    // Check for timeout
    if (error.name === 'AbortError') {
      return { error: 'timeout' };
    }
    // Check for connection refused (ECONNREFUSED)
    if (
      error.cause?.code === 'ECONNREFUSED' ||
      error.message?.includes('ECONNREFUSED')
    ) {
      return { error: 'connection_refused' };
    }
    // Other network errors
    return { error: 'connection_refused' };
  }
}

/**
 * Build PostgreSQL connection string using shared docker credentials.
 */
function buildPostgresConnectionString(port: number): string {
  const { password, postgresUser, postgresDatabase } = DOCKER_DB_CREDENTIALS;
  return `Host=localhost;Port=${port};Database=${postgresDatabase};Username=${postgresUser};Password=${password};`;
}

/**
 * Build SQL Server connection string using shared docker credentials.
 */
function buildSqlServerConnectionString(port: number): string {
  const { password, sqlServerUser } = DOCKER_DB_CREDENTIALS;
  return `Server=localhost,${port};User Id=${sqlServerUser};Password=${password};TrustServerCertificate=True;`;
}

/**
 * Extract host port from a Docker port mapping string
 * e.g., `"0.0.0.0:5432->5432/tcp"` returns 5432
 */
function extractHostPort(portMapping: string): number | null {
  // Match IPv4 format: "0.0.0.0:5432->5432/tcp"
  const ipv4Match = portMapping.match(/^\d+\.\d+\.\d+\.\d+:(\d+)/);
  if (ipv4Match) {
    return parseInt(ipv4Match[1], 10);
  }

  // Match IPv6 format: ":::5432->5432/tcp"
  const ipv6Match = portMapping.match(/^:::(\d+)/);
  if (ipv6Match) {
    return parseInt(ipv6Match[1], 10);
  }

  return null;
}

/**
 * Container info with pre-extracted host ports for efficient lookup
 */
interface ContainerWithPorts {
  container: ServiceInfo;
  hostPorts: Set<number>;
}

/**
 * Extract and memoize host ports for all containers
 */
function extractContainerPorts(
  containers: ServiceInfo[]
): ContainerWithPorts[] {
  return containers.map((container) => {
    const hostPorts = new Set<number>();
    for (const portMapping of container.ports) {
      const port = extractHostPort(portMapping);
      if (port !== null) {
        hostPorts.add(port);
      }
    }
    return { container, hostPorts };
  });
}

/**
 * Find a Docker container that exposes a specific port
 */
function findContainerByPort(
  containersWithPorts: ContainerWithPorts[],
  port: number
): ServiceInfo | undefined {
  const found = containersWithPorts.find((c) => c.hostPorts.has(port));
  return found?.container;
}

/**
 * Build service statuses by matching .env ports to Docker containers
 */
function buildServiceStatuses(
  ports: StatusInfo['ports'],
  containersWithPorts: ContainerWithPorts[],
  enabledServices: StatusInfo['services']
): ServiceStatus[] {
  const statuses: ServiceStatus[] = [];

  // Always include WebService
  const webserviceContainer = findContainerByPort(
    containersWithPorts,
    ports.webservice
  );
  statuses.push({
    name: 'WebService',
    port: ports.webservice,
    status:
      webserviceContainer?.state === SERVICE_STATUS.RUNNING
        ? SERVICE_STATUS.RUNNING
        : SERVICE_STATUS.STOPPED,
    health:
      (webserviceContainer?.health as ServiceHealthValue) ||
      SERVICE_HEALTH.NOT_APPLICABLE,
  });

  // Include database services if data is enabled
  if (enabledServices.data) {
    const postgresContainer = findContainerByPort(
      containersWithPorts,
      ports.postgres
    );
    statuses.push({
      name: 'PostgreSQL',
      port: ports.postgres,
      status:
        postgresContainer?.state === SERVICE_STATUS.RUNNING
          ? SERVICE_STATUS.RUNNING
          : SERVICE_STATUS.STOPPED,
      health:
        (postgresContainer?.health as ServiceHealthValue) ||
        SERVICE_HEALTH.NOT_APPLICABLE,
    });

    const sqlserverContainer = findContainerByPort(
      containersWithPorts,
      ports.sqlserver
    );
    statuses.push({
      name: 'SQL Server',
      port: ports.sqlserver,
      status:
        sqlserverContainer?.state === SERVICE_STATUS.RUNNING
          ? SERVICE_STATUS.RUNNING
          : SERVICE_STATUS.STOPPED,
      health:
        (sqlserverContainer?.health as ServiceHealthValue) ||
        SERVICE_HEALTH.NOT_APPLICABLE,
    });
  }

  // Include Azurite if storage is enabled (show all three ports)
  if (enabledServices.storage) {
    const azuriteContainer = findContainerByPort(
      containersWithPorts,
      ports.azuriteBlob
    );
    const azuriteStatus =
      azuriteContainer?.state === SERVICE_STATUS.RUNNING
        ? SERVICE_STATUS.RUNNING
        : SERVICE_STATUS.STOPPED;
    const azuriteHealth =
      (azuriteContainer?.health as ServiceHealthValue) ||
      SERVICE_HEALTH.NOT_APPLICABLE;

    statuses.push({
      name: 'Azurite (Blob)',
      port: ports.azuriteBlob,
      status: azuriteStatus,
      health: azuriteHealth,
    });
    // Uncomment when we have support for Queue and Table in Azurite
    // statuses.push({
    //   name: 'Azurite (Queue)',
    //   port: ports.azuriteQueue,
    //   status: azuriteStatus,
    //   health: azuriteHealth,
    // });
    // statuses.push({
    //   name: 'Azurite (Table)',
    //   port: ports.azuriteTable,
    //   status: azuriteStatus,
    //   health: azuriteHealth,
    // });
  }

  return statuses;
}

/**
 * Format the status table for services
 */
function formatServiceTable(services: ServiceStatus[]): string {
  const lines: string[] = [];
  const separator = '━'.repeat(55);

  lines.push(separator);
  lines.push(
    `${'Service'.padEnd(16)}${'Status'.padEnd(12)}${'Health'.padEnd(12)}Port`
  );
  lines.push(separator);

  for (const service of services) {
    lines.push(
      `${service.name.padEnd(16)}${service.status.padEnd(12)}${service.health.padEnd(12)}${service.port}`
    );
  }

  lines.push(separator);
  return lines.join('\n');
}

/**
 * Check if a service is unhealthy (stopped or unhealthy health)
 */
function isUnhealthyService(service: ServiceStatus): boolean {
  return (
    service.status === SERVICE_STATUS.STOPPED ||
    service.health === SERVICE_HEALTH.UNHEALTHY
  );
}

/**
 * Determine exit code based on service health
 */
function determineExitCode(services: ServiceStatus[]): number {
  if (services.length === 0) {
    return EXIT_CODES.NO_CONTAINERS;
  }

  // Check if all services are stopped
  const stoppedServices = services.filter(
    (s) => s.status === SERVICE_STATUS.STOPPED
  );
  if (stoppedServices.length === services.length) {
    return EXIT_CODES.NO_CONTAINERS;
  }

  // Check for any unhealthy services (stopped, unhealthy, or starting)
  const unhealthyServices = services.filter(isUnhealthyService);
  if (unhealthyServices.length > 0) {
    return EXIT_CODES.UNHEALTHY;
  }

  return EXIT_CODES.HEALTHY;
}

/**
 * Display the status output in JSON format
 */
function displayJsonStatus(status: StatusInfo): void {
  const jsonOutput = {
    services: status.services,
    containers: status.serviceStatuses,
    ports: status.ports,
    urls: {
      backend: `http://localhost:${status.ports.webservice}`,
      ...(status.services.storage && {
        azuriteBlob: `http://127.0.0.1:${status.ports.azuriteBlob}/devstoreaccount1`,
      }),
    },
    connectionStrings: {
      ...(status.services.data && {
        postgres: buildPostgresConnectionString(status.ports.postgres),
        sqlserver: buildSqlServerConnectionString(status.ports.sqlserver),
      }),
    },
    ...(status.services.auth && {
      auth: {
        publishableKey: status.publishableKey || null,
        error: status.publishableKeyError || null,
      },
    }),
  };

  emitJson(jsonOutput);
}

/**
 * Display the status output
 */
function displayStatus(status: StatusInfo, mode: OutputMode): void {
  modeLog(mode, '\n🔍 Rayfin Development Environment Status\n');

  // Services section
  modeLog(mode, 'Services:');
  if (status.services.auth) modeLog(mode, '    auth: enabled');
  if (status.services.data) modeLog(mode, '    data: enabled');
  if (status.services.storage) modeLog(mode, '    storage: enabled');
  modeLog(mode, '');

  // Service status table
  if (status.serviceStatuses.length > 0) {
    modeLog(mode, formatServiceTable(status.serviceStatuses));
    modeLog(mode, '');

    // Service URLs section
    modeLog(
      mode,
      `🌐 Rayfin Backend URL: http://localhost:${status.ports.webservice}`
    );

    if (status.services.data || status.services.storage) {
      modeLog(mode, '\n🌐 Connection Strings:');
    }

    if (status.services.data) {
      modeLog(
        mode,
        `   > PostgreSQL: ${buildPostgresConnectionString(status.ports.postgres)}`
      );
      modeLog(
        mode,
        `   > SQL Server: ${buildSqlServerConnectionString(status.ports.sqlserver)}`
      );
    }

    if (status.services.storage) {
      modeLog(
        mode,
        `   > Azurite Blob: http://127.0.0.1:${status.ports.azuriteBlob}/devstoreaccount1`
      );
    }
    modeLog(mode, '');

    // Authentication section (only if auth enabled)
    if (status.services.auth) {
      modeLog(mode, '🔑 Authentication:');
      if (status.publishableKey) {
        modeLog(mode, `   > Publishable Key: ${status.publishableKey}`);
      } else if (status.publishableKeyError) {
        modeLog(mode, `   ⚠️  ${status.publishableKeyError}`);
      } else {
        modeLog(mode, '   ⚠️  Publishable key not available');
      }
      modeLog(mode, '');
    }
  }
}

/**
 * Display error message when no containers are running
 */
function displayNoContainersError(mode: OutputMode): void {
  modeLog(mode, '\n❌ No containers are running\n');
  modeLog(mode, '💡 Start the development environment with: rayfin dev\n');
}

/**
 * Options for dev status command
 */
interface DevStatusOptions {
  json?: boolean;
}

/**
 * Main status command implementation
 */
async function runDevStatus(
  this: Command,
  options: DevStatusOptions
): Promise<void> {
  // OR-merge with root-level --json so `rayfin --json dev status` works.
  const json = Boolean(options.json) || resolveRootOutputFlags(this).json;
  try {
    const mode = resolveOutputMode({ json });

    // Get parent command options (from 'rayfin dev')
    const parentOpts = this.parent?.opts() as { envFile?: string } | undefined;

    // Find project root
    const projectRoot = findRayfinProjectRoot(process.cwd(), { silent: true });
    const rayfinDir = join(projectRoot, 'rayfin');

    // Load rayfin.yml configuration (silent since we already logged the project root)
    const rayfinConfig = loadRayfinConfig(projectRoot, {
      silent: true,
      envFile: parentOpts?.envFile,
    });
    if (!rayfinConfig) {
      modeError(mode, '❌ Could not find rayfin.yml configuration');
      process.exit(EXIT_CODES.NO_CONTAINERS);
    }

    const projectName = rayfinConfig.id || 'rayfin';

    // Check if .env file exists
    const hasEnvFile = await envFileExists(rayfinDir);
    if (!hasEnvFile) {
      displayNoContainersError(mode);
      process.exit(EXIT_CODES.NO_CONTAINERS);
    }

    // Read environment variables
    const envVars = await readEnvFile(rayfinDir);
    const envMap = new Map(envVars.map((v) => [v.key, v.value]));

    // Check for required port variables
    if (!envMap.has('RAYFIN_WEBSERVICE_HTTP_PORT')) {
      modeError(mode, '\n❌ Port configuration not found in .env\n');
      modeLog(mode, '💡 Run `rayfin dev` to regenerate the environment\n');
      process.exit(EXIT_CODES.NO_CONTAINERS);
    }

    // Get Docker containers for this project and extract ports for efficient lookups
    const containers = await getDockerServices(projectName);
    const containersWithPorts = extractContainerPorts(containers);

    if (containersWithPorts.length === 0) {
      displayNoContainersError(mode);
      process.exit(EXIT_CODES.NO_CONTAINERS);
    }

    // Build status info, passing envVars to avoid repeated file I/O
    const portOptions = { envVars };
    const ports = {
      webservice: await getWebServicePort(portOptions),
      postgres: await getPostgresPort(portOptions),
      sqlserver: await getSqlServerPort(portOptions),
      azuriteBlob: await getAzuriteBlobPort(portOptions),
      azuriteQueue: await getAzuriteQueuePort(portOptions),
      azuriteTable: await getAzuriteTablePort(portOptions),
    };

    const enabledServices = {
      auth: rayfinConfig.services?.auth?.enabled ?? false,
      data: rayfinConfig.services?.data?.enabled ?? false,
      storage: rayfinConfig.services?.storage?.enabled ?? false,
    };

    // Build service statuses by matching .env ports to Docker containers
    const serviceStatuses = buildServiceStatuses(
      ports,
      containersWithPorts,
      enabledServices
    );

    // Try to fetch publishable key from API
    let publishableKey: string | undefined;
    let publishableKeyError: string | undefined;

    if (enabledServices.auth) {
      const result = await fetchPublishableKeyFromApi(ports.webservice);
      if (result.key) {
        publishableKey = result.key;
      } else if (result.error) {
        // Generate specific error messages based on error type
        switch (result.error) {
          case 'timeout':
            publishableKeyError =
              'Publishable key not available (request timeout)';
            break;
          case 'connection_refused':
            publishableKeyError =
              'Publishable key not available (WebService not running)';
            break;
          case 'invalid_json':
            publishableKeyError =
              'Publishable key not available (invalid response format)';
            break;
          case 'service_error':
            publishableKeyError =
              'Publishable key not available (WebService returned error)';
            break;
          case 'not_found':
            publishableKeyError = 'Publishable key not available';
            break;
        }
      }
    }

    const status: StatusInfo = {
      services: enabledServices,
      serviceStatuses,
      ports,
      publishableKey,
      publishableKeyError,
    };

    // Determine exit code based on service health
    const exitCode = determineExitCode(status.serviceStatuses);

    // Display output in requested format
    if (json) {
      displayJsonStatus(status);
    } else {
      displayStatus(status, mode);

      // Show warnings for unhealthy services
      if (exitCode !== EXIT_CODES.HEALTHY) {
        modeLog(mode, '\n⚠️  Some services are unhealthy');
        modeLog(
          mode,
          '💡 Wait for services to become healthy or restart with: rayfin dev --stop && rayfin dev\n'
        );
      }
    }

    process.exit(exitCode);
  } catch (error: any) {
    const mode = resolveOutputMode({ json });
    if (error.message?.includes('Could not find rayfin project root')) {
      modeError(mode, '❌ Not in a Rayfin project directory');
      modeLog(
        mode,
        '💡 Navigate to a Rayfin project or run `rayfin init` to create one\n'
      );
    } else {
      modeError(mode, '❌ Error:', error.message);
    }
    process.exit(EXIT_CODES.NO_CONTAINERS);
  }
}

/**
 * Dev status subcommand
 * Displays the current state of the local development environment
 */
export const devStatusCommand = new Command('status')
  .description('Display the status of the local development environment')
  .option('--json', 'Output status in JSON format', false)
  .action(runDevStatus);
