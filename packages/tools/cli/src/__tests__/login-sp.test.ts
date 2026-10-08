import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────
// Declared at module scope so vi.mock factories can reference them, but
// each test re-imports a fresh `loginCommand` via `vi.resetModules()` to
// avoid Commander retaining parsed option values across tests.

const mockAcquireToken = vi.fn();
const mockIsServicePrincipal = vi.fn().mockReturnValue(false);

vi.mock('../auth/rayfin-auth.js', () => ({
  RayfinAuth: vi.fn().mockImplementation(() => ({
    acquireToken: mockAcquireToken,
    get isServicePrincipal() {
      return mockIsServicePrincipal();
    },
  })),
}));

vi.mock('../auth/constants.js', () => ({
  getFabricScopes: vi
    .fn()
    .mockReturnValue(['https://api.fabric.microsoft.com/.default']),
}));

vi.mock('../auth/state.js', () => ({
  loadAuthState: vi.fn().mockResolvedValue(null),
  saveAuthState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/ambient-env.js', () => ({
  hasAmbientToken: vi.fn().mockReturnValue(false),
}));

// ── Tests ─────────────────────────────────────────────────────────────

describe('login command — service principal validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset modules so each test gets a fresh Commander instance
    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('should require --client-id for service principal', async () => {
    const { loginCommand } = await import('../commands/login');

    await expect(
      loginCommand.parseAsync(
        [
          'login',
          '--service-principal',
          '--client-secret',
          'secret',
          '--tenant',
          'tid',
        ],
        { from: 'user' }
      )
    ).rejects.toThrow('--client-id is required');
  });

  it('should require --client-secret for service principal', async () => {
    const { loginCommand } = await import('../commands/login');

    await expect(
      loginCommand.parseAsync(
        [
          'login',
          '--service-principal',
          '--client-id',
          'cid',
          '--tenant',
          'tid',
        ],
        { from: 'user' }
      )
    ).rejects.toThrow('--client-secret is required');
  });

  it('should require --tenant for service principal', async () => {
    const { loginCommand } = await import('../commands/login');

    await expect(
      loginCommand.parseAsync(
        [
          'login',
          '--service-principal',
          '--client-id',
          'cid',
          '--client-secret',
          'secret',
        ],
        { from: 'user' }
      )
    ).rejects.toThrow('--tenant is required');
  });

  it('should succeed with all required SP flags', async () => {
    mockIsServicePrincipal.mockReturnValue(true);
    mockAcquireToken.mockResolvedValue({
      token: 'sp-token',
      expiresOnTimestamp: Date.now() + 3600_000,
    });

    const { loginCommand } = await import('../commands/login');
    const { RayfinAuth } = await import('../auth/rayfin-auth');

    await loginCommand.parseAsync(
      [
        'login',
        '--service-principal',
        '--client-id',
        'sp-cid',
        '--client-secret',
        'sp-secret',
        '--tenant',
        'sp-tenant',
      ],
      { from: 'user' }
    );

    expect(RayfinAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'sp-cid',
        clientSecret: 'sp-secret',
        tenantId: 'sp-tenant',
      })
    );
  });

  it('should persist SP credentials to auth state on success', async () => {
    mockIsServicePrincipal.mockReturnValue(true);
    mockAcquireToken.mockResolvedValue({
      token: 'sp-token',
      expiresOnTimestamp: Date.now() + 3600_000,
    });

    const { loginCommand } = await import('../commands/login');
    const { saveAuthState } = await import('../auth/state');

    await loginCommand.parseAsync(
      [
        'login',
        '--service-principal',
        '--client-id',
        'persist-cid',
        '--client-secret',
        'persist-secret',
        '--tenant',
        'persist-tenant',
      ],
      { from: 'user' }
    );

    expect(saveAuthState).toHaveBeenCalledWith(
      expect.objectContaining({
        identityType: 'service_principal',
        tenantId: 'persist-tenant',
        clientId: 'persist-cid',
        clientSecret: 'persist-secret',
      })
    );
  });

  it('should have all SP-related options on the command', async () => {
    const { loginCommand } = await import('../commands/login');
    const optionFlags = loginCommand.options.map((o) => o.long);
    expect(optionFlags).toContain('--service-principal');
    expect(optionFlags).toContain('--client-id');
    expect(optionFlags).toContain('--client-secret');
  });

  it('should reject --client-id without --service-principal', async () => {
    const { loginCommand } = await import('../commands/login');

    await expect(
      loginCommand.parseAsync(
        [
          'login',
          '--client-id',
          'cid',
          '--client-secret',
          'secret',
          '--tenant',
          'tid',
        ],
        { from: 'user' }
      )
    ).rejects.toThrow(
      '--client-id and --client-secret require the --service-principal flag'
    );
  });

  it('should reject --client-secret without --service-principal', async () => {
    const { loginCommand } = await import('../commands/login');

    await expect(
      loginCommand.parseAsync(['login', '--client-secret', 'secret'], {
        from: 'user',
      })
    ).rejects.toThrow(
      '--client-id and --client-secret require the --service-principal flag'
    );
  });
});
