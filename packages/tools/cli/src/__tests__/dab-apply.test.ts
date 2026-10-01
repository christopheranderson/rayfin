import { existsSync, readFileSync } from 'fs';

import { InvocationContext } from '@microsoft/rayfin-tools-common/_internal/telemetry';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { setCurrentContext } from '../telemetry/context-store.js';
import { applyConfigToServer } from '../utils/dab-apply';

// Mock fs functions
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Mock output-mode to use console.log/error directly (tests spy on console)
vi.mock('../utils/output-mode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/output-mode')>();
  return {
    ...actual,
    modeLog: (_mode: unknown, ...args: unknown[]) => console.log(...args),
    modeError: (_mode: unknown, ...args: unknown[]) => console.error(...args),
    resolveOutputMode: () => 'interactive',
  };
});

// Mock fetch globally
global.fetch = vi.fn();

describe('dab-apply utility', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  afterEach(() => {
    setCurrentContext(undefined);
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('applyConfigToServer', () => {
    const mockConfigPath = '/path/to/dab-config.json';
    const mockConfigContent = '{"test": "config"}';

    it('should throw error if config file does not exist', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      await expect(applyConfigToServer(mockConfigPath)).rejects.toThrow(
        'DAB configuration file not found: /path/to/dab-config.json'
      );
    });

    it('should throw error if config file contains invalid JSON', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('invalid json {');

      await expect(applyConfigToServer(mockConfigPath)).rejects.toThrow(
        'Invalid JSON in configuration file:'
      );
    });

    it('should successfully apply configuration to DAB server', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(mockConfigContent);

      const mockResponse = {
        ok: true,
        text: vi.fn().mockResolvedValue('Success'),
      };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      await applyConfigToServer(mockConfigPath);

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:5168/api/applyconfig',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ConfigData: mockConfigContent,
            Force: false,
          }),
        }
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        '✅ Configuration applied successfully!'
      );
    });

    it('should send force parameter when force is true', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(mockConfigContent);

      const mockResponse = {
        ok: true,
        text: vi.fn().mockResolvedValue('Success'),
      };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      await applyConfigToServer(mockConfigPath, undefined, true);

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:5168/api/applyconfig',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ConfigData: mockConfigContent,
            Force: true,
          }),
        }
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        '⚠️  Using force mode - DAB will accept configuration that may result in data loss'
      );
    });

    it('should handle server error responses', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(mockConfigContent);

      const mockResponse = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: { get: vi.fn().mockReturnValue(null) },
        text: vi.fn().mockResolvedValue('Server error details'),
      };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      await expect(applyConfigToServer(mockConfigPath)).rejects.toThrow(
        'DAB server responded with error: 500 Internal Server Error'
      );
    });

    it('retries a transient response without rereading the generated config', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(mockConfigContent);
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          headers: { get: vi.fn().mockReturnValue(null) },
          text: vi.fn().mockResolvedValue('try again'),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { get: vi.fn().mockReturnValue(null) },
          text: vi.fn().mockResolvedValue('Success'),
        } as unknown as Response);

      await applyConfigToServer(
        mockConfigPath,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          retryTransientErrors: true,
          retryOptions: { maxAttempts: 2, baseDelay: 0 },
        }
      );

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(readFileSync).toHaveBeenCalledTimes(1);
    });

    it('should handle connection refused errors', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(mockConfigContent);

      const connectionError = new Error('fetch failed');
      connectionError.message = 'ECONNREFUSED';
      vi.mocked(fetch).mockRejectedValue(connectionError);

      await expect(applyConfigToServer(mockConfigPath)).rejects.toThrow(
        'Cannot connect to Rayfin server at http://localhost:5168/api/applyconfig'
      );
    });

    it('should handle other fetch errors', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(mockConfigContent);

      const fetchError = new Error('Network error');
      vi.mocked(fetch).mockRejectedValue(fetchError);

      await expect(applyConfigToServer(mockConfigPath)).rejects.toThrow(
        'Network error'
      );
    });

    it('should log server response when available', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(mockConfigContent);

      const mockResponse = {
        ok: true,
        text: vi.fn().mockResolvedValue('Configuration applied successfully'),
      };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      await applyConfigToServer(mockConfigPath);

      expect(consoleSpy).toHaveBeenCalledWith(
        '📝 Server response: Configuration applied successfully'
      );
    });

    it('records response activity when a remote endpoint has no authorization header', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(mockConfigContent);
      vi.mocked(fetch).mockResolvedValue(
        new Response('Success', {
          status: 200,
          headers: { 'x-ms-root-activity-id': 'dab-activity-1' },
        })
      );
      const context = new InvocationContext('rayfin-cli', '1.0.0');
      setCurrentContext(context);

      await applyConfigToServer(
        mockConfigPath,
        'https://fabric.example/__private/applyconfig',
        false,
        true
      );

      expect(
        context.finalize({
          osType: 'linux',
          osVersion: 'test',
          nodeVersion: 'test',
        }).properties?.fabric_activity_ids
      ).toBe('["dab-activity-1"]');
    });
  });
});
