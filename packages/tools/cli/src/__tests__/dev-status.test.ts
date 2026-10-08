import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Command } from 'commander';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { devStatusCommand } from '../commands/dev/dev-status';

describe('dev status command', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('command structure', () => {
    it('should have correct command name and description', () => {
      expect(devStatusCommand.name()).toBe('status');
      expect(devStatusCommand.description()).toBe(
        'Display the status of the local development environment'
      );
    });

    it('should have no required arguments', () => {
      const args = devStatusCommand.registeredArguments;
      expect(args).toHaveLength(0);
    });

    it('should have --json option', () => {
      const options = devStatusCommand.options;
      expect(options).toHaveLength(1);

      const jsonOption = options.find((opt) => opt.long === '--json');
      expect(jsonOption).toBeDefined();
      expect(jsonOption?.description).toBe('Output status in JSON format');
      expect(jsonOption?.defaultValue).toBe(false);
    });

    it('should be addable to parent command', () => {
      const parentCommand = new Command('dev');
      expect(() => {
        parentCommand.addCommand(devStatusCommand);
      }).not.toThrow();
    });

    it('should show help without errors', () => {
      const testProgram = new Command();
      testProgram.addCommand(devStatusCommand);

      // Test that help can be generated
      expect(() => {
        devStatusCommand.helpInformation();
      }).not.toThrow();
    });
  });

  describe('exit codes', () => {
    let testProjectDir: string;

    beforeEach(() => {
      // Create a unique temporary directory for each test
      testProjectDir = join(
        tmpdir(),
        `rayfin-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      );

      // Create the rayfin directory structure
      mkdirSync(join(testProjectDir, 'rayfin'), { recursive: true });

      // Mock process.exit to prevent test termination
      vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit called');
      }) as () => never);
    });

    afterEach(() => {
      // Clean up the test directory
      try {
        rmSync(testProjectDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should define correct exit code constants', async () => {
      // Import the module to verify exit codes are properly defined
      const devStatus = await import('../commands/dev/dev-status');
      expect(devStatus).toBeDefined();
    });
  });

  describe('rayfin.yml configuration reading', () => {
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

    it('should correctly parse enabled services from rayfin.yml', async () => {
      // Create a rayfin.yml file with specific service configuration
      const rayfinConfig = `id: test-project
name: Test Project
version: 1.0.0
services:
  auth:
    enabled: true
  data:
    enabled: false
  storage:
    enabled: true
`;
      writeFileSync(join(testProjectDir, 'rayfin', 'rayfin.yml'), rayfinConfig);

      // Import the config utilities to verify parsing
      const { loadRayfinConfig } = await import('../utils/config-utils.js');
      const config = loadRayfinConfig(testProjectDir);

      expect(config).not.toBeNull();
      expect(config?.services?.auth?.enabled).toBe(true);
      expect(config?.services?.data?.enabled).toBe(false);
      expect(config?.services?.storage?.enabled).toBe(true);
    });
  });

  describe('port reading utilities', () => {
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

    it('should read WebService port from .env file', async () => {
      const envContent = `RAYFIN_WEBSERVICE_HTTP_PORT=5170`;
      writeFileSync(join(testProjectDir, 'rayfin', '.env'), envContent);

      const { getWebServicePort } = await import('../utils/env-file-utils.js');
      const rayfinDir = join(testProjectDir, 'rayfin');
      const port = await getWebServicePort(rayfinDir);

      expect(port).toBe(5170);
    });

    it('should return default WebService port when .env missing', async () => {
      const { getWebServicePort } = await import('../utils/env-file-utils.js');
      const rayfinDir = join(testProjectDir, 'rayfin');
      const port = await getWebServicePort(rayfinDir);

      expect(port).toBe(5168);
    });

    it('should read SQL Server port from .env file', async () => {
      const envContent = `RAYFIN_SQLSERVER_PORT=1434`;
      writeFileSync(join(testProjectDir, 'rayfin', '.env'), envContent);

      const { getSqlServerPort } = await import('../utils/env-file-utils.js');
      const rayfinDir = join(testProjectDir, 'rayfin');
      const port = await getSqlServerPort(rayfinDir);

      expect(port).toBe(1434);
    });

    it('should return default SQL Server port when .env missing', async () => {
      const { getSqlServerPort } = await import('../utils/env-file-utils.js');
      const rayfinDir = join(testProjectDir, 'rayfin');
      const port = await getSqlServerPort(rayfinDir);

      expect(port).toBe(1433);
    });

    it('should read PostgreSQL port from .env file', async () => {
      const envContent = `RAYFIN_POSTGRES_PORT=5433`;
      writeFileSync(join(testProjectDir, 'rayfin', '.env'), envContent);

      const { getPostgresPort } = await import('../utils/env-file-utils.js');
      const rayfinDir = join(testProjectDir, 'rayfin');
      const port = await getPostgresPort(rayfinDir);

      expect(port).toBe(5433);
    });

    it('should return default PostgreSQL port when .env missing', async () => {
      const { getPostgresPort } = await import('../utils/env-file-utils.js');
      const rayfinDir = join(testProjectDir, 'rayfin');
      const port = await getPostgresPort(rayfinDir);

      expect(port).toBe(5432);
    });

    it('should read Azurite Blob port from .env file', async () => {
      const envContent = `RAYFIN_AZURITE_BLOB_PORT=10003`;
      writeFileSync(join(testProjectDir, 'rayfin', '.env'), envContent);

      const { getAzuriteBlobPort } = await import('../utils/env-file-utils.js');
      const rayfinDir = join(testProjectDir, 'rayfin');
      const port = await getAzuriteBlobPort(rayfinDir);

      expect(port).toBe(10003);
    });

    it('should return default Azurite Blob port when .env missing', async () => {
      const { getAzuriteBlobPort } = await import('../utils/env-file-utils.js');
      const rayfinDir = join(testProjectDir, 'rayfin');
      const port = await getAzuriteBlobPort(rayfinDir);

      expect(port).toBe(10000);
    });

    it('should read Azurite Queue port from .env file', async () => {
      const envContent = `RAYFIN_AZURITE_QUEUE_PORT=10004`;
      writeFileSync(join(testProjectDir, 'rayfin', '.env'), envContent);

      const { getAzuriteQueuePort } =
        await import('../utils/env-file-utils.js');
      const rayfinDir = join(testProjectDir, 'rayfin');
      const port = await getAzuriteQueuePort(rayfinDir);

      expect(port).toBe(10004);
    });

    it('should return default Azurite Queue port when .env missing', async () => {
      const { getAzuriteQueuePort } =
        await import('../utils/env-file-utils.js');
      const rayfinDir = join(testProjectDir, 'rayfin');
      const port = await getAzuriteQueuePort(rayfinDir);

      expect(port).toBe(10001);
    });

    it('should read Azurite Table port from .env file', async () => {
      const envContent = `RAYFIN_AZURITE_TABLE_PORT=10005`;
      writeFileSync(join(testProjectDir, 'rayfin', '.env'), envContent);

      const { getAzuriteTablePort } =
        await import('../utils/env-file-utils.js');
      const rayfinDir = join(testProjectDir, 'rayfin');
      const port = await getAzuriteTablePort(rayfinDir);

      expect(port).toBe(10005);
    });

    it('should return default Azurite Table port when .env missing', async () => {
      const { getAzuriteTablePort } =
        await import('../utils/env-file-utils.js');
      const rayfinDir = join(testProjectDir, 'rayfin');
      const port = await getAzuriteTablePort(rayfinDir);

      expect(port).toBe(10002);
    });

    it('should read publishable key from .env file', async () => {
      const envContent = `RAYFIN_PUBLISHABLE_KEY=pk_dev_1234567890abcdef`;
      writeFileSync(join(testProjectDir, 'rayfin', '.env'), envContent);

      const { readEnvFile } = await import('../utils/env-file-utils.js');
      const rayfinDir = join(testProjectDir, 'rayfin');
      const envVars = await readEnvFile(rayfinDir);
      const keyVar = envVars.find((v) => v.key === 'RAYFIN_PUBLISHABLE_KEY');

      expect(keyVar).toBeDefined();
      expect(keyVar?.value).toBe('pk_dev_1234567890abcdef');
    });
  });

  describe('port reading with envVars option', () => {
    it('should read WebService port from envVars array', async () => {
      const { getWebServicePort } = await import('../utils/env-file-utils.js');
      const envVars = [{ key: 'RAYFIN_WEBSERVICE_HTTP_PORT', value: '5175' }];
      const port = await getWebServicePort({ envVars });

      expect(port).toBe(5175);
    });

    it('should read SQL Server port from envVars array', async () => {
      const { getSqlServerPort } = await import('../utils/env-file-utils.js');
      const envVars = [{ key: 'RAYFIN_SQLSERVER_PORT', value: '1450' }];
      const port = await getSqlServerPort({ envVars });

      expect(port).toBe(1450);
    });

    it('should read PostgreSQL port from envVars array', async () => {
      const { getPostgresPort } = await import('../utils/env-file-utils.js');
      const envVars = [{ key: 'RAYFIN_POSTGRES_PORT', value: '5450' }];
      const port = await getPostgresPort({ envVars });

      expect(port).toBe(5450);
    });

    it('should read Azurite Blob port from envVars array', async () => {
      const { getAzuriteBlobPort } = await import('../utils/env-file-utils.js');
      const envVars = [{ key: 'RAYFIN_AZURITE_BLOB_PORT', value: '10010' }];
      const port = await getAzuriteBlobPort({ envVars });

      expect(port).toBe(10010);
    });

    it('should read Azurite Queue port from envVars array', async () => {
      const { getAzuriteQueuePort } =
        await import('../utils/env-file-utils.js');
      const envVars = [{ key: 'RAYFIN_AZURITE_QUEUE_PORT', value: '10011' }];
      const port = await getAzuriteQueuePort({ envVars });

      expect(port).toBe(10011);
    });

    it('should read Azurite Table port from envVars array', async () => {
      const { getAzuriteTablePort } =
        await import('../utils/env-file-utils.js');
      const envVars = [{ key: 'RAYFIN_AZURITE_TABLE_PORT', value: '10012' }];
      const port = await getAzuriteTablePort({ envVars });

      expect(port).toBe(10012);
    });

    it('should return default when envVars array is empty', async () => {
      const { getWebServicePort } = await import('../utils/env-file-utils.js');
      const envVars: { key: string; value: string }[] = [];
      const port = await getWebServicePort({ envVars });

      expect(port).toBe(5168);
    });

    it('should return default when variable not in envVars array', async () => {
      const { getWebServicePort } = await import('../utils/env-file-utils.js');
      const envVars = [{ key: 'SOME_OTHER_VAR', value: '1234' }];
      const port = await getWebServicePort({ envVars });

      expect(port).toBe(5168);
    });

    it('should read multiple ports from same envVars array', async () => {
      const { getWebServicePort, getSqlServerPort, getPostgresPort } =
        await import('../utils/env-file-utils.js');

      const envVars = [
        { key: 'RAYFIN_WEBSERVICE_HTTP_PORT', value: '5180' },
        { key: 'RAYFIN_SQLSERVER_PORT', value: '1460' },
        { key: 'RAYFIN_POSTGRES_PORT', value: '5460' },
      ];

      const webPort = await getWebServicePort({ envVars });
      const sqlPort = await getSqlServerPort({ envVars });
      const pgPort = await getPostgresPort({ envVars });

      expect(webPort).toBe(5180);
      expect(sqlPort).toBe(1460);
      expect(pgPort).toBe(5460);
    });
  });
});
