import { execSync, exec, execFile } from 'child_process';
import { readFileSync } from 'fs';
import { createServer } from 'node:net';
import { promisify } from 'util';

import { parse } from 'yaml';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface DockerInfo {
  available: boolean;
  version?: string;
  error?: string;
}

export interface DockerComposeInfo {
  available: boolean;
  command?: 'docker compose' | 'docker-compose';
  version?: string;
  error?: string;
}

export const checkDockerAvailable = (): DockerInfo => {
  try {
    // Check if Docker is installed
    const versionOutput = execSync('docker --version', {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();

    // Check if Docker daemon is running
    try {
      execSync('docker info', {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      return {
        available: true,
        version: versionOutput,
      };
    } catch (daemonError) {
      return {
        available: false,
        error:
          'Docker is installed but not running. Please start Docker Desktop or the Docker daemon.',
      };
    }
  } catch (installError) {
    return {
      available: false,
      error:
        'Docker is not installed. Please install Docker Desktop from https://www.docker.com/products/docker-desktop',
    };
  }
};

export const checkDockerComposeAvailable = (): DockerComposeInfo => {
  // First try the newer Docker Compose plugin (docker compose)
  try {
    const versionOutput = execSync('docker compose version', {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();

    return {
      available: true,
      command: 'docker compose',
      version: versionOutput,
    };
  } catch {
    // Fall back to standalone docker-compose
    try {
      const versionOutput = execSync('docker-compose --version', {
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();

      return {
        available: true,
        command: 'docker-compose',
        version: versionOutput,
      };
    } catch {
      return {
        available: false,
        error:
          'Docker Compose is not available. Please ensure Docker Desktop is installed with Compose plugin.',
      };
    }
  }
};

export const executeDockerCommand = (
  command: string,
  options: { cwd?: string } = {}
): string => {
  try {
    return execSync(command, {
      encoding: 'utf8',
      stdio: 'pipe',
      cwd: options.cwd || process.cwd(),
    }).trim();
  } catch (error: any) {
    throw new Error(`Docker command failed: ${error.message}`);
  }
};

export const executeDockerCommandAsync = async (
  command: string,
  options: { cwd?: string } = {}
): Promise<string> => {
  try {
    const { stdout } = await execAsync(command, {
      encoding: 'utf8',
      cwd: options.cwd || process.cwd(),
    });
    return stdout.trim();
  } catch (error: any) {
    throw new Error(`Docker command failed: ${error.message}`);
  }
};

export interface ServiceInfo {
  name: string;
  status: string;
  ports: string[];
  health?: 'healthy' | 'unhealthy' | 'starting' | 'unknown';
  containerId?: string;
  state?: string; // running, exited, etc.
}

export const getDockerServices = async (
  projectName?: string
): Promise<ServiceInfo[]> => {
  try {
    // Use .State for container state and .Status for health info
    const command =
      'docker ps --format "{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Ports}}"';
    const output = await executeDockerCommandAsync(command);

    if (!output.trim()) {
      return [];
    }

    const services: ServiceInfo[] = [];

    // Handle different line endings: \n, \r\n, \r
    const lines = output.trim().split(/\r?\n|\r/);

    // Process all lines (no header to skip since we're not using table format)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (!line) {
        continue;
      }

      const parts = line.split('\t');

      if (parts.length >= 5) {
        const containerId = parts[0].trim();
        const name = parts[1].trim();
        const state = parts[2].trim(); // running, exited, etc.
        const statusInfo = parts[3].trim(); // health info
        const portsString = parts[4].trim();

        // Filter by project name if provided
        if (projectName && !name.includes(projectName)) {
          continue;
        }

        // Parse ports
        const ports: string[] = [];
        if (portsString && portsString !== '') {
          // Split by comma and extract port mappings
          const portMappings = portsString.split(',').map((p) => p.trim());

          for (const mapping of portMappings) {
            if (mapping.includes('->')) {
              const [hostPort, containerPort] = mapping.split('->');
              const portMapping = `${hostPort.trim()}:${containerPort.trim()}`;
              ports.push(portMapping);
            } else {
              ports.push(mapping);
            }
          }
        }

        // Extract health status from the status info string
        let health: 'healthy' | 'unhealthy' | 'starting' | 'unknown' =
          'unknown';
        if (statusInfo.includes('(healthy)')) {
          health = 'healthy';
        } else if (statusInfo.includes('(unhealthy)')) {
          health = 'unhealthy';
        } else if (statusInfo.includes('(health: starting)')) {
          health = 'starting';
        } else if (statusInfo.includes('(starting)')) {
          health = 'starting';
        }

        const serviceInfo = {
          name,
          status: statusInfo, // Keep this for display purposes
          ports,
          health,
          containerId,
          state, // Add state for logic decisions
        };

        services.push(serviceInfo);
      }
    }

    return services;
  } catch (error: any) {
    // Return empty array if command fails
    return [];
  }
};

export const getDockerComposeServices = async (
  projectName = 'rayfin'
): Promise<ServiceInfo[]> => {
  return await getDockerServices(projectName);
};

export const monitorServiceHealth = async (
  config: ServiceConfig,
  options: {
    timeout?: number;
    pollingInterval?: number;
    verbose?: boolean;
    onUpdate?: (services: ServiceInfo[]) => void;
  } = {}
): Promise<ServiceReadinessResult> => {
  return waitForServicesReady(config.composePath, config.projectName, options);
};

export interface ServiceConfig {
  composePath: string;
  /** Additional Compose override files, applied after `composePath`. */
  additionalComposePaths?: string[];
  composeCommand: string;
  projectName: string;
  /** Compose project directory used to resolve relative paths in Compose files. */
  projectDirectory?: string;
  /** Explicit env file passed to every Compose lifecycle command. */
  envFilePath?: string;
  detach: boolean;
  pull: boolean;
  verbose: boolean;
  profiles?: string[];
}

/** Build arguments shared by every Docker Compose lifecycle command. */
function buildDockerComposeBaseArgs(config: ServiceConfig): string[] {
  const baseCommand = config.composeCommand.split(' ');
  const args = [...baseCommand.slice(1), '-f', config.composePath];
  for (const composePath of config.additionalComposePaths ?? []) {
    args.push('-f', composePath);
  }
  args.push('--project-name', config.projectName);
  if (config.projectDirectory) {
    args.push('--project-directory', config.projectDirectory);
  }
  if (config.envFilePath) {
    args.push('--env-file', config.envFilePath);
  }
  return args;
}

/** Build the argument vector for `docker compose up`. */
export function buildDockerComposeUpArgs(config: ServiceConfig): string[] {
  const args = buildDockerComposeBaseArgs(config);

  for (const profile of config.profiles ?? []) {
    args.push('--profile', profile);
  }
  args.push('up');
  if (config.detach) args.push('-d');
  if (config.pull) args.push('--pull', 'always');
  return args;
}

/** Build the argument vector for stop, down, or destructive purge. */
export function buildDockerComposeLifecycleArgs(
  config: ServiceConfig,
  action: 'stop' | 'down' | 'purge'
): string[] {
  const args = buildDockerComposeBaseArgs(config);
  for (const profile of config.profiles ?? []) {
    args.push('--profile', profile);
  }
  if (action === 'purge') {
    args.push('down', '-v');
  } else {
    args.push(action);
  }
  return args;
}

export const startDockerServices = async (
  config: ServiceConfig
): Promise<void> => {
  try {
    const baseCommand = config.composeCommand.split(' ');
    const execFileCmd = baseCommand[0];
    const args = buildDockerComposeUpArgs(config);
    await execFileAsync(execFileCmd, args);
  } catch (error: any) {
    throw new Error(`Failed to start services: ${error.message}`);
  }
};

export const stopDockerServices = async (
  config: ServiceConfig
): Promise<void> => {
  try {
    const baseCommand = config.composeCommand.split(' ');
    const execFileCmd = baseCommand[0];
    const args = buildDockerComposeLifecycleArgs(config, 'stop');

    await execFileAsync(execFileCmd, args);
  } catch (error: any) {
    throw new Error(`Failed to stop services: ${error.message}`);
  }
};

export const shutdownDockerServices = async (
  config: ServiceConfig
): Promise<void> => {
  try {
    const baseCommand = config.composeCommand.split(' ');
    const execFileCmd = baseCommand[0];
    const args = buildDockerComposeLifecycleArgs(config, 'down');

    await execFileAsync(execFileCmd, args);
  } catch (error: any) {
    throw new Error(`Failed to shutdown services: ${error.message}`);
  }
};

export const purgeDockerServices = async (
  config: ServiceConfig
): Promise<void> => {
  try {
    const baseCommand = config.composeCommand.split(' ');
    const execFileCmd = baseCommand[0];
    const args = buildDockerComposeLifecycleArgs(config, 'purge');

    await execFileAsync(execFileCmd, args);
  } catch (error: any) {
    throw new Error(`Failed to purge services: ${error.message}`);
  }
};

export const stopDockerComposeServices = async (
  composePath: string,
  composeCommand: string,
  projectName?: string
): Promise<void> => {
  const config: ServiceConfig = {
    composePath,
    composeCommand,
    projectName: projectName || 'default',
    detach: false,
    pull: false,
    verbose: false,
  };
  await stopDockerServices(config);
};

const LOOPBACK_HOSTS = ['127.0.0.1', '::1'] as const;
const EPHEMERAL_PORT_ATTEMPTS = 10;
type SocketError = Error & { code?: string };

const canBindPort = async (port: number, host: string): Promise<boolean> =>
  new Promise<boolean>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', (error: SocketError) => {
      if (
        host === '::1' &&
        (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT')
      ) {
        resolve(true);
      } else if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        resolve(false);
      } else {
        reject(error);
      }
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close((error) => (error ? reject(error) : resolve(true)));
    });
  });

export const checkPortAvailability = async (port: number): Promise<boolean> => {
  for (const host of LOOPBACK_HOSTS) {
    if (!(await canBindPort(port, host))) return false;
  }
  return true;
};

const requestEphemeralPort = async (): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Expected an ephemeral TCP listener address'));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });

/** Ask the OS for a free loopback port that is also available on IPv6. */
export const findAvailableEphemeralPort = async (
  reservedPorts?: Set<number>
): Promise<number> => {
  for (let attempt = 0; attempt < EPHEMERAL_PORT_ATTEMPTS; attempt++) {
    const port = await requestEphemeralPort();
    if (!reservedPorts?.has(port) && (await checkPortAvailability(port))) {
      reservedPorts?.add(port);
      return port;
    }
  }
  throw new Error('Could not allocate an ephemeral loopback port');
};

export interface ServiceReadinessResult {
  ready: boolean;
  services: ServiceInfo[];
  errors: string[];
  warnings: string[];
  allServicesRunning: boolean;
  hasUnhealthyServices: boolean;
  healthTimeout: boolean;
  healthDetails?: {
    sqlserver?: { ready: boolean; health: string };
    webservice?: { ready: boolean; health: string };
  };
}

// Helper function to check if all services are in running state
const NON_RUNNING_STATUS_KEYWORDS = [
  'paused',
  'exit',
  'exited',
  'dead',
  'error',
  'restart',
  'restarting',
  'stop',
  'stopped',
];

const statusIndicatesRunning = (status?: string): boolean => {
  if (!status) {
    return false;
  }

  const normalized = status.toLowerCase();

  if (
    NON_RUNNING_STATUS_KEYWORDS.some((keyword) => normalized.includes(keyword))
  ) {
    return false;
  }

  return normalized.includes('up') || normalized.includes('running');
};

export const areAllServicesRunning = (services: ServiceInfo[]): boolean => {
  if (services.length === 0) return false;

  return services.every((service) => {
    const state = service.state?.toLowerCase();

    if (state) {
      return state === 'running';
    }

    return statusIndicatesRunning(service.status);
  });
};

// Helper function to get health status summary
const getHealthySummary = (
  services: ServiceInfo[]
): { healthy: number; total: number; hasHealthChecks: boolean } => {
  const servicesWithHealthChecks = services.filter(
    (s) => s.health !== undefined
  );
  const healthyServices = servicesWithHealthChecks.filter(
    (s) => s.health === 'healthy'
  );

  return {
    healthy: healthyServices.length,
    total: servicesWithHealthChecks.length,
    hasHealthChecks: servicesWithHealthChecks.length > 0,
  };
};

export const waitForServicesReady = async (
  _composePath: string, // unused but kept for API compatibility
  projectName = 'rayfin',
  options: {
    timeout?: number;
    pollingInterval?: number;
    verbose?: boolean;
    onUpdate?: (services: ServiceInfo[]) => void;
  } = {}
): Promise<ServiceReadinessResult> => {
  const {
    timeout = 60000,
    pollingInterval = 2000,
    verbose = false,
    onUpdate,
  } = options;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (verbose) {
    console.log(
      `\n🔍 Starting two-phase service readiness check (timeout: ${timeout}ms, interval: ${pollingInterval}ms)`
    );
  }

  // Phase 1: Wait for all services to be running
  const phase1StartTime = Date.now();
  const phase1Timeout = Math.floor(timeout * 0.7); // Use 70% of timeout for Phase 1

  if (verbose) {
    console.log(
      `\n📋 Phase 1: Waiting for services to reach 'running' state (${phase1Timeout}ms timeout)`
    );
  }

  while (Date.now() - phase1StartTime < phase1Timeout) {
    try {
      const services = await getDockerComposeServices(projectName);

      if (onUpdate) {
        onUpdate(services);
      }

      if (verbose && services.length > 0) {
        const runningCount = services.filter(
          (s) => s.state?.toLowerCase() === 'running'
        ).length;
        console.log(
          `   📊 Services status: ${runningCount}/${services.length} running`
        );
      }

      // Check for failed services
      const failedServices = services.filter(
        (service) =>
          service.state?.toLowerCase().includes('exited') ||
          service.state?.toLowerCase().includes('dead') ||
          service.state?.toLowerCase().includes('error')
      );

      if (failedServices.length > 0) {
        errors.push(
          `Failed services: ${failedServices.map((s) => s.name).join(', ')}`
        );
        return {
          ready: false,
          services,
          errors,
          warnings,
          allServicesRunning: false,
          hasUnhealthyServices: false,
          healthTimeout: false,
        };
      }

      // Check if all services are running
      if (services.length > 0 && areAllServicesRunning(services)) {
        if (verbose) {
          console.log(
            `   ✅ Phase 1 complete: All ${services.length} services are running`
          );
        }
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, pollingInterval));
    } catch (error) {
      if (verbose) {
        console.log(
          `   ❌ Error during Phase 1: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      errors.push(
        `Phase 1 failed: ${error instanceof Error ? error.message : String(error)}`
      );
      await new Promise((resolve) => setTimeout(resolve, pollingInterval));
    }
  }

  // Get final services state after Phase 1
  let services: ServiceInfo[] = [];
  try {
    services = await getDockerComposeServices(projectName);
  } catch (error) {
    errors.push(
      `Failed to get services after Phase 1: ${error instanceof Error ? error.message : String(error)}`
    );
    return {
      ready: false,
      services: [],
      errors,
      warnings,
      allServicesRunning: false,
      hasUnhealthyServices: false,
      healthTimeout: false,
    };
  }

  // Check if Phase 1 succeeded
  if (!areAllServicesRunning(services)) {
    errors.push(
      `Phase 1 timeout: Services did not reach running state within ${phase1Timeout}ms`
    );
    return {
      ready: false,
      services,
      errors,
      warnings,
      allServicesRunning: false,
      hasUnhealthyServices: false,
      healthTimeout: false,
    };
  }

  // Phase 2: Wait for health checks (optional)
  const phase2StartTime = Date.now();
  const phase2Timeout = timeout - (phase2StartTime - phase1StartTime);
  const healthSummary = getHealthySummary(services);

  if (verbose) {
    console.log(
      `\n🏥 Phase 2: Waiting for health checks (${phase2Timeout}ms timeout)`
    );
    if (!healthSummary.hasHealthChecks) {
      console.log(`   ℹ️  No health checks configured, skipping Phase 2`);
    } else {
      console.log(
        `   � Health status: ${healthSummary.healthy}/${healthSummary.total} healthy`
      );
    }
  }

  // If no health checks configured, we're done
  if (!healthSummary.hasHealthChecks) {
    if (verbose) {
      console.log(
        `✅ Service readiness complete: All services running (no health checks)`
      );
    }
    return {
      ready: true,
      services,
      errors,
      warnings,
      allServicesRunning: true,
      hasUnhealthyServices: false,
      healthTimeout: false,
    };
  }

  // Wait for health checks
  let healthTimeout = false;
  while (Date.now() - phase2StartTime < phase2Timeout) {
    try {
      services = await getDockerComposeServices(projectName);

      if (onUpdate) {
        onUpdate(services);
      }

      const currentHealthSummary = getHealthySummary(services);

      if (verbose) {
        console.log(
          `   🏥 Health status: ${currentHealthSummary.healthy}/${currentHealthSummary.total} healthy`
        );
      }

      // All health checks passed
      if (
        currentHealthSummary.hasHealthChecks &&
        currentHealthSummary.healthy === currentHealthSummary.total
      ) {
        if (verbose) {
          console.log(`   ✅ Phase 2 complete: All health checks passed`);
        }
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, pollingInterval));
    } catch (error) {
      if (verbose) {
        console.log(
          `   ⚠️  Error during Phase 2: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      // Don't fail on Phase 2 errors, just warn
      warnings.push(
        `Health check error: ${error instanceof Error ? error.message : String(error)}`
      );
      await new Promise((resolve) => setTimeout(resolve, pollingInterval));
    }
  }

  // Final health check analysis
  const finalHealthSummary = getHealthySummary(services);
  const hasUnhealthyServices =
    finalHealthSummary.hasHealthChecks &&
    finalHealthSummary.healthy < finalHealthSummary.total;

  if (Date.now() - phase2StartTime >= phase2Timeout) {
    healthTimeout = true;
    warnings.push('Health checks timed out but services are running');
    if (verbose) {
      console.log(`   ⚠️  Phase 2 timed out, but services are running`);
    }
  }

  if (hasUnhealthyServices && !healthTimeout) {
    warnings.push('Some services are unhealthy but running');
  }

  if (verbose) {
    console.log(`✅ Service readiness complete: All services running`);
    if (warnings.length > 0) {
      console.log(`⚠️  Warnings: ${warnings.join(', ')}`);
    }
  }

  return {
    ready: true,
    services,
    errors,
    warnings,
    allServicesRunning: true,
    hasUnhealthyServices,
    healthTimeout,
  };
};

export interface AcrAuthInfo {
  authenticated: boolean;
  registry?: string;
  error?: string;
}

export interface AcrValidationResult {
  success: boolean;
  registries: string[];
  error?: string;
  failedRegistry?: string;
}

export const checkAcrAuthentication = (registryUrl: string): AcrAuthInfo => {
  try {
    // Extract registry name from full URL (e.g., "rayfin-chcvgsdxacg9gkd4.azurecr.io" from full image URL)
    const registryName = registryUrl.split('/')[0];
    const registryShortName = registryName.split('.')[0]; // e.g., "rayfin-chcvgsdxacg9gkd4"

    // Use az CLI to check authentication - this is the most reliable method
    try {
      execSync(
        `az acr repository list --name ${registryShortName} --output none`,
        {
          encoding: 'utf8',
          stdio: 'pipe',
        }
      );

      return {
        authenticated: true,
        registry: registryName,
      };
    } catch (azError: any) {
      // Check if the error is authentication-related
      const errorMessage = azError.message?.toLowerCase() || '';

      if (
        errorMessage.includes('unauthorized') ||
        errorMessage.includes('authentication') ||
        errorMessage.includes('login') ||
        errorMessage.includes('403') ||
        errorMessage.includes('401') ||
        errorMessage.includes('not logged in') ||
        errorMessage.includes('permission denied') ||
        errorMessage.includes('please run') ||
        errorMessage.includes('az login')
      ) {
        return {
          authenticated: false,
          registry: registryName,
          error: `Not authenticated to Azure Container Registry '${registryName}'. ACR requires the Azure CLI for registry login. Run 'az login' followed by 'az acr login --name ${registryShortName}'.`,
        };
      }

      // If it's not clearly an auth error, assume authentication is OK
      // This handles cases where az CLI is not installed or other non-auth issues
      return {
        authenticated: true,
        registry: registryName,
      };
    }
  } catch (error: any) {
    return {
      authenticated: false,
      registry: registryUrl.split('/')[0],
      error: `Failed to check ACR authentication: ${error.message}`,
    };
  }
};

/**
 * Extracts the ACR registry for the rayfin-webservice from docker-compose.yml file
 * @param composePath - Path to the docker-compose.yml file
 * @returns The ACR registry hostname for rayfin-webservice, or null if not found
 */
export const extractRayfinWebserviceRegistry = (
  composePath: string
): string | null => {
  try {
    const composeContent = readFileSync(composePath, 'utf8');
    const composeData = parse(composeContent);

    // Use optional chaining and early returns for cleaner code
    const image = composeData?.services?.['webservice']?.image;

    if (
      typeof image !== 'string' ||
      !image.split('/')[0]?.endsWith('.azurecr.io')
    ) {
      return null;
    }

    // Extract registry hostname (everything before the first slash)
    const registryMatch = image.match(/^([^/]+\.azurecr\.io)/);
    return registryMatch ? registryMatch[1] : null;
  } catch (error: any) {
    throw new Error(
      `Failed to parse docker-compose.yml at ${composePath}: ${error.message}`
    );
  }
};

/**
 * Validates ACR authentication for the rayfin-webservice registry found in docker-compose.yml file
 * @param composePath - Path to the docker-compose.yml file
 * @returns Validation result with success status and any error details
 */
export const validateAcrAuthentication = (
  composePath: string
): AcrValidationResult => {
  try {
    const registry = extractRayfinWebserviceRegistry(composePath);

    if (!registry) {
      return {
        success: true,
        registries: [],
      };
    }

    // Check authentication for the rayfin-webservice registry
    const authResult = checkAcrAuthentication(registry);

    if (!authResult.authenticated) {
      return {
        success: false,
        registries: [registry],
        failedRegistry: registry,
        error:
          authResult.error || `Authentication failed for registry ${registry}`,
      };
    }

    return {
      success: true,
      registries: [registry],
    };
  } catch (error: any) {
    return {
      success: false,
      registries: [],
      error: `Failed to validate ACR authentication: ${error.message}`,
    };
  }
};

/**
 * Port allocation utilities for multi-project development
 */

/**
 * Error thrown when a bounded port search finds no available candidate.
 */
export class PortRangeExhaustedError extends Error {
  constructor(basePort: number, maxAttempts: number) {
    super(
      `Could not find available port starting from ${basePort} after ${maxAttempts} attempts`
    );
    this.name = 'PortRangeExhaustedError';
  }
}

/**
 * Find an available port starting from a base port
 * @param basePort - Starting port number
 * @param reservedPorts - Optional set of already reserved ports to avoid (port will be added when found)
 * @param maxAttempts - Maximum number of ports to try (default: 100)
 * @returns Promise that resolves to an available port number
 * @throws {@link PortRangeExhaustedError} if no available port is found within maxAttempts
 */
export const findAvailablePort = async (
  basePort: number,
  reservedPorts?: Set<number>,
  maxAttempts = 100
): Promise<number> => {
  for (let i = 0; i < maxAttempts; i++) {
    const port = basePort + i;
    // Check both reservation status and system availability
    if (!reservedPorts?.has(port) && (await checkPortAvailability(port))) {
      reservedPorts?.add(port); // Track this port for subsequent allocations
      return port;
    }
  }

  throw new PortRangeExhaustedError(basePort, maxAttempts);
};

export interface ServicePortAllocation {
  RAYFIN_WEBSERVICE_HTTP_PORT: number;
  RAYFIN_WEBSERVICE_HTTPS_PORT: number;
  RAYFIN_SQLSERVER_PORT?: number;
  RAYFIN_POSTGRES_PORT?: number;
  RAYFIN_MAILDEV_SMTP_PORT?: number;
  RAYFIN_MAILDEV_WEB_PORT?: number;
  RAYFIN_POSTGRES_DATAAPI_PORT?: number;
  RAYFIN_AZURITE_BLOB_PORT?: number;
  RAYFIN_AZURITE_QUEUE_PORT?: number;
  RAYFIN_AZURITE_TABLE_PORT?: number;
  RAYFIN_ASPIRE_UI_PORT?: number;
  RAYFIN_ASPIRE_OTLP_PORT?: number;
}

const SERVICE_PORT_ENV_KEYS = [
  'RAYFIN_WEBSERVICE_HTTP_PORT',
  'RAYFIN_WEBSERVICE_HTTPS_PORT',
  'RAYFIN_SQLSERVER_PORT',
  'RAYFIN_POSTGRES_PORT',
  'RAYFIN_MAILDEV_SMTP_PORT',
  'RAYFIN_MAILDEV_WEB_PORT',
  'RAYFIN_POSTGRES_DATAAPI_PORT',
  'RAYFIN_AZURITE_BLOB_PORT',
  'RAYFIN_AZURITE_QUEUE_PORT',
  'RAYFIN_AZURITE_TABLE_PORT',
  'RAYFIN_ASPIRE_UI_PORT',
  'RAYFIN_ASPIRE_OTLP_PORT',
] as const satisfies readonly (keyof ServicePortAllocation)[];

/** Add valid persisted Docker service ports to a session reservation set. */
export function reserveServicePortsFromEnv(
  envVars: ReadonlyMap<string, string>,
  reservedPorts: Set<number>
): void {
  for (const key of SERVICE_PORT_ENV_KEYS) {
    const value = envVars.get(key);
    if (!value || !/^\d+$/.test(value)) continue;
    const port = Number.parseInt(value, 10);
    if (port > 0 && port <= 65535) reservedPorts.add(port);
  }
}

/**
 * Allocate ports for all enabled services based on profiles
 * @param profiles - Active Docker Compose profiles
 * @param reservedPorts - Session-scoped ports already claimed by sibling runtimes
 * @returns Promise that resolves to port allocation map
 */
export const allocateServicePorts = async (
  profiles: string[],
  reservedPorts = new Set<number>()
): Promise<ServicePortAllocation> => {
  const allocation: ServicePortAllocation = {
    RAYFIN_WEBSERVICE_HTTP_PORT: await findAvailablePort(5168, reservedPorts),
    RAYFIN_WEBSERVICE_HTTPS_PORT: await findAvailablePort(7126, reservedPorts),
    RAYFIN_POSTGRES_PORT: await findAvailablePort(5432, reservedPorts),
  };

  // Allocate SQL Server port if data-api-mssql profile is enabled
  if (profiles.includes('data-api-mssql')) {
    allocation.RAYFIN_SQLSERVER_PORT = await findAvailablePort(
      1433,
      reservedPorts
    );
  }

  // Allocate PostgreSQL Data API port if data-api-postgresql profile is enabled
  if (profiles.includes('data-api-postgresql')) {
    allocation.RAYFIN_POSTGRES_DATAAPI_PORT = await findAvailablePort(
      5433,
      reservedPorts
    );
  }

  // Allocate MailDev ports if email profile is enabled
  if (profiles.includes('email')) {
    allocation.RAYFIN_MAILDEV_SMTP_PORT = await findAvailablePort(
      1025,
      reservedPorts
    );
    allocation.RAYFIN_MAILDEV_WEB_PORT = await findAvailablePort(
      1080,
      reservedPorts
    );
  }

  // Allocate Azurite ports if storage profile is enabled
  if (profiles.includes('storage')) {
    const blobPort = await findAvailablePort(10000, reservedPorts);
    allocation.RAYFIN_AZURITE_BLOB_PORT = blobPort;
    allocation.RAYFIN_AZURITE_QUEUE_PORT = await findAvailablePort(
      blobPort + 1,
      reservedPorts
    );
    allocation.RAYFIN_AZURITE_TABLE_PORT = await findAvailablePort(
      blobPort + 2,
      reservedPorts
    );
  }

  // Allocate Aspire Dashboard ports if telemetry profile is enabled
  if (profiles.includes('telemetry')) {
    const aspireUIPort = await findAvailablePort(18888, reservedPorts);
    allocation.RAYFIN_ASPIRE_UI_PORT = aspireUIPort;
    allocation.RAYFIN_ASPIRE_OTLP_PORT = await findAvailablePort(
      4317,
      reservedPorts
    );
  }

  return allocation;
};

/**
 * Function type for fetching Docker services
 */
export type DockerServicesFetcher = (
  projectName?: string
) => Promise<ServiceInfo[]>;

/**
 * Attempts to reuse already-running docker services that match the current rayfin.yml profile set.
 * @param projectName - The project name prefix used when filtering docker containers.
 * @param enabledProfiles - The compose profiles that should currently be active (data, storage, etc.).
 * @param fetchServices - Optional function used to retrieve docker services (mockable for tests).
 * @returns A ServiceReadinessResult when existing services are healthy and match config, otherwise null.
 */
export const getAllCurrentHealthyServicesIfExist = async (
  projectName: string,
  enabledProfiles: string[],
  fetchServices: DockerServicesFetcher = getDockerServices
): Promise<ServiceReadinessResult | null> => {
  // Check if services are already running for this project
  console.log('🔍 Checking for existing services...');
  const existingServices = await fetchServices(projectName);
  let result: ServiceReadinessResult | null = null;

  if (existingServices.length > 0) {
    // Check if all existing services are running and healthy
    const allRunning = areAllServicesRunning(existingServices);
    const servicesWithHealthChecks = existingServices.filter((s) => s.health);
    const allHealthy =
      servicesWithHealthChecks.length === 0 ||
      servicesWithHealthChecks.every(
        (s) => s.health === 'healthy' || s.health === 'starting'
      );

    // Verify that running services match the desired configuration
    const hasWebservice = existingServices.some((s) =>
      s.name.includes('webservice')
    );
    const hasSqlServer = existingServices.some((s) =>
      s.name.includes('sqlserver')
    );
    const hasPostgresDataApi = existingServices.some((s) =>
      s.name.includes('postgres-dataapi')
    );
    const hasAzurite = existingServices.some((s) => s.name.includes('azurite'));
    const hasAspireDashboard = existingServices.some((s) =>
      s.name.includes('aspire')
    );

    const needsSqlServer = enabledProfiles.includes('data-api-mssql');
    const needsPostgresDataApi = enabledProfiles.includes(
      'data-api-postgresql'
    );
    const needsAzurite = enabledProfiles.includes('storage');
    const needsAspireDashboard = enabledProfiles.includes('telemetry');

    const configMatches =
      hasWebservice && // Always need webservice
      needsSqlServer === hasSqlServer && // SQL Server matches config
      needsPostgresDataApi === hasPostgresDataApi && // PostgreSQL Data API matches config
      needsAzurite === hasAzurite && // Azurite matches config
      needsAspireDashboard === hasAspireDashboard; // Aspire Dashboard matches config

    const hasExplicitState = existingServices.every((s) => Boolean(s.state));

    if (allRunning && allHealthy && configMatches && hasExplicitState) {
      console.log('✅ Services are already running and healthy!\n');

      // Create a ServiceReadinessResult from existing services
      result = {
        ready: true,
        services: existingServices,
        errors: [],
        warnings: [],
        allServicesRunning: true,
        hasUnhealthyServices: false,
        healthTimeout: false,
        healthDetails: {
          sqlserver: existingServices.find((s) => s.name.includes('sqlserver'))
            ? {
                ready: true,
                health:
                  existingServices.find((s) => s.name.includes('sqlserver'))
                    ?.health || 'healthy',
              }
            : undefined,
          webservice: existingServices.find((s) =>
            s.name.includes('webservice')
          )
            ? {
                ready: true,
                health:
                  existingServices.find((s) => s.name.includes('webservice'))
                    ?.health || 'healthy',
              }
            : undefined,
        },
      };
    } else if (!configMatches) {
      console.log(
        '⚠️  Running services do not match rayfin.yml configuration. Restarting...\n'
      );
    } else if (!hasExplicitState) {
      console.log(
        '⚠️  Services are missing state information. Restarting...\n'
      );
    } else {
      console.log(
        '⚠️  Services exist but are not all running or healthy. Restarting...\n'
      );
    }
  } else {
    console.log('📋 No existing services found. Starting new services...\n');
  }

  return result;
};
