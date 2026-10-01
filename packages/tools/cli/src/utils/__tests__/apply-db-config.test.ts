import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { CliHandledError } from '../../errors';
import { applyDbConfig } from '../apply-db-config';
import * as dabApply from '../dab-apply';
import * as dabConfigGenerator from '../dab-config-generator';
import * as remoteEndpointUtils from '../remote-endpoint-utils';

// Mock the dependencies
vi.mock('../dab-apply');
vi.mock('../dab-config-generator');
vi.mock('../remote-endpoint-utils');

// Mock output-mode so modeLog/modeError use console (tests spy on it)
vi.mock('../output-mode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../output-mode')>();
  return {
    ...actual,
    modeLog: (_mode: unknown, ...args: unknown[]) => console.log(...args),
    modeError: (_mode: unknown, ...args: unknown[]) => console.error(...args),
    resolveOutputMode: () => 'interactive',
  };
});

describe('apply-db-config', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Mock console methods to avoid cluttering test output
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('propagateError parameter', () => {
    beforeEach(() => {
      // Setup generateDabConfig to succeed with a non-empty entities array
      // so the apply-to-server step is reached in these tests
      vi.mocked(dabConfigGenerator.generateDabConfig).mockResolvedValue({
        configPath: '/fake/path/dab-config.json',
        entities: [{ name: 'TestEntity' }],
        duration: 100,
        dialect: 'mssql',
      });
    });

    it('should throw error when propagateError is true and applyConfigToServer fails', async () => {
      // Arrange
      const testError = new Error('Connection failed');
      vi.mocked(dabApply.applyConfigToServer).mockRejectedValue(testError);

      // Act & Assert
      await expect(
        applyDbConfig({
          remote: false,
          force: false,
          exitOnError: false,
          propagateError: true,
        })
      ).rejects.toThrow('Connection failed');

      // Verify console.error was not called (error should be propagated, not logged)
      expect(console.error).not.toHaveBeenCalled();
    });

    it('should not throw error when propagateError is false and applyConfigToServer fails', async () => {
      // Arrange
      const testError = new Error('Connection refused');
      vi.mocked(dabApply.applyConfigToServer).mockRejectedValue(testError);

      // Act & Assert - should not throw
      await expect(
        applyDbConfig({
          remote: false,
          force: false,
          exitOnError: false,
          propagateError: false,
        })
      ).resolves.not.toThrow();

      // Verify console.error was called to log the error
      expect(console.error).toHaveBeenCalledWith(
        '❌ Failed to apply configuration to local server'
      );
      expect(console.error).toHaveBeenCalledWith('   Connection refused');
    });

    it('should throw error when propagateError is true and generateDabConfig fails', async () => {
      // Arrange
      const testError = new Error('Invalid configuration');
      vi.mocked(dabConfigGenerator.generateDabConfig).mockRejectedValue(
        testError
      );

      // Act & Assert
      await expect(
        applyDbConfig({
          remote: false,
          force: false,
          exitOnError: false,
          propagateError: true,
        })
      ).rejects.toThrow('Invalid configuration');
    });

    it('should not throw error when propagateError is false and generateDabConfig fails', async () => {
      // Arrange
      const testError = new Error('Schema validation failed');
      vi.mocked(dabConfigGenerator.generateDabConfig).mockRejectedValue(
        testError
      );

      // Act & Assert - should not throw
      await expect(
        applyDbConfig({
          remote: false,
          force: false,
          exitOnError: false,
          propagateError: false,
        })
      ).resolves.not.toThrow();

      // Verify error was logged
      expect(console.error).toHaveBeenCalledWith(
        '❌ Failed to apply configuration to local server'
      );
    });
  });

  describe('successful execution', () => {
    it('should not throw when propagateError is true and execution succeeds', async () => {
      // Arrange
      vi.mocked(dabConfigGenerator.generateDabConfig).mockResolvedValue({
        configPath: '/fake/path/dab-config.json',
        entities: [{ name: 'TestEntity' }],
        duration: 100,
        dialect: 'mssql',
      });
      vi.mocked(dabApply.applyConfigToServer).mockResolvedValue(undefined);

      // Act & Assert - should succeed without throwing
      await expect(
        applyDbConfig({
          remote: false,
          force: false,
          exitOnError: false,
          propagateError: true,
        })
      ).resolves.not.toThrow();

      // Verify success messages were logged
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('DB Apply (Local Mode)')
      );
    });

    it('forwards serviceRoot to generateDabConfig when provided', async () => {
      vi.mocked(dabConfigGenerator.generateDabConfig).mockResolvedValue({
        configPath: '/fake/path/dab-config.json',
        entities: [{ name: 'TestEntity' }],
        duration: 100,
        dialect: 'mssql',
      });
      vi.mocked(dabApply.applyConfigToServer).mockResolvedValue(undefined);

      await applyDbConfig({
        remote: false,
        force: false,
        exitOnError: false,
        propagateError: true,
        serviceRoot: '/workspace/packages/data',
      });

      expect(dabConfigGenerator.generateDabConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceRoot: '/workspace/packages/data',
        })
      );
    });

    it('forwards buildCommand to generateDabConfig when provided', async () => {
      vi.mocked(dabConfigGenerator.generateDabConfig).mockResolvedValue({
        configPath: '/fake/path/dab-config.json',
        entities: [{ name: 'TestEntity' }],
        duration: 100,
        dialect: 'mssql',
      });
      vi.mocked(dabApply.applyConfigToServer).mockResolvedValue(undefined);

      await applyDbConfig({
        remote: false,
        force: false,
        exitOnError: false,
        propagateError: true,
        serviceRoot: '/workspace/packages/data',
        buildCommand: 'npm run build',
      });

      expect(dabConfigGenerator.generateDabConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceRoot: '/workspace/packages/data',
          buildCommand: 'npm run build',
        })
      );
    });

    it('omits buildCommand from generateDabConfig when not provided', async () => {
      vi.mocked(dabConfigGenerator.generateDabConfig).mockResolvedValue({
        configPath: '/fake/path/dab-config.json',
        entities: [{ name: 'TestEntity' }],
        duration: 100,
        dialect: 'mssql',
      });
      vi.mocked(dabApply.applyConfigToServer).mockResolvedValue(undefined);

      await applyDbConfig({
        remote: false,
        force: false,
        exitOnError: false,
        propagateError: true,
      });

      expect(dabConfigGenerator.generateDabConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          buildCommand: undefined,
        })
      );
    });
  });

  describe('empty entities (no @entity() classes defined)', () => {
    it('should log info message and not call applyConfigToServer when entities is empty', async () => {
      // Arrange
      vi.mocked(dabConfigGenerator.generateDabConfig).mockResolvedValue({
        configPath: '',
        entities: [],
        duration: 100,
        dialect: 'mssql',
      });

      // Act - should resolve without throwing
      await expect(
        applyDbConfig({
          remote: false,
          force: false,
          exitOnError: false,
          propagateError: true,
        })
      ).resolves.not.toThrow();

      // Verify info message was logged
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('No entity classes found')
      );

      // Verify applyConfigToServer was NOT called
      expect(dabApply.applyConfigToServer).not.toHaveBeenCalled();
    });
  });

  describe('remote mode without a configured endpoint', () => {
    beforeEach(() => {
      // No remote endpoint is configured.
      vi.mocked(remoteEndpointUtils.hasRemoteEndpoint).mockReturnValue(false);
    });

    it('throws (not falls back to local) when propagateError is true', async () => {
      await expect(
        applyDbConfig({
          remote: true,
          force: false,
          exitOnError: false,
          propagateError: true,
        })
      ).rejects.toThrow('No remote endpoint configured');

      // Must reject before generating config or contacting any server, so it
      // can never apply a "remote" request to the local dev server.
      expect(dabConfigGenerator.generateDabConfig).not.toHaveBeenCalled();
      expect(dabApply.applyConfigToServer).not.toHaveBeenCalled();
    });

    it('throws when exitOnError is true', async () => {
      await expect(
        applyDbConfig({
          remote: true,
          force: false,
          exitOnError: true,
        })
      ).rejects.toThrow('No remote endpoint configured');

      expect(dabApply.applyConfigToServer).not.toHaveBeenCalled();
    });
  });

  describe('exitOnError wraps the rethrow in CliHandledError', () => {
    // The catch block in applyDbConfig prints a formatted error block
    // (header + message + troubleshooting tips) before rethrowing when
    // exitOnError is true. That printed block is the user-facing
    // message, so the rethrow MUST be a CliHandledError — otherwise
    // the top-level handler re-prints `error.message`
    // and the user sees the error twice (the duplicate-log bug that
    // previously affected `rayfin dev db apply` and `rayfin up db apply`).

    it('wraps a generateDabConfig failure in CliHandledError when exitOnError is true', async () => {
      const underlying = new Error('Schema validation failed');
      vi.mocked(dabConfigGenerator.generateDabConfig).mockRejectedValue(
        underlying
      );

      try {
        await applyDbConfig({
          remote: false,
          force: false,
          exitOnError: true,
          propagateError: false,
        });
        expect.fail('Expected applyDbConfig to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(CliHandledError);
        expect((error as CliHandledError).originalError).toBe(underlying);
      }

      // Catch block still ran: header + tips were printed exactly once.
      expect(console.error).toHaveBeenCalledWith(
        '❌ Failed to apply configuration to local server'
      );
    });

    it('wraps an applyConfigToServer failure in CliHandledError when exitOnError is true', async () => {
      vi.mocked(dabConfigGenerator.generateDabConfig).mockResolvedValue({
        configPath: '/fake/path/dab-config.json',
        entities: [{ name: 'TestEntity' }],
        duration: 100,
        dialect: 'mssql',
      });
      const underlying = new Error('Anonymous data access is not supported');
      vi.mocked(dabApply.applyConfigToServer).mockRejectedValue(underlying);

      try {
        await applyDbConfig({
          remote: true,
          force: false,
          exitOnError: true,
          propagateError: false,
          remoteEndpoint: 'https://example.invalid/api',
        });
        expect.fail('Expected applyDbConfig to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(CliHandledError);
        expect((error as CliHandledError).originalError).toBe(underlying);
      }

      expect(console.error).toHaveBeenCalledWith(
        '❌ Failed to apply configuration to remote endpoint'
      );
    });

    it('wraps the missing-remote-endpoint error in CliHandledError when exitOnError is true', async () => {
      vi.mocked(remoteEndpointUtils.hasRemoteEndpoint).mockReturnValue(false);

      try {
        await applyDbConfig({
          remote: true,
          force: false,
          exitOnError: true,
        });
        expect.fail('Expected applyDbConfig to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(CliHandledError);
        expect((error as CliHandledError).originalError).toBeInstanceOf(Error);
        expect(
          ((error as CliHandledError).originalError as Error).message
        ).toBe('No remote endpoint configured');
      }

      expect(console.error).toHaveBeenCalledWith(
        '❌ No remote endpoint configured'
      );
    });
  });

  describe('remote apply forwards the resource moniker header', () => {
    beforeEach(() => {
      vi.mocked(dabConfigGenerator.generateDabConfig).mockResolvedValue({
        configPath: '/fake/path/dab-config.json',
        entities: [{ name: 'TestEntity' }],
        duration: 100,
        dialect: 'mssql',
      });
      vi.mocked(dabApply.applyConfigToServer).mockResolvedValue(undefined);
      vi.mocked(remoteEndpointUtils.hasRemoteEndpoint).mockReturnValue(true);
      vi.mocked(remoteEndpointUtils.getRemoteApplyConfigUrl).mockReturnValue(
        'https://api.fabric.example/workspaces/ws/appBackends/item-123/__private/applyconfig'
      );
      vi.mocked(
        remoteEndpointUtils.getRemoteAuthorizationHeader
      ).mockResolvedValue('Bearer token');
    });

    it('passes force and the X-Ms-Workload-Resource-Moniker header on remote apply', async () => {
      vi.mocked(remoteEndpointUtils.getActiveDeploymentEnvVars).mockReturnValue(
        {
          rayfinItemId: 'item-123',
          fabricWorkspaceId: 'ws',
        } as never
      );

      await applyDbConfig({ remote: true, force: true, propagateError: true });

      expect(dabApply.applyConfigToServer).toHaveBeenCalledWith(
        '/fake/path/dab-config.json',
        expect.any(String),
        true,
        true,
        'Bearer token',
        { 'X-Ms-Workload-Resource-Moniker': 'item-123' },
        expect.any(String),
        { retryTransientErrors: false, retryOptions: undefined }
      );
    });

    it('omits the moniker header when no deployment item id is available', async () => {
      vi.mocked(remoteEndpointUtils.getActiveDeploymentEnvVars).mockReturnValue(
        null
      );

      await applyDbConfig({ remote: true, force: true, propagateError: true });

      expect(dabApply.applyConfigToServer).toHaveBeenCalledWith(
        '/fake/path/dab-config.json',
        expect.any(String),
        true,
        true,
        'Bearer token',
        undefined,
        expect.any(String),
        { retryTransientErrors: false, retryOptions: undefined }
      );
    });

    it('retries only the remote apply when requested by v2', async () => {
      await applyDbConfig({
        remote: true,
        force: true,
        propagateError: true,
        retryTransientErrors: true,
      });

      expect(dabApply.applyConfigToServer).toHaveBeenCalledWith(
        '/fake/path/dab-config.json',
        expect.any(String),
        true,
        true,
        'Bearer token',
        undefined,
        expect.any(String),
        { retryTransientErrors: true, retryOptions: undefined }
      );
      expect(dabConfigGenerator.generateDabConfig).toHaveBeenCalledOnce();
    });
  });
});
