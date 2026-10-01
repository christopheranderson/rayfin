import { PublicClientApplication, ResponseMode } from '@azure/msal-node';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { RayfinAuth } from '../rayfin-auth.js';

// Mock the cache module
vi.mock('../cache.js', () => ({
  createCachePlugin: vi.fn().mockResolvedValue({
    beforeCacheAccess: vi.fn(),
    afterCacheAccess: vi.fn(),
  }),
}));

// Mock the state module
vi.mock('../state.js', () => ({
  loadAuthState: vi.fn().mockResolvedValue(null),
  saveAuthState: vi.fn().mockResolvedValue(undefined),
  clearAuthState: vi.fn().mockResolvedValue(undefined),
}));

// Mock @azure/msal-node
const mockGetAllAccounts = vi.fn().mockResolvedValue([]);
const mockRemoveAccount = vi.fn().mockResolvedValue(undefined);
const mockAcquireTokenSilent = vi.fn();
const mockAcquireTokenInteractive = vi.fn();
const mockAcquireTokenByDeviceCode = vi.fn();

vi.mock('@azure/msal-node', () => ({
  PublicClientApplication: vi.fn().mockImplementation(() => ({
    getTokenCache: () => ({
      getAllAccounts: mockGetAllAccounts,
      removeAccount: mockRemoveAccount,
    }),
    acquireTokenSilent: mockAcquireTokenSilent,
    acquireTokenInteractive: mockAcquireTokenInteractive,
    acquireTokenByDeviceCode: mockAcquireTokenByDeviceCode,
  })),
  LogLevel: {
    Error: 0,
    Warning: 1,
    Info: 2,
    Verbose: 3,
    Trace: 4,
  },
  ResponseMode: {
    QUERY: 'query',
    FRAGMENT: 'fragment',
    FORM_POST: 'form_post',
  },
}));

describe('RayfinAuth', () => {
  let auth: RayfinAuth;
  let savedAuthorityHost: string | undefined;

  beforeEach(() => {
    savedAuthorityHost = process.env['RAYFIN_AUTHORITY_HOST'];
    delete process.env['RAYFIN_AUTHORITY_HOST'];
    vi.clearAllMocks();
    auth = new RayfinAuth();
  });

  afterEach(() => {
    if (savedAuthorityHost === undefined) {
      delete process.env['RAYFIN_AUTHORITY_HOST'];
    } else {
      process.env['RAYFIN_AUTHORITY_HOST'] = savedAuthorityHost;
    }
  });

  describe('isLoggedIn', () => {
    it('should return false when no cached accounts', async () => {
      mockGetAllAccounts.mockResolvedValue([]);

      const result = await auth.isLoggedIn();

      expect(result).toBe(false);
    });

    it('should return true when a cached account exists', async () => {
      mockGetAllAccounts.mockResolvedValue([
        { username: 'user@example.com', tenantId: 'tenant-123' },
      ]);

      const result = await auth.isLoggedIn();

      expect(result).toBe(true);
    });
  });

  describe('getAccount', () => {
    it('should return null when no accounts cached', async () => {
      mockGetAllAccounts.mockResolvedValue([]);

      const account = await auth.getAccount();

      expect(account).toBeNull();
    });

    it('should return first cached account when no persisted state', async () => {
      const mockAccount = {
        username: 'user@example.com',
        tenantId: 'tenant-123',
      };
      mockGetAllAccounts.mockResolvedValue([mockAccount]);

      const account = await auth.getAccount();

      expect(account).toEqual(mockAccount);
    });

    it('should prefer the account matching persisted state over accounts[0]', async () => {
      const oldAccount = {
        username: 'old@example.com',
        tenantId: 'tenant-old',
      };
      const activeAccount = {
        username: 'active@example.com',
        tenantId: 'tenant-active',
      };
      // MSAL cache returns old account first
      mockGetAllAccounts.mockResolvedValue([oldAccount, activeAccount]);

      // Persisted state says active user is "active@example.com"
      const { loadAuthState } = await import('../state.js');
      vi.mocked(loadAuthState).mockResolvedValue({
        identityType: 'user',
        tenantId: 'tenant-active',
        userPrincipalName: 'active@example.com',
      });

      const account = await auth.getAccount();

      expect(account).toEqual(activeAccount);
    });
  });

  describe('acquireToken', () => {
    it('should try silent acquisition when cached account exists', async () => {
      const mockAccount = {
        username: 'user@example.com',
        tenantId: 'tenant-123',
      };
      mockGetAllAccounts.mockResolvedValue([mockAccount]);

      const mockResult = {
        accessToken: 'test-token',
        expiresOn: new Date('2026-03-01T00:00:00Z'),
        idTokenClaims: {
          preferred_username: 'user@example.com',
          tid: 'tenant-123',
        },
        account: mockAccount,
      };
      mockAcquireTokenSilent.mockResolvedValue(mockResult);

      const result = await auth.acquireToken();

      expect(result.token).toBe('test-token');
      expect(result.expiresOnTimestamp).toBe(
        new Date('2026-03-01T00:00:00Z').getTime()
      );
      expect(mockAcquireTokenSilent).toHaveBeenCalledWith({
        account: mockAccount,
        scopes: ['https://api.fabric.microsoft.com/.default'],
      });
    });

    it('should fall back to interactive when silent fails', async () => {
      const mockAccount = {
        username: 'user@example.com',
        tenantId: 'tenant-123',
      };
      mockGetAllAccounts.mockResolvedValue([mockAccount]);
      mockAcquireTokenSilent.mockRejectedValue(new Error('Token expired'));

      const mockResult = {
        accessToken: 'interactive-token',
        expiresOn: new Date('2026-03-01T00:00:00Z'),
        idTokenClaims: {
          preferred_username: 'user@example.com',
          tid: 'tenant-123',
          name: 'Test User',
        },
        account: mockAccount,
        tenantId: 'tenant-123',
      };
      mockAcquireTokenInteractive.mockResolvedValue(mockResult);

      const result = await auth.acquireToken();

      expect(result.token).toBe('interactive-token');
    });

    it('should use interactive when no cached account', async () => {
      mockGetAllAccounts.mockResolvedValue([]);

      const mockResult = {
        accessToken: 'new-token',
        expiresOn: new Date('2026-03-01T00:00:00Z'),
        idTokenClaims: {
          preferred_username: 'newuser@example.com',
          tid: 'tenant-new',
          name: 'New User',
        },
        account: { username: 'newuser@example.com', tenantId: 'tenant-new' },
        tenantId: 'tenant-new',
      };
      mockAcquireTokenInteractive.mockResolvedValue(mockResult);

      const result = await auth.acquireToken();

      expect(result.token).toBe('new-token');
      expect(mockAcquireTokenSilent).not.toHaveBeenCalled();
      expect(mockAcquireTokenInteractive).toHaveBeenCalledWith(
        expect.objectContaining({
          scopes: ['https://api.fabric.microsoft.com/.default'],
          responseMode: ResponseMode.FORM_POST,
        })
      );
    });

    it('should throw when token acquisition returns no access token', async () => {
      mockGetAllAccounts.mockResolvedValue([]);

      const mockResult = {
        accessToken: '',
        expiresOn: null,
        idTokenClaims: {},
        account: null,
        tenantId: '',
      };
      mockAcquireTokenInteractive.mockResolvedValue(mockResult);

      await expect(auth.acquireToken()).rejects.toThrow(
        'Token acquisition succeeded but no access token returned'
      );
    });
  });

  describe('logout', () => {
    it('should remove all cached accounts and clear state', async () => {
      const accounts = [
        { username: 'user1@example.com' },
        { username: 'user2@example.com' },
      ];
      mockGetAllAccounts.mockResolvedValue(accounts);

      await auth.logout();

      expect(mockRemoveAccount).toHaveBeenCalledTimes(2);
    });

    it('should succeed even with no cached accounts', async () => {
      mockGetAllAccounts.mockResolvedValue([]);

      await expect(auth.logout()).resolves.not.toThrow();
    });
  });

  describe('constructor', () => {
    it('should use default authority when no tenant specified', () => {
      const defaultAuth = new RayfinAuth();
      expect(defaultAuth).toBeDefined();
    });

    it('should accept tenant-specific authority', () => {
      const tenantAuth = new RayfinAuth({ tenantId: 'my-tenant-id' });
      expect(tenantAuth).toBeDefined();
    });

    it('does not set knownAuthorities for the default public authority host', async () => {
      await auth.isLoggedIn();

      expect(PublicClientApplication).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: expect.not.objectContaining({
            knownAuthorities: expect.any(Array),
          }),
        })
      );
    });

    it('sets knownAuthorities to the bare host for non-default authority hosts', async () => {
      process.env['RAYFIN_AUTHORITY_HOST'] = 'https://login.example.invalid';
      const alternateAuth = new RayfinAuth();

      await alternateAuth.isLoggedIn();

      expect(PublicClientApplication).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: expect.objectContaining({
            authority: 'https://login.example.invalid/common',
            knownAuthorities: ['login.example.invalid'],
          }),
        })
      );
    });

    it('sets knownAuthorities to the bare host for tenant-specific non-default authority hosts', async () => {
      process.env['RAYFIN_AUTHORITY_HOST'] = 'https://login.example.invalid';
      const tenantAuth = new RayfinAuth({ tenantId: 'contoso' });

      await tenantAuth.isLoggedIn();

      expect(PublicClientApplication).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: expect.objectContaining({
            authority: 'https://login.example.invalid/contoso',
            knownAuthorities: ['login.example.invalid'],
          }),
        })
      );
    });
  });
});
