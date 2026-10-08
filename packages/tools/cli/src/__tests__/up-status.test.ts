import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Command } from 'commander';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { getAuthenticatedToken, isAuthenticated } from '../auth/index.js';
import { upStatusCommand } from '../commands/up/up-status';
import { MONIKER_HEADER } from '../config/constants.js';
import { RayfinItemManager } from '../services/fabric/rayfin-item.js';
import { fabricFetch } from '../utils/http-client.js';

vi.mock('../services/fabric/rayfin-item.js');
vi.mock('../services/fabric/workspace.js');
vi.mock('../services/fabric/sql.js');
vi.mock('../auth/index.js');
vi.mock('../utils/http-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/http-client.js')>()),
  fabricFetch: vi.fn(),
}));

// Mock output-mode so emitJson uses console.log (tests spy on it)
vi.mock('../utils/output-mode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/output-mode')>();
  return {
    ...actual,
    emitJson: (data: Record<string, unknown>) =>
      console.log(JSON.stringify(data, null, 2)),
  };
});

describe('up status command', () => {
  beforeEach(() => {
    vi.stubEnv('RAYFIN_FEATURE_FLAGS', '');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('command structure', () => {
    it('should have correct command name and description', () => {
      expect(upStatusCommand.name()).toBe('status');
      expect(upStatusCommand.description()).toBe(
        'Display the status of the cloud deployment'
      );
    });

    it('should have no required arguments', () => {
      const args = upStatusCommand.registeredArguments;
      expect(args).toHaveLength(0);
    });

    it('should have --json option', () => {
      const options = upStatusCommand.options;
      const jsonOption = options.find((opt) => opt.long === '--json');
      expect(jsonOption).toBeDefined();
      expect(jsonOption?.description).toBe('Output status in JSON format');
      expect(jsonOption?.defaultValue).toBe(false);
    });

    it('should have --verbose option', () => {
      const options = upStatusCommand.options;
      const verboseOption = options.find((opt) => opt.long === '--verbose');
      expect(verboseOption).toBeDefined();
      expect(verboseOption?.description).toBe('Enable verbose output');
      expect(verboseOption?.defaultValue).toBeUndefined();
      expect(verboseOption?.short).toBe('-v');
    });

    it('should be addable to parent command', () => {
      const parentCommand = new Command('up');
      expect(() => {
        parentCommand.addCommand(upStatusCommand);
      }).not.toThrow();
    });

    it('should show help without errors', () => {
      const testProgram = new Command();
      testProgram.addCommand(upStatusCommand);

      expect(() => {
        upStatusCommand.helpInformation();
      }).not.toThrow();
    });
  });

  describe('exit codes', () => {
    let testProjectDir: string;

    beforeEach(() => {
      testProjectDir = join(
        tmpdir(),
        `rayfin-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      );

      mkdirSync(join(testProjectDir, 'rayfin'), { recursive: true });

      vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit called');
      }) as () => never);
    });

    afterEach(() => {
      try {
        rmSync(testProjectDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should exit with NOT_DEPLOYED (1) when no rayfin.yml exists', async () => {
      vi.spyOn(process, 'cwd').mockReturnValue(testProjectDir);

      await expect(
        upStatusCommand.parseAsync(['status'], { from: 'user' })
      ).rejects.toThrow('process.exit called');

      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('should exit with NOT_DEPLOYED (1) when no deployment metadata', async () => {
      const rayfinConfig = `id: test-project
name: Test Project
version: 1.0.0
services:
  auth:
    enabled: false
  data:
    enabled: true
  storage:
    enabled: false
`;
      writeFileSync(join(testProjectDir, 'rayfin', 'rayfin.yml'), rayfinConfig);
      vi.spyOn(process, 'cwd').mockReturnValue(testProjectDir);

      await expect(
        upStatusCommand.parseAsync(['status'], { from: 'user' })
      ).rejects.toThrow('process.exit called');

      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  describe('rayfin.yml configuration reading', () => {
    let testProjectDir: string;

    beforeEach(() => {
      testProjectDir = join(
        tmpdir(),
        `rayfin-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      );
      mkdirSync(join(testProjectDir, 'rayfin'), { recursive: true });
    });

    afterEach(() => {
      try {
        rmSync(testProjectDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should correctly parse enabled services from rayfin.yml', async () => {
      const rayfinConfig = `id: test-project
name: Test Project
version: 1.0.0
services:
  auth:
    enabled: true
  data:
    enabled: false
  storage:
    enabled: true
`;
      writeFileSync(join(testProjectDir, 'rayfin', 'rayfin.yml'), rayfinConfig);

      const { loadRayfinConfig } = await import('../utils/config-utils.js');
      const config = loadRayfinConfig(testProjectDir);

      expect(config).not.toBeNull();
      expect(config?.services?.auth?.enabled).toBe(true);
      expect(config?.services?.data?.enabled).toBe(false);
      expect(config?.services?.storage?.enabled).toBe(true);
    });

    it('should read deployment data from `rayfin/.deployments.json`', async () => {
      writeFileSync(
        join(testProjectDir, 'rayfin', 'rayfin.yml'),
        `id: test-project
name: Test Project
version: 1.0.0
services:
  auth:
    enabled: false
  data:
    enabled: true
  storage:
    enabled: false
`
      );

      const { writeDeploymentEnvFile, readDeploymentEnvFile } =
        await import('../utils/env-fabric-utils.js');
      await writeDeploymentEnvFile(testProjectDir, 'test-ws', {
        rayfinItemId: 'item-123',
        rayfinApiUrl: 'https://example.com/endpoint',
        fabricWorkspaceId: 'ws-456',
        publishableKey: 'pk-test-abc123',
        fabricPortalUrl: 'https://fabric.microsoft.com',
      });

      const deployment = readDeploymentEnvFile(testProjectDir, 'test-ws');

      expect(deployment).not.toBeNull();
      expect(deployment?.rayfinItemId).toBe('item-123');
      expect(deployment?.fabricWorkspaceId).toBe('ws-456');
      expect(deployment?.rayfinApiUrl).toBe('https://example.com/endpoint');
      expect(deployment?.publishableKey).toBe('pk-test-abc123');
      expect(deployment?.fabricPortalUrl).toBe('https://fabric.microsoft.com');
    });
  });

  describe('JSON output format', () => {
    let testProjectDir: string;

    beforeEach(() => {
      testProjectDir = join(
        tmpdir(),
        `rayfin-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      );
      mkdirSync(join(testProjectDir, 'rayfin'), { recursive: true });

      vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit called');
      }) as () => never);
    });

    afterEach(() => {
      try {
        rmSync(testProjectDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should output the same MSIT portal URL in plain and JSON modes', async () => {
      const rayfinConfig = `id: test-project
name: Test Project
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

      // Write deployment data via the registry-backed API.
      const { writeDeploymentEnvFile } =
        await import('../utils/env-fabric-utils.js');
      await writeDeploymentEnvFile(testProjectDir, 'test-ws', {
        rayfinItemId: 'item-123',
        rayfinApiUrl: 'https://example.com/endpoint',
        fabricWorkspaceId: 'ws-456',
        fabricTenantId: 'tenant-789',
        publishableKey: 'pk-test-key',
        fabricPortalUrl: 'https://msit.powerbi.com',
        hostingUrl:
          'https://silky-sand-4924b3ad1f-centraluseuap.webapp.rayfingwdev.com',
      });

      vi.spyOn(process, 'cwd').mockReturnValue(testProjectDir);

      // Mock isAuthenticated to return false (simulates unauthenticated)
      const credUtils = await import('../auth/index.js');
      vi.mocked(credUtils.isAuthenticated).mockResolvedValue(false);

      const logCalls: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
        logCalls.push(args.map(String).join(' '));
      });
      const stderrWrites: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
      });

      const expectedPortalUrl =
        'https://msit.powerbi.com/groups/ws-456/appbackends/item-123';

      await expect(
        upStatusCommand.parseAsync(['status'], { from: 'user' })
      ).rejects.toThrow('process.exit called');

      expect(stderrWrites.join('')).toContain(
        `  Portal:          ${expectedPortalUrl}`
      );
      logCalls.length = 0;
      vi.mocked(process.exit).mockClear();

      await expect(
        upStatusCommand.parseAsync(['status', '--json'], { from: 'user' })
      ).rejects.toThrow('process.exit called');

      // Find the JSON output line (should be the complete JSON string)
      const jsonLine = logCalls.find((line) => line.startsWith('{'));
      expect(jsonLine).toBeDefined();

      const parsed = JSON.parse(jsonLine!);
      expect(parsed.projectName).toBe('test-project');
      expect(parsed.deployed).toBe(true);
      expect(parsed.deployment.rayfinItemId).toBe('item-123');
      expect(parsed.deployment.fabricWorkspaceId).toBe('ws-456');
      // `fabricPortalUrl` is the full deep link to the deployed item,
      // composed from the bare portal origin + workspace + item + tenant
      // (see composeFabricItemDeepLink). Consumers can click/paste this
      // URL directly to land on the item in Fabric.
      expect(parsed.deployment.fabricPortalUrl).toBe(expectedPortalUrl);
      expect(parsed.deployment.hostingUrl).toBe(
        'https://silky-sand-4924b3ad1f-centraluseuap.webapp.rayfingwdev.com'
      );
      expect(parsed.services.auth).toBe(true);
      expect(parsed.services.data).toBe(true);
      expect(parsed.services.storage).toBe(false);
      expect(parsed.database).toBeNull();

      // Deployed but unauthenticated — health cannot be verified, so the
      // exit code must be UNHEALTHY (2), not HEALTHY (0).
      expect(process.exit).toHaveBeenCalledWith(2);
    });
  });

  // End-to-end coverage for the root → leaf `--json` / `--verbose`
  // inheritance contract. The unit tests in `root-output-flags.test.ts`
  // pin the helper, but the OR-merge `Boolean(options.x) ||
  // resolveRootOutputFlags(...).x` is hand-written at ~11 call sites.
  // These tests confirm the contract actually fires through Commander's
  // parse → action handler boundary at a representative leaf, so a
  // future call-site typo (e.g. `??` instead of `||`, or forgetting the
  // helper entirely) gets caught.
  describe('root flag inheritance (--json)', () => {
    let testProjectDir: string;

    beforeEach(() => {
      testProjectDir = join(
        tmpdir(),
        `rayfin-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      );
      mkdirSync(join(testProjectDir, 'rayfin'), { recursive: true });

      vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit called');
      }) as () => never);

      // Reset Commander option values on the singleton leaf. Commander
      // does NOT re-apply option defaults on subsequent parses (see
      // https://github.com/tj/commander.js — `_optionValues` retains
      // values once set), so a prior `--json` invocation in this file
      // would leak `options.json === true` into the action handler and
      // mask whether root inheritance actually wired through. Clearing
      // the bag before each test ensures these assertions truly exercise
      // the inheritance path rather than test pollution.

      (upStatusCommand as any)._optionValues = {};
    });

    afterEach(() => {
      try {
        rmSync(testProjectDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    /**
     * Builds a minimal `rayfin up status` Command tree that mirrors the
     * real CLI's root-level flag declarations. Used to drive
     * `parseAsync` from the root so the inheritance walk performed by
     * `resolveRootOutputFlags()` runs end-to-end.
     */
    function buildRootProgram(): Command {
      const root = new Command()
        .name('rayfin')
        .exitOverride()
        .option('-y, --yes', 'Auto-accept all confirmation prompts', false)
        .option('--verbose', 'Enable verbose output', false)
        .option('--json', 'Emit machine-readable JSON output', false);
      const upGroup = new Command('up').description('Cloud deployment');
      upGroup.addCommand(upStatusCommand);
      root.addCommand(upGroup);
      return root;
    }

    async function seedDeployedFixture(hostingUrl?: string): Promise<void> {
      writeFileSync(
        join(testProjectDir, 'rayfin', 'rayfin.yml'),
        `id: test-project
name: Test Project
version: 1.0.0
services:
  auth:
    enabled: false
  data:
    enabled: true
  storage:
    enabled: false
`
      );
      const { writeDeploymentEnvFile } =
        await import('../utils/env-fabric-utils.js');
      await writeDeploymentEnvFile(testProjectDir, 'test-ws', {
        rayfinItemId: 'item-123',
        rayfinApiUrl: 'https://example.com/endpoint',
        fabricWorkspaceId: 'ws-456',
        publishableKey: 'pk-test-key',
        hostingUrl,
      });

      vi.spyOn(process, 'cwd').mockReturnValue(testProjectDir);

      const credUtils = await import('../auth/index.js');
      vi.mocked(credUtils.isAuthenticated).mockResolvedValue(false);
    }

    it('honors `rayfin --json up status` (root flag inherits to leaf)', async () => {
      await seedDeployedFixture();

      const logCalls: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
        logCalls.push(args.map(String).join(' '));
      });

      const root = buildRootProgram();
      await expect(
        root.parseAsync(['node', 'rayfin', '--json', 'up', 'status'])
      ).rejects.toThrow('process.exit called');

      const jsonLine = logCalls.find((line) => line.startsWith('{'));
      expect(jsonLine).toBeDefined();
      const parsed = JSON.parse(jsonLine!);
      expect(parsed.projectName).toBe('test-project');
      expect(parsed.deployed).toBe(true);
      expect(parsed.deployment.hostingUrl).toBeNull();
    });

    it('still honors `rayfin up status --json` (local flag back-compat)', async () => {
      await seedDeployedFixture();

      const logCalls: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
        logCalls.push(args.map(String).join(' '));
      });

      const root = buildRootProgram();
      await expect(
        root.parseAsync(['node', 'rayfin', 'up', 'status', '--json'])
      ).rejects.toThrow('process.exit called');

      const jsonLine = logCalls.find((line) => line.startsWith('{'));
      expect(jsonLine).toBeDefined();
      const parsed = JSON.parse(jsonLine!);
      expect(parsed.projectName).toBe('test-project');
      expect(parsed.deployed).toBe(true);
    });

    it('emits no JSON when neither root nor local --json is set', async () => {
      // Negative control: confirms the inheritance tests above are
      // detecting the flag rather than always emitting JSON.
      await seedDeployedFixture();

      const logCalls: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
        logCalls.push(args.map(String).join(' '));
      });

      const root = buildRootProgram();
      await expect(
        root.parseAsync(['node', 'rayfin', 'up', 'status'])
      ).rejects.toThrow('process.exit called');

      const jsonLine = logCalls.find((line) => line.startsWith('{'));
      expect(jsonLine).toBeUndefined();
    });

    it('hides the `storage:` line in human output', async () => {
      await seedDeployedFixture();

      // In test runs `process.stdout.isTTY` is false, so `resolveOutputMode`
      // returns 'plain' and `modeLog` writes to `process.stderr.write`
      // instead of `console.log`. Spy on stderr so we capture every
      // human-mode display call.
      const stderrCalls: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation(((
        chunk: string | Uint8Array
      ): boolean => {
        stderrCalls.push(chunk.toString());
        return true;
      }) as typeof process.stderr.write);

      const root = buildRootProgram();
      await expect(
        root.parseAsync(['node', 'rayfin', 'up', 'status'])
      ).rejects.toThrow('process.exit called');

      const combined = stderrCalls.join('');
      expect(combined).toMatch(/Services:/);
      expect(combined).toMatch(/auth:\s+disabled/);
      expect(combined).toMatch(/data:\s+enabled/);
      expect(combined).not.toMatch(/storage:/);
      expect(combined).not.toMatch(/Static app:/);
    });

    it('shows the deployed static app URL in human output', async () => {
      const hostingUrl =
        'https://silky-sand-4924b3ad1f-centraluseuap.webapp.rayfingwdev.com';
      await seedDeployedFixture(hostingUrl);

      const stderrCalls: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation(((
        chunk: string | Uint8Array
      ): boolean => {
        stderrCalls.push(chunk.toString());
        return true;
      }) as typeof process.stderr.write);

      const root = buildRootProgram();
      await expect(
        root.parseAsync(['node', 'rayfin', 'up', 'status'])
      ).rejects.toThrow('process.exit called');

      expect(stderrCalls.join('')).toContain(`Static app:      ${hostingUrl}`);
    });
  });

  describe('live endpoint status', () => {
    const runtimeEndpoint = 'https://runtime.example/app/';
    const managementEndpoint =
      'https://api.fabric.example/v1/workspaces/ws-456/appBackends/item-123';
    let testProjectDir: string;

    beforeEach(async () => {
      testProjectDir = mkdtempSync(join(tmpdir(), 'rayfin-up-status-'));
      mkdirSync(join(testProjectDir, 'rayfin'));
      writeFileSync(
        join(testProjectDir, 'rayfin', 'rayfin.yml'),
        'id: test-project\nservices:\n  auth:\n    enabled: true\n  data:\n    enabled: false\n'
      );
      const { writeDeploymentEnvFile } =
        await import('../utils/env-fabric-utils.js');
      await writeDeploymentEnvFile(testProjectDir, 'test-ws', {
        rayfinItemId: 'item-123',
        rayfinApiUrl: runtimeEndpoint,
        fabricWorkspaceId: 'ws-456',
      });
      vi.spyOn(process, 'cwd').mockReturnValue(testProjectDir);
      vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit called');
      }) as () => never);
      upStatusCommand.setOptionValue('json', false);
      upStatusCommand.setOptionValue('verbose', false);
      new Command('up').addCommand(upStatusCommand);
      vi.mocked(isAuthenticated).mockResolvedValue(true);
      vi.mocked(getAuthenticatedToken).mockResolvedValue({
        token: 'test-token',
        expiresOnTimestamp: Date.now() + 60_000,
        identityType: 'user',
      });
      vi.mocked(
        RayfinItemManager.prototype.getRayfinItemEndpoint
      ).mockReturnValue(managementEndpoint);
      vi.mocked(
        RayfinItemManager.prototype.getAuthorizationHeader
      ).mockReturnValue('Bearer test-token');
      vi.mocked(fabricFetch).mockReset();
      vi.mocked(console.log).mockClear();
    });

    afterEach(() => {
      vi.mocked(isAuthenticated).mockResolvedValue(false);
      vi.useRealTimers();
      rmSync(testProjectDir, { recursive: true, force: true });
    });

    async function readStatus(
      args = ['status', '--json'],
      command = upStatusCommand
    ) {
      await expect(command.parseAsync(args, { from: 'user' })).rejects.toThrow(
        'process.exit called'
      );
      const output = vi
        .mocked(console.log)
        .mock.calls.find(([message]) => String(message).startsWith('{'));
      expect(output).toBeDefined();
      return JSON.parse(String(output![0]));
    }

    it.each(['', 'ws-456'])(
      'honors --env-file and keeps selected metadata together with workspace override %j',
      async (workspaceId) => {
        vi.stubEnv('RAYFIN_WORKSPACE_ID', workspaceId);
        const { writeDeploymentEnvFile } =
          await import('../utils/env-fabric-utils.js');
        await writeDeploymentEnvFile(testProjectDir, 'other-ws', {
          rayfinItemId: 'other-item',
          rayfinApiUrl: 'https://other-runtime.example/',
          fabricWorkspaceId: 'other-workspace',
          publishableKey: 'pk-other',
        });
        vi.mocked(fabricFetch).mockResolvedValue(new Response('pk-test-key'));
        const command = new Command('up')
          .option('--env-file <name>')
          .addCommand(upStatusCommand);

        const status = await readStatus(
          ['--env-file', 'test-ws', 'status', '--json'],
          command
        );

        expect(status.deployment).toMatchObject({
          rayfinItemId: 'item-123',
          fabricWorkspaceId: 'ws-456',
          rayfinApiUrl: runtimeEndpoint,
          publishableKey: null,
        });
        expect(status.envFabric).toMatchObject({
          workspaceName: 'test-ws',
          apiUrl: runtimeEndpoint,
          publishableKey: null,
        });
        expect(
          RayfinItemManager.prototype.getRayfinItemEndpoint
        ).toHaveBeenLastCalledWith('ws-456', 'item-123');
        expect(process.exit).toHaveBeenNthCalledWith(1, 0);
      }
    );

    it.each([
      ['missing', '', 1],
      ['test-ws', 'other-workspace', 2],
    ])(
      'rejects an invalid explicit deployment %s before live inspection',
      async (name, workspaceId, exitCode) => {
        vi.stubEnv('RAYFIN_WORKSPACE_ID', workspaceId);
        const command = new Command('up')
          .option('--env-file <name>')
          .addCommand(upStatusCommand);

        await expect(
          command.parseAsync(['--env-file', name, 'status', '--json'], {
            from: 'user',
          })
        ).rejects.toThrow('process.exit called');

        expect(fabricFetch).not.toHaveBeenCalled();
        expect(process.exit).toHaveBeenNthCalledWith(1, exitCode);
      }
    );

    it('retrieves the key from the management endpoint instead of parsing runtime HTML', async () => {
      vi.mocked(fabricFetch).mockImplementation(async (url) =>
        String(url).startsWith(managementEndpoint)
          ? new Response(JSON.stringify({ publishableKey: 'pk-test-key' }), {
              headers: { 'Content-Type': 'application/json' },
            })
          : new Response('<html><div id="root"></div></html>', {
              headers: { 'Content-Type': 'text/html' },
            })
      );

      const status = await readStatus();

      expect(fabricFetch).toHaveBeenCalledWith(
        `${managementEndpoint}/__private/publishable-key`,
        expect.objectContaining({
          redirect: 'manual',
        })
      );
      const requestHeaders = new Headers(
        vi.mocked(fabricFetch).mock.calls[0][1]?.headers
      );
      expect(requestHeaders.get('Authorization')).toBe('Bearer test-token');
      expect(requestHeaders.get(MONIKER_HEADER)).toBe('item-123');
      expect(fabricFetch).not.toHaveBeenCalledWith(
        `${runtimeEndpoint}/__private/publishable-key`,
        expect.anything()
      );
      expect(status.endpointHealth).toMatchObject({
        scope: 'management',
        url: `${managementEndpoint}/__private/publishable-key`,
        reachable: true,
        httpStatus: 200,
        authenticated: true,
        publishableKey: 'pk-test-key',
        metadata: { publishableKeyRetrieved: true, error: null },
        error: null,
      });
      expect(process.exit).toHaveBeenNthCalledWith(1, 0);
    });

    it.each([
      ['JSON object', '{"publishableKey":"pk-test-key"}', 'application/json'],
      ['JSON string', '"pk-test-key"', 'application/json'],
      ['plain text', '  pk-test-key\n', 'text/plain'],
    ])(
      'accepts a successful %s key response',
      async (_name, body, contentType) => {
        vi.mocked(fabricFetch).mockResolvedValue(
          new Response(body, { headers: { 'Content-Type': contentType } })
        );

        const status = await readStatus();

        expect(status.endpointHealth).toMatchObject({
          reachable: true,
          authenticated: true,
          httpStatus: 200,
          publishableKey: 'pk-test-key',
          metadata: { publishableKeyRetrieved: true, error: null },
          error: null,
        });
        expect(process.exit).toHaveBeenNthCalledWith(1, 0);
      }
    );

    it.each([
      [401, 'Unauthorized', false, 'rayfin login'],
      [403, 'Forbidden', false, 'account has access'],
      [404, 'Not Found', null, 'app still exists'],
      [500, 'Internal Server Error', null, 'Fabric service status'],
      [302, 'Found', null, 'Fabric service status'],
    ])(
      'fails the check for HTTP %s instead of reporting success',
      async (httpStatus, statusText, authenticated, hint) => {
        vi.mocked(fabricFetch).mockResolvedValue(
          new Response('', { status: httpStatus, statusText })
        );

        const status = await readStatus();

        expect(status.authenticated).toBe(true);
        expect(status.endpointHealth).toMatchObject({
          reachable: true,
          authenticated,
          httpStatus,
          error: `HTTP ${httpStatus} ${statusText}`,
          hint: expect.stringContaining(hint),
        });
        expect(process.exit).toHaveBeenNthCalledWith(1, 2);
      }
    );

    it.each([
      ['HTML fallback', '<html><div id="root"></div></html>'],
      ['malformed JSON', '{"publishableKey":'],
      ['unrecognized JSON', '{"message":"OK"}'],
      ['empty response', ''],
      ['null JSON', 'null'],
      ['non-string key', '{"publishableKey":123}'],
      ['empty key', '{"publishableKey":""}'],
      ['whitespace key', '"   "'],
    ])(
      'separates %s metadata from transport and authentication',
      async (_name, body) => {
        vi.mocked(fabricFetch).mockResolvedValue(new Response(body));

        const status = await readStatus();

        expect(status.endpointHealth).toMatchObject({
          reachable: true,
          httpStatus: 200,
          authenticated: true,
          publishableKey: null,
          metadata: {
            publishableKeyRetrieved: false,
            error: 'unexpected-format',
          },
          error: null,
        });
        expect(process.exit).toHaveBeenNthCalledWith(1, 0);
      }
    );

    it('uses the command-error exit code when configuration reading throws', async () => {
      const config = await import('../utils/config-utils.js');
      const { runUpStatusLegacy } =
        await import('../commands/up/up-status-legacy.js');
      vi.spyOn(config, 'loadRayfinConfig').mockImplementation(() => {
        throw new Error('Configuration read failed');
      });

      await expect(runUpStatusLegacy.call(upStatusCommand)).rejects.toThrow(
        'process.exit called'
      );

      expect(process.exit).toHaveBeenNthCalledWith(1, 1);
      expect(fabricFetch).not.toHaveBeenCalled();
    });

    it.each([
      [
        'connection refused',
        new Error('fetch failed', { cause: { code: 'ECONNREFUSED' } }),
        'Connection refused',
      ],
      ['network failure', new Error('fetch failed'), 'fetch failed'],
    ])(
      'reports %s without claiming endpoint authentication',
      async (_name, error, message) => {
        vi.mocked(fabricFetch).mockRejectedValue(error);

        const status = await readStatus();

        expect(status.endpointHealth).toMatchObject({
          reachable: false,
          httpStatus: null,
          authenticated: null,
          error: message,
          hint: expect.stringContaining('network access'),
        });
        expect(process.exit).toHaveBeenNthCalledWith(1, 2);
      }
    );

    it.each(['headers', 'body'])(
      'times out while waiting for response %s and clears the timer',
      async (stage) => {
        vi.useFakeTimers();
        vi.mocked(fabricFetch).mockImplementation(async (_url, options) => {
          const waitForAbort = () =>
            new Promise<string>((_resolve, reject) => {
              options?.signal?.addEventListener('abort', () => {
                reject(new globalThis.DOMException('Aborted', 'AbortError'));
              });
            });
          if (stage === 'headers') await waitForAbort();
          const response = new Response('');
          vi.spyOn(response, 'text').mockImplementation(waitForAbort);
          return response;
        });

        const pending = readStatus();
        await vi.runAllTimersAsync();
        const status = await pending;

        expect(status.endpointHealth).toMatchObject({
          reachable: stage === 'body',
          httpStatus: stage === 'body' ? 200 : null,
          error: 'Request timed out (10s)',
        });
        expect(process.exit).toHaveBeenNthCalledWith(1, 2);
        expect(vi.getTimerCount()).toBe(0);
      }
    );

    it('clears the timeout after a network failure', async () => {
      vi.useFakeTimers();
      vi.mocked(fabricFetch).mockRejectedValue(new Error('fetch failed'));

      await readStatus();

      expect(vi.getTimerCount()).toBe(0);
    });

    it('honors the canonical --output json mode', async () => {
      const root = new Command('rayfin').option('--output <mode>');
      root.addCommand(new Command('up').addCommand(upStatusCommand));
      vi.mocked(fabricFetch).mockResolvedValue(
        new Response('{"publishableKey":"pk-test-key"}')
      );

      await expect(
        root.parseAsync(['--output', 'json', 'up', 'status'], { from: 'user' })
      ).rejects.toThrow('process.exit called');

      const output = vi
        .mocked(console.log)
        .mock.calls.find(([message]) => String(message).startsWith('{'));
      expect(output).toBeDefined();
      expect(JSON.parse(String(output![0])).endpointHealth.error).toBeNull();
      expect(process.exit).toHaveBeenNthCalledWith(1, 0);
    });

    it.each(['plain', 'interactive'])(
      'shows a clean management check in %s output',
      async (mode) => {
        const root = new Command('rayfin').option('--output <mode>');
        root.addCommand(new Command('up').addCommand(upStatusCommand));
        const stderr: string[] = [];
        vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
          stderr.push(String(chunk));
          return true;
        });
        vi.mocked(fabricFetch).mockResolvedValue(new Response('pk-test-key'));

        await expect(
          root.parseAsync(['--output', mode, 'up', 'status'], { from: 'user' })
        ).rejects.toThrow('process.exit called');

        const output = [
          ...stderr,
          ...vi.mocked(console.log).mock.calls.map((args) => args.join(' ')),
        ].join('\n');
        expect(output).toContain('Management Endpoint');
        expect(output).toContain(managementEndpoint);
        expect(output).toMatch(/Status:.*Reachable/);
        expect(output).not.toMatch(/Warning:|Metadata:|Invalid JSON/);
        expect(process.exit).toHaveBeenNthCalledWith(1, 0);
      }
    );

    it('reports a reachable HTTP failure with an authentication recovery hint', async () => {
      const stderr: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
      vi.mocked(fabricFetch).mockResolvedValue(
        new Response('', { status: 401, statusText: 'Unauthorized' })
      );

      await expect(
        upStatusCommand.parseAsync(['status'], { from: 'user' })
      ).rejects.toThrow('process.exit called');

      const output = [
        ...stderr,
        ...vi.mocked(console.error).mock.calls.map((args) => args.join(' ')),
      ].join('\n');
      expect(output).toContain('Check failed (endpoint reachable)');
      expect(output).toContain('HTTP 401 Unauthorized');
      expect(output).toContain("Run 'rayfin login'");
      expect(output).not.toContain('Endpoint is unreachable');
      expect(output).not.toContain('Re-deploy');
      expect(process.exit).toHaveBeenNthCalledWith(1, 2);
    });
  });
});
