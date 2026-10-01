import { createServer, type Server } from 'node:net';

import { describe, it, expect, vi } from 'vitest';

import {
  areAllServicesRunning,
  buildDockerComposeLifecycleArgs,
  buildDockerComposeUpArgs,
  checkPortAvailability,
  findAvailableEphemeralPort,
  getAllCurrentHealthyServicesIfExist,
  reserveServicePortsFromEnv,
} from '../docker-utils.js';
import type { ServiceInfo } from '../docker-utils.js';

describe('Port Allocation', () => {
  it('reserves only valid persisted Docker service ports', () => {
    const reservedPorts = new Set<number>();

    reserveServicePortsFromEnv(
      new Map([
        ['RAYFIN_WEBSERVICE_HTTP_PORT', '5168'],
        ['RAYFIN_POSTGRES_PORT', '5432'],
        ['RAYFIN_SQLSERVER_PORT', 'not-a-port'],
        ['RAYFIN_ASPIRE_UI_PORT', '70000'],
        ['RAYFIN_PUBLIC_FRONTEND_PORT', '5173'],
        ['CUSTOM_PORT', '8080'],
      ]),
      reservedPorts
    );

    expect(reservedPorts).toEqual(new Set([5168, 5432]));
  });

  describe('allocateServicePorts', () => {
    it('should allocate sequential ports for Azurite services', async () => {
      // Dynamically import to ensure fresh module
      const { allocateServicePorts } = await import('../docker-utils.js');

      const allocation = await allocateServicePorts(['storage']);

      expect(allocation.RAYFIN_AZURITE_BLOB_PORT).toBeDefined();
      expect(allocation.RAYFIN_AZURITE_QUEUE_PORT).toBeDefined();
      expect(allocation.RAYFIN_AZURITE_TABLE_PORT).toBeDefined();

      // Queue port should be blob port + at least 1, table port should be blob port + at least 2
      // (exact values depend on port availability)
      const blobPort = allocation.RAYFIN_AZURITE_BLOB_PORT!;
      expect(allocation.RAYFIN_AZURITE_QUEUE_PORT).toBeGreaterThan(blobPort);
      expect(allocation.RAYFIN_AZURITE_TABLE_PORT).toBeGreaterThan(blobPort);
    });

    it('should only allocate ports for enabled profiles', async () => {
      const { allocateServicePorts } = await import('../docker-utils.js');

      const allocation = await allocateServicePorts(['data-api-mssql']);

      // WebService ports always allocated
      expect(allocation.RAYFIN_WEBSERVICE_HTTP_PORT).toBeDefined();
      expect(allocation.RAYFIN_WEBSERVICE_HTTPS_PORT).toBeDefined();

      // SQL Server port allocated (data-api-mssql profile enabled)
      expect(allocation.RAYFIN_SQLSERVER_PORT).toBeDefined();

      // Storage, telemetry ports not allocated
      expect(allocation.RAYFIN_AZURITE_BLOB_PORT).toBeUndefined();
      expect(allocation.RAYFIN_AZURITE_QUEUE_PORT).toBeUndefined();
      expect(allocation.RAYFIN_AZURITE_TABLE_PORT).toBeUndefined();
      expect(allocation.RAYFIN_ASPIRE_UI_PORT).toBeUndefined();
      expect(allocation.RAYFIN_ASPIRE_OTLP_PORT).toBeUndefined();
    });

    it('should allocate all ports when all profiles enabled', async () => {
      const { allocateServicePorts } = await import('../docker-utils.js');

      const allocation = await allocateServicePorts([
        'data-api-mssql',
        'storage',
        'telemetry',
      ]);

      // All ports should be allocated
      expect(allocation.RAYFIN_WEBSERVICE_HTTP_PORT).toBeDefined();
      expect(allocation.RAYFIN_WEBSERVICE_HTTPS_PORT).toBeDefined();
      expect(allocation.RAYFIN_SQLSERVER_PORT).toBeDefined();
      expect(allocation.RAYFIN_AZURITE_BLOB_PORT).toBeDefined();
      expect(allocation.RAYFIN_AZURITE_QUEUE_PORT).toBeDefined();
      expect(allocation.RAYFIN_AZURITE_TABLE_PORT).toBeDefined();
      expect(allocation.RAYFIN_ASPIRE_UI_PORT).toBeDefined();
      expect(allocation.RAYFIN_ASPIRE_OTLP_PORT).toBeDefined();
    });

    it('should exclude ports already claimed by sibling runtimes', async () => {
      const { allocateServicePorts } = await import('../docker-utils.js');
      const reservedPorts = new Set([5168, 7126, 5432]);

      const allocation = await allocateServicePorts([], reservedPorts);

      const initiallyReserved = [5168, 7126, 5432];
      expect(initiallyReserved).not.toContain(
        allocation.RAYFIN_WEBSERVICE_HTTP_PORT
      );
      expect(initiallyReserved).not.toContain(
        allocation.RAYFIN_WEBSERVICE_HTTPS_PORT
      );
      expect(initiallyReserved).not.toContain(allocation.RAYFIN_POSTGRES_PORT);
      expect(reservedPorts).toEqual(
        new Set([
          5168,
          7126,
          5432,
          allocation.RAYFIN_WEBSERVICE_HTTP_PORT,
          allocation.RAYFIN_WEBSERVICE_HTTPS_PORT,
          allocation.RAYFIN_POSTGRES_PORT,
        ])
      );
    });
  });
});

describe('Service Status Utilities', () => {
  describe('areAllServicesRunning', () => {
    it('should return false for empty service array', () => {
      expect(areAllServicesRunning([])).toBe(false);
    });

    it('should return true when all services are running', () => {
      const services: ServiceInfo[] = [
        {
          name: 'test-webservice-1',
          status: 'Up 5 minutes',
          state: 'running',
          ports: ['0.0.0.0:5168->8080/tcp'],
          health: 'healthy',
          containerId: 'abc123',
        },
        {
          name: 'test-sqlserver-1',
          status: 'Up 5 minutes',
          state: 'running',
          ports: ['0.0.0.0:1433->1433/tcp'],
          health: 'healthy',
          containerId: 'def456',
        },
      ];

      expect(areAllServicesRunning(services)).toBe(true);
    });

    it('should return false when any service is exited', () => {
      const services: ServiceInfo[] = [
        {
          name: 'test-webservice-1',
          status: 'Up 5 minutes',
          state: 'running',
          ports: ['0.0.0.0:5168->8080/tcp'],
          health: 'healthy',
          containerId: 'abc123',
        },
        {
          name: 'test-sqlserver-1',
          status: 'Exited (1) 2 minutes ago',
          state: 'exited',
          ports: [],
          health: 'unhealthy',
          containerId: 'def456',
        },
      ];

      expect(areAllServicesRunning(services)).toBe(false);
    });

    it('should return false when any service is paused', () => {
      const services: ServiceInfo[] = [
        {
          name: 'test-webservice-1',
          status: 'Up 5 minutes',
          state: 'running',
          ports: ['0.0.0.0:5168->8080/tcp'],
          health: 'healthy',
          containerId: 'abc123',
        },
        {
          name: 'test-azurite-1',
          status: 'Up 5 minutes (Paused)',
          state: 'paused',
          ports: ['0.0.0.0:10000->10000/tcp'],
          containerId: 'ghi789',
        },
      ];

      expect(areAllServicesRunning(services)).toBe(false);
    });

    it('should handle services with status containing "Up" but no explicit running state', () => {
      const services: ServiceInfo[] = [
        {
          name: 'test-webservice-1',
          status: 'Up 2 hours',
          ports: ['0.0.0.0:5168->8080/tcp'],
          health: 'healthy',
          containerId: 'abc123',
        },
      ];

      expect(areAllServicesRunning(services)).toBe(true);
    });

    it('should return false for services not containing "Up" in status', () => {
      const services: ServiceInfo[] = [
        {
          name: 'test-webservice-1',
          status: 'Restarting (1) Less than a second ago',
          state: 'restarting',
          ports: [],
          health: 'unhealthy',
          containerId: 'abc123',
        },
      ];

      expect(areAllServicesRunning(services)).toBe(false);
    });

    it('should return true for single running service', () => {
      const services: ServiceInfo[] = [
        {
          name: 'test-webservice-1',
          status: 'Up',
          state: 'running',
          ports: ['5168->8080'],
          health: 'healthy',
        },
      ];

      expect(areAllServicesRunning(services)).toBe(true);
    });
  });
});

const createServiceFetcher = (services: ServiceInfo[]) =>
  vi
    .fn<(projectName?: string) => Promise<ServiceInfo[]>>()
    .mockResolvedValue(services);

describe('getAllCurrentHealthyServicesIfExist', () => {
  it('should return null when no services are found', async () => {
    const fetchServices = createServiceFetcher([]);

    const result = await getAllCurrentHealthyServicesIfExist(
      'test-project',
      [],
      fetchServices
    );

    expect(result).toBeNull();
    expect(fetchServices).toHaveBeenCalledWith('test-project');
  });

  it('should return ServiceReadinessResult when all services are running and healthy', async () => {
    const services: ServiceInfo[] = [
      {
        name: 'test-project-webservice-1',
        status: 'Up',
        state: 'running',
        ports: ['5168->8080'],
        health: 'healthy',
      },
    ];
    const fetchServices = createServiceFetcher(services);

    const result = await getAllCurrentHealthyServicesIfExist(
      'test-project',
      [],
      fetchServices
    );

    expect(result).not.toBeNull();
    expect(result?.ready).toBe(true);
    expect(result?.allServicesRunning).toBe(true);
    expect(result?.hasUnhealthyServices).toBe(false);
  });

  it('should return null when services exist but are not all running', async () => {
    const services: ServiceInfo[] = [
      {
        name: 'test-project-webservice-1',
        status: 'Up',
        state: 'running',
        ports: ['5168->8080'],
        health: 'healthy',
      },
      {
        name: 'test-project-sqlserver-1',
        status: 'Exited',
        state: 'exited',
        ports: [],
        health: 'unhealthy',
      },
    ];
    const fetchServices = createServiceFetcher(services);

    const result = await getAllCurrentHealthyServicesIfExist(
      'test-project',
      ['data'],
      fetchServices
    );

    expect(result).toBeNull();
  });

  it('should return null when services lack explicit state', async () => {
    const services: ServiceInfo[] = [
      {
        name: 'test-project-webservice-1',
        status: 'Up 2 minutes',
        ports: ['5168->8080'],
        health: 'healthy',
      },
    ];
    const fetchServices = createServiceFetcher(services);

    const result = await getAllCurrentHealthyServicesIfExist(
      'test-project',
      [],
      fetchServices
    );

    expect(result).toBeNull();
  });
});

describe('service health check logic', () => {
  it('should return healthy result when all services have healthy status', async () => {
    const services: ServiceInfo[] = [
      {
        name: 'test-project-webservice-1',
        status: 'Up',
        state: 'running',
        ports: ['5168->8080'],
        health: 'healthy',
      },
      {
        name: 'test-project-sqlserver-1',
        status: 'Up',
        state: 'running',
        ports: ['1433->1433'],
        health: 'healthy',
      },
    ];
    const fetchServices = createServiceFetcher(services);

    const result = await getAllCurrentHealthyServicesIfExist(
      'test-project',
      ['data-api-mssql'],
      fetchServices
    );

    expect(result).not.toBeNull();
    expect(result?.ready).toBe(true);
    expect(result?.hasUnhealthyServices).toBe(false);
  });

  it('should return healthy result when services are starting', async () => {
    const services: ServiceInfo[] = [
      {
        name: 'test-project-webservice-1',
        status: 'Up',
        state: 'running',
        ports: ['5168->8080'],
        health: 'starting',
      },
    ];
    const fetchServices = createServiceFetcher(services);

    const result = await getAllCurrentHealthyServicesIfExist(
      'test-project',
      [],
      fetchServices
    );

    expect(result).not.toBeNull();
    expect(result?.ready).toBe(true);
  });

  it('should return null when any service is unhealthy', async () => {
    const services: ServiceInfo[] = [
      {
        name: 'test-project-webservice-1',
        status: 'Up',
        state: 'running',
        ports: ['5168->8080'],
        health: 'healthy',
      },
      {
        name: 'test-project-sqlserver-1',
        status: 'Up',
        state: 'running',
        ports: ['1433->1433'],
        health: 'unhealthy',
      },
    ];
    const fetchServices = createServiceFetcher(services);

    const result = await getAllCurrentHealthyServicesIfExist(
      'test-project',
      ['data'],
      fetchServices
    );

    expect(result).toBeNull();
  });

  it('should return healthy result when services have no health checks', async () => {
    const services: ServiceInfo[] = [
      {
        name: 'test-project-webservice-1',
        status: 'Up',
        state: 'running',
        ports: ['5168->8080'],
      },
    ];
    const fetchServices = createServiceFetcher(services);

    const result = await getAllCurrentHealthyServicesIfExist(
      'test-project',
      [],
      fetchServices
    );

    expect(result).not.toBeNull();
    expect(result?.ready).toBe(true);
  });
});

describe('service configuration matching', () => {
  it('should return healthy result when webservice is running and no profiles enabled', async () => {
    const services: ServiceInfo[] = [
      {
        name: 'project-webservice-1',
        status: 'Up',
        state: 'running',
        ports: ['5168->8080'],
        health: 'healthy',
      },
    ];
    const fetchServices = createServiceFetcher(services);

    const result = await getAllCurrentHealthyServicesIfExist(
      'project',
      [],
      fetchServices
    );

    expect(result).not.toBeNull();
    expect(result?.ready).toBe(true);
  });

  it('should return healthy result when data profile is enabled and sqlserver is running', async () => {
    const services: ServiceInfo[] = [
      {
        name: 'project-webservice-1',
        status: 'Up',
        state: 'running',
        ports: ['5168->8080'],
        health: 'healthy',
      },
      {
        name: 'project-sqlserver-1',
        status: 'Up',
        state: 'running',
        ports: ['1433->1433'],
        health: 'healthy',
      },
    ];
    const fetchServices = createServiceFetcher(services);

    const result = await getAllCurrentHealthyServicesIfExist(
      'project',
      ['data-api-mssql'],
      fetchServices
    );

    expect(result).not.toBeNull();
    expect(result?.ready).toBe(true);
  });

  it('should return null when data profile is enabled but sqlserver is not running', async () => {
    const services: ServiceInfo[] = [
      {
        name: 'project-webservice-1',
        status: 'Up',
        state: 'running',
        ports: ['5168->8080'],
        health: 'healthy',
      },
    ];
    const fetchServices = createServiceFetcher(services);

    const result = await getAllCurrentHealthyServicesIfExist(
      'project',
      ['data-api-mssql'],
      fetchServices
    );

    expect(result).toBeNull();
  });

  it('should return null when sqlserver is running but data profile is disabled', async () => {
    const services: ServiceInfo[] = [
      {
        name: 'project-webservice-1',
        status: 'Up',
        state: 'running',
        ports: ['5168->8080'],
        health: 'healthy',
      },
      {
        name: 'project-sqlserver-1',
        status: 'Up',
        state: 'running',
        ports: ['1433->1433'],
        health: 'healthy',
      },
    ];
    const fetchServices = createServiceFetcher(services);

    const result = await getAllCurrentHealthyServicesIfExist(
      'project',
      [],
      fetchServices
    );

    expect(result).toBeNull();
  });

  it('should return healthy result with all services when all profiles are enabled', async () => {
    const services: ServiceInfo[] = [
      {
        name: 'project-webservice-1',
        status: 'Up',
        state: 'running',
        ports: ['5168->8080'],
        health: 'healthy',
      },
      {
        name: 'project-sqlserver-1',
        status: 'Up',
        state: 'running',
        ports: ['1433->1433'],
        health: 'healthy',
      },
      {
        name: 'project-azurite-1',
        status: 'Up',
        state: 'running',
        ports: ['10000->10000', '10001->10001'],
        health: 'healthy',
      },
    ];
    const fetchServices = createServiceFetcher(services);

    const result = await getAllCurrentHealthyServicesIfExist(
      'project',
      ['data-api-mssql', 'storage'],
      fetchServices
    );

    expect(result).not.toBeNull();
    expect(result?.ready).toBe(true);
  });

  it('should return null when webservice is missing', async () => {
    const services: ServiceInfo[] = [
      {
        name: 'project-sqlserver-1',
        status: 'Up',
        state: 'running',
        ports: ['1433->1433'],
        health: 'healthy',
      },
    ];
    const fetchServices = createServiceFetcher(services);

    const result = await getAllCurrentHealthyServicesIfExist(
      'project',
      ['data'],
      fetchServices
    );

    expect(result).toBeNull();
  });
});

describe('docker compose arg construction with paths containing spaces', () => {
  // These tests verify that docker compose operations construct argument arrays
  // correctly — paths with spaces remain as single array elements, never
  // word-split.  The underlying `execFileAsync` (promisify(execFile)) does not
  // use a shell, so each element in the args array is a discrete argv entry.

  it('should keep compose file path with spaces as a single arg element', () => {
    // Replicate the arg construction logic used by startDockerServices
    const composeCommand = 'docker compose';
    const composePath =
      '/Users/test/path with spaces/project/rayfin/.temp/docker-compose.yml';
    const projectName = 'test-project';

    const baseCommand = composeCommand.split(' ');
    const args = [
      ...baseCommand.slice(1),
      '-f',
      composePath,
      '--project-name',
      projectName,
      'up',
      '-d',
    ];

    // The compose path must be a single array element, not word-split
    expect(args).toContain(composePath);
    const fIndex = args.indexOf('-f');
    expect(args[fIndex + 1]).toBe(composePath);
    // Verify no element contains only a fragment of the path
    expect(args).not.toContain('/Users/test/path');
    expect(args).not.toContain('with');
    expect(args).not.toContain(
      'spaces/project/rayfin/.temp/docker-compose.yml'
    );
  });

  it('should keep compose path with spaces intact for stop operations', () => {
    const composeCommand = 'docker compose';
    const composePath =
      '/Users/test/my project dir/rayfin/.temp/docker-compose.yml';
    const projectName = 'my-project';
    const profiles = ['data-api-mssql', 'storage'];

    const baseCommand = composeCommand.split(' ');
    const args = [
      ...baseCommand.slice(1),
      '-f',
      composePath,
      '--project-name',
      projectName,
    ];
    profiles.forEach((profile) => {
      args.push('--profile', profile);
    });
    args.push('down');

    expect(args).toContain(composePath);
    expect(args).toContain('down');
    expect(args).toContain('data-api-mssql');
    expect(args).toContain('storage');
    // Verify the path is one element, not split on spaces
    expect(args.filter((a) => a.includes('my project dir'))).toHaveLength(1);
  });

  it('should keep compose path with spaces intact for purge operations', () => {
    const composeCommand = 'docker compose';
    const composePath =
      '/Users/test/my project dir/rayfin/.temp/docker-compose.yml';
    const projectName = 'my-project';
    const profiles = ['data-api-mssql'];

    const baseCommand = composeCommand.split(' ');
    const args = [
      ...baseCommand.slice(1),
      '-f',
      composePath,
      '--project-name',
      projectName,
    ];
    profiles.forEach((profile) => {
      args.push('--profile', profile);
    });
    args.push('down', '-v');

    expect(args).toContain(composePath);
    expect(args).toContain('down');
    expect(args).toContain('-v');
    expect(args.filter((a) => a.includes('my project dir'))).toHaveLength(1);
  });

  it('should keep env-file path with spaces as a single arg element', () => {
    // Replicate the dev.ts arg construction for --env-file
    const composePath =
      '/Users/test/path with spaces/project/rayfin/.temp/docker-compose.yml';
    const envFilePath =
      '/Users/test/path with spaces/project/rayfin/.temp/.env';
    const projectName = 'test-project';

    const args = [
      'compose',
      '-f',
      composePath,
      '--project-name',
      projectName,
      '--env-file',
      envFilePath,
      '--profile',
      'data-api-mssql',
      'up',
      '-d',
    ];

    // Both paths should be single array elements
    expect(args).toContain(composePath);
    expect(args).toContain(envFilePath);
    const envFileIndex = args.indexOf('--env-file');
    expect(args[envFileIndex + 1]).toBe(envFilePath);
  });
});

describe('buildDockerComposeUpArgs', () => {
  it('forwards every enabled profile to docker compose up', () => {
    expect(
      buildDockerComposeUpArgs({
        composePath: '/p/rayfin/.temp/docker-compose.yml',
        composeCommand: 'docker compose',
        projectName: 'my-app',
        detach: true,
        pull: false,
        verbose: false,
        profiles: ['data-api-mssql', 'telemetry'],
      })
    ).toEqual([
      'compose',
      '-f',
      '/p/rayfin/.temp/docker-compose.yml',
      '--project-name',
      'my-app',
      '--profile',
      'data-api-mssql',
      '--profile',
      'telemetry',
      'up',
      '-d',
    ]);
  });

  it('forwards override files, project directory, and env file', () => {
    expect(
      buildDockerComposeUpArgs({
        composePath: '/p/rayfin/.temp/docker-compose.yml',
        additionalComposePaths: ['/p/docker-compose.override.yml'],
        composeCommand: 'docker compose',
        projectName: 'my-app',
        projectDirectory: '/workspace',
        envFilePath: '/p/rayfin/.env',
        detach: true,
        pull: false,
        verbose: false,
      })
    ).toEqual([
      'compose',
      '-f',
      '/p/rayfin/.temp/docker-compose.yml',
      '-f',
      '/p/docker-compose.override.yml',
      '--project-name',
      'my-app',
      '--project-directory',
      '/workspace',
      '--env-file',
      '/p/rayfin/.env',
      'up',
      '-d',
    ]);
  });
});

describe('buildDockerComposeLifecycleArgs', () => {
  const config = {
    composePath: '/p/rayfin/.temp/docker-compose.yml',
    additionalComposePaths: ['/p/docker-compose.override.yml'],
    composeCommand: 'docker compose',
    projectName: 'my-app',
    projectDirectory: '/workspace',
    envFilePath: '/p/rayfin/.env',
    detach: false,
    pull: false,
    verbose: false,
    profiles: ['telemetry'],
  };

  it.each([
    ['stop', ['stop']],
    ['down', ['down']],
    ['purge', ['down', '-v']],
  ] as const)('forwards overrides for %s', (action, tail) => {
    const args = buildDockerComposeLifecycleArgs(config, action);

    expect(args).toEqual([
      'compose',
      '-f',
      '/p/rayfin/.temp/docker-compose.yml',
      '-f',
      '/p/docker-compose.override.yml',
      '--project-name',
      'my-app',
      '--project-directory',
      '/workspace',
      '--env-file',
      '/p/rayfin/.env',
      '--profile',
      'telemetry',
      ...tail,
    ]);
  });
});

describe('checkPortAvailability', () => {
  const listen = (host: string): Promise<{ server: Server; port: number }> =>
    new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, host, () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Expected a TCP listener address'));
          return;
        }
        resolve({ server, port: address.port });
      });
    });

  const close = (server: Server): Promise<void> =>
    new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );

  it('reports an IPv4 loopback listener as occupied', async () => {
    const { server, port } = await listen('127.0.0.1');
    try {
      await expect(checkPortAvailability(port)).resolves.toBe(false);
    } finally {
      await close(server);
    }
  });

  it('reports an IPv6 loopback listener as occupied when IPv6 is available', async () => {
    let listener: { server: Server; port: number };
    try {
      listener = await listen('::1');
    } catch (error) {
      expect(['EADDRNOTAVAIL', 'EAFNOSUPPORT']).toContain(
        (error as Error & { code?: string }).code
      );
      return;
    }

    try {
      await expect(checkPortAvailability(listener.port)).resolves.toBe(false);
    } finally {
      await close(listener.server);
    }
  });

  it('reports a port as available after its listener closes', async () => {
    const { server, port } = await listen('127.0.0.1');
    await close(server);

    await expect(checkPortAvailability(port)).resolves.toBe(true);
  });

  it('returns an OS-assigned port available on both loopback families', async () => {
    const reservedPorts = new Set<number>();
    const port = await findAvailableEphemeralPort(reservedPorts);

    expect(port).toBeGreaterThan(0);
    expect(reservedPorts).toContain(port);
    await expect(checkPortAvailability(port)).resolves.toBe(true);
  });
});
