import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────

const mockAcquireToken = vi.fn();
const mockIsLoggedIn = vi.fn();

vi.mock('../auth/rayfin-auth.js', () => ({
  RayfinAuth: vi.fn().mockImplementation(() => ({
    acquireToken: mockAcquireToken,
    isLoggedIn: mockIsLoggedIn,
  })),
}));

vi.mock('../auth/state.js', () => ({
  loadAuthState: vi.fn(),
}));

vi.mock('../utils/ambient-env.js', () => ({
  hasAmbientToken: vi.fn().mockReturnValue(false),
  getAmbientToken: vi.fn().mockReturnValue(null),
  getAmbientTenantId: vi.fn().mockReturnValue(null),
}));

vi.mock('../auth/cache.js', () => ({
  createCachePlugin: vi.fn().mockResolvedValue({}),
}));

// ── Tests ─────────────────────────────────────────────────────────────

describe('getAuth — service principal paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the singleton between tests by re-importing
    vi.resetModules();
  });

  it('should bypass singleton when clientSecret is supplied in options', async () => {
    const { RayfinAuth } = await import('../auth/rayfin-auth.js');
    const { loadAuthState } = await import('../auth/state.js');
    vi.mocked(loadAuthState).mockResolvedValue(null);

    // Use a fresh import to get the singleton-reset module
    const { getAuthenticatedToken } = await import('../auth/index.js');

    mockAcquireToken.mockResolvedValue({
      token: 'sp-token-1',
      expiresOnTimestamp: Date.now() + 3600_000,
    });

    const result = await getAuthenticatedToken(undefined, {
      clientId: 'sp-id',
      clientSecret: 'sp-secret',
      tenantId: 'tenant-1',
    });

    expect(result.token).toBe('sp-token-1');
    expect(RayfinAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'sp-id',
        clientSecret: 'sp-secret',
        tenantId: 'tenant-1',
      })
    );
  });

  it('should restore SP session from persisted auth state', async () => {
    const { RayfinAuth } = await import('../auth/rayfin-auth.js');
    const { loadAuthState } = await import('../auth/state.js');

    vi.mocked(loadAuthState).mockResolvedValue({
      identityType: 'service_principal',
      tenantId: 'persisted-tenant',
      clientId: 'persisted-client-id',
      clientSecret: 'persisted-secret',
    });

    mockAcquireToken.mockResolvedValue({
      token: 'restored-sp-token',
      expiresOnTimestamp: Date.now() + 3600_000,
    });

    const { getAuthenticatedToken } = await import('../auth/index.js');
    const result = await getAuthenticatedToken();

    expect(result.token).toBe('restored-sp-token');
    expect(RayfinAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'persisted-tenant',
        clientId: 'persisted-client-id',
        clientSecret: 'persisted-secret',
      })
    );
  });

  it('should prefer explicit options.tenantId over persisted SP tenantId', async () => {
    const { RayfinAuth } = await import('../auth/rayfin-auth.js');
    const { loadAuthState } = await import('../auth/state.js');

    vi.mocked(loadAuthState).mockResolvedValue({
      identityType: 'service_principal',
      tenantId: 'persisted-tenant',
      clientId: 'persisted-client-id',
      clientSecret: 'persisted-secret',
    });

    mockAcquireToken.mockResolvedValue({
      token: 'token',
      expiresOnTimestamp: Date.now() + 3600_000,
    });

    const { getAuthenticatedToken } = await import('../auth/index.js');
    await getAuthenticatedToken(undefined, { tenantId: 'override-tenant' });

    // The explicit tenantId should win because the SP path in getAuth
    // uses `options?.tenantId ?? state.tenantId`
    // But since clientSecret is NOT in options here, it goes through the
    // singleton path which reads persisted state
    expect(RayfinAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'override-tenant',
      })
    );
  });

  it('should not restore SP session when state is missing clientSecret', async () => {
    const { RayfinAuth } = await import('../auth/rayfin-auth.js');
    const { loadAuthState } = await import('../auth/state.js');

    vi.mocked(loadAuthState).mockResolvedValue({
      identityType: 'service_principal',
      tenantId: 'tenant-1',
      clientId: 'client-1',
      // clientSecret is missing — should fall through to default path
    });

    mockAcquireToken.mockResolvedValue({
      token: 'user-token',
      expiresOnTimestamp: Date.now() + 3600_000,
    });

    const { getAuthenticatedToken } = await import('../auth/index.js');
    await getAuthenticatedToken();

    // Should NOT pass clientSecret since it was missing from state
    expect(RayfinAuth).toHaveBeenCalledWith(
      expect.not.objectContaining({
        clientSecret: expect.anything(),
      })
    );
  });

  it('should fall back to persisted tenantId for user sessions', async () => {
    const { RayfinAuth } = await import('../auth/rayfin-auth.js');
    const { loadAuthState } = await import('../auth/state.js');

    vi.mocked(loadAuthState).mockResolvedValue({
      identityType: 'user',
      tenantId: 'user-tenant',
      userPrincipalName: 'user@example.com',
    });

    mockAcquireToken.mockResolvedValue({
      token: 'user-token',
      expiresOnTimestamp: Date.now() + 3600_000,
    });

    const { getAuthenticatedToken } = await import('../auth/index.js');
    await getAuthenticatedToken();

    expect(RayfinAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'user-tenant',
      })
    );
  });
});

describe('ensureAuthenticated — service principal', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const ambientEnv = await import('../utils/ambient-env.js');
    vi.mocked(ambientEnv.hasAmbientToken).mockReturnValue(false);
    vi.mocked(ambientEnv.getAmbientToken).mockReturnValue(null);
  });

  it('should not trigger interactive login for service principal', async () => {
    const { loadAuthState } = await import('../auth/state.js');

    vi.mocked(loadAuthState).mockResolvedValue({
      identityType: 'service_principal',
      tenantId: 'tenant-1',
      clientId: 'client-1',
      clientSecret: 'secret-1',
    });

    mockIsLoggedIn.mockResolvedValue(true);
    mockAcquireToken.mockResolvedValue({
      token: 'sp-token',
      expiresOnTimestamp: Date.now() + 3600_000,
    });

    const { ensureAuthenticated } = await import('../auth/index.js');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await ensureAuthenticated();

    expect(result.token).toBe('sp-token');
    // Should NOT print the interactive login message
    const loginMessages = consoleSpy.mock.calls
      .flat()
      .filter((msg) => String(msg).includes('launching login'));
    expect(loginMessages).toHaveLength(0);

    consoleSpy.mockRestore();
  });

  it('suppresses the ambient token diagnostic when silent', async () => {
    const ambientEnv = await import('../utils/ambient-env.js');
    vi.mocked(ambientEnv.hasAmbientToken).mockReturnValue(true);
    vi.mocked(ambientEnv.getAmbientToken).mockReturnValue('ambient-token');
    const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { ensureAuthenticated } = await import('../auth/index.js');

    const result = await ensureAuthenticated(undefined, { silent: true });

    expect(result.token).toBe('ambient-token');
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('suppresses the login diagnostic when silent', async () => {
    const { loadAuthState } = await import('../auth/state.js');
    vi.mocked(loadAuthState).mockResolvedValue(null);
    mockIsLoggedIn.mockResolvedValue(false);
    mockAcquireToken.mockResolvedValue({
      token: 'user-token',
      expiresOnTimestamp: Date.now() + 3600_000,
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { ensureAuthenticated } = await import('../auth/index.js');

    const result = await ensureAuthenticated(undefined, { silent: true });

    expect(result.token).toBe('user-token');
    expect(consoleSpy).not.toHaveBeenCalled();
    // Pins the actual fix mechanism: silentOnly reaching acquireToken.
    expect(mockAcquireToken).toHaveBeenCalledWith(undefined, {
      silentOnly: true,
    });
    consoleSpy.mockRestore();
  });
});
