import { describe, it, expect, vi, beforeEach } from 'vitest';

import { getCurrentUser, normalizeUsername } from '../user-utils.js';

vi.mock('../state.js');
vi.mock('../cache.js', () => ({
  createCachePlugin: vi.fn().mockResolvedValue({
    beforeCacheAccess: vi.fn(),
    afterCacheAccess: vi.fn(),
  }),
}));
vi.mock('../rayfin-auth.js');
vi.mock('../index.js');

describe('user-utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getCurrentUser', () => {
    it('should return user info from persisted auth state', async () => {
      const { loadAuthState } = await import('../state.js');
      vi.mocked(loadAuthState).mockResolvedValue({
        identityType: 'user',
        tenantId: 'tenant-abc',
        userPrincipalName: 'john.doe@contoso.com',
        userName: 'John Doe',
      });

      const result = await getCurrentUser();

      expect(result).toEqual({
        username: 'john.doe',
        email: 'john.doe@contoso.com',
        accountName: 'tenant-abc',
      });
    });

    it('should fall back to MSAL cached account when no auth state', async () => {
      const { loadAuthState } = await import('../state.js');
      vi.mocked(loadAuthState).mockResolvedValue(null);

      const { getRayfinAuth } = await import('../index.js');
      vi.mocked(getRayfinAuth).mockResolvedValue({
        getAccount: vi.fn().mockResolvedValue({
          username: 'jane.smith@contoso.com',
          tenantId: 'tenant-xyz',
        }),
      } as any);

      const result = await getCurrentUser();

      expect(result).toEqual({
        username: 'jane.smith',
        email: 'jane.smith@contoso.com',
        accountName: 'tenant-xyz',
      });
    });

    it('should throw error when not logged in', async () => {
      const { loadAuthState } = await import('../state.js');
      vi.mocked(loadAuthState).mockResolvedValue(null);

      const { getRayfinAuth } = await import('../index.js');
      vi.mocked(getRayfinAuth).mockResolvedValue({
        getAccount: vi.fn().mockResolvedValue(null),
      } as any);

      await expect(getCurrentUser()).rejects.toThrow(
        "Not logged in. Please run 'rayfin login' first."
      );
    });

    it('should handle auth state without tenant ID', async () => {
      const { loadAuthState } = await import('../state.js');
      vi.mocked(loadAuthState).mockResolvedValue({
        identityType: 'user',
        userPrincipalName: 'user@example.com',
      });

      const result = await getCurrentUser();

      expect(result).toEqual({
        username: 'user',
        email: 'user@example.com',
        accountName: '',
      });
    });
  });

  describe('normalizeUsername', () => {
    it('should normalize username correctly', () => {
      expect(normalizeUsername('John.Doe')).toBe('johndoe');
      expect(normalizeUsername('user@domain.com')).toBe('userdomaincom');
      expect(normalizeUsername('test-user_123')).toBe('testuser123');
      expect(normalizeUsername('UPPERCASE')).toBe('uppercase');
      expect(normalizeUsername('user with spaces')).toBe('userwithspaces');
      expect(normalizeUsername('special!@#$%^&*()chars')).toBe('specialchars');
    });

    it('should handle empty string', () => {
      expect(normalizeUsername('')).toBe('');
    });

    it('should handle numbers only', () => {
      expect(normalizeUsername('123456')).toBe('123456');
    });
  });
});
