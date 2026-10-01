import { RAYFIN_ENV_CONFIG_VARS } from '@microsoft/rayfin-tools-common/_internal/auth';
import { Command } from 'commander';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { RayfinAuth } from '../../auth/rayfin-auth.js';
import { loadAuthState, saveAuthState } from '../../auth/state.js';
import { loginCommand } from '../../commands/login.js';
import { readDeploymentsRegistryState } from '../../utils/deployments-registry.js';
import { findRayfinProjectRoot } from '../../utils/project-utils.js';

// Mock the auth modules
vi.mock('../../auth/rayfin-auth.js');
vi.mock('../../auth/state.js');
vi.mock('../../utils/deployments-registry.js');
vi.mock('../../utils/project-utils.js');
// Override only the resolver functions used by acquireToken(); the
// shared RAYFIN_ENV_CONFIG_VARS is owned by tools-common and not
// mocked here.
vi.mock('../../auth/constants.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../auth/constants.js')>();
  return {
    ...actual,
    getFabricScopes: () => ['https://api.fabric.microsoft.com/.default'],
    getFabricScope: () => 'https://api.fabric.microsoft.com/.default',
  };
});

describe('login command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('command structure', () => {
    it('should have correct command name and description', () => {
      expect(loginCommand.name()).toBe('login');
      expect(loginCommand.description()).toBe('Sign in to the Rayfin platform');
    });

    it('should have --tenant option', () => {
      const options = loginCommand.options;
      const tenantOption = options.find(
        (opt: { long?: string }) => opt.long === '--tenant'
      );
      expect(tenantOption).toBeDefined();
      expect(tenantOption?.short).toBe('-t');
      expect(tenantOption?.description).toBe(
        'Provide your Tenant ID for Fabric to sign in to'
      );
    });

    it('should have --service-principal option', () => {
      const options = loginCommand.options;
      const spOption = options.find(
        (opt: { long?: string }) => opt.long === '--service-principal'
      );
      expect(spOption).toBeDefined();
      expect(spOption?.description).toBe(
        'Authenticate with service principal to Fabric using client credentials'
      );
    });

    it('should describe --select as a deprecated, no-op flag', () => {
      const selectOption = loginCommand.options.find(
        (opt: { long?: string }) => opt.long === '--select'
      );

      expect(selectOption?.description).toBe(
        'Deprecated: the MSAL account picker is now always shown on login. This flag is accepted for backwards compatibility and has no additional effect.'
      );
    });

    it('should have status subcommand', () => {
      const statusCmd = loginCommand.commands.find(
        (cmd: Command) => cmd.name() === 'status'
      );
      expect(statusCmd).toBeDefined();
      expect(statusCmd?.description()).toBe(
        'Display current authentication status'
      );
    });

    it('should have --encryption-fallback-enabled option', () => {
      const options = loginCommand.options;
      const fallbackOption = options.find(
        (opt: { long?: string }) => opt.long === '--encryption-fallback-enabled'
      );
      expect(fallbackOption).toBeDefined();
      expect(fallbackOption?.description).toContain(
        'Required only when login fails with a keychain error.'
      );
    });

    it('should be addable to parent command', () => {
      const parent = new Command('rayfin');
      expect(() => parent.addCommand(loginCommand)).not.toThrow();
    });

    it('should always request account selection for interactive login', async () => {
      const savedEnv: Record<string, string | undefined> = {};
      for (const { envVar } of RAYFIN_ENV_CONFIG_VARS) {
        savedEnv[envVar] = process.env[envVar];
        delete process.env[envVar];
      }

      const acquireTokenMock = vi
        .fn()
        .mockResolvedValue({ token: 'fake', expiresOnTimestamp: Date.now() });
      vi.mocked(RayfinAuth).mockImplementation(
        () =>
          ({
            acquireToken: acquireTokenMock,
            isServicePrincipal: false,
            isLoggedIn: vi.fn().mockResolvedValue(false),
            getAccount: vi.fn().mockResolvedValue(null),
            logout: vi.fn().mockResolvedValue(undefined),
          }) as any
      );
      vi.mocked(loadAuthState).mockResolvedValue({
        identityType: 'user',
        tenantId: 'selected-tenant',
        userPrincipalName: 'someone@example.invalid',
      });
      vi.mocked(saveAuthState).mockResolvedValue(undefined);

      const parent = new Command();
      parent.addCommand(loginCommand);
      parent.exitOverride();

      try {
        await parent.parseAsync(['login'], { from: 'user' });
      } finally {
        for (const { envVar } of RAYFIN_ENV_CONFIG_VARS) {
          delete process.env[envVar];
          if (savedEnv[envVar] !== undefined) {
            process.env[envVar] = savedEnv[envVar];
          }
        }
      }

      expect(acquireTokenMock).toHaveBeenCalledWith(
        ['https://api.fabric.microsoft.com/.default'],
        { forceAccountSelect: true }
      );
      expect(saveAuthState).not.toHaveBeenCalled();
    });
  });

  describe('environment-config override validation', () => {
    // Test-fixture values keyed by the persisted environmentConfig
    // field name. The env-var list and assertion blocks are derived
    // from RAYFIN_ENV_CONFIG_VARS so adding/renaming a knob only
    // requires editing the shared constant + this map.
    const TEST_VALUES: Record<
      (typeof RAYFIN_ENV_CONFIG_VARS)[number]['configField'],
      string
    > = {
      authorityHost: 'https://example.invalid',
      clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      fabricScope: 'https://example.invalid/.default',
      fabricApiUrl: 'https://api.example.invalid/v1',
      fabricPortalUrl: 'https://portal.example.invalid/',
    };

    const ENV_VARS = RAYFIN_ENV_CONFIG_VARS.map(({ envVar }) => envVar);

    /** Set every RAYFIN_* env var to its TEST_VALUES entry. */
    function setAllEnvVars(): void {
      for (const { envVar, configField } of RAYFIN_ENV_CONFIG_VARS) {
        process.env[envVar] = TEST_VALUES[configField];
      }
    }

    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
      // Save and unconditionally delete every test so a previous test
      // leak (or the user's actual shell exports) doesn't contaminate
      // assertions that rely on a clean env.
      savedEnv = {};
      for (const k of ENV_VARS) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
      }
    });

    afterEach(() => {
      for (const k of ENV_VARS) {
        delete process.env[k];
        if (savedEnv[k] !== undefined) {
          process.env[k] = savedEnv[k];
        }
      }
    });

    it('rejects an auth-group var without endpoint vars and lists all four missing', async () => {
      const acquireTokenMock = vi.fn();
      vi.mocked(RayfinAuth).mockImplementation(
        () =>
          ({
            acquireToken: acquireTokenMock,
            isLoggedIn: vi.fn().mockResolvedValue(false),
            getAccount: vi.fn().mockResolvedValue(null),
            logout: vi.fn().mockResolvedValue(undefined),
          }) as any
      );
      vi.mocked(saveAuthState).mockResolvedValue(undefined);

      // Set only the first auth-group env var. The other 4 (2 auth +
      // 2 endpoint) must all be reported as missing.
      const firstAuth = RAYFIN_ENV_CONFIG_VARS.find((v) => v.group === 'auth')!;
      process.env[firstAuth.envVar] = TEST_VALUES[firstAuth.configField];

      const parent = new Command();
      parent.addCommand(loginCommand);
      parent.exitOverride();

      await expect(
        parent.parseAsync(['login'], { from: 'user' })
      ).rejects.toThrow(
        /Authentication overrides require all five environment-config variables/i
      );

      // The error message must enumerate every missing var, including
      // the endpoint vars.
      const missing = RAYFIN_ENV_CONFIG_VARS.filter(
        ({ envVar }) => envVar !== firstAuth.envVar
      ).map(({ envVar }) => envVar);
      let thrown: Error | undefined;
      try {
        await parent.parseAsync(['login'], { from: 'user' });
      } catch (e) {
        thrown = e as Error;
      }
      for (const v of missing) {
        expect(thrown?.message).toContain(v);
      }

      expect(acquireTokenMock).not.toHaveBeenCalled();
      expect(saveAuthState).not.toHaveBeenCalled();
    });

    it('rejects the full auth group without endpoint vars and reports the missing endpoints', async () => {
      const acquireTokenMock = vi.fn();
      vi.mocked(RayfinAuth).mockImplementation(
        () =>
          ({
            acquireToken: acquireTokenMock,
            isLoggedIn: vi.fn().mockResolvedValue(false),
            getAccount: vi.fn().mockResolvedValue(null),
            logout: vi.fn().mockResolvedValue(undefined),
          }) as any
      );
      vi.mocked(saveAuthState).mockResolvedValue(undefined);

      // Set every auth-group var; leave both endpoint vars unset.
      for (const v of RAYFIN_ENV_CONFIG_VARS.filter(
        (v) => v.group === 'auth'
      )) {
        process.env[v.envVar] = TEST_VALUES[v.configField];
      }
      const endpointVars = RAYFIN_ENV_CONFIG_VARS.filter(
        (v) => v.group === 'endpoint'
      );

      const parent = new Command();
      parent.addCommand(loginCommand);
      parent.exitOverride();

      await expect(
        parent.parseAsync(['login'], { from: 'user' })
      ).rejects.toThrow(
        new RegExp(
          `Missing:.*${endpointVars[0].envVar}.*${endpointVars[1].envVar}`,
          'i'
        )
      );

      expect(acquireTokenMock).not.toHaveBeenCalled();
      expect(saveAuthState).not.toHaveBeenCalled();
    });

    it('rejects auth-group + only one endpoint var', async () => {
      const acquireTokenMock = vi.fn();
      vi.mocked(RayfinAuth).mockImplementation(
        () =>
          ({
            acquireToken: acquireTokenMock,
            isLoggedIn: vi.fn().mockResolvedValue(false),
            getAccount: vi.fn().mockResolvedValue(null),
            logout: vi.fn().mockResolvedValue(undefined),
          }) as any
      );
      vi.mocked(saveAuthState).mockResolvedValue(undefined);

      // Set all 3 auth + only RAYFIN_FABRIC_API_URL — RAYFIN_FABRIC_PORTAL_URL
      // is missing, must fail.
      for (const v of RAYFIN_ENV_CONFIG_VARS.filter(
        (v) => v.group === 'auth'
      )) {
        process.env[v.envVar] = TEST_VALUES[v.configField];
      }
      const apiUrl = RAYFIN_ENV_CONFIG_VARS.find(
        (v) => v.envVar === 'RAYFIN_FABRIC_API_URL'
      )!;
      process.env[apiUrl.envVar] = TEST_VALUES[apiUrl.configField];

      const parent = new Command();
      parent.addCommand(loginCommand);
      parent.exitOverride();

      await expect(
        parent.parseAsync(['login'], { from: 'user' })
      ).rejects.toThrow(/RAYFIN_FABRIC_PORTAL_URL/i);

      expect(acquireTokenMock).not.toHaveBeenCalled();
      expect(saveAuthState).not.toHaveBeenCalled();
    });

    it('persists environmentConfig when all five env vars are set', async () => {
      // Stub RayfinAuth so the action reaches the persist step without
      // contacting MSAL.
      const acquireTokenMock = vi
        .fn()
        .mockResolvedValue({ token: 'fake', expiresOnTimestamp: Date.now() });
      vi.mocked(RayfinAuth).mockImplementation(
        () =>
          ({
            acquireToken: acquireTokenMock,
            isLoggedIn: vi.fn().mockResolvedValue(false),
            getAccount: vi.fn().mockResolvedValue(null),
            logout: vi.fn().mockResolvedValue(undefined),
          }) as any
      );
      vi.mocked(loadAuthState).mockResolvedValue({
        identityType: 'user',
        tenantId: 'existing-tenant',
        userPrincipalName: 'someone@example.invalid',
      });
      vi.mocked(saveAuthState).mockResolvedValue(undefined);

      setAllEnvVars();

      const parent = new Command();
      parent.addCommand(loginCommand);
      parent.exitOverride();

      await parent.parseAsync(['login'], { from: 'user' });

      // 1. acquireToken was called (sign-in actually happened).
      expect(acquireTokenMock).toHaveBeenCalledTimes(1);

      // 2. saveAuthState was invoked with the values mapped onto the
      // persisted environmentConfig sub-fields. Existing top-level
      // fields (tenantId, userPrincipalName) are preserved.
      expect(saveAuthState).toHaveBeenCalledTimes(1);
      const persisted = vi.mocked(saveAuthState).mock.calls[0][0];
      expect(persisted).toMatchObject({
        identityType: 'user',
        tenantId: 'existing-tenant',
        userPrincipalName: 'someone@example.invalid',
        environmentConfig: TEST_VALUES,
      });
    });

    it('does not persist when only endpoint vars are set (no auth-group vars)', async () => {
      // Endpoint-only path: any combination of RAYFIN_FABRIC_API_URL /
      // RAYFIN_FABRIC_PORTAL_URL with no auth vars set must succeed
      // without writing environmentConfig — the user is using them as
      // one-off process env values.
      const acquireTokenMock = vi
        .fn()
        .mockResolvedValue({ token: 'fake', expiresOnTimestamp: Date.now() });
      vi.mocked(RayfinAuth).mockImplementation(
        () =>
          ({
            acquireToken: acquireTokenMock,
            isLoggedIn: vi.fn().mockResolvedValue(false),
            getAccount: vi.fn().mockResolvedValue(null),
            logout: vi.fn().mockResolvedValue(undefined),
          }) as any
      );
      vi.mocked(loadAuthState).mockResolvedValue(null);
      vi.mocked(saveAuthState).mockResolvedValue(undefined);

      for (const v of RAYFIN_ENV_CONFIG_VARS.filter(
        (v) => v.group === 'endpoint'
      )) {
        process.env[v.envVar] = TEST_VALUES[v.configField];
      }

      const parent = new Command();
      parent.addCommand(loginCommand);
      parent.exitOverride();

      await parent.parseAsync(['login'], { from: 'user' });

      expect(acquireTokenMock).toHaveBeenCalledTimes(1);
      expect(saveAuthState).not.toHaveBeenCalled();
    });

    it('persists environmentConfig with a default user identity when auth state is missing', async () => {
      const acquireTokenMock = vi
        .fn()
        .mockResolvedValue({ token: 'fake', expiresOnTimestamp: Date.now() });
      vi.mocked(RayfinAuth).mockImplementation(
        () =>
          ({
            acquireToken: acquireTokenMock,
            isLoggedIn: vi.fn().mockResolvedValue(false),
            getAccount: vi.fn().mockResolvedValue(null),
            logout: vi.fn().mockResolvedValue(undefined),
          }) as any
      );
      vi.mocked(loadAuthState).mockResolvedValue(null);
      vi.mocked(saveAuthState).mockResolvedValue(undefined);

      setAllEnvVars();

      const parent = new Command();
      parent.addCommand(loginCommand);
      parent.exitOverride();

      await parent.parseAsync(['login'], { from: 'user' });

      expect(saveAuthState).toHaveBeenCalledTimes(1);
      expect(vi.mocked(saveAuthState).mock.calls[0][0]).toEqual({
        identityType: 'user',
        environmentConfig: TEST_VALUES,
      });
    });

    it('does not call saveAuthState when no env vars are set', async () => {
      const acquireTokenMock = vi
        .fn()
        .mockResolvedValue({ token: 'fake', expiresOnTimestamp: Date.now() });
      vi.mocked(RayfinAuth).mockImplementation(
        () =>
          ({
            acquireToken: acquireTokenMock,
            isLoggedIn: vi.fn().mockResolvedValue(false),
            getAccount: vi.fn().mockResolvedValue(null),
            logout: vi.fn().mockResolvedValue(undefined),
          }) as any
      );
      vi.mocked(loadAuthState).mockResolvedValue({
        identityType: 'user',
        environmentConfig: {
          authorityHost: 'https://preserved.invalid',
          clientId: 'preserved-id',
          fabricScope: 'https://preserved.invalid/.default',
          fabricApiUrl: 'https://api.preserved.invalid/v1',
          fabricPortalUrl: 'https://portal.preserved.invalid/',
        },
      });
      vi.mocked(saveAuthState).mockResolvedValue(undefined);

      const parent = new Command();
      parent.addCommand(loginCommand);
      parent.exitOverride();

      await parent.parseAsync(['login'], { from: 'user' });

      // Login still happened, but the existing environmentConfig is
      // left untouched (saveAuthState NOT called from the login action).
      expect(acquireTokenMock).toHaveBeenCalledTimes(1);
      expect(saveAuthState).not.toHaveBeenCalled();
    });
  });

  describe('status output', () => {
    const savedFabricApiUrl = process.env['RAYFIN_FABRIC_API_URL'];

    beforeEach(() => {
      vi.stubEnv('RAYFIN_TENANT_ID', '');
      vi.stubEnv('RAYFIN_TOKEN', '');
      vi.mocked(findRayfinProjectRoot).mockReturnValue('/project');
      vi.mocked(readDeploymentsRegistryState).mockReturnValue({
        registry: { deployments: {} },
        warnings: [],
      });
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      if (savedFabricApiUrl === undefined) {
        delete process.env['RAYFIN_FABRIC_API_URL'];
      } else {
        process.env['RAYFIN_FABRIC_API_URL'] = savedFabricApiUrl;
      }
    });

    it('prints the default Fabric API endpoint when signed in without an override', async () => {
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      delete process.env['RAYFIN_FABRIC_API_URL'];
      const acquireTokenMock = vi.fn().mockResolvedValue({
        token: 'fake',
        expiresOnTimestamp: Date.parse('2026-03-01T00:00:00Z'),
      });
      vi.mocked(RayfinAuth).mockImplementation(
        () =>
          ({
            acquireToken: acquireTokenMock,
            isLoggedIn: vi.fn().mockResolvedValue(true),
            getAccount: vi.fn().mockResolvedValue({
              username: 'someone@example.invalid',
              tenantId: 'tenant-from-cache',
            }),
            logout: vi.fn().mockResolvedValue(undefined),
          }) as any
      );
      vi.mocked(loadAuthState).mockResolvedValue({
        identityType: 'user',
        tenantId: 'tenant-from-state',
        userPrincipalName: 'someone@example.invalid',
      });

      const parent = new Command();
      parent.addCommand(loginCommand);
      parent.exitOverride();

      await parent.parseAsync(['login', 'status'], { from: 'user' });

      expect(stderrSpy).toHaveBeenCalledWith(
        '   Endpoint:  https://api.fabric.microsoft.com/v1\n'
      );
      expect(acquireTokenMock).toHaveBeenCalledWith(
        ['https://api.fabric.microsoft.com/.default'],
        { silentOnly: true }
      );
      expect(stderrSpy).toHaveBeenCalledWith(
        `   Expires:   ${new Date('2026-03-01T00:00:00Z').toLocaleString()}\n`
      );
      stderrSpy.mockRestore();
    });

    it('prints the resolved Fabric API endpoint when signed in', async () => {
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      process.env['RAYFIN_FABRIC_API_URL'] = 'https://api.example.invalid/v1';
      const acquireTokenMock = vi.fn().mockResolvedValue({
        token: 'fake',
        expiresOnTimestamp: Date.parse('2026-03-01T00:00:00Z'),
      });
      vi.mocked(RayfinAuth).mockImplementation(
        () =>
          ({
            acquireToken: acquireTokenMock,
            isLoggedIn: vi.fn().mockResolvedValue(true),
            getAccount: vi.fn().mockResolvedValue({
              username: 'someone@example.invalid',
              tenantId: 'tenant-from-cache',
            }),
            logout: vi.fn().mockResolvedValue(undefined),
          }) as any
      );
      vi.mocked(loadAuthState).mockResolvedValue({
        identityType: 'user',
        tenantId: 'tenant-from-state',
        userPrincipalName: 'someone@example.invalid',
      });

      const parent = new Command();
      parent.addCommand(loginCommand);
      parent.exitOverride();

      await parent.parseAsync(['login', 'status'], { from: 'user' });

      expect(stderrSpy).toHaveBeenCalledWith(
        '   Endpoint:  https://api.example.invalid/v1\n'
      );
      expect(acquireTokenMock).toHaveBeenCalledWith(
        ['https://api.fabric.microsoft.com/.default'],
        { silentOnly: true }
      );
      stderrSpy.mockRestore();
    });

    it.each([
      { configuredTenant: 'other-tenant', matches: false },
      { configuredTenant: 'SIGNED-IN-TENANT', matches: true },
    ])(
      'checks the project tenant $configuredTenant locally',
      async ({ configuredTenant, matches }) => {
        const stderrSpy = vi
          .spyOn(process.stderr, 'write')
          .mockImplementation(() => true);
        const acquireToken = vi
          .fn()
          .mockRejectedValue(new Error('Silent token acquisition failed'));
        vi.mocked(RayfinAuth).mockImplementation(
          () =>
            ({
              acquireToken,
              isLoggedIn: vi.fn().mockResolvedValue(true),
              getAccount: vi.fn().mockResolvedValue(null),
            }) as unknown as RayfinAuth
        );
        vi.mocked(loadAuthState).mockResolvedValue({
          identityType: 'user',
          tenantId: 'signed-in-tenant',
        });
        vi.mocked(readDeploymentsRegistryState).mockReturnValue({
          registry: {
            active: 'workspace',
            deployments: { workspace: { fabricTenantId: configuredTenant } },
          },
          warnings: [],
        });
        const parent = new Command().addCommand(loginCommand).exitOverride();
        const result = parent.parseAsync(['login', 'status'], { from: 'user' });
        if (matches) {
          await result;
          expect(stderrSpy).toHaveBeenCalledWith('Signed in\n');
          expect(acquireToken).toHaveBeenCalledWith(
            ['https://api.fabric.microsoft.com/.default'],
            { silentOnly: true }
          );
          expect(stderrSpy).toHaveBeenCalledWith(
            '   Token:     expired or unavailable (re-login may be required)\n'
          );
        } else {
          await expect(result).rejects.toThrow(
            `rayfin login --tenant ${configuredTenant}`
          );
          expect(stderrSpy).not.toHaveBeenCalledWith(
            expect.stringContaining('Signed in')
          );
          expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining(
              `\n   Run 'rayfin login --tenant ${configuredTenant}'`
            )
          );
          expect(acquireToken).not.toHaveBeenCalled();
        }
        stderrSpy.mockRestore();
      }
    );

    it.each(['ambient', 'signed-out', 'signed-in'] as const)(
      'emits one JSON object for %s status',
      async (scenario) => {
        const stdoutSpy = vi
          .spyOn(process.stdout, 'write')
          .mockImplementation(() => true);
        const acquireToken = vi.fn().mockResolvedValue({
          token: 'test-token-not-for-output',
          expiresOnTimestamp: Date.parse('2026-03-01T00:00:00Z'),
        });
        vi.mocked(RayfinAuth).mockImplementation(
          () =>
            ({
              acquireToken,
              isLoggedIn: vi.fn().mockResolvedValue(scenario === 'signed-in'),
              getAccount: vi.fn().mockResolvedValue(null),
            }) as unknown as RayfinAuth
        );
        vi.mocked(loadAuthState).mockResolvedValue({ identityType: 'user' });
        if (scenario === 'ambient') {
          vi.stubEnv('RAYFIN_TOKEN', 'test-token-not-for-output');
        }
        const parent = new Command()
          .option('--json')
          .addCommand(loginCommand)
          .exitOverride();

        await parent.parseAsync(['--json', 'login', 'status'], {
          from: 'user',
        });

        expect(stdoutSpy).toHaveBeenCalledTimes(1);
        const output = String(stdoutSpy.mock.calls[0][0]);
        expect(output).not.toContain('test-token-not-for-output');
        expect(JSON.parse(output)).toMatchObject({
          status: scenario === 'signed-out' ? 'not-signed-in' : 'ok',
          command: 'login status',
          ...(scenario === 'signed-out'
            ? { recovery: "Run 'rayfin login' to authenticate." }
            : {
                identityType: scenario === 'ambient' ? 'external' : 'user',
                verification: 'endpoint-not-verified',
              }),
        });
        if (scenario === 'signed-in') {
          expect(acquireToken).toHaveBeenCalledWith(
            ['https://api.fabric.microsoft.com/.default'],
            { silentOnly: true }
          );
        } else {
          expect(acquireToken).not.toHaveBeenCalled();
        }
        stdoutSpy.mockRestore();
      }
    );

    it('prefers the environment tenant and emits one JSON error without acquiring a token', async () => {
      const stdoutSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      vi.stubEnv('RAYFIN_TENANT_ID', 'environment-tenant');
      const acquireToken = vi.fn();
      vi.mocked(RayfinAuth).mockImplementation(
        () =>
          ({
            acquireToken,
            isLoggedIn: vi.fn().mockResolvedValue(true),
            getAccount: vi
              .fn()
              .mockResolvedValue({ tenantId: 'cached-tenant' }),
          }) as unknown as RayfinAuth
      );
      vi.mocked(loadAuthState).mockResolvedValue({ identityType: 'user' });
      vi.mocked(readDeploymentsRegistryState).mockReturnValue({
        registry: {
          active: 'workspace',
          deployments: { workspace: { fabricTenantId: 'cached-tenant' } },
        },
        warnings: [],
      });
      const parent = new Command()
        .option('--json')
        .addCommand(loginCommand)
        .exitOverride();
      await expect(
        parent.parseAsync(['--json', 'login', 'status'], { from: 'user' })
      ).rejects.toThrow('rayfin login --tenant environment-tenant');
      expect(stdoutSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(stdoutSpy.mock.calls[0][0]))).toEqual({
        status: 'error',
        error: expect.stringContaining(
          'rayfin login --tenant environment-tenant'
        ),
      });
      expect(acquireToken).not.toHaveBeenCalled();
      stdoutSpy.mockRestore();
    });
  });
});
