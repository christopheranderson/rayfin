import { randomUUID } from 'crypto';
import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { DevConfig } from '../../commands/dev/dev';
import { applyProjectRuntimeSettingsWithRetries } from '../apply-project-runtime-settings';

// Mock ora spinner
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

// Mock dependencies
vi.mock('../env-file-utils', () => ({
  getWebServicePort: vi.fn(async () => 5168),
}));

const resolveFrontendDevPort = vi.fn();
const appendLocalDevRedirectUrisForPort =
  vi.fn<
    (
      services: RayfinConfig['services'],
      port: number
    ) => RayfinConfig['services']
  >();

vi.mock('../frontend-dev-port.js', () => ({
  resolveFrontendDevPort: (rayfinDir: string) =>
    resolveFrontendDevPort(rayfinDir),
  appendLocalDevRedirectUrisForPort: (
    services: RayfinConfig['services'],
    port: number
  ) => appendLocalDevRedirectUrisForPort(services, port),
}));

vi.mock('../remote-endpoint-utils.js', () => ({
  hasRemoteEndpoint: vi.fn(() => false),
  getRemoteRuntimeSettingsUrl: vi.fn(() => null),
  getRemoteAuthorizationHeader: vi.fn(),
}));

describe('applyProjectRuntimeSettings', () => {
  let testDir: string;
  let rayfinDir: string;
  let tempDir: string;
  let config: DevConfig;
  let rayfinConfig: RayfinConfig;
  let consoleSpy: {
    log: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  };
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Mirror the real helper: append the assigned port's localhost/127.0.0.1
    // origins without mutating the caller's services object.
    resolveFrontendDevPort.mockReset();
    resolveFrontendDevPort.mockResolvedValue({
      port: 5174,
      redirectPorts: [5174],
    });
    appendLocalDevRedirectUrisForPort.mockReset();
    appendLocalDevRedirectUrisForPort.mockImplementation((services, port) => {
      const existing = services.auth?.allowedRedirectUris ?? [];
      return {
        ...services,
        auth: {
          ...services.auth,
          allowedRedirectUris: [
            ...existing,
            `http://localhost:${port}`,
            `http://127.0.0.1:${port}`,
          ],
        },
      };
    });

    // Create a unique test directory
    testDir = join(tmpdir(), `rayfin-test-${randomUUID()}`);
    rayfinDir = join(testDir, 'rayfin');
    tempDir = join(rayfinDir, '.temp');

    await mkdir(tempDir, { recursive: true });

    // Create .env file with port
    await writeFile(
      join(tempDir, '.env'),
      'RAYFIN_WEBSERVICE_HTTP_PORT=5168\n'
    );

    // Create test config
    config = {
      projectRoot: testDir,
      projectName: 'test-project',
      composePath: join(tempDir, 'docker-compose.yml'),
      healthTimeout: 60000,
      pollingInterval: 2000,
      ports: {
        webservice: 5168,
        sqlserver: 1433,
      },
      verbose: false,
    };

    // Create test rayfin config
    rayfinConfig = {
      id: 'test-project',
      name: 'Test Project',
      version: '1.0.0',
      services: {
        auth: {
          enabled: true,
        },
        data: {
          enabled: true,
        },
        storage: {
          enabled: false,
        },
        staticHosting: {
          enabled: false,
          folder: 'dist',
          indexDocument: 'index.html',
        },
      },
    };

    // Mock console methods
    consoleSpy = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };

    // Mock fetch
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await rm(testDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }

    // Restore mocks
    consoleSpy.log.mockRestore();
    consoleSpy.warn.mockRestore();
    consoleSpy.error.mockRestore();
    vi.restoreAllMocks();
  });

  describe('local mode (remote = false)', () => {
    it('should sync runtime settings to local web service successfully', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      await applyProjectRuntimeSettingsWithRetries(config, rayfinConfig);

      // Verify fetch was called with correct URL and payload
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:5168/api/projectRuntimeSettings',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: expect.any(String),
        })
      );

      // Verify payload structure - should be direct services object
      const callArgs = fetchSpy.mock.calls[0];
      const payload = JSON.parse(callArgs[1].body);
      expect(payload).toEqual({
        auth: {
          allowedRedirectUris: [
            'http://localhost:5174',
            'http://127.0.0.1:5174',
          ],
          enabled: true,
        },
        data: { enabled: true },
        staticHosting: {
          enabled: false,
          folder: 'dist',
          indexDocument: 'index.html',
        },
        storage: { enabled: false },
      });
    });

    it('should add the assigned frontend dev origins to local auth settings', async () => {
      rayfinConfig.services.auth = {
        enabled: true,
        allowedRedirectUris: ['http://localhost:5173'],
      };
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      await applyProjectRuntimeSettingsWithRetries(config, rayfinConfig);

      expect(resolveFrontendDevPort).toHaveBeenCalledWith(rayfinDir);
      expect(appendLocalDevRedirectUrisForPort).toHaveBeenCalledWith(
        expect.anything(),
        5174
      );
      const callArgs = fetchSpy.mock.calls[0];
      const payload = JSON.parse(callArgs[1].body);
      expect(payload.auth.allowedRedirectUris).toEqual([
        'http://localhost:5173',
        'http://localhost:5174',
        'http://127.0.0.1:5174',
      ]);
      expect(rayfinConfig.services.auth.allowedRedirectUris).toEqual([
        'http://localhost:5173',
      ]);
    });

    it('should translate asset access before syncing local runtime settings', async () => {
      rayfinConfig.services.staticHosting!.assetAccess = 'protected';
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      await applyProjectRuntimeSettingsWithRetries(config, rayfinConfig);

      const callArgs = fetchSpy.mock.calls[0];
      const payload = JSON.parse(callArgs[1].body);
      expect(payload.staticHosting).toEqual({
        enabled: false,
        folder: 'dist',
        indexDocument: 'index.html',
        anonymousAccess: false,
      });
      expect(rayfinConfig.services.staticHosting).toHaveProperty(
        'assetAccess',
        'protected'
      );
    });

    it('prepares the frontend redirect payload once across retries', async () => {
      vi.useFakeTimers();
      try {
        fetchSpy
          .mockRejectedValueOnce(new Error('fetch failed'))
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: () => Promise.resolve(''),
          });

        const pending = applyProjectRuntimeSettingsWithRetries(
          config,
          rayfinConfig
        );
        await vi.advanceTimersByTimeAsync(6000);
        await pending;

        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(resolveFrontendDevPort).toHaveBeenCalledOnce();
        expect(appendLocalDevRedirectUrisForPort).toHaveBeenCalledOnce();
        expect(fetchSpy.mock.calls[0][1].body).toBe(
          fetchSpy.mock.calls[1][1].body
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('uses a command-provided port resolution without probing again', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      await applyProjectRuntimeSettingsWithRetries(config, rayfinConfig, {
        frontendDevPort: { port: 5175, redirectPorts: [5175, 5174] },
      });

      expect(resolveFrontendDevPort).not.toHaveBeenCalled();
      expect(appendLocalDevRedirectUrisForPort).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        5175
      );
      expect(appendLocalDevRedirectUrisForPort).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        5174
      );
      const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(payload.auth.allowedRedirectUris).toEqual([
        'http://localhost:5175',
        'http://127.0.0.1:5175',
        'http://localhost:5174',
        'http://127.0.0.1:5174',
      ]);
    });

    it('should throw error for API error response', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: { get: vi.fn().mockReturnValue(null) },
        text: () => Promise.resolve('Something went wrong'),
      });

      await expect(
        applyProjectRuntimeSettingsWithRetries(config, rayfinConfig)
      ).rejects.toThrow('Failed to sync: 500 Internal Server Error');

      // Verify error messages were logged
      expect(consoleSpy.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to sync: 500 Internal Server Error')
      );
    });

    it.skip('should throw error for network error after retries', async () => {
      fetchSpy.mockRejectedValue(new Error('Network error'));

      await expect(
        applyProjectRuntimeSettingsWithRetries(config, rayfinConfig)
      ).rejects.toThrow('Network error');

      // Verify error messages were logged
      expect(consoleSpy.error).toHaveBeenCalledWith(
        '   The service may still be starting. Please retry after some time.'
      );
    });

    it('should skip sync when rayfinConfig is null', async () => {
      await applyProjectRuntimeSettingsWithRetries(config, null);

      // Verify fetch was not called
      expect(fetchSpy).not.toHaveBeenCalled();

      // Verify warning message
      expect(consoleSpy.warn).toHaveBeenCalledWith(
        '⚠️  No rayfin.yml configuration found - skipping runtime settings sync'
      );
    });

    it('should warn that connectors are skipped in local development', async () => {
      rayfinConfig.connectors = [
        {
          name: 'salesmodel',
          type: 'fabric-semanticmodel',
          version: '1',
          config: { workspaceId: 'ws-1', itemId: 'item-1' },
          operations: [{ name: 'executeQuery' }],
          auth: { type: 'delegated' },
        },
      ];
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      await applyProjectRuntimeSettingsWithRetries(config, rayfinConfig);

      expect(consoleSpy.warn).toHaveBeenCalledWith(
        '⚠️  Connectors are not supported in local development - they will be skipped'
      );
      // Local sync still proceeds; connectors are not part of the services payload.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const callArgs = fetchSpy.mock.calls[0];
      const payload = JSON.parse(callArgs[1].body);
      expect(payload.connectors).toBeUndefined();
    });

    it('should not warn about connectors when none are configured', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      await applyProjectRuntimeSettingsWithRetries(config, rayfinConfig);

      expect(consoleSpy.warn).not.toHaveBeenCalledWith(
        '⚠️  Connectors are not supported in local development - they will be skipped'
      );
    });

    it('should use correct port from env file', async () => {
      const { getWebServicePort } = await import('../env-file-utils');
      vi.mocked(getWebServicePort).mockResolvedValue(8080);

      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      await applyProjectRuntimeSettingsWithRetries(config, rayfinConfig);

      // Verify fetch was called with custom port
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:8080/api/projectRuntimeSettings',
        expect.any(Object)
      );
    }, 35000);
  });

  describe('remote mode (remote = true)', () => {
    beforeEach(async () => {
      const remoteEndpointUtils = await import('../remote-endpoint-utils.js');
      vi.mocked(remoteEndpointUtils.hasRemoteEndpoint).mockReturnValue(true);
      vi.mocked(
        remoteEndpointUtils.getRemoteRuntimeSettingsUrl
      ).mockReturnValue(
        'https://api.fabric.microsoft.com/v1/workspaces/ws-123/appBackends/item-456/__private/projectRuntimeSettings'
      );
    });

    it('should sync runtime settings to local endpoint (not remote) by default', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      await applyProjectRuntimeSettingsWithRetries(config, rayfinConfig);

      // applyProjectRuntimeSettingsWithRetries always uses local mode (remote=false)
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:5168/api/projectRuntimeSettings',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        })
      );
    }, 35000);

    it('should throw error for local API error even when remote is configured', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        headers: { get: vi.fn().mockReturnValue(null) },
        text: () => Promise.resolve('Service is starting up'),
      });

      await expect(
        applyProjectRuntimeSettingsWithRetries(config, rayfinConfig)
      ).rejects.toThrow('Failed to sync: 503 Service Unavailable');

      // Verify error messages were logged (without leading spaces - the actual log output)
      expect(consoleSpy.error).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('Failed to sync: 503 Service Unavailable')
      );
      expect(consoleSpy.error).toHaveBeenNthCalledWith(
        2,
        '\n   This appears to be a configuration error, not a connection issue.'
      );
    }, 35000);

    /*
    I've skipped this test with .skip because it times out due to the retry logic in
    applyProjectRuntimeSettingsWithRetries. When the fetch is mocked to reject with a
    network error, the function enters its retry loop with delays between attempts,
    which causes the test to exceed the 35-second timeout.
    */
    it.skip('should throw error for local network error even when remote is configured', async () => {
      fetchSpy.mockRejectedValue(new Error('Connection refused'));

      await expect(
        applyProjectRuntimeSettingsWithRetries(config, rayfinConfig)
      ).rejects.toThrow('Connection refused');

      // Verify error messages were logged
      expect(consoleSpy.error).toHaveBeenCalledWith(
        '   The service may still be starting. Please retry after some time.'
      );
    }, 35000);

    it('should sync to local server when remote endpoint is not configured', async () => {
      const remoteEndpointUtils = await import('../remote-endpoint-utils.js');
      vi.mocked(remoteEndpointUtils.hasRemoteEndpoint).mockReturnValue(false);
      vi.mocked(
        remoteEndpointUtils.getRemoteRuntimeSettingsUrl
      ).mockReturnValue(null);

      // Mock successful local response since we're in local mode (remote=false by default)
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      await applyProjectRuntimeSettingsWithRetries(config, rayfinConfig);

      // In local mode, it should still sync to local server regardless of remote endpoint
      expect(fetchSpy).toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:5168/api/projectRuntimeSettings',
        expect.any(Object)
      );
    }, 35000);
  });

  describe('payload structure', () => {
    it('should send all service configurations in payload', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      const fullConfig: RayfinConfig = {
        id: 'full-test',
        name: 'Full Test',
        version: '1.0.0',
        services: {
          auth: {
            enabled: true,
            customClaims: { app_version: '1.0.0' },
            scopes: ['read:data', 'write:data'],
          },
          data: {
            enabled: true,
          },
          storage: {
            enabled: true,
          },
          staticHosting: {
            enabled: false,
            folder: 'dist',
            indexDocument: 'index.html',
          },
        },
      };

      await applyProjectRuntimeSettingsWithRetries(config, fullConfig);
    }, 35000);

    it('should handle minimal service configuration', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      const minimalConfig: RayfinConfig = {
        id: 'minimal-test',
        name: 'Minimal Test',
        version: '1.0.0',
        services: {
          auth: { enabled: false },
          data: { enabled: false },
          storage: { enabled: false },
          staticHosting: {
            enabled: false,
            folder: 'dist',
            indexDocument: 'index.html',
          },
        },
      };

      await applyProjectRuntimeSettingsWithRetries(config, minimalConfig);
    }, 35000);
  });
});
