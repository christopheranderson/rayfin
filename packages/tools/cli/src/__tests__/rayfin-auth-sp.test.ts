import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────

// Mock @azure/msal-node before importing RayfinAuth
const mockAcquireTokenByClientCredential = vi.fn();
const mockAcquireTokenSilent = vi.fn();
const mockAcquireTokenInteractive = vi.fn();
const mockGetAllAccounts = vi.fn().mockResolvedValue([]);
const mockRemoveAccount = vi.fn();

vi.mock('@azure/msal-node', () => ({
  ConfidentialClientApplication: vi.fn().mockImplementation(() => ({
    acquireTokenByClientCredential: mockAcquireTokenByClientCredential,
  })),
  PublicClientApplication: vi.fn().mockImplementation(() => ({
    acquireTokenSilent: mockAcquireTokenSilent,
    acquireTokenInteractive: mockAcquireTokenInteractive,
    getTokenCache: () => ({
      getAllAccounts: mockGetAllAccounts,
      removeAccount: mockRemoveAccount,
    }),
  })),
  LogLevel: { Warning: 2 },
}));

vi.mock('../auth/cache.js', () => ({
  createCachePlugin: vi.fn().mockResolvedValue({}),
}));

vi.mock('../auth/state.js', () => ({
  loadAuthState: vi.fn().mockResolvedValue(null),
  saveAuthState: vi.fn().mockResolvedValue(undefined),
  clearAuthState: vi.fn().mockResolvedValue(undefined),
}));

import { RayfinAuth } from '../auth/rayfin-auth';
import { clearAuthState } from '../auth/state';

// ── Tests ─────────────────────────────────────────────────────────────

describe('RayfinAuth — service principal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isServicePrincipal', () => {
    it('should return true when clientSecret is provided', () => {
      const auth = new RayfinAuth({
        clientId: 'sp-client-id',
        clientSecret: 'sp-secret',
        tenantId: 'tenant-123',
      });
      expect(auth.isServicePrincipal).toBe(true);
    });

    it('should return false when clientSecret is not provided', () => {
      const auth = new RayfinAuth({ tenantId: 'tenant-123' });
      expect(auth.isServicePrincipal).toBe(false);
    });

    it('should return false when only clientId is provided', () => {
      const auth = new RayfinAuth({ clientId: 'sp-client-id' });
      expect(auth.isServicePrincipal).toBe(false);
    });
  });

  describe('acquireToken', () => {
    it('should use client credentials flow for service principal', async () => {
      const expiresOn = new Date(Date.now() + 3600 * 1000);
      mockAcquireTokenByClientCredential.mockResolvedValue({
        accessToken: 'sp-access-token',
        expiresOn,
      });

      const auth = new RayfinAuth({
        clientId: 'sp-client-id',
        clientSecret: 'sp-secret',
        tenantId: 'tenant-123',
      });

      const result = await auth.acquireToken();

      expect(mockAcquireTokenByClientCredential).toHaveBeenCalledTimes(1);
      expect(result.token).toBe('sp-access-token');
      expect(result.expiresOnTimestamp).toBe(expiresOn.getTime());
      // Should NOT attempt interactive or silent flows
      expect(mockAcquireTokenSilent).not.toHaveBeenCalled();
      expect(mockAcquireTokenInteractive).not.toHaveBeenCalled();
    });

    it('should pass scopes to acquireTokenByClientCredential', async () => {
      mockAcquireTokenByClientCredential.mockResolvedValue({
        accessToken: 'token',
        expiresOn: new Date(),
      });

      const auth = new RayfinAuth({
        clientId: 'sp-client-id',
        clientSecret: 'sp-secret',
        tenantId: 'tenant-123',
      });

      const customScopes = ['https://api.fabric.microsoft.com/.default'];
      await auth.acquireToken(customScopes);

      expect(mockAcquireTokenByClientCredential).toHaveBeenCalledWith({
        scopes: customScopes,
      });
    });

    it('should throw when client credentials flow returns null', async () => {
      mockAcquireTokenByClientCredential.mockResolvedValue(null);

      const auth = new RayfinAuth({
        clientId: 'sp-client-id',
        clientSecret: 'sp-secret',
        tenantId: 'tenant-123',
      });

      await expect(auth.acquireToken()).rejects.toThrow(
        'Client credentials flow returned null'
      );
    });

    it('should throw when access token is missing from result', async () => {
      mockAcquireTokenByClientCredential.mockResolvedValue({
        accessToken: '',
        expiresOn: new Date(),
      });

      const auth = new RayfinAuth({
        clientId: 'sp-client-id',
        clientSecret: 'sp-secret',
        tenantId: 'tenant-123',
      });

      await expect(auth.acquireToken()).rejects.toThrow(
        'no access token returned'
      );
    });
  });

  describe('isLoggedIn', () => {
    it('should return true for service principal without checking cache', async () => {
      const auth = new RayfinAuth({
        clientId: 'sp-client-id',
        clientSecret: 'sp-secret',
        tenantId: 'tenant-123',
      });

      const loggedIn = await auth.isLoggedIn();

      expect(loggedIn).toBe(true);
      // Should NOT initialise a PCA or query the token cache
      expect(mockGetAllAccounts).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('should clear auth state without touching PCA cache', async () => {
      const auth = new RayfinAuth({
        clientId: 'sp-client-id',
        clientSecret: 'sp-secret',
        tenantId: 'tenant-123',
      });

      await auth.logout();

      expect(clearAuthState).toHaveBeenCalledTimes(1);
      // Should NOT attempt to enumerate or remove PCA accounts
      expect(mockGetAllAccounts).not.toHaveBeenCalled();
      expect(mockRemoveAccount).not.toHaveBeenCalled();
    });
  });

  describe('CCA caching', () => {
    it('should reuse the same CCA instance across multiple acquireToken calls', async () => {
      const { ConfidentialClientApplication } =
        await import('@azure/msal-node');

      mockAcquireTokenByClientCredential.mockResolvedValue({
        accessToken: 'token',
        expiresOn: new Date(),
      });

      const auth = new RayfinAuth({
        clientId: 'sp-client-id',
        clientSecret: 'sp-secret',
        tenantId: 'tenant-123',
      });

      await auth.acquireToken();
      await auth.acquireToken();

      // CCA constructor should only be called once (singleton per instance)
      expect(ConfidentialClientApplication).toHaveBeenCalledTimes(1);
    });
  });
});
