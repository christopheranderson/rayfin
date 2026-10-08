import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { join } from 'path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { clearAuthState, loadAuthState, saveAuthState } from '../state.js';

// Mock fs/promises
vi.mock('fs/promises');

// Mock constants to use a temp directory
vi.mock('../constants.js', () => ({
  RAYFIN_CONFIG_DIR: '/tmp/.rayfin-test',
  AUTH_STATE_FILE: 'auth.json',
  TOKEN_CACHE_FILE: 'cache.bin',
}));

describe('auth/state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loadAuthState', () => {
    it('should return parsed state when auth.json exists', async () => {
      const mockState = {
        identityType: 'user',
        tenantId: 'test-tenant',
        userPrincipalName: 'user@example.com',
      };

      vi.mocked(readFile).mockResolvedValue(JSON.stringify(mockState));

      const result = await loadAuthState();

      expect(result).toEqual(mockState);
      expect(readFile).toHaveBeenCalledWith(
        join('/tmp/.rayfin-test', 'auth.json'),
        'utf8'
      );
    });

    it('should return null when auth.json does not exist', async () => {
      vi.mocked(readFile).mockRejectedValue(new Error('ENOENT: no such file'));

      const result = await loadAuthState();

      expect(result).toBeNull();
    });

    it('should return null when auth.json contains invalid JSON', async () => {
      vi.mocked(readFile).mockResolvedValue('not valid json');

      const result = await loadAuthState();

      expect(result).toBeNull();
    });
  });

  describe('saveAuthState', () => {
    it('should write state to auth.json', async () => {
      vi.mocked(mkdir).mockResolvedValue(undefined);
      vi.mocked(writeFile).mockResolvedValue();

      const state = {
        identityType: 'user' as const,
        tenantId: 'test-tenant',
        userPrincipalName: 'user@example.com',
      };

      await saveAuthState(state);

      expect(mkdir).toHaveBeenCalledWith('/tmp/.rayfin-test', {
        recursive: true,
        mode: 0o700,
      });
      expect(writeFile).toHaveBeenCalledWith(
        join('/tmp/.rayfin-test', 'auth.json'),
        JSON.stringify(state, null, 2),
        { encoding: 'utf8', mode: 0o600 }
      );
    });
  });

  describe('clearAuthState', () => {
    it('should delete auth.json and cache.bin', async () => {
      vi.mocked(unlink).mockResolvedValue();

      await clearAuthState();

      expect(unlink).toHaveBeenCalledTimes(2);
      expect(unlink).toHaveBeenCalledWith(
        join('/tmp/.rayfin-test', 'auth.json')
      );
      expect(unlink).toHaveBeenCalledWith(
        join('/tmp/.rayfin-test', 'cache.bin')
      );
    });

    it('should not throw when files do not exist', async () => {
      vi.mocked(unlink).mockRejectedValue(new Error('ENOENT'));

      await expect(clearAuthState()).resolves.not.toThrow();
    });
  });
});
