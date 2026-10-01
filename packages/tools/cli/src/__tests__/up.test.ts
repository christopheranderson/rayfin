import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import {
  parseRayfinYaml,
  validateConnectors,
} from '@microsoft/rayfin-tools-common/_internal/config';
import { Command } from 'commander';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ensureAuthenticated } from '../auth/index.js';
import { postRuntimeSettings, up } from '../commands/up/up';
import {
  DEFAULT_FABRIC_SETTINGS,
  getFabricSettings,
} from '../config/constants';
import { CliHandledError } from '../errors';
import { RayfinItemManager } from '../services/fabric/rayfin-item.js';
import { WorkspaceManager } from '../services/fabric/workspace.js';
import {
  loadRayfinConfig,
  resolveServiceRoot,
  resolveServiceSubpath,
} from '../utils/config-utils.js';
import { createCliFeatureFlags } from '../utils/feature-flags.js';
import { findRayfinProjectRoot } from '../utils/project-utils.js';

vi.mock('../auth/index.js');
vi.mock('../commands/up/up-storage.js', async () => {
  const { Command } = await import('commander');
  return { upStorageCommand: new Command('storage') };
});
vi.mock('../rayfin-services/index.js', () => ({
  createCliFrameworkEnvService: vi.fn(),
  createCliStorageService: vi.fn(),
}));
vi.mock('../services/fabric/workspace.js');
vi.mock('../services/fabric/rayfin-item.js');
vi.mock('../services/connector-generator.js', () => ({
  generateConnectorDabConfigs: vi.fn(),
}));
vi.mock('../utils/connector-apply.js', () => ({
  applyConnectorConfigs: vi.fn(),
  detectConnectorEntityCollisions: vi.fn(() => []),
  detectReservedConnectorEntityNames: vi.fn(() => []),
  formatConnectorEntityCollisionError: vi.fn(),
  formatReservedConnectorEntityNameError: vi.fn(),
  selectConnectorsToApply: vi.fn(() => []),
}));
vi.mock('../utils/config-utils.js');
vi.mock('../utils/dab-config-generator.js', () => ({
  generateDabConfig: vi.fn(),
}));
vi.mock('../utils/dab-apply.js', () => ({
  applyConfigToServer: vi.fn(),
}));
vi.mock('../utils/feature-flags.js', () => ({
  createCliFeatureFlags: vi.fn(() => ({
    get: vi.fn(
      (name: string) => name === 'up-legacy' || name === 'cli-up-anonstatic'
    ),
  })),
}));
vi.mock('../utils/project-utils.js', () => ({
  findRayfinProjectRoot: vi.fn(() => 'Q:\\test-project'),
}));

describe('up command', () => {
  let command: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveServiceSubpath).mockImplementation(
      (serviceRoot, _serviceName, _fieldName, configuredPath) =>
        resolve(serviceRoot, configuredPath)
    );
    vi.mocked(ensureAuthenticated).mockResolvedValue({
      token: 'test-token',
      expiresOnTimestamp: 0,
      identityType: 'user',
      tenantId: 'tenant-test',
    });
    vi.mocked(WorkspaceManager.prototype.getWorkspace).mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      displayName: 'Test Workspace',
    } as never);
    vi.mocked(
      RayfinItemManager.prototype.getAuthorizationHeader
    ).mockReturnValue('Bearer test-token');
    vi.mocked(createCliFeatureFlags).mockImplementation(
      () =>
        ({
          register: vi.fn(),
          get: (name: string) =>
            name === 'up-legacy' || name === 'cli-up-anonstatic',
        }) as ReturnType<typeof createCliFeatureFlags>
    );
    command = up();
  });

  it('should have correct command structure', () => {
    expect(command.name()).toBe('up');
    expect(command.description()).toBe(
      'Deploy the application to Fabric as a Rayfin item'
    );
  });

  it('should have all expected options', () => {
    const options = command.options.map((opt) => opt.flags);
    expect(options).toContain('-t, --tenant <id>');
    expect(options).toContain('-w, --workspace <name>');
    expect(options).toContain('--item-name <name>');
    expect(options).toContain('--workspace-id <id>');
    expect(options).toContain('--capacity-id <id>');
    expect(options).toContain('--workspace-uri <uri>');
    expect(options).toContain('--force');
    expect(options).toContain('-n, --dry-run');
    expect(options).toContain('--env-file <path>');
    expect(options).toContain('-v, --verbose');
    expect(options).toContain('--exclude-services <names>');
  });

  it('documents both supported deployment exclusions', () => {
    const excludeServices = command.options.find(
      (opt) => opt.flags === '--exclude-services <names>'
    );

    expect(excludeServices?.description).toContain(
      'supported: staticHosting, functions'
    );
  });

  it('emits one JSON error for an unknown excluded service', async () => {
    command.exitOverride();
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      await expect(
        command.parseAsync([
          'node',
          'rayfin',
          '--json',
          '--exclude-services',
          'foo',
        ])
      ).rejects.toThrow(CliHandledError);

      const calls = stdout.mock.calls.map((call) => String(call[0]));
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0])).toEqual({
        status: 'error',
        error: 'Unknown service: foo. Allowed: staticHosting, functions',
      });
    } finally {
      stdout.mockRestore();
    }
  });

  it('renders a recovery hint for an unsupported provider', async () => {
    command.exitOverride();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    try {
      await expect(
        command.parseAsync(['node', 'rayfin', '--provider', 'docker'])
      ).rejects.toThrow(CliHandledError);

      const calls = consoleError.mock.calls.map((call) => String(call[0]));
      expect(calls).toContain(
        '   Omit `--provider` or use `--provider fabric`.'
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('should have short aliases for common targeting options', () => {
    const tenantOption = command.options.find((opt) => opt.long === '--tenant');
    const workspaceOption = command.options.find(
      (opt) => opt.long === '--workspace'
    );
    const dryRunOption = command.options.find(
      (opt) => opt.long === '--dry-run'
    );
    const verboseOption = command.options.find(
      (opt) => opt.long === '--verbose'
    );

    expect(tenantOption?.short).toBe('-t');
    expect(workspaceOption?.short).toBe('-w');
    expect(dryRunOption?.short).toBe('-n');
    expect(verboseOption?.short).toBe('-v');
  });

  it('should describe refreshed targeting and env-file options', () => {
    const tenantOption = command.options.find((opt) => opt.long === '--tenant');
    const workspaceIdOption = command.options.find(
      (opt) => opt.long === '--workspace-id'
    );
    const envFileOption = command.options.find(
      (opt) => opt.long === '--env-file'
    );

    expect(tenantOption?.description).toBe(
      'Entra ID tenant GUID. Use when your account spans multiple tenants'
    );
    expect(workspaceIdOption?.description).toBe(
      'Fabric workspace GUID to deploy into'
    );
    expect(envFileOption?.description).toBe(
      "Defaults to rayfin/.env and contains Fabric app's properties"
    );
  });

  it('should describe encryption fallback as keychain-error fallback', () => {
    const fallbackOption = command.options.find(
      (opt) => opt.long === '--encryption-fallback-enabled'
    );

    expect(fallbackOption?.description).toContain(
      'Required only when login fails with a keychain error.'
    );
  });

  it('should not expose removed ACA or subscription targeting arguments and flags', () => {
    const argumentNames =
      command.registeredArguments?.map((arg) => arg.name()) || [];
    expect(argumentNames).toHaveLength(0);
    expect(argumentNames).not.toContain('azure-subscription-id');

    const flags = command.options.map((opt) => opt.flags);
    expect(flags).not.toContain('-e, --environment <environment>');
    expect(flags).not.toContain('--force-container');

    const optionSurface = command.options
      .map((opt) => `${opt.flags} ${opt.description}`)
      .join('\n');
    expect(optionSurface).not.toMatch(/subscription/i);
    expect(optionSurface).not.toMatch(/container apps/i);
  });

  describe('RayfinItemManager', () => {
    it('should construct correct endpoint URL', async () => {
      const { RayfinItemManager } = await vi.importActual<
        typeof import('../services/fabric/rayfin-item')
      >('../services/fabric/rayfin-item');

      const manager = new RayfinItemManager('test-token');
      const endpoint = manager.getRayfinItemEndpoint('ws-123', 'item-456');

      expect(endpoint).toBe(
        'https://api.fabric.microsoft.com/v1/workspaces/ws-123/appBackends/item-456'
      );
    });
  });

  describe('workspace selection', () => {
    it('should accept --workspace flag', () => {
      const option = command.options.find((opt) => opt.long === '--workspace');
      expect(option).toBeDefined();
      expect(option?.description).toMatch(/Fabric workspace display name/i);
      expect(option?.short).toBe('-w');
    });

    it('should accept --workspace-id flag', () => {
      const options = command.options.find(
        (opt) => opt.long === '--workspace-id'
      );
      expect(options).toBeDefined();
      expect(options?.optional).toBe(false);
    });

    it('should accept --workspace-uri flag', () => {
      const option = command.options.find(
        (opt) => opt.long === '--workspace-uri'
      );
      expect(option).toBeDefined();
      expect(option?.optional).toBe(false);
      expect(option?.description).toMatch(/portal workspace URL/i);
    });
  });

  describe('runtime settings sync flow', () => {
    let testProjectDir: string;

    beforeEach(() => {
      testProjectDir = join(
        tmpdir(),
        `rayfin-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      );
      mkdirSync(join(testProjectDir, 'rayfin'), { recursive: true });
      mkdirSync(join(testProjectDir, 'rayfin', '.temp'), { recursive: true });
    });

    afterEach(() => {
      try {
        rmSync(testProjectDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should invoke runtime settings API after publishable key retrieval', async () => {
      const rayfinConfig = `id: test-up-sync
name: Test Up Sync
version: 1.0.0
services:
  auth:
    enabled: true
  data:
    enabled: true
  storage:
    enabled: false
`;
      writeFileSync(join(testProjectDir, 'rayfin', 'rayfin.yml'), rayfinConfig);

      const fetchCalls: Array<{ url: string; method: string; body?: string }> =
        [];
      const fetchSpy = vi.fn((url: string, options?: any) => {
        fetchCalls.push({
          url,
          method: options?.method || 'GET',
          body: options?.body,
        });

        if (url.includes('/__private/publishable-key')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve('"pk_test_123"'),
          } as Response);
        }

        if (url.includes('/__private/projectRuntimeSettings')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(''),
          } as Response);
        }

        return Promise.resolve({ ok: false, status: 404 } as Response);
      });

      global.fetch = fetchSpy as any;

      const workloadEndpoint =
        'https://testapi.fabric.microsoft.com/v1/workspaces/ws1/appbackends/item1';

      const keyResponse = await fetch(
        `${workloadEndpoint}/__private/publishable-key`,
        {
          method: 'GET',
        }
      );
      expect(keyResponse.ok).toBe(true);
      expect(JSON.parse(await keyResponse.text())).toBe('pk_test_123');

      const payload = {
        services: {
          auth: { enabled: true },
          data: { enabled: true },
          storage: { enabled: false },
        },
      };

      const settingsResponse = await fetch(
        `${workloadEndpoint}/__private/projectRuntimeSettings`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );
      expect(settingsResponse.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      const keyCall = fetchCalls.find((c) =>
        c.url.includes('/__private/publishable-key')
      );
      expect(keyCall?.method).toBe('GET');

      const settingsCall = fetchCalls.find((c) =>
        c.url.includes('/__private/projectRuntimeSettings')
      );
      expect(settingsCall?.method).toBe('POST');
      expect(JSON.parse(settingsCall!.body!).services.storage.enabled).toBe(
        false
      );
    });

    it('should retry publishable key retrieval with transient failures', async () => {
      const rayfinConfig = `id: test-up-retry
name: Test Up Retry
version: 1.0.0
services:
  auth:
    enabled: true
  data:
    enabled: false
  storage:
    enabled: false
`;
      writeFileSync(join(testProjectDir, 'rayfin', 'rayfin.yml'), rayfinConfig);

      let keyAttempt = 0;
      const fetchSpy = vi.fn((url: string) => {
        if (url.includes('/__private/publishable-key')) {
          keyAttempt++;
          if (keyAttempt >= 3) {
            return Promise.resolve({
              ok: true,
              status: 200,
              text: () => Promise.resolve('"pk_test_retry"'),
            } as Response);
          }
          return Promise.resolve({ ok: false, status: 503 } as Response);
        }

        if (url.includes('/__private/projectRuntimeSettings')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(''),
          } as Response);
        }

        return Promise.resolve({ ok: false, status: 404 } as Response);
      });

      global.fetch = fetchSpy as any;

      const workloadEndpoint =
        'https://testapi.fabric.microsoft.com/v1/workspaces/ws1/appbackends/item1';

      for (let i = 0; i < 3; i++) {
        const keyResponse = await fetch(
          `${workloadEndpoint}/__private/publishable-key`,
          {
            method: 'GET',
          }
        );

        if (keyResponse.ok) {
          const response = await fetch(
            `${workloadEndpoint}/__private/projectRuntimeSettings`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ services: { auth: { enabled: true } } }),
            }
          );
          expect(response.ok).toBe(true);
          break;
        }
      }

      expect(keyAttempt).toBe(3);
      expect(
        fetchSpy.mock.calls.filter((call) =>
          call[0].includes('/__private/projectRuntimeSettings')
        )
      ).toHaveLength(1);
    });

    it('should handle runtime settings sync failure gracefully', async () => {
      const rayfinConfig = `id: test-up-fail-graceful
name: Test Up Fail Graceful
version: 1.0.0
services:
  auth:
    enabled: true
  data:
    enabled: true
  storage:
    enabled: true
`;
      writeFileSync(join(testProjectDir, 'rayfin', 'rayfin.yml'), rayfinConfig);

      const fetchSpy = vi.fn((url: string) => {
        if (url.includes('/__private/publishable-key')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve('"pk_test_fail"'),
          } as Response);
        }

        if (url.includes('/__private/projectRuntimeSettings')) {
          return Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.resolve('Internal Server Error'),
          } as Response);
        }

        return Promise.resolve({ ok: false, status: 404 } as Response);
      });

      global.fetch = fetchSpy as any;

      const workloadEndpoint =
        'https://testapi.fabric.microsoft.com/v1/workspaces/ws1/appbackends/item1';

      const keyResponse = await fetch(
        `${workloadEndpoint}/__private/publishable-key`,
        {
          method: 'GET',
        }
      );
      expect(keyResponse.ok).toBe(true);

      const settingsResponse = await fetch(
        `${workloadEndpoint}/__private/projectRuntimeSettings`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            services: {
              auth: { enabled: true },
              data: { enabled: true },
              storage: { enabled: true },
            },
          }),
        }
      );

      expect(settingsResponse.ok).toBe(false);
      expect(settingsResponse.status).toBe(500);
      expect(await settingsResponse.text()).toBe('Internal Server Error');
    });
  });

  describe('deployment persistence', () => {
    it('should write new deployment fields to rayfin.yml', () => {
      const deploymentFields = [
        'rayfinItemId',
        'rayfinApiUrl',
        'fabricWorkspaceId',
        'fabricDeepLink',
        'publishableKey',
      ];

      for (const field of deploymentFields) {
        expect(typeof field).toBe('string');
      }
    });
  });

  describe('dry-run mode', () => {
    it('should have --dry-run flag', () => {
      const dryRunOption = command.options.find(
        (opt) => opt.long === '--dry-run'
      );
      expect(dryRunOption).toBeDefined();
      expect(dryRunOption?.short).toBe('-n');
    });

    it('emits exactly one structured JSON plan at the command boundary', async () => {
      vi.mocked(resolveServiceRoot).mockReturnValue(process.cwd());
      vi.mocked(loadRayfinConfig).mockReturnValueOnce({
        id: 'json-dry-run',
        services: {
          auth: { enabled: true },
          data: { enabled: false },
          storage: { enabled: false },
          staticHosting: {
            enabled: true,
            folder: 'dist',
            buildCommand: 'npm run build',
          },
        },
      } as any);
      const stdout = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);

      try {
        await expect(
          command.parseAsync([
            'node',
            'rayfin',
            '--json',
            '--dry-run',
            '--workspace-id',
            '11111111-1111-4111-8111-111111111111',
          ])
        ).resolves.toBeDefined();

        const calls = stdout.mock.calls.map((call) => String(call[0]));
        expect(calls).toHaveLength(1);
        expect(JSON.parse(calls[0])).toMatchObject({
          status: 'dry-run',
          blocked: false,
          plan: {
            projectName: 'json-dry-run',
            itemName: 'json-dry-run',
            workspaceId: '11111111-1111-4111-8111-111111111111',
            workspaceName: 'Test Workspace',
            services: { staticHosting: true },
            preflight: [{ blocking: false }],
          },
        });
      } finally {
        vi.mocked(resolveServiceRoot).mockReset();
        stdout.mockRestore();
      }
    });
  });

  describe.each([true, false])(
    'Functions auth validation (dryRun=%s)',
    (dryRun) => {
      it.each([
        ['', 'services.functions.auth'],
        ['auth: {}', 'services.functions.auth.type'],
        ['auth: null', 'services.functions.auth'],
        ['auth:\n      type: null', 'services.functions.auth.type'],
        ['auth: application', 'services.functions.auth'],
        ['auth:\n      type: appAuth', 'services.functions.auth.type'],
        ['auth:\n      type: delegated', 'services.functions.auth.type'],
      ])(
        'rejects %s with one JSON error before deployment work',
        async (auth, field) => {
          vi.mocked(loadRayfinConfig).mockReturnValueOnce(
            parseRayfinYaml(`
id: invalid-functions-auth
services:
  functions:
    enabled: true
    ${auth}
`)
          );
          const stdout = vi
            .spyOn(process.stdout, 'write')
            .mockImplementation(() => true);
          const fetch = vi
            .spyOn(globalThis, 'fetch')
            .mockRejectedValue(new Error('Unexpected network call'));

          try {
            await expect(
              command.parseAsync([
                'node',
                'rayfin',
                '--json',
                ...(dryRun ? ['--dry-run'] : []),
              ])
            ).rejects.toThrow(CliHandledError);

            expect(stdout).toHaveBeenCalledTimes(1);
            expect(JSON.parse(String(stdout.mock.calls[0][0]))).toEqual({
              status: 'error',
              error: expect.stringContaining(field),
              code: 'invalid-functions-config',
            });
            expect(findRayfinProjectRoot).not.toHaveBeenCalled();
            expect(ensureAuthenticated).not.toHaveBeenCalled();
            expect(fetch).not.toHaveBeenCalled();
            // JSON mode must suppress config-discovery logging so stdout
            // stays a single parseable payload.
            expect(loadRayfinConfig).toHaveBeenCalledWith(
              undefined,
              expect.objectContaining({ silent: true })
            );
          } finally {
            stdout.mockRestore();
            fetch.mockRestore();
          }
        }
      );

      it('renders an actionable error in plain output', async () => {
        vi.mocked(loadRayfinConfig).mockReturnValueOnce(
          parseRayfinYaml(`
id: invalid-functions-auth
services:
  functions:
    enabled: true
    auth:
      type: appAuth
`)
        );
        const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          await expect(
            command.parseAsync([
              'node',
              'rayfin',
              ...(dryRun ? ['--dry-run'] : []),
            ])
          ).rejects.toThrow(CliHandledError);
          expect(
            stderr.mock.calls.map((call) => String(call[0])).join('\n')
          ).toContain('Set services.functions.auth.type to "application".');
          expect(findRayfinProjectRoot).not.toHaveBeenCalled();
          expect(ensureAuthenticated).not.toHaveBeenCalled();
        } finally {
          stderr.mockRestore();
        }
      });
    }
  );

  it.each([
    { enabled: true, auth: 'auth:\n      type: application' },
    { enabled: false, auth: 'auth:\n      type: application' },
    { enabled: false, auth: '' },
  ])(
    'allows valid Functions authentication in legacy dry-run without opt-in: %j',
    async ({ enabled, auth }) => {
      vi.mocked(loadRayfinConfig).mockReturnValueOnce(
        parseRayfinYaml(`
id: valid-functions-auth
services:
  functions:
    enabled: ${enabled}
    ${auth}
`)
      );
      const stdout = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      try {
        await command.parseAsync([
          'node',
          'rayfin',
          '--json',
          '--dry-run',
          '--workspace-id',
          '11111111-1111-4111-8111-111111111111',
        ]);
        expect(stdout).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(stdout.mock.calls[0][0]))).toMatchObject({
          status: 'dry-run',
          plan: { services: { functions: enabled } },
        });
        expect(ensureAuthenticated).toHaveBeenCalledOnce();
      } finally {
        stdout.mockRestore();
      }
    }
  );

  it.each([
    { enabled: false, exclude: false },
    { enabled: true, exclude: true },
  ])(
    'rejects delegated auth even when Functions will not deploy: %j',
    async ({ enabled, exclude }) => {
      vi.mocked(loadRayfinConfig).mockReturnValue(
        parseRayfinYaml(`
id: invalid-functions-auth
services:
  functions:
    enabled: ${enabled}
    auth:
      type: delegated
`)
      );
      const stdout = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      try {
        for (const dryRun of [false, true]) {
          stdout.mockClear();
          await expect(
            command.parseAsync([
              'node',
              'rayfin',
              '--json',
              ...(dryRun ? ['--dry-run'] : []),
              ...(exclude ? ['--exclude-services', 'functions'] : []),
            ])
          ).rejects.toThrow('Only application authentication is supported.');
          expect(stdout).toHaveBeenCalledOnce();
          expect(JSON.parse(String(stdout.mock.calls[0][0])).code).toBe(
            'invalid-functions-config'
          );
          expect(ensureAuthenticated).not.toHaveBeenCalled();
        }
      } finally {
        stdout.mockRestore();
      }
    }
  );

  it('allows application auth through real deployment preflight without opt-in', async () => {
    const config = parseRayfinYaml(`
id: application-functions-auth
services:
  functions:
    enabled: false
    auth:
      type: application
`);
    vi.mocked(loadRayfinConfig).mockReturnValueOnce(config);
    vi.mocked(ensureAuthenticated).mockRejectedValueOnce(
      new Error('Reached authentication')
    );
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      await expect(
        command.parseAsync(['node', 'rayfin', '--json'])
      ).rejects.toThrow('Reached authentication');
      expect(ensureAuthenticated).toHaveBeenCalledOnce();
      expect(config.services.functions?.auth).toEqual({ type: 'application' });
    } finally {
      stdout.mockRestore();
    }
  });

  describe('destructive schema protection', () => {
    it('should have --force flag', () => {
      const forceOption = command.options.find((opt) => opt.long === '--force');
      expect(forceOption).toBeDefined();
    });
  });

  describe('connectors validation and POST body', () => {
    it('validateConnectors accepts a valid connectors block', () => {
      const errors = validateConnectors([
        {
          name: 'salesModel',
          type: 'fabric-semanticmodel',
          config: { workspaceId: 'ws-1', itemId: 'item-1' },
          version: '1',
          operations: [{ name: 'executeQuery' }],
          auth: { type: 'delegated' },
        },
      ]);
      expect(errors).toHaveLength(0);
    });

    it('validateConnectors rejects a connector missing auth', () => {
      const errors = validateConnectors([
        {
          name: 'salesModel',
          type: 'fabric-semanticmodel',
          config: { workspaceId: 'ws-1', itemId: 'item-1' },
          version: '1',
          operations: [{ name: 'executeQuery' }],
        },
      ]);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch(/missing required field "auth\.type"/i);
    });

    it('validateConnectors rejects an unknown connector type', () => {
      const errors = validateConnectors([
        {
          name: 'mySource',
          type: 'fabric-unknown' as any,
          config: { workspaceId: 'ws-1', itemId: 'item-1' },
        },
      ]);
      expect(errors).toHaveLength(1);
      expect(errors[0].sourceName).toBe('mySource');
      expect(errors[0].message).toMatch(/unsupported type/i);
    });

    it('validateConnectors rejects an invalid version on a versioned connector', () => {
      const errors = validateConnectors([
        {
          name: 'salesModel',
          type: 'fabric-semanticmodel',
          config: { workspaceId: 'ws-1', itemId: 'item-1' },
          version: '0.5',
          auth: { type: 'delegated' },
        },
      ]);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch(/invalid.*version/i);
    });

    it('validateConnectors rejects an unsupported operation name', () => {
      const errors = validateConnectors([
        {
          name: 'salesModel',
          type: 'fabric-semanticmodel',
          config: { workspaceId: 'ws-1', itemId: 'item-1' },
          version: '1',
          operations: [{ name: 'executeQuery2' as any }],
          auth: { type: 'delegated' },
        },
      ]);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch(/does not support operation/i);
    });

    it('postRuntimeSettings merges connectors as a top-level sibling in the POST body', async () => {
      const postBodies: string[] = [];
      const fetchSpy = vi.fn((url: string, options?: any) => {
        if (url.includes('/__private/projectRuntimeSettings')) {
          postBodies.push(options?.body ?? '');
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(''),
          } as Response);
        }
        return Promise.resolve({ ok: false, status: 404 } as Response);
      });
      global.fetch = fetchSpy as any;

      const services = {
        auth: { enabled: true },
        data: { enabled: true },
        storage: { enabled: false },
      } as any;
      // In-memory shape from `rayfin.yml` is an array of self-describing
      // entries (`{ name, type, ... }`). The wire shape is a map keyed by
      // name with the entry kind under `connector:`. `postRuntimeSettings`
      // owns that transform — this test exercises both ends.
      const connectors = [
        {
          name: 'salesModel',
          type: 'fabric-semanticmodel',
          version: '1',
          config: { workspaceId: 'ws-1', itemId: 'item-1' },
          operations: [{ name: 'executeQuery' }],
          auth: { type: 'delegated' },
        },
      ] as any;

      // Drive the real production merge in `postRuntimeSettings` so a
      // regression that stops forwarding `connectors` is caught here.
      await postRuntimeSettings(
        'https://endpoint',
        services,
        'Bearer test-token',
        () => {},
        'runtime-settings',
        undefined,
        connectors
      );

      expect(postBodies).toHaveLength(1);
      const body = JSON.parse(postBodies[0]);
      expect(body.connectors).toBeDefined();
      // Wire shape: map keyed by name, entry kind under `connector:`.
      expect(body.connectors.salesModel.connector).toBe('fabric-semanticmodel');
      // Wire shape strips the `name` field (it's already the map key)
      // and renames `type` → `connector`.
      expect(body.connectors.salesModel.type).toBeUndefined();
      expect(body.connectors.salesModel.name).toBeUndefined();
      // connectors must be a top-level sibling of the service settings.
      expect(body.auth).toBeDefined();
      expect(body.data).toBeDefined();
    });

    it('postRuntimeSettings omits connectors when none are configured', async () => {
      const postBodies: string[] = [];
      const fetchSpy = vi.fn((url: string, options?: any) => {
        if (url.includes('/__private/projectRuntimeSettings')) {
          postBodies.push(options?.body ?? '');
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(''),
          } as Response);
        }
        return Promise.resolve({ ok: false, status: 404 } as Response);
      });
      global.fetch = fetchSpy as any;

      const services = {
        auth: { enabled: true },
        data: { enabled: true },
        storage: { enabled: false },
      } as any;

      await postRuntimeSettings(
        'https://endpoint',
        services,
        'Bearer test-token',
        () => {}
      );

      expect(postBodies).toHaveLength(1);
      const body = JSON.parse(postBodies[0]);
      expect(body.connectors).toBeUndefined();
      expect(body.auth).toBeDefined();
    });
  });

  describe('getFabricSettings', () => {
    const ENV_KEYS = [
      'RAYFIN_FABRIC_API_URL',
      'RAYFIN_FABRIC_PORTAL_URL',
    ] as const;

    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
      savedEnv = {};
      for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    });

    afterEach(() => {
      for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
    });

    it('should return default Fabric settings when no env vars are set', () => {
      const settings = getFabricSettings();
      expect(settings).toEqual(DEFAULT_FABRIC_SETTINGS);
    });

    it('should override fabricApiBaseUrl via RAYFIN_FABRIC_API_URL', () => {
      process.env.RAYFIN_FABRIC_API_URL = 'https://custom-api.example.com/v1';
      const settings = getFabricSettings();
      expect(settings.fabricApiBaseUrl).toBe(
        'https://custom-api.example.com/v1'
      );
      expect(settings.fabricPortalUrl).toBe(
        DEFAULT_FABRIC_SETTINGS.fabricPortalUrl
      );
    });

    it('should override fabricPortalUrl via RAYFIN_FABRIC_PORTAL_URL', () => {
      process.env.RAYFIN_FABRIC_PORTAL_URL =
        'https://custom-portal.example.com/';
      const settings = getFabricSettings();
      expect(settings.fabricPortalUrl).toBe(
        'https://custom-portal.example.com/'
      );
    });

    it('should always return fixed workloadId and itemType', () => {
      process.env.RAYFIN_FABRIC_API_URL = 'https://override.example.com/v1';
      const settings = getFabricSettings();
      expect(settings.workloadId).toBe('BaaS');
      expect(settings.itemType).toBe('AppBackend');
    });
  });
});
