import { describe, it, expect } from 'vitest';

import { areAllServicesRunning, ServiceInfo } from '../utils/docker-utils.js';

describe('Port Allocation', () => {
  describe('allocateServicePorts', () => {
    it('should allocate sequential ports for Azurite services', async () => {
      // Dynamically import to ensure fresh module
      const { allocateServicePorts } = await import('../utils/docker-utils.js');

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
      const { allocateServicePorts } = await import('../utils/docker-utils.js');

      const allocation = await allocateServicePorts(['data-api-mssql']);

      // WebService ports always allocated
      expect(allocation.RAYFIN_WEBSERVICE_HTTP_PORT).toBeDefined();
      expect(allocation.RAYFIN_WEBSERVICE_HTTPS_PORT).toBeDefined();

      // Postgres port always allocated
      expect(allocation.RAYFIN_POSTGRES_PORT).toBeDefined();

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
      const { allocateServicePorts } = await import('../utils/docker-utils.js');

      const allocation = await allocateServicePorts([
        'data-api-mssql',
        'storage',
        'telemetry',
      ]);

      // All ports should be allocated
      expect(allocation.RAYFIN_WEBSERVICE_HTTP_PORT).toBeDefined();
      expect(allocation.RAYFIN_WEBSERVICE_HTTPS_PORT).toBeDefined();
      expect(allocation.RAYFIN_POSTGRES_PORT).toBeDefined();
      expect(allocation.RAYFIN_SQLSERVER_PORT).toBeDefined();
      expect(allocation.RAYFIN_AZURITE_BLOB_PORT).toBeDefined();
      expect(allocation.RAYFIN_AZURITE_QUEUE_PORT).toBeDefined();
      expect(allocation.RAYFIN_AZURITE_TABLE_PORT).toBeDefined();
      expect(allocation.RAYFIN_ASPIRE_UI_PORT).toBeDefined();
      expect(allocation.RAYFIN_ASPIRE_OTLP_PORT).toBeDefined();
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
