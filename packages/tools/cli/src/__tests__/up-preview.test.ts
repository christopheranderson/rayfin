import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StaticHostingConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import { runEnsureUserLicenseWorkflow } from '@microsoft/rayfin-tools-common/_internal/workflows/ensure-user-license';
import { runUpWorkflow } from '@microsoft/rayfin-tools-common/_internal/workflows/up';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

import { ensureAuthenticated } from '../auth/index.js';
import { up } from '../commands/up/up.js';
import { CliHandledError } from '../errors.js';
import { RayfinItemManager } from '../services/fabric/rayfin-item.js';
import { writeDeploymentEnvFile } from '../utils/env-fabric-utils.js';
import type { OutputMode } from '../utils/output-mode.js';

const state = vi.hoisted(() => ({
  legacy: false,
  anonStatic: false,
  projectRoot: '',
}));

vi.mock('../auth/index.js', () => ({
  ensureAuthenticated: vi.fn(),
  loadAuthState: vi.fn(async () => null),
}));
vi.mock('../commands/up/up-storage.js', async () => {
  const { Command } = await import('commander');
  return { upStorageCommand: new Command('storage') };
});
vi.mock('../services/connector-generator.js', () => ({
  generateConnectorDabConfigs: vi.fn(),
}));
vi.mock('../rayfin-services/index.js', () => ({
  createCliFrameworkEnvService: vi.fn(),
  createCliStorageService: vi.fn(),
}));
vi.mock('../utils/connector-apply.js', () => ({
  applyConnectorConfigs: vi.fn(),
  detectConnectorEntityCollisions: vi.fn(() => []),
  detectReservedConnectorEntityNames: vi.fn(() => []),
  formatConnectorEntityCollisionError: vi.fn(),
  formatReservedConnectorEntityNameError: vi.fn(),
  selectConnectorsToApply: vi.fn(() => []),
}));
vi.mock('../utils/dab-config-generator.js', () => ({
  generateDabConfig: vi.fn(),
}));
vi.mock('../utils/project-utils.js', () => ({
  findRayfinProjectRoot: vi.fn(() => state.projectRoot),
}));
vi.mock('../utils/feature-flags.js', () => ({
  createCliFeatureFlags: vi.fn(() => ({
    get: (name: string) =>
      (name === 'up-legacy' && state.legacy) ||
      (name === 'cli-up-anonstatic' && state.anonStatic),
  })),
}));
vi.mock('../diagnostics/session.js', () => ({
  createCliDiagnosticSession: vi.fn(async () => ({
    diagnostics: { debug: vi.fn() },
    close: vi.fn(),
  })),
}));
vi.mock('../config/constants.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../config/constants.js')>();
  return {
    ...actual,
    getFabricSettings: () => ({
      ...actual.DEFAULT_FABRIC_SETTINGS,
      fabricApiBaseUrl: 'https://api.fabric.microsoft.com/v1',
      fabricPortalUrl: 'https://app.fabric.microsoft.com',
    }),
  };
});
vi.mock(
  '@microsoft/rayfin-tools-common/_internal/workflows/ensure-user-license',
  () => ({
    runEnsureUserLicenseWorkflow: vi.fn(),
  })
);
vi.mock(
  '@microsoft/rayfin-tools-common/_internal/workflows/up',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@microsoft/rayfin-tools-common/_internal/workflows/up')
      >();
    return {
      ...actual,
      runUpWorkflow: vi.fn(async () => {
        throw new Error('A preview must not run the deployment workflow');
      }),
    };
  }
);

const workspaceId = '11111111-1111-4111-8111-111111111111';
const workspaceName = 'Preview Workspace';
const apiUrl = 'https://api.fabric.microsoft.com/v1/workspaces';
const outputs: OutputMode[] = ['interactive', 'plain', 'json'];

async function snapshot(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, content] of Object.entries(await snapshot(path))) {
        files[join(entry.name, name)] = content;
      }
    } else {
      files[entry.name] = await readFile(path, 'utf8');
    }
  }
  return files;
}

async function writeConfig(
  overrides: Partial<StaticHostingConfig> = {}
): Promise<void> {
  await writeFile(
    join(state.projectRoot, 'rayfin', 'rayfin.yml'),
    stringify({
      id: 'preview-app',
      name: 'Preview App',
      version: '1.0.0',
      services: {
        auth: { enabled: false },
        data: { enabled: false },
        staticHosting: {
          enabled: true,
          path: 'packages/frontend',
          folder: 'dist',
          buildCommand:
            "node -e \"require('node:fs').writeFileSync('build-ran', 'yes')\"",
          ...overrides,
        },
      },
    })
  );
}

function preview(
  mode: OutputMode,
  target: string[] = ['--workspace-id', workspaceId],
  extra: string[] = []
): Promise<Command> {
  const command = new Command()
    .option('--output <mode>')
    .option('--json')
    .addCommand(up());
  return command.parseAsync([
    'node',
    'rayfin',
    '--output',
    mode,
    'up',
    '-n',
    '-y',
    ...target,
    ...extra,
  ]);
}

describe.each(['workflow', 'legacy'] as const)(
  '%s deployment preview',
  (path) => {
    let stdout: string[];
    let stderr: string[];
    let logs: string[];
    let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

    beforeEach(async () => {
      vi.clearAllMocks();
      state.legacy = path === 'legacy';
      state.anonStatic = false;
      state.projectRoot = await mkdtemp(join(tmpdir(), 'rayfin-up-preview-'));
      await mkdir(join(state.projectRoot, 'rayfin'));
      await mkdir(join(state.projectRoot, 'packages', 'frontend'), {
        recursive: true,
      });
      await writeConfig();
      vi.stubEnv('RAYFIN_WORKSPACE_ID', '');
      vi.stubEnv('RAYFIN_WORKSPACE_NAME', '');
      vi.stubEnv('RAYFIN_TELEMETRY_OPTOUT', '1');
      vi.mocked(ensureAuthenticated).mockResolvedValue({
        token: 'synthetic-test-token',
        expiresOnTimestamp: 0,
        identityType: 'user',
        tenantId: 'tenant-preview',
      });
      vi.mocked(runEnsureUserLicenseWorkflow).mockResolvedValue({
        status: 'ok',
        data: { outcome: 'licensed' },
      });
      vi.spyOn(RayfinItemManager.prototype, 'getOrCreateRayfinItem');
      vi.spyOn(RayfinItemManager.prototype, 'createRayfinItem');
      vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('Unexpected process.exit in preview');
      });
      fetchMock = vi.fn<typeof fetch>(async (input, init) => {
        expect(init?.method ?? 'GET').toBe('GET');
        const url = String(input);
        if (url === `${apiUrl}/${workspaceId}`) {
          return Response.json({ id: workspaceId, displayName: workspaceName });
        }
        if (url === apiUrl) {
          return Response.json({
            value: [{ id: workspaceId, displayName: workspaceName }],
          });
        }
        throw new Error(`Unexpected preview request: ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);
      stdout = [];
      stderr = [];
      logs = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdout.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
      vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.join(' '));
      });
      vi.spyOn(console, 'error').mockImplementation((...args) => {
        stderr.push(args.join(' '));
      });
      vi.spyOn(console, 'warn').mockImplementation((...args) => {
        stderr.push(args.join(' '));
      });
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      await rm(state.projectRoot, { recursive: true, force: true });
    });

    function expectNoProvisioning(): void {
      expect(runUpWorkflow).not.toHaveBeenCalled();
      expect(
        RayfinItemManager.prototype.getOrCreateRayfinItem
      ).not.toHaveBeenCalled();
      expect(
        RayfinItemManager.prototype.createRayfinItem
      ).not.toHaveBeenCalled();
    }

    it.each(outputs)(
      'shows the resolved workspace and explicit item name in %s without building or writing',
      async (mode) => {
        const before = await snapshot(state.projectRoot);

        await preview(mode, undefined, [
          '--force',
          '--item-name',
          'preview-backend',
        ]);

        expect(ensureAuthenticated).toHaveBeenCalledOnce();
        expect(fetchMock).toHaveBeenCalledOnce();
        expectNoProvisioning();
        expect(await snapshot(state.projectRoot)).toEqual(before);
        if (mode === 'json') {
          expect(stdout).toHaveLength(1);
          expect(logs).toEqual([]);
          expect(stdout[0]).not.toContain('\u001b');
          expect(JSON.parse(stdout[0])).toMatchObject({
            status: 'dry-run',
            blocked: false,
            plan: {
              projectName: 'preview-app',
              itemName: 'preview-backend',
              workspaceId,
              workspaceName,
              services: { staticHosting: true },
            },
          });
          expect(JSON.parse(stdout[0]).plan).not.toHaveProperty('itemId');
        } else {
          const text = [...logs, ...stderr].join('\n');
          const target = `Workspace: "${workspaceName}" (ID: ${workspaceId})`;
          expect(text).toContain(target);
          expect(text.indexOf(target)).toBeLessThan(
            text.indexOf('Planned operations:')
          );
          expect(text).toContain(
            'Create or reuse Rayfin item "preview-backend" (AppBackend)'
          );
          expect(text).not.toContain('No API calls');
        }
      }
    );

    it.each(outputs)(
      'rejects a missing static package in %s before auth or remote reads',
      async (mode) => {
        await writeConfig({ path: 'packages/frontend-missing' });
        const before = await snapshot(state.projectRoot);

        await expect(preview(mode)).rejects.toBeInstanceOf(CliHandledError);

        const error =
          mode === 'json' ? JSON.parse(stdout[0]).error : stderr.join('\n');
        expect(error).toContain(
          "Service 'staticHosting' path 'packages/frontend-missing'"
        );
        expect(error).toContain(
          join(state.projectRoot, 'packages', 'frontend-missing')
        );
        expect(error).toContain('Check services.staticHosting.path');
        if (mode === 'json') {
          expect(stdout).toHaveLength(1);
          expect(JSON.parse(stdout[0]).status).toBe('error');
        }
        expect(ensureAuthenticated).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
        expectNoProvisioning();
        expect(await snapshot(state.projectRoot)).toEqual(before);
      }
    );

    it('rejects a static root outside its service path before auth or remote reads', async () => {
      await mkdir(join(state.projectRoot, 'packages', 'outside'), {
        recursive: true,
      });
      await writeConfig({ root: '../outside' });
      const before = await snapshot(state.projectRoot);

      await expect(preview('json')).rejects.toThrow(
        "Service 'staticHosting' root '../outside' escapes the service root"
      );

      expect(stdout).toHaveLength(1);
      const error = JSON.parse(stdout[0]).error as string;
      expect(error).toContain(
        "Service 'staticHosting' root '../outside' escapes the service root"
      );
      expect(error).toContain(join(state.projectRoot, 'packages', 'outside'));
      expect(ensureAuthenticated).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expectNoProvisioning();
      expect(await snapshot(state.projectRoot)).toEqual(before);
    });

    it('requires existing output only when no build command is configured', async () => {
      await writeConfig({ buildCommand: undefined });
      await expect(preview('json')).rejects.toThrow('Static folder not found');
      expect(ensureAuthenticated).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expectNoProvisioning();
    });

    it('reports the missing path even when access-posture preflight would also block', async () => {
      state.anonStatic = true;
      await writeConfig({ path: 'packages/frontend-missing' });

      await expect(preview('json')).rejects.toThrow(
        "Service 'staticHosting' path 'packages/frontend-missing' does not exist"
      );

      expect(stdout).toHaveLength(1);
      expect(JSON.parse(stdout[0]).status).toBe('error');
      expect(ensureAuthenticated).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expectNoProvisioning();
    });

    it('warns when a blocking preflight cannot resolve an old deployment item name', async () => {
      state.anonStatic = true;
      await writeFile(
        join(state.projectRoot, 'packages', 'frontend', 'package.json'),
        JSON.stringify({
          dependencies: { '@microsoft/rayfin-auth': '1.0.0' },
        })
      );
      const installedAuthPackage = join(
        state.projectRoot,
        'packages',
        'frontend',
        'node_modules',
        '@microsoft',
        'rayfin-auth'
      );
      await mkdir(installedAuthPackage, { recursive: true });
      await writeFile(
        join(installedAuthPackage, 'package.json'),
        JSON.stringify({
          name: '@microsoft/rayfin-auth',
          version: '1.0.0',
        })
      );
      await writeDeploymentEnvFile(state.projectRoot, 'Old Workspace Name', {
        fabricWorkspaceId: workspaceId,
        rayfinItemId: '22222222-2222-4222-8222-222222222222',
        rayfinApiUrl: 'https://api.example.com',
        fabricPortalUrl: 'https://app.fabric.microsoft.com',
      });
      const before = await snapshot(state.projectRoot);

      await expect(preview('json', [])).rejects.toBeInstanceOf(CliHandledError);

      expect(stdout).toHaveLength(1);
      expect(JSON.parse(stdout[0])).toMatchObject({
        status: 'dry-run',
        blocked: true,
        plan: {
          itemName: 'preview-app',
        },
        warnings: [
          'The recorded deployment predates item-name tracking. Its current Fabric item name will be resolved during deployment.',
        ],
      });
      expect(ensureAuthenticated).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expectNoProvisioning();
      expect(await snapshot(state.projectRoot)).toEqual(before);
    });

    it.each([false, true])(
      'skips excluded static input validation (enabled: %s)',
      async (enabled) => {
        await writeConfig({ enabled, path: 'packages/frontend-missing' });
        await preview(
          'json',
          undefined,
          enabled ? ['--exclude-services', 'StaticHosting'] : []
        );
        expect(JSON.parse(stdout[0])).toMatchObject({
          status: 'dry-run',
          plan: { workspaceId, services: { staticHosting: false } },
        });
        expectNoProvisioning();
      }
    );

    it.each(outputs)(
      'fails workspace resolution in %s without provisioning or changing files',
      async (mode) => {
        fetchMock.mockResolvedValueOnce(
          Response.json({ message: 'Workspace unavailable' }, { status: 404 })
        );
        const before = await snapshot(state.projectRoot);

        await expect(preview(mode)).rejects.toBeInstanceOf(CliHandledError);

        expect(fetchMock).toHaveBeenCalledOnce();
        expectNoProvisioning();
        expect(await snapshot(state.projectRoot)).toEqual(before);
        if (mode === 'json') {
          expect(stdout).toHaveLength(1);
          expect(JSON.parse(stdout[0]).status).toBe('error');
          expect(JSON.parse(stdout[0])).not.toHaveProperty('plan');
        }
      }
    );

    it.each([
      ['--workspace', workspaceName],
      [
        '--workspace-uri',
        `https://app.fabric.microsoft.com/groups/${workspaceId}/list`,
      ],
    ])(
      'resolves %s through the same target selection used for deployment',
      async (...target) => {
        await preview('json', target);
        expect(JSON.parse(stdout[0]).plan).toMatchObject({
          workspaceId,
          workspaceName,
        });
        expectNoProvisioning();
      }
    );

    it('preserves explicit workspace precedence and authentication options', async () => {
      const tenantId = '33333333-3333-4333-8333-333333333333';
      vi.stubEnv('RAYFIN_WORKSPACE_ID', '22222222-2222-4222-8222-222222222222');

      await preview('json', undefined, [
        '--tenant',
        tenantId,
        '--encryption-fallback-enabled',
      ]);

      expect(ensureAuthenticated).toHaveBeenCalledWith(undefined, {
        tenantId,
        encryptionFallbackEnabled: true,
        ...(path === 'legacy' ? { silent: true } : {}),
      });
      expect(JSON.parse(stdout[0]).plan).toMatchObject({
        workspaceId,
        workspaceName,
      });
      expectNoProvisioning();
    });

    it('resolves a recorded deployment to its current workspace name without changing the registry', async () => {
      await writeDeploymentEnvFile(state.projectRoot, 'Old Workspace Name', {
        fabricWorkspaceId: workspaceId,
        rayfinItemId: '22222222-2222-4222-8222-222222222222',
        rayfinItemName: 'recorded-backend',
        rayfinApiUrl: 'https://api.example.com',
        fabricPortalUrl: 'https://app.fabric.microsoft.com',
      });
      stdout = [];
      const before = await snapshot(state.projectRoot);

      await preview('json', []);

      expect(stdout).toHaveLength(1);
      expect(JSON.parse(stdout[0]).plan).toMatchObject({
        itemName: 'recorded-backend',
        workspaceId,
        workspaceName,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expectNoProvisioning();
      expect(await snapshot(state.projectRoot)).toEqual(before);
    });

    it('does not report an old backend as deployed when workspace preview fails', async () => {
      await writeDeploymentEnvFile(state.projectRoot, 'Old Workspace Name', {
        fabricWorkspaceId: workspaceId,
        rayfinItemId: '22222222-2222-4222-8222-222222222222',
        rayfinApiUrl: 'https://api.example.com',
        fabricPortalUrl: 'https://app.fabric.microsoft.com',
      });
      fetchMock.mockResolvedValueOnce(
        Response.json({ message: 'Workspace unavailable' }, { status: 404 })
      );
      const before = await snapshot(state.projectRoot);

      await expect(preview('plain', [])).rejects.toBeInstanceOf(
        CliHandledError
      );

      const output = [...logs, ...stderr].join('\n');
      expect(output).not.toContain(
        'Backend services were deployed successfully'
      );
      expect(output).not.toContain('retry only the static hosting step');
      expectNoProvisioning();
      expect(await snapshot(state.projectRoot)).toEqual(before);
    });
  }
);
