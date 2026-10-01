/**
 * Unit coverage for the Layer 1 `runUpV2` wrapper. These tests pin the
 * host-shaped logic that lives only in this file — targeting precedence,
 * `--exclude-services` validation, the `--dry-run` short-circuit, and the
 * `Result` → output + exit-code mapping — which is otherwise reachable only
 * through the slow, network-bound v2 E2E axis. `runUpWorkflow`, auth, and the
 * host adapters are mocked so each test exercises only the wrapper's branching.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { noopTelemetryHandle } from '@microsoft/rayfin-tools-common/_internal/adapters';
import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import { noopDeploymentTelemetryCollector } from '@microsoft/rayfin-tools-common/_internal/services/project-telemetry';
import { InvocationContext } from '@microsoft/rayfin-tools-common/_internal/telemetry';
import { HttpError } from '@microsoft/rayfin-tools-common/_internal/utils/retry';
import { runEnsureUserLicenseWorkflow } from '@microsoft/rayfin-tools-common/_internal/workflows/ensure-user-license';
import { runFabricReadinessWorkflow } from '@microsoft/rayfin-tools-common/_internal/workflows/fabric-readiness';
import type { UpResult } from '@microsoft/rayfin-tools-common/_internal/workflows/up';
import { runUpWorkflow } from '@microsoft/rayfin-tools-common/_internal/workflows/up';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { plainProgress } from '../adapters/progress.js';
import { CliTelemetryHandle } from '../adapters/telemetry.js';
import { cliUserInteraction } from '../adapters/user-interaction.js';
import { ensureAuthenticated } from '../auth/index.js';
import {
  promptWorkspaceResolution,
  promptWorkspaceSelection,
} from '../commands/up/prompts.js';
import { createUpDeps } from '../commands/up/up-deps.js';
import {
  createConsole,
  createUpTelemetryDeps,
  runUpV2,
  type UpCommandOptions,
} from '../commands/up/up-v2.js';
import { createCliDiagnosticSession } from '../diagnostics/session.js';
import { CliCancelledError, CliHandledError } from '../errors.js';
import { getCliFabricItemById } from '../external-services/fabric/client.js';
import { createCliFabricReadinessClient } from '../external-services/fabric/index.js';
import { createCliUserLicenseService } from '../services/user-license.js';
import { getAmbientWorkspaceId } from '../utils/ambient-env.js';
import { loadRayfinConfig } from '../utils/config-utils.js';
import { listDeploymentsState } from '../utils/deployments-registry.js';
import { createCliFeatureFlags } from '../utils/feature-flags.js';
import { collectLegacyMigrationWarnings } from '../utils/migration-utils.js';
import { isInteractive } from '../utils/output-mode.js';
import { findRayfinProjectRoot } from '../utils/project-utils.js';
import { resolveWorkspaceFromList } from '../utils/resolve-workspace-name.js';

const {
  mockFeatureFlagGet,
  mockReadinessListWorkspaces,
  mockGetWorkspace,
  mockCreateItem,
  mockInspectAuthSdk,
  mockUpgradeAuthSdk,
} = vi.hoisted(() => ({
  mockFeatureFlagGet: vi.fn((_name: string) => false),
  mockReadinessListWorkspaces: vi.fn(),
  mockGetWorkspace: vi.fn(),
  mockCreateItem: vi.fn(),
  mockInspectAuthSdk: vi.fn(),
  mockUpgradeAuthSdk: vi.fn(),
}));

// Mock ora so `createConsole`'s interactive row does not start a live spinner.
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn(),
    isSpinning: false,
  })),
}));
vi.mock(
  '@microsoft/rayfin-tools-common/_internal/workflows/fabric-readiness',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@microsoft/rayfin-tools-common/_internal/workflows/fabric-readiness')
      >();
    return { ...actual, runFabricReadinessWorkflow: vi.fn() };
  }
);
vi.mock(
  '@microsoft/rayfin-tools-common/_internal/workflows/up',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@microsoft/rayfin-tools-common/_internal/workflows/up')
      >();
    return { ...actual, runUpWorkflow: vi.fn() };
  }
);
vi.mock(
  '@microsoft/rayfin-tools-common/_internal/workflows/ensure-user-license',
  () => ({
    runEnsureUserLicenseWorkflow: vi.fn(),
  })
);
vi.mock('../auth/index.js', () => ({
  ensureAuthenticated: vi.fn(),
}));
vi.mock('../commands/up/up-deps.js', () => ({
  createUpDeps: vi.fn(() => ({ dispose: vi.fn() })),
}));
vi.mock('../diagnostics/session.js', () => ({
  createCliDiagnosticSession: vi.fn(),
}));
vi.mock('../commands/up/prompts.js', () => ({
  promptWorkspaceResolution: vi.fn(),
  promptWorkspaceSelection: vi.fn(),
}));
vi.mock('../external-services/fabric/client.js', () => ({
  getCliFabricItemById: vi.fn(),
}));
vi.mock('../services/user-license.js', () => ({
  createCliUserLicenseService: vi.fn(async () => ({
    ensureUserHasLicense: vi.fn(),
  })),
}));
vi.mock('../rayfin-services/auth-sdk.js', () => ({
  createCliAuthSdkService: vi.fn(() => ({
    inspect: mockInspectAuthSdk,
    upgrade: mockUpgradeAuthSdk,
  })),
}));
vi.mock('../config/constants.js', () => ({
  getFabricSettings: vi.fn(() => ({ fabricPortalUrl: 'https://portal.test' })),
}));
vi.mock('../external-services/fabric/index.js', () => ({
  createCliFabricClient: vi.fn(() => ({
    getWorkspace: mockGetWorkspace,
    listWorkspaces: vi.fn(),
    getItemByName: vi.fn(),
    createItem: mockCreateItem,
  })),
  createCliFabricReadinessClient: vi.fn(() => ({
    listWorkspaces: mockReadinessListWorkspaces,
  })),
  createCliRayfinWorkloadClient: vi.fn(() => ({})),
}));
vi.mock('../utils/ambient-env.js', () => ({
  getAmbientTenantId: vi.fn(() => null),
  getAmbientWorkspaceId: vi.fn(),
}));
vi.mock('../utils/config-utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/config-utils.js')>();
  return { ...actual, loadRayfinConfig: vi.fn() };
});
vi.mock('../utils/deployments-registry.js', () => ({
  listDeploymentsState: vi.fn(() => ({ deployments: [], warnings: [] })),
}));
vi.mock('../utils/feature-flags.js', () => ({
  createCliFeatureFlags: vi.fn(() => ({ get: mockFeatureFlagGet })),
}));
vi.mock('../utils/migration-utils.js', () => ({
  collectLegacyMigrationWarnings: vi.fn(() => []),
}));
// Partially mock output-mode so `isInteractive` is controllable per test; every
// other helper (emitJson, modeLog, resolveOutputMode, …) keeps real behavior so
// the render and exit-code assertions below still exercise the true path.
vi.mock('../utils/output-mode.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/output-mode.js')>();
  return { ...actual, isInteractive: vi.fn(() => false) };
});
vi.mock('../utils/project-utils.js', () => ({
  findRayfinProjectRoot: vi.fn(() => '/proj'),
}));
vi.mock('../utils/resolve-workspace-name.js', () => ({
  resolveWorkspaceFromList: vi.fn(),
}));
const mockRunUpWorkflow = runUpWorkflow as ReturnType<typeof vi.fn>;
const mockRunFabricReadinessWorkflow = runFabricReadinessWorkflow as ReturnType<
  typeof vi.fn
>;

function mockReadinessResult(result: unknown, notices: unknown[] = []): void {
  mockRunFabricReadinessWorkflow.mockResolvedValue({
    status: 'ok',
    data: { result, notices },
  });
}
const mockRunEnsureUserLicenseWorkflow = vi.mocked(
  runEnsureUserLicenseWorkflow
);

describe('createUpTelemetryDeps', () => {
  it('uses no-op dependencies when telemetry is disabled', () => {
    expect(createUpTelemetryDeps(undefined)).toEqual({
      telemetry: noopTelemetryHandle,
      projectTelemetry: noopDeploymentTelemetryCollector,
    });
  });

  it('uses real dependencies when telemetry is enabled', () => {
    const invocationContext = new InvocationContext(
      'rayfin-cli',
      '1.35.0-alpha'
    );

    const { telemetry, projectTelemetry } =
      createUpTelemetryDeps(invocationContext);

    expect(telemetry).toBeInstanceOf(CliTelemetryHandle);
    expect(projectTelemetry).not.toBe(noopDeploymentTelemetryCollector);
    expect(projectTelemetry.collectDeploymentTelemetry).toEqual(
      expect.any(Function)
    );
    expect(projectTelemetry).toHaveProperty(
      'persistProjectOrigin',
      expect.any(Function)
    );
  });
});
const mockEnsureAuthenticated = ensureAuthenticated as ReturnType<typeof vi.fn>;
const mockGetCliFabricItemById = getCliFabricItemById as ReturnType<
  typeof vi.fn
>;
const mockPromptWorkspaceSelection = promptWorkspaceSelection as ReturnType<
  typeof vi.fn
>;
const mockPromptWorkspaceResolution = promptWorkspaceResolution as ReturnType<
  typeof vi.fn
>;
const mockGetAmbientWorkspaceId = getAmbientWorkspaceId as ReturnType<
  typeof vi.fn
>;
const mockLoadRayfinConfig = loadRayfinConfig as ReturnType<typeof vi.fn>;
const mockListDeploymentsState = listDeploymentsState as ReturnType<
  typeof vi.fn
>;
const mockCollectLegacyMigrationWarnings =
  collectLegacyMigrationWarnings as ReturnType<typeof vi.fn>;
const mockResolveWorkspaceFromList = resolveWorkspaceFromList as ReturnType<
  typeof vi.fn
>;
const mockCreateCliFabricReadinessClient =
  createCliFabricReadinessClient as ReturnType<typeof vi.fn>;
const mockIsInteractive = isInteractive as ReturnType<typeof vi.fn>;

const BASE_CONFIG = {
  id: 'proj',
  services: {
    auth: { enabled: false },
    data: { enabled: false },
  },
} as unknown as RayfinConfig;

const SUCCESS_RESULT: UpResult = {
  itemId: 'item-1',
  itemName: 'proj',
  apiUrl: 'https://api.test/item-1',
  workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
  workspaceName: 'Workspace',
  workspaceKey: 'workspace',
  workspaceCreated: false,
  trialStarted: false,
  capacityAssigned: false,
  portalUrl: 'https://portal.test/ws-explicit',
  configUpdated: false,
  excludedServices: [],
  generate: [],
};

const INVALID_FUNCTIONS_AUTH_ERROR =
  'Invalid services.functions.auth.type: found "managedIdentity". ' +
  'Only application authentication is supported. ' +
  'Set services.functions.auth.type to "application".';

function makeOptions(overrides: Partial<UpCommandOptions>): UpCommandOptions {
  // Validation tests call runUpV2 directly with deliberately invalid IDs.
  if (overrides.workspaceId === 'ws-explicit') {
    return { ...overrides, workspaceId: SUCCESS_RESULT.workspaceId };
  }
  return { ...overrides };
}

let stdoutWrites: string[] = [];
let savedFabricApiUrl: string | undefined;
let savedFabricPortalUrl: string | undefined;

/** Parse the JSON object from the last `process.stdout.write` call. */
function parseLastJson(): unknown {
  expect(stdoutWrites.length).toBeGreaterThan(0);
  return JSON.parse(stdoutWrites[stdoutWrites.length - 1].trim());
}

describe('runUpV2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    savedFabricApiUrl = process.env.RAYFIN_FABRIC_API_URL;
    savedFabricPortalUrl = process.env.RAYFIN_FABRIC_PORTAL_URL;
    delete process.env.RAYFIN_FABRIC_API_URL;
    delete process.env.RAYFIN_FABRIC_PORTAL_URL;
    vi.stubEnv('RAYFIN_WORKSPACE_NAME', '');
    vi.mocked(createCliDiagnosticSession).mockResolvedValue({
      diagnostics: { debug: vi.fn() },
      close: vi.fn().mockResolvedValue(undefined),
    });
    mockFeatureFlagGet.mockReturnValue(false);
    mockInspectAuthSdk.mockResolvedValue({ state: 'satisfied' });
    mockUpgradeAuthSdk.mockResolvedValue({ status: 'upgraded' });
    mockRunEnsureUserLicenseWorkflow.mockResolvedValue({
      status: 'ok',
      data: { outcome: 'licensed' },
    });
    mockRunFabricReadinessWorkflow.mockImplementation(
      async ({ workspaceId }: { workspaceId?: string }) =>
        workspaceId
          ? {
              status: 'ok',
              data: {
                result: {
                  status: 'ready',
                  workspace: { id: workspaceId, displayName: 'Workspace' },
                  capacityId: 'capacity-1',
                  capacitySource: 'selected-paid',
                  workspaceCreated: false,
                },
                notices: [],
              },
            }
          : {
              status: 'ok',
              data: {
                result: {
                  status: 'action-required',
                  reason: 'capacity_selection_required',
                  message: 'Choose an existing workspace.',
                  retryable: true,
                },
                notices: [],
              },
            }
    );
    mockIsInteractive.mockReturnValue(false);
    mockEnsureAuthenticated.mockResolvedValue({
      token: 'tok-abc',
      identityType: 'user',
      tenantId: 'tenant-abc',
    });
    mockGetWorkspace.mockImplementation(async (id: string) => ({
      id,
      displayName: 'Workspace',
    }));
    mockGetCliFabricItemById.mockResolvedValue({
      id: 'item-1',
      displayName: 'proj',
      type: 'AppBackend',
      workspaceId: SUCCESS_RESULT.workspaceId,
    });
    mockLoadRayfinConfig.mockReturnValue(BASE_CONFIG);
    mockListDeploymentsState.mockReturnValue({
      deployments: [],
      warnings: [],
    });
    mockGetAmbientWorkspaceId.mockReturnValue(null);
    mockRunUpWorkflow.mockResolvedValue({ status: 'ok', data: SUCCESS_RESULT });
    mockPromptWorkspaceResolution.mockResolvedValue('new');
    stdoutWrites = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    if (savedFabricApiUrl === undefined) {
      delete process.env.RAYFIN_FABRIC_API_URL;
    } else {
      process.env.RAYFIN_FABRIC_API_URL = savedFabricApiUrl;
    }
    if (savedFabricPortalUrl === undefined) {
      delete process.env.RAYFIN_FABRIC_PORTAL_URL;
    } else {
      process.env.RAYFIN_FABRIC_PORTAL_URL = savedFabricPortalUrl;
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    ['json', false],
    ['json', true],
    ['plain', false],
    ['plain', true],
    ['interactive', false],
    ['interactive', true],
  ] as const)(
    'rejects URL workspace IDs before auth in %s output (dry run: %s)',
    async (output, dryRun) => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        runUpV2({
          output,
          dryRun,
          workspaceId:
            'https://app.powerbi.com/groups/767f94fa-1106-4377-8fb4-bb931907444a/list',
        })
      ).rejects.toBeInstanceOf(CliHandledError);

      expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
      expect(mockLoadRayfinConfig).not.toHaveBeenCalled();
      expect(mockRunUpWorkflow).not.toHaveBeenCalled();
      if (output === 'json') {
        expect(stdoutWrites).toHaveLength(1);
        expect(parseLastJson()).toEqual({
          status: 'error',
          error: expect.stringContaining('--workspace-uri <url>'),
        });
      } else {
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('--workspace-id must be a GUID')
        );
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('--workspace-uri <url>')
        );
      }
    }
  );

  it('rejects an invalid capacity ID before authentication', async () => {
    await expect(
      runUpV2({ output: 'json', capacityId: 'not-a-guid' })
    ).rejects.toBeInstanceOf(CliHandledError);

    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
    expect(parseLastJson()).toMatchObject({
      status: 'error',
      code: 'invalid-capacity-id',
      error: expect.stringContaining('--capacity-id must be a GUID'),
    });
  });

  it.each([
    {
      workspaceOption: '--workspace',
      options: { workspace: 'My Workspace' },
    },
    {
      workspaceOption: '--workspace-id',
      options: { workspaceId: SUCCESS_RESULT.workspaceId },
    },
    {
      workspaceOption: '--workspace-uri',
      options: {
        workspaceUri: `https://app.powerbi.com/groups/${SUCCESS_RESULT.workspaceId}`,
      },
    },
  ])(
    'rejects $workspaceOption with --capacity-id before authentication',
    async ({ workspaceOption, options }) => {
      await expect(
        runUpV2({
          output: 'json',
          ...options,
          capacityId: '11111111-1111-4111-8111-111111111111',
        })
      ).rejects.toBeInstanceOf(CliHandledError);

      expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
      expect(mockRunUpWorkflow).not.toHaveBeenCalled();
      expect(parseLastJson()).toMatchObject({
        status: 'error',
        code: 'capacity-target-conflict',
        error: expect.stringContaining(
          `${workspaceOption} and --capacity-id cannot be used together`
        ),
      });
    }
  );

  it('rejects RAYFIN_WORKSPACE_ID with --capacity-id before authentication', async () => {
    mockGetAmbientWorkspaceId.mockReturnValue(SUCCESS_RESULT.workspaceId);

    await expect(
      runUpV2({
        output: 'json',
        capacityId: '11111111-1111-4111-8111-111111111111',
      })
    ).rejects.toBeInstanceOf(CliHandledError);

    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
    expect(mockRunFabricReadinessWorkflow).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
    expect(parseLastJson()).toMatchObject({
      status: 'error',
      code: 'capacity-target-conflict',
      error: expect.stringContaining(
        'RAYFIN_WORKSPACE_ID and --capacity-id cannot be used together'
      ),
    });
  });

  it('rejects --capacity-id when the env file supplies RAYFIN_WORKSPACE_ID', async () => {
    mockLoadRayfinConfig.mockImplementationOnce(() => {
      mockGetAmbientWorkspaceId.mockReturnValue(SUCCESS_RESULT.workspaceId);
      return BASE_CONFIG;
    });

    await expect(
      runUpV2({
        output: 'json',
        capacityId: '11111111-1111-4111-8111-111111111111',
      })
    ).rejects.toBeInstanceOf(CliHandledError);

    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
    expect(mockRunFabricReadinessWorkflow).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
    expect(parseLastJson()).toMatchObject({
      status: 'error',
      code: 'capacity-target-conflict',
      error: expect.stringContaining('Unset RAYFIN_WORKSPACE_ID'),
    });
  });

  it('keeps the JSON code aligned with the first capacity validation error', async () => {
    await expect(
      runUpV2({
        output: 'json',
        workspaceId: SUCCESS_RESULT.workspaceId,
        capacityId: 'not-a-guid',
      })
    ).rejects.toBeInstanceOf(CliHandledError);

    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
    expect(parseLastJson()).toMatchObject({
      status: 'error',
      code: 'invalid-capacity-id',
      error: expect.stringContaining('--capacity-id must be a GUID'),
    });
  });

  it.each([
    ['interactive', false],
    ['plain', false],
    ['json', false],
    ['interactive', true],
    ['plain', true],
  ] as const)(
    'persists a sanitized failure in %s mode with verbose=%s',
    async (output, verbose) => {
      const configDir = await mkdtemp(join(tmpdir(), 'up-diagnostics-'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const actual = await vi.importActual<
        typeof import('../diagnostics/session.js')
      >('../diagnostics/session.js');
      vi.mocked(createCliDiagnosticSession).mockImplementationOnce((options) =>
        actual.createCliDiagnosticSession({ ...options, configDir })
      );
      const dispose = vi.fn();
      vi.mocked(createUpDeps).mockImplementationOnce((options) => {
        options.diagnostics.debug({
          area: 'build.stderr',
          message: 'compiler detail Bearer private-token',
        });
        return {
          dispose,
        } as unknown as ReturnType<typeof createUpDeps>;
      });
      mockRunUpWorkflow.mockResolvedValueOnce({
        status: 'failed',
        error: { code: 'up-failed', message: 'Build failed' },
      });
      try {
        await expect(
          runUpV2(makeOptions({ output, verbose, workspaceId: 'ws-explicit' }))
        ).rejects.toThrow('Build failed');
        expect(dispose).toHaveBeenCalledOnce();
        const session = await vi.mocked(createCliDiagnosticSession).mock
          .results[0].value;
        const content = await readFile(session.logPath, 'utf8');
        expect(content).toContain('compiler detail Bearer [REDACTED]');
        expect(content).toContain('Command completed');
        expect(content).toContain('"status":"failed"');
        expect(content).not.toContain('private-token');
        const stderr = vi
          .mocked(process.stderr.write)
          .mock.calls.map(([chunk]) => String(chunk))
          .join('');
        expect(stderr.includes('compiler detail')).toBe(verbose);
        expect(stderr).not.toContain('private-token');
        if (output === 'json') {
          expect(stdoutWrites).toHaveLength(1);
          expect(parseLastJson()).toMatchObject({
            status: 'error',
            diagnosticLog: session.logPath,
          });
        } else {
          expect(errorSpy).toHaveBeenCalledWith(
            `   Diagnostic log: ${session.logPath}`
          );
        }
      } finally {
        await rm(configDir, { recursive: true, force: true });
      }
    }
  );

  it.each(['app', 'dxt', 'msit'])(
    'accepts %s.powerbi.com workspace URLs through the v2 wrapper',
    async (environment) => {
      vi.stubEnv('RAYFIN_FABRIC_API_URL', '');
      vi.stubEnv('RAYFIN_FABRIC_PORTAL_URL', '');
      const workspaceId = '767f94fa-1106-4377-8fb4-bb931907444a';

      await runUpV2({
        output: 'json',
        workspaceUri: `https://${environment}.powerbi.com/groups/${workspaceId}/list?experience=power-bi`,
      });

      expect(mockRunUpWorkflow).toHaveBeenCalledTimes(1);
      expect(mockRunUpWorkflow.mock.calls[0][0].workspaceId).toBe(workspaceId);
      expect(mockResolveWorkspaceFromList).not.toHaveBeenCalled();
      expect(process.env.RAYFIN_FABRIC_API_URL).toBe(
        `https://${environment === 'app' ? '' : environment}api.fabric.microsoft.com/v1`
      );
      expect(process.env.RAYFIN_FABRIC_PORTAL_URL).toBe(
        environment === 'msit'
          ? 'https://msit.powerbi.com/'
          : `https://${environment}.fabric.microsoft.com/`
      );
    }
  );

  it('persists configuration failures before authentication and returns the log in JSON', async () => {
    const configDir = await mkdtemp(
      join(tmpdir(), 'up-preflight-diagnostics-')
    );
    const actual = await vi.importActual<
      typeof import('../diagnostics/session.js')
    >('../diagnostics/session.js');
    vi.mocked(createCliDiagnosticSession).mockImplementationOnce((options) =>
      actual.createCliDiagnosticSession({ ...options, configDir })
    );
    mockLoadRayfinConfig.mockImplementationOnce(() => {
      throw new Error('Invalid deployment configuration');
    });
    try {
      await expect(runUpV2({ output: 'json' })).rejects.toThrow(
        'Invalid deployment configuration'
      );
      const session = await vi.mocked(createCliDiagnosticSession).mock
        .results[0].value;
      const content = await readFile(session.logPath, 'utf8');
      expect(content).toContain('Invalid deployment configuration');
      expect(content).toContain('Command completed');
      expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
      expect(stdoutWrites).toHaveLength(1);
      expect(parseLastJson()).toMatchObject({ diagnosticLog: session.logPath });
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it.each(['ok', 'cancelled'] as const)(
    'flushes the %s workflow outcome before returning',
    async (status) => {
      mockRunUpWorkflow.mockResolvedValueOnce({ status, data: SUCCESS_RESULT });
      await runUpV2(
        makeOptions({ output: 'json', workspaceId: 'ws-explicit' })
      );
      const session = await vi.mocked(createCliDiagnosticSession).mock
        .results[0].value;
      expect(session.close).toHaveBeenCalledWith({
        status: status === 'ok' ? 'success' : 'cancelled',
        exitCode: 0,
      });
    }
  );

  it.each(['authentication', 'configuration', 'workspace'] as const)(
    'preserves the original %s failure in the thrown error and diagnostic session',
    async (stage) => {
      const error = Object.assign(new TypeError('Operation unavailable'), {
        code: 'E_ORIGINAL',
      });
      if (stage === 'authentication')
        mockEnsureAuthenticated.mockRejectedValueOnce(error);
      if (stage === 'configuration')
        mockLoadRayfinConfig.mockImplementationOnce(() => {
          throw error;
        });
      if (stage === 'workspace')
        mockReadinessListWorkspaces.mockRejectedValueOnce(error);
      const failure = await runUpV2({
        output: 'json',
        workspace: 'workspace',
      }).catch((caught: unknown) => caught);
      expect(failure).toBeInstanceOf(CliHandledError);
      expect((failure as CliHandledError).originalError).toBe(error);
      expect(stdoutWrites).toHaveLength(1);
      expect(parseLastJson()).toMatchObject({ error: error.message });
      const session = await vi.mocked(createCliDiagnosticSession).mock
        .results[0].value;
      expect(session.close).toHaveBeenCalledWith({
        status: 'failed',
        exitCode: 1,
        error,
      });
    }
  );

  it('(a) prefers an explicit --workspace-id over ambient env targeting', async () => {
    mockGetAmbientWorkspaceId.mockReturnValue('ws-ambient');
    vi.stubEnv('RAYFIN_WORKSPACE_NAME', 'Scaffold Workspace');

    await runUpV2(
      makeOptions({
        output: 'json',
        workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
      })
    );

    expect(mockRunUpWorkflow).toHaveBeenCalledTimes(1);
    const request = mockRunUpWorkflow.mock.calls[0][0];
    expect(request.workspaceId).toBe('767f94fa-1106-4377-8fb4-bb931907444a');
    expect(createCliUserLicenseService).toHaveBeenCalledOnce();
    // The explicit-id branch resolves first, so ambient env is never consulted.
    expect(mockGetAmbientWorkspaceId).not.toHaveBeenCalled();
  });

  it('passes an explicit Fabric item name to the workflow', async () => {
    await runUpV2(
      makeOptions({
        output: 'json',
        workspaceId: SUCCESS_RESULT.workspaceId,
        itemName: '  unique-app  ',
      })
    );

    const request = mockRunUpWorkflow.mock.calls[0][0];
    expect(request.itemName).toBe('unique-app');
    expect(request.config.id).toBe('proj');
  });

  it('reuses the recorded Fabric item name when no override is passed', async () => {
    mockListDeploymentsState.mockReturnValue({
      deployments: [
        {
          workspaceName: 'workspace',
          active: true,
          record: {
            itemId: 'item-1',
            itemName: 'recorded-app',
            apiUrl: 'https://api.test/item-1',
            workspaceId: SUCCESS_RESULT.workspaceId,
          },
        },
      ],
      warnings: [],
    });

    await runUpV2(makeOptions({ output: 'json', workspaceId: 'ws-explicit' }));

    const request = mockRunUpWorkflow.mock.calls[0][0];
    expect(request.itemName).toBe('recorded-app');
    expect(request.knownItemId).toBe('item-1');
  });

  it('rejects changing the name of a recorded workspace deployment', async () => {
    mockListDeploymentsState.mockReturnValue({
      deployments: [
        {
          workspaceName: 'workspace',
          active: true,
          record: {
            itemId: 'item-1',
            itemName: 'recorded-app',
            apiUrl: 'https://api.test/item-1',
            workspaceId: SUCCESS_RESULT.workspaceId,
          },
        },
      ],
      warnings: [],
    });
    const notice = {
      kind: 'capacity-assigned' as const,
      workspaceId: SUCCESS_RESULT.workspaceId,
      workspaceName: 'Workspace',
      capacityId: 'capacity-1',
      capacityName: 'Capacity',
    };
    mockReadinessResult(
      {
        status: 'ready',
        workspace: {
          id: SUCCESS_RESULT.workspaceId,
          displayName: 'Workspace',
        },
        capacityId: 'capacity-1',
        capacitySource: 'selected-paid',
        workspaceCreated: false,
      },
      [notice]
    );

    await expect(
      runUpV2(
        makeOptions({
          output: 'json',
          workspaceId: 'ws-explicit',
          itemName: 'different-app',
        })
      )
    ).rejects.toThrow(CliHandledError);

    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
    expect(parseLastJson()).toMatchObject({
      status: 'error',
      error: expect.stringContaining(
        'This project already deploys to "recorded-app"'
      ),
    });
  });

  it('resolves the current Fabric name for a legacy record', async () => {
    mockListDeploymentsState.mockReturnValue({
      deployments: [
        {
          workspaceName: 'workspace',
          active: true,
          record: {
            itemId: 'item-1',
            apiUrl: 'https://api.test/item-1',
            workspaceId: SUCCESS_RESULT.workspaceId,
          },
        },
      ],
      warnings: [],
    });
    mockGetCliFabricItemById.mockResolvedValue({
      id: 'item-1',
      displayName: 'existing-backend',
      type: 'AppBackend',
      workspaceId: SUCCESS_RESULT.workspaceId,
    });

    await runUpV2(
      makeOptions({
        output: 'json',
        workspaceId: 'ws-explicit',
      })
    );

    expect(mockGetCliFabricItemById).toHaveBeenCalledWith(
      'tok-abc',
      SUCCESS_RESULT.workspaceId,
      'item-1'
    );
    expect(mockRunUpWorkflow.mock.calls[0][0]).toMatchObject({
      itemName: 'existing-backend',
      knownItemId: 'item-1',
    });
  });

  it('validates an override against the current name of a legacy record', async () => {
    mockListDeploymentsState.mockReturnValue({
      deployments: [
        {
          workspaceName: 'workspace',
          active: true,
          record: {
            itemId: 'item-1',
            apiUrl: 'https://api.test/item-1',
            workspaceId: SUCCESS_RESULT.workspaceId,
          },
        },
      ],
      warnings: [],
    });

    mockGetCliFabricItemById.mockResolvedValue({
      id: 'item-1',
      displayName: 'existing-backend',
      type: 'AppBackend',
      workspaceId: SUCCESS_RESULT.workspaceId,
    });

    await expect(
      runUpV2(
        makeOptions({
          output: 'json',
          workspaceId: SUCCESS_RESULT.workspaceId,
          itemName: 'different-app',
        })
      )
    ).rejects.toThrow(CliHandledError);

    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
    expect(parseLastJson()).toMatchObject({
      status: 'error',
      error: expect.stringContaining(
        'This project already deploys to "existing-backend"'
      ),
    });
  });

  it('fails when a recorded Fabric item no longer exists', async () => {
    mockListDeploymentsState.mockReturnValue({
      deployments: [
        {
          workspaceName: 'workspace',
          active: true,
          record: {
            itemId: 'item-1',
            apiUrl: 'https://api.test/item-1',
            workspaceId: SUCCESS_RESULT.workspaceId,
          },
        },
      ],
      warnings: [],
    });
    const notice = {
      kind: 'capacity-assigned' as const,
      workspaceId: SUCCESS_RESULT.workspaceId,
      workspaceName: 'Workspace',
      capacityId: 'capacity-1',
      capacityName: 'Capacity',
    };
    mockReadinessResult(
      {
        status: 'ready',
        workspace: {
          id: SUCCESS_RESULT.workspaceId,
          displayName: 'Workspace',
        },
        capacityId: 'capacity-1',
        capacitySource: 'selected-paid',
        workspaceCreated: false,
      },
      [notice]
    );
    mockGetCliFabricItemById.mockResolvedValue(undefined);

    await expect(runUpV2(makeOptions({ output: 'json' }))).rejects.toThrow(
      CliHandledError
    );

    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
    expect(parseLastJson()).toMatchObject({
      status: 'error',
      error: expect.stringContaining('no longer exists'),
    });
  });

  it('does not run readiness when recorded item lookup throws', async () => {
    mockListDeploymentsState.mockReturnValue({
      deployments: [
        {
          workspaceName: 'workspace',
          active: true,
          record: {
            itemId: 'item-1',
            apiUrl: 'https://api.test/item-1',
            workspaceId: SUCCESS_RESULT.workspaceId,
          },
        },
      ],
      warnings: [],
    });
    mockGetCliFabricItemById.mockRejectedValue(new Error('lookup failed'));

    await expect(runUpV2(makeOptions({ output: 'json' }))).rejects.toThrow(
      CliHandledError
    );

    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
    expect(parseLastJson()).toMatchObject({
      status: 'error',
      error: expect.stringContaining('lookup failed'),
    });
    expect(mockRunFabricReadinessWorkflow).not.toHaveBeenCalled();
  });

  it('rejects an empty item name before authentication', async () => {
    await expect(
      runUpV2(
        makeOptions({
          output: 'json',
          workspaceId: SUCCESS_RESULT.workspaceId,
          itemName: '   ',
        })
      )
    ).rejects.toThrow(CliHandledError);

    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
  });

  it('runs the license preflight', async () => {
    const workspace = {
      id: 'ws-resolved',
      displayName: 'Workspace',
    };
    mockReadinessListWorkspaces.mockResolvedValue([workspace]);
    mockResolveWorkspaceFromList.mockReturnValue(workspace);

    await runUpV2(makeOptions({ output: 'json', workspace: 'Workspace' }));

    expect(createCliUserLicenseService).toHaveBeenCalledOnce();
    expect(createCliUserLicenseService).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'fabric',
        session: expect.objectContaining({
          token: 'tok-abc',
          tenantId: 'tenant-abc',
        }),
        notify: expect.any(Function),
      })
    );
    expect(mockRunEnsureUserLicenseWorkflow).toHaveBeenCalledOnce();
    expect(mockEnsureAuthenticated).toHaveBeenCalledOnce();
    expect(
      mockRunEnsureUserLicenseWorkflow.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mockCreateCliFabricReadinessClient.mock.invocationCallOrder[0]
    );
  });

  it('resolves up feature flags from the project and selected env file', async () => {
    await runUpV2(
      makeOptions({
        output: 'json',
        dryRun: true,
        workspaceId: 'ws-explicit',
        envFile: 'custom.env',
      })
    );

    expect(createCliFeatureFlags).toHaveBeenCalledWith('/proj', {
      command: 'up',
      envFile: 'custom.env',
      silent: true,
    });
  });

  it('reuses the authenticated session for license readiness and a viable dry run', async () => {
    await runUpV2(
      makeOptions({
        output: 'json',
        dryRun: true,
        workspaceId: 'ws-explicit',
      })
    );

    expect(mockEnsureAuthenticated).toHaveBeenCalledOnce();
    expect(createCliUserLicenseService).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ token: 'tok-abc' }),
      })
    );
    expect(
      mockRunEnsureUserLicenseWorkflow.mock.invocationCallOrder[0]
    ).toBeLessThan(mockGetWorkspace.mock.invocationCallOrder[0]);
    expect(mockGetWorkspace).toHaveBeenCalledWith(SUCCESS_RESULT.workspaceId);
    expect(createUpDeps).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
  });

  it('keeps the interactive license check read-only during dry-run', async () => {
    mockIsInteractive.mockReturnValue(true);

    await runUpV2(
      makeOptions({
        output: 'interactive',
        dryRun: true,
        workspaceId: 'ws-explicit',
      })
    );

    expect(mockRunEnsureUserLicenseWorkflow).toHaveBeenCalledWith(
      { allowInteractiveEnrollment: false },
      expect.anything()
    );
  });

  it('keeps native Ctrl+C handling during the dry-run workspace read', async () => {
    const existingListeners = new Set(process.listeners('SIGINT'));
    let resolveWorkspaceRead:
      | ((workspace: { id: string; displayName: string }) => void)
      | undefined;
    mockGetWorkspace.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWorkspaceRead = resolve;
        })
    );

    const invocation = runUpV2(
      makeOptions({
        output: 'json',
        dryRun: true,
        workspaceId: 'ws-explicit',
      })
    );
    await vi.waitFor(() => expect(mockGetWorkspace).toHaveBeenCalledOnce());

    expect(
      process
        .listeners('SIGINT')
        .find((listener) => !existingListeners.has(listener))
    ).toBeUndefined();

    resolveWorkspaceRead?.({
      id: SUCCESS_RESULT.workspaceId,
      displayName: 'Workspace',
    });
    await invocation;
  });

  it('uses spinner progress for an interactive license preflight', async () => {
    mockIsInteractive.mockReturnValue(true);

    await runUpV2(
      makeOptions({ output: 'interactive', workspaceId: 'ws-explicit' })
    );

    const dependencies = mockRunEnsureUserLicenseWorkflow.mock.calls[0][1];
    expect(dependencies.progress).not.toBe(plainProgress);
  });

  it('stops before target resolution when the license preflight fails', async () => {
    mockRunEnsureUserLicenseWorkflow.mockResolvedValueOnce({
      status: 'failed',
      error: {
        code: 'fabric_license_enrollment_required',
        message:
          'A Fabric license is required. Rerun this command interactively to open Fabric license setup.',
      },
    });

    await expect(
      runUpV2(makeOptions({ output: 'json', workspace: 'Workspace' }))
    ).rejects.toThrow('A Fabric license is required');

    expect(mockEnsureAuthenticated).toHaveBeenCalledOnce();
    expect(mockCreateCliFabricReadinessClient).not.toHaveBeenCalled();
    expect(createUpDeps).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
  });

  it('cancels a pending license preflight without resolving a target', async () => {
    const existingListeners = new Set(process.listeners('SIGINT'));
    mockRunEnsureUserLicenseWorkflow.mockImplementationOnce(
      (_request, dependencies) =>
        new Promise((resolve) => {
          dependencies.signal?.onCancellationRequested(() => {
            resolve({ status: 'cancelled' });
          });
        })
    );

    const invocation = runUpV2(
      makeOptions({ output: 'json', workspace: 'Workspace' })
    );
    await vi.waitFor(() => {
      expect(mockRunEnsureUserLicenseWorkflow).toHaveBeenCalledOnce();
    });
    const invocationListener = process
      .listeners('SIGINT')
      .find((listener) => !existingListeners.has(listener));
    expect(invocationListener).toBeDefined();
    invocationListener?.('SIGINT');

    await expect(invocation).rejects.toBeInstanceOf(CliCancelledError);
    expect(parseLastJson()).toEqual({
      status: 'cancelled',
      reason: 'operation-cancelled',
      warnings: [],
    });
    expect(mockCreateCliFabricReadinessClient).not.toHaveBeenCalled();
    expect(createUpDeps).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
  });

  it('uses one tenant-aware session for licensing and deployment', async () => {
    await runUpV2(
      makeOptions({
        output: 'json',
        workspaceId: 'ws-explicit',
        tenant: 'tenant-requested',
        encryptionFallbackEnabled: true,
      })
    );

    expect(mockEnsureAuthenticated).toHaveBeenCalledOnce();
    expect(mockEnsureAuthenticated).toHaveBeenCalledWith(undefined, {
      tenantId: 'tenant-requested',
      encryptionFallbackEnabled: true,
    });
    expect(createCliUserLicenseService).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ token: 'tok-abc' }),
      })
    );
    expect(createUpDeps).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'tok-abc' })
    );
  });

  it('falls back to ambient env when no explicit workspace is passed', async () => {
    mockGetAmbientWorkspaceId.mockReturnValue('ws-ambient');

    await runUpV2(makeOptions({ output: 'json', yes: true }));

    expect(mockResolveWorkspaceFromList).not.toHaveBeenCalled();
    const request = mockRunUpWorkflow.mock.calls[0][0];
    expect(request.workspaceId).toBe('ws-ambient');
  });

  it('runs readiness for an ambient workspace target', async () => {
    mockGetAmbientWorkspaceId.mockReturnValue('ws-ambient');
    mockReadinessResult({
      status: 'ready',
      workspace: { id: 'ws-ambient', displayName: 'Ambient' },
      capacityId: 'cap-ambient',
      capacitySource: 'selected-paid',
      workspaceCreated: false,
    });

    await runUpV2(makeOptions({ output: 'json', yes: true }));

    expect(mockPromptWorkspaceResolution).not.toHaveBeenCalled();
    expect(mockRunFabricReadinessWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-ambient' }),
      expect.anything()
    );
    expect(mockRunUpWorkflow.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws-ambient',
      capacitySource: 'selected-paid',
      workspaceCreated: false,
    });
  });

  it('resolves the workspace through readiness when no targeting context exists', async () => {
    const notices = [
      {
        kind: 'trial-started',
        capacityId: 'cap-1',
        capacityName: 'Trial',
      },
      {
        kind: 'workspace-created',
        workspaceId: 'ws-new',
        workspaceName: 'my-app',
      },
    ];
    mockReadinessResult(
      {
        status: 'ready',
        workspace: { id: 'ws-new', displayName: 'my-app' },
        capacityId: 'cap-1',
        capacitySource: 'new-trial',
        workspaceCreated: true,
      },
      notices
    );

    await runUpV2(makeOptions({ output: 'json', yes: true }));

    expect(mockPromptWorkspaceResolution).not.toHaveBeenCalled();
    expect(mockReadinessListWorkspaces).not.toHaveBeenCalled();
    expect(mockPromptWorkspaceSelection).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-new',
        // Readiness ran in the pre-flight; its outcome is handed over so the
        // workflow can report what targeting prepared.
        workspaceCreated: true,
        capacitySource: 'new-trial',
        readinessNotices: notices,
      }),
      expect.anything()
    );
  });

  it('supplies interactive capacity selection to readiness', async () => {
    mockIsInteractive.mockReturnValue(true);
    mockReadinessResult({
      status: 'ready',
      workspace: { id: 'ws-new', displayName: 'my-app' },
      capacityId: 'paid-f2',
      capacitySource: 'selected-paid',
      workspaceCreated: true,
    });

    await runUpV2(makeOptions({ output: 'plain' }));

    expect(mockPromptWorkspaceResolution).toHaveBeenCalledWith(
      cliUserInteraction
    );
    expect(mockRunFabricReadinessWorkflow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ui: cliUserInteraction,
        premiumCapacitySelection: 'prompt',
      })
    );
  });

  it('treats an explicit capacity as pre-approved for assignment', async () => {
    mockIsInteractive.mockReturnValue(true);
    mockReadinessResult({
      status: 'ready',
      workspace: { id: 'ws-new', displayName: 'my-app' },
      capacityId: '11111111-1111-4111-8111-111111111111',
      capacitySource: 'explicit',
      workspaceCreated: true,
    });

    await runUpV2(
      makeOptions({
        output: 'plain',
        capacityId: '11111111-1111-4111-8111-111111111111',
      })
    );

    expect(mockRunFabricReadinessWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        capacityId: '11111111-1111-4111-8111-111111111111',
        capacityAssignmentMode: 'automatic',
      }),
      expect.objectContaining({
        ui: cliUserInteraction,
      })
    );
    expect(mockPromptWorkspaceResolution).not.toHaveBeenCalled();
    expect(mockPromptWorkspaceSelection).not.toHaveBeenCalled();
  });

  it('forwards --yes as deterministic capacity consent without prompting', async () => {
    mockReadinessResult({
      status: 'ready',
      workspace: { id: 'ws-new', displayName: 'my-app' },
      capacityId: 'paid-f2',
      capacitySource: 'selected-paid',
      workspaceCreated: true,
    });

    await runUpV2({ output: 'json', yes: true });

    expect(mockPromptWorkspaceResolution).not.toHaveBeenCalled();
    expect(mockRunFabricReadinessWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        capacityAssignmentMode: 'automatic',
      }),
      expect.objectContaining({
        ui: undefined,
        premiumCapacitySelection: 'fallback',
      })
    );
  });

  it('falls through to the workspace picker after assignment is declined', async () => {
    mockIsInteractive.mockReturnValue(true);
    mockReadinessResult({ status: 'assignment-declined' });
    mockReadinessListWorkspaces.mockResolvedValue([
      { id: 'ws-existing', displayName: 'Existing Workspace' },
    ]);
    mockPromptWorkspaceSelection.mockResolvedValue({
      id: 'ws-existing',
      displayName: 'Existing Workspace',
    });

    await runUpV2(makeOptions({ output: 'plain' }));

    expect(mockPromptWorkspaceSelection).toHaveBeenCalledOnce();
    expect(mockRunFabricReadinessWorkflow).toHaveBeenCalledOnce();
    expect(mockRunUpWorkflow.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws-existing',
    });
  });

  it('skips readiness and opens the workspace picker when existing workspace is selected', async () => {
    mockIsInteractive.mockReturnValue(true);
    mockPromptWorkspaceResolution.mockResolvedValue('existing');
    mockReadinessListWorkspaces.mockResolvedValue([
      { id: 'ws-existing', displayName: 'Existing Workspace' },
    ]);
    mockPromptWorkspaceSelection.mockResolvedValue({
      id: 'ws-existing',
      displayName: 'Existing Workspace',
    });

    await runUpV2(makeOptions({ output: 'plain' }));

    expect(mockPromptWorkspaceResolution).toHaveBeenCalledWith(
      cliUserInteraction
    );
    expect(mockRunFabricReadinessWorkflow).not.toHaveBeenCalled();
    expect(mockPromptWorkspaceSelection).toHaveBeenCalledWith(
      [{ id: 'ws-existing', displayName: 'Existing Workspace' }],
      cliUserInteraction
    );
    expect(mockRunUpWorkflow.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws-existing',
      workspaceCreated: undefined,
      capacitySource: undefined,
    });
  });

  it('cancels when the workspace resolution choice is dismissed', async () => {
    mockIsInteractive.mockReturnValue(true);
    mockPromptWorkspaceResolution.mockResolvedValue(undefined);

    await expect(
      runUpV2(makeOptions({ output: 'interactive' }))
    ).rejects.toBeInstanceOf(CliCancelledError);

    expect(mockRunFabricReadinessWorkflow).not.toHaveBeenCalled();
    expect(mockPromptWorkspaceSelection).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'without a capacity selection',
      options: { output: 'json' as const },
      capacityId: undefined,
    },
    {
      label: 'with an explicit capacity selection',
      options: {
        output: 'json' as const,
        capacityId: '11111111-1111-4111-8111-111111111111',
      },
      capacityId: '11111111-1111-4111-8111-111111111111',
    },
  ])(
    'automatically creates a workspace in non-interactive mode $label',
    async ({ options, capacityId }) => {
      mockReadinessResult({
        status: 'ready',
        workspace: { id: 'ws-new', displayName: 'my-app' },
        capacityId: capacityId ?? 'capacity-1',
        capacitySource: capacityId ? 'explicit' : 'selected-paid',
        workspaceCreated: true,
      });

      await runUpV2(makeOptions(options));

      expect(mockRunFabricReadinessWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          capacityId,
          capacityAssignmentMode: 'automatic',
        }),
        expect.objectContaining({
          ui: undefined,
          premiumCapacitySelection: 'fallback',
        })
      );
      expect(mockReadinessListWorkspaces).not.toHaveBeenCalled();
      expect(mockPromptWorkspaceResolution).not.toHaveBeenCalled();
      expect(mockPromptWorkspaceSelection).not.toHaveBeenCalled();
      expect(mockRunUpWorkflow.mock.calls[0][0]).toMatchObject({
        workspaceId: 'ws-new',
        workspaceCreated: true,
      });
    }
  );

  it('reports a readiness failure once, before the picker it falls through to', async () => {
    // Targeting prints the failure live so the Builder knows why they are
    // being asked to pick; the host must not then repeat it after they answer.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockIsInteractive.mockReturnValue(true);
    mockReadinessResult({
      status: 'action-required',
      reason: 'ineligible_for_trial',
      message: 'This account is not eligible for a Fabric trial.',
      retryable: false,
    });

    mockReadinessListWorkspaces.mockResolvedValue([
      { id: 'ws-picked', name: 'Picked' },
    ]);
    mockPromptWorkspaceSelection.mockResolvedValue({
      id: 'ws-picked',
      name: 'Picked',
    });

    try {
      await runUpV2(makeOptions({}));

      const mentions = warn.mock.calls.filter((call) =>
        String(call[0]).includes('Could not prepare a Fabric workspace')
      );
      expect(mentions).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('omits emoji from plain readiness warnings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockReadinessResult({
      status: 'action-required',
      reason: 'ineligible_for_trial',
      message: 'This account is not eligible for a Fabric trial.',
      retryable: false,
    });

    await runUpV2(makeOptions({ output: 'plain', workspaceId: 'ws-explicit' }));

    expect(warn).toHaveBeenCalledWith(
      'Could not prepare a Fabric workspace automatically.'
    );
    expect(
      warn.mock.calls.some(([message]) => String(message).includes('⚠️'))
    ).toBe(false);
  });

  it('serializes retained readiness resources when fallback has no target', async () => {
    mockReadinessResult(
      {
        status: 'failed',
        reason: 'workspace_assignment_failed',
        message: 'Assignment failed.',
        retryable: true,
      },
      [
        {
          kind: 'workspace-created',
          workspaceId: 'ws-retained',
          workspaceName: 'proj-20260917-100000',
        },
      ]
    );

    await expect(
      runUpV2(makeOptions({ output: 'json', yes: true }))
    ).rejects.toBeInstanceOf(CliHandledError);

    expect(parseLastJson()).toMatchObject({
      status: 'error',
      notices: [
        {
          kind: 'workspace-created',
          workspaceId: 'ws-retained',
          workspaceName: 'proj-20260917-100000',
        },
      ],
    });
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'attaches trial capacity to a targeted workspace that has none',
      options: { output: 'json', workspaceId: 'ws-explicit' },
      resolvedWorkspaceId: SUCCESS_RESULT.workspaceId,
      displayName: 'Explicit',
      capacityId: 'cap-trial',
      capacitySource: 'new-trial',
    },
    {
      label: 'leaves capacity alone when a targeted workspace already has some',
      options: {
        output: 'json',
        workspaceId: '11111111-1111-4111-8111-111111111111',
      },
      resolvedWorkspaceId: '11111111-1111-4111-8111-111111111111',
      displayName: 'Named',
      capacityId: 'cap-owned',
      capacitySource: 'workspace',
    },
    {
      label:
        'attaches trial capacity when --workspace names a workspace with none',
      options: { output: 'json', workspace: 'By Name' },
      resolvedWorkspaceId: 'ws-by-name',
      displayName: 'By Name',
      capacityId: 'cap-trial',
      capacitySource: 'new-trial',
    },
  ] as const)(
    '$label',
    async ({
      options,
      resolvedWorkspaceId,
      displayName,
      capacityId,
      capacitySource,
    }) => {
      if ('workspace' in options) {
        mockReadinessListWorkspaces.mockResolvedValue([
          { id: resolvedWorkspaceId, displayName },
        ]);
        mockResolveWorkspaceFromList.mockReturnValue({
          id: resolvedWorkspaceId,
          displayName,
        });
      }
      mockReadinessResult({
        status: 'ready',
        workspace: { id: resolvedWorkspaceId, displayName },
        capacityId,
        capacitySource,
        workspaceCreated: false,
      });

      await runUpV2(makeOptions(options));

      expect(mockRunFabricReadinessWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: resolvedWorkspaceId }),
        expect.anything()
      );
      expect(mockRunUpWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: resolvedWorkspaceId,
          capacitySource,
          workspaceCreated: false,
        }),
        expect.anything()
      );
    }
  );

  it('stops targeting when readiness is cancelled and preserves notices', async () => {
    mockIsInteractive.mockReturnValue(true);
    mockRunFabricReadinessWorkflow.mockResolvedValue({
      status: 'cancelled',
      notices: [
        {
          kind: 'workspace-created',
          workspaceId: 'ws-created',
          workspaceName: 'proj-20260917-111946',
        },
      ],
    });

    await expect(
      runUpV2(makeOptions({ output: 'json', yes: true }))
    ).rejects.toBeInstanceOf(CliCancelledError);

    expect(mockPromptWorkspaceSelection).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
    expect(parseLastJson()).toEqual({
      status: 'cancelled',
      reason: 'operation-cancelled',
      warnings: [],
      notices: [
        {
          kind: 'workspace-created',
          workspaceId: 'ws-created',
          workspaceName: 'proj-20260917-111946',
        },
      ],
    });
  });

  // A readiness problem is a failed convenience, not a failed run. Splitting the
  // assignment outcome introduced two statuses the fall-through had never seen —
  // `failed` is the harshest readiness can report — and if either one
  // short-circuits it, a Builder who already owns a usable workspace is
  // stranded at an error instead of being offered the picker.
  it.each([
    ['action-required', 'ineligible_for_trial', false],
    ['failed', 'workspace_assignment_failed', true],
    ['retry-later', 'workspace_assignment_timeout', true],
  ] as const)(
    'still falls back to the picker when readiness reports %s',
    async (status, reason, retryable) => {
      mockIsInteractive.mockReturnValue(true);
      mockReadinessResult({
        status,
        reason,
        message: 'Fabric did not complete the assignment.',
        retryable,
      });
      mockReadinessListWorkspaces.mockResolvedValue([
        { id: 'ws-picked', name: 'Picked' },
      ]);
      mockPromptWorkspaceSelection.mockResolvedValue({
        id: 'ws-picked',
        name: 'Picked',
      });

      await runUpV2(makeOptions({}));

      expect(mockPromptWorkspaceSelection).toHaveBeenCalled();
      expect(mockRunUpWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws-picked',
          workspaceCreated: undefined,
        }),
        expect.anything()
      );
    }
  );

  it.each([
    ['action-required', 'capacity_not_usable', false],
    ['failed', 'workspace_assignment_failed', true],
    ['retry-later', 'workspace_assignment_timeout', true],
  ] as const)(
    'stops targeting when an explicit capacity reports %s',
    async (status, reason, retryable) => {
      mockIsInteractive.mockReturnValue(true);
      mockReadinessResult({
        status,
        reason,
        message: 'The explicit capacity could not be used.',
        retryable,
      });

      await expect(
        runUpV2(
          makeOptions({
            output: 'json',
            capacityId: '11111111-1111-4111-8111-111111111111',
          })
        )
      ).rejects.toBeInstanceOf(CliHandledError);

      expect(mockPromptWorkspaceResolution).not.toHaveBeenCalled();
      expect(mockPromptWorkspaceSelection).not.toHaveBeenCalled();
      expect(mockRunUpWorkflow).not.toHaveBeenCalled();
      expect(parseLastJson()).toMatchObject({
        status: 'action_required',
        code: reason,
        reason,
        retryable,
        error: 'The explicit capacity could not be used.',
      });
    }
  );

  it('stops targeting when explicit-capacity readiness fails unexpectedly', async () => {
    mockIsInteractive.mockReturnValue(true);
    mockRunFabricReadinessWorkflow.mockResolvedValue({
      status: 'failed',
      error: {
        code: 'fabric-readiness-failed',
        message: 'Fabric returned an unexpected error.',
      },
    });

    await expect(
      runUpV2(
        makeOptions({
          output: 'json',
          capacityId: '11111111-1111-4111-8111-111111111111',
        })
      )
    ).rejects.toBeInstanceOf(CliHandledError);

    expect(mockPromptWorkspaceResolution).not.toHaveBeenCalled();
    expect(mockPromptWorkspaceSelection).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
    expect(parseLastJson()).toMatchObject({
      status: 'action_required',
      code: 'fabric-readiness-failed',
      reason: 'fabric-readiness-failed',
      retryable: true,
      error: 'Fabric returned an unexpected error.',
    });
  });

  it('deploys to the targeted workspace anyway when readiness fails', async () => {
    mockIsInteractive.mockReturnValue(true);
    mockReadinessResult({
      status: 'action-required',
      reason: 'ineligible_for_trial',
      message: 'This account is not eligible for a Fabric trial.',
      retryable: false,
    });

    await runUpV2(makeOptions({ output: 'json', workspaceId: 'ws-explicit' }));

    // The Builder named this workspace; a failed convenience must not demote
    // that to a prompt, nor make the run worse than it was before readiness.
    expect(mockPromptWorkspaceResolution).not.toHaveBeenCalled();
    expect(mockPromptWorkspaceSelection).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: SUCCESS_RESULT.workspaceId,
        workspaceCreated: undefined,
      }),
      expect.anything()
    );
  });

  it('leaves portal resolution to the workflow when none is configured', async () => {
    mockGetAmbientWorkspaceId.mockReturnValue('ws-ambient');

    await runUpV2(makeOptions({ output: 'json' }));

    const request = mockRunUpWorkflow.mock.calls[0][0];
    expect(request.portalBaseUrl).toBeUndefined();
  });

  it('passes a configured portal URL to the workflow as an override', async () => {
    process.env.RAYFIN_FABRIC_PORTAL_URL = 'https://portal.example.invalid/';
    mockGetAmbientWorkspaceId.mockReturnValue('ws-ambient');

    await runUpV2(makeOptions({ output: 'json' }));

    const request = mockRunUpWorkflow.mock.calls[0][0];
    expect(request.portalBaseUrl).toBe('https://portal.example.invalid');
  });

  it('preserves a portal override when targeting by workspace URI', async () => {
    process.env.RAYFIN_FABRIC_PORTAL_URL = 'https://portal.example.invalid/';

    await runUpV2(
      makeOptions({
        output: 'json',
        workspaceUri:
          'https://msit.powerbi.com/groups/00000000-0000-0000-0000-000000000001/list',
      })
    );

    const request = mockRunUpWorkflow.mock.calls[0][0];
    expect(request.portalBaseUrl).toBe('https://portal.example.invalid');
    expect(process.env.RAYFIN_FABRIC_API_URL).toBe(
      'https://msitapi.fabric.microsoft.com/v1'
    );
  });

  it('resolves the scaffolded workspace name using the already acquired token', async () => {
    vi.stubEnv('RAYFIN_WORKSPACE_NAME', 'Finance # Reporting');
    const workspaceId = '767f94fa-1106-4377-8fb4-bb931907444a';
    const workspace = {
      id: workspaceId,
      displayName: 'Finance # Reporting',
    };
    mockReadinessListWorkspaces.mockResolvedValue([workspace]);
    mockResolveWorkspaceFromList.mockReturnValue(workspace);

    await runUpV2({ output: 'json' });

    expect(mockEnsureAuthenticated).toHaveBeenCalledTimes(1);
    expect(mockResolveWorkspaceFromList).toHaveBeenCalledWith(
      'Finance # Reporting',
      [workspace]
    );
    expect(mockEnsureAuthenticated.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateCliFabricReadinessClient.mock.invocationCallOrder[0]
    );
    expect(mockRunUpWorkflow.mock.calls[0][0].workspaceId).toBe(workspaceId);
    expect(mockPromptWorkspaceSelection).not.toHaveBeenCalled();
  });

  it('cancels an aborted scaffolded workspace lookup', async () => {
    vi.stubEnv('RAYFIN_WORKSPACE_NAME', 'Finance # Reporting');
    const existingListeners = new Set(process.listeners('SIGINT'));
    mockCreateCliFabricReadinessClient.mockImplementationOnce(
      (_accessToken, options) =>
        ({
          listWorkspaces: () =>
            new Promise((_, reject) => {
              options.signal?.addEventListener(
                'abort',
                () => reject(new Error('Aborted')),
                { once: true }
              );
            }),
        }) as ReturnType<typeof createCliFabricReadinessClient>
    );

    const invocation = runUpV2(makeOptions({ output: 'json' }));
    await vi.waitFor(() => {
      expect(mockCreateCliFabricReadinessClient).toHaveBeenCalledOnce();
    });
    const invocationListener = process
      .listeners('SIGINT')
      .find((listener) => !existingListeners.has(listener));
    expect(invocationListener).toBeDefined();
    invocationListener?.('SIGINT');

    await expect(invocation).rejects.toBeInstanceOf(CliCancelledError);
    expect(parseLastJson()).toEqual({
      status: 'cancelled',
      reason: 'operation-cancelled',
      warnings: [],
    });
    expect(mockResolveWorkspaceFromList).not.toHaveBeenCalled();
    expect(createUpDeps).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
  });

  it('prefers a recorded deployment over the original scaffold workspace', async () => {
    vi.stubEnv('RAYFIN_WORKSPACE_NAME', 'Original Workspace');
    mockListDeploymentsState.mockReturnValue({
      deployments: [
        {
          workspaceName: 'Current Workspace',
          active: true,
          record: {
            itemId: 'current-item',
            apiUrl: 'https://api.test/current',
            workspaceId: 'current-workspace',
          },
        },
      ],
      warnings: [],
    });

    await runUpV2({ output: 'json' });

    expect(mockResolveWorkspaceFromList).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow.mock.calls[0][0]).toMatchObject({
      workspaceId: 'current-workspace',
      knownItemId: 'current-item',
    });
  });

  it('skips readiness for a recorded deployment workspace', async () => {
    mockListDeploymentsState.mockReturnValue({
      deployments: [
        {
          workspaceName: 'Current Workspace',
          active: true,
          record: {
            itemId: 'current-item',
            apiUrl: 'https://api.test/current',
            workspaceId: 'current-workspace',
          },
        },
      ],
      warnings: [],
    });
    await runUpV2({ output: 'json' });

    expect(mockPromptWorkspaceResolution).not.toHaveBeenCalled();
    expect(mockRunFabricReadinessWorkflow).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow.mock.calls[0][0]).toMatchObject({
      workspaceId: 'current-workspace',
      knownItemId: 'current-item',
      readinessNotices: [],
    });
  });

  it('warns that capacity ID is ignored for an existing deployment', async () => {
    mockListDeploymentsState.mockReturnValue({
      deployments: [
        {
          workspaceName: 'Current Workspace',
          active: true,
          record: {
            itemId: 'current-item',
            apiUrl: 'https://api.test/current',
            workspaceId: 'current-workspace',
          },
        },
      ],
      warnings: [],
    });

    await runUpV2({
      output: 'json',
      capacityId: '11111111-1111-4111-8111-111111111111',
    });

    expect(mockRunFabricReadinessWorkflow).not.toHaveBeenCalled();
    expect(parseLastJson()).toMatchObject({
      status: 'success',
      warnings: [
        'Ignoring --capacity-id because an existing deployment keeps its current workspace capacity.',
      ],
    });
  });

  it('prompts to select among multiple inactive recorded deployments', async () => {
    mockIsInteractive.mockReturnValue(true);
    mockListDeploymentsState.mockReturnValue({
      deployments: [
        {
          workspaceName: 'first-workspace',
          active: false,
          record: {
            itemId: 'first-item',
            apiUrl: 'https://api.test/first',
            workspaceId: 'first-id',
          },
        },
        {
          workspaceName: 'second-workspace',
          active: false,
          record: {
            itemId: 'second-item',
            apiUrl: 'https://api.test/second',
            workspaceId: 'second-id',
          },
        },
      ],
      warnings: [],
    });
    const selectSpy = vi
      .spyOn(cliUserInteraction, 'select')
      .mockResolvedValue('second-workspace');

    await runUpV2(makeOptions({ output: 'interactive', yes: true }));

    expect(selectSpy).toHaveBeenCalledWith(
      'Multiple Fabric workspace deployments found. Which one?',
      [
        { label: 'first-workspace', value: 'first-workspace' },
        { label: 'second-workspace', value: 'second-workspace' },
      ],
      undefined
    );
    const request = mockRunUpWorkflow.mock.calls[0][0];
    expect(request.workspaceId).toBe('second-id');
    expect(request.knownItemId).toBe('second-item');
    expect(mockPromptWorkspaceSelection).not.toHaveBeenCalled();
  });

  it('does not prompt among multiple inactive recorded deployments during dry-run', async () => {
    mockIsInteractive.mockReturnValue(true);
    mockListDeploymentsState.mockReturnValue({
      deployments: [
        {
          workspaceName: 'first-workspace',
          active: false,
          record: {
            itemId: 'first-item',
            itemName: 'first-app',
            apiUrl: 'https://api.test/first',
            workspaceId: 'first-id',
          },
        },
        {
          workspaceName: 'second-workspace',
          active: false,
          record: {
            itemId: 'second-item',
            itemName: 'second-app',
            apiUrl: 'https://api.test/second',
            workspaceId: 'second-id',
          },
        },
      ],
      warnings: [],
    });
    const selectSpy = vi
      .spyOn(cliUserInteraction, 'select')
      .mockResolvedValue('second-workspace');

    await runUpV2(makeOptions({ output: 'interactive', dryRun: true }));

    expect(selectSpy).not.toHaveBeenCalled();
    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
    expect(mockRunFabricReadinessWorkflow).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
  });

  it('presents a workspace picker when no targeting context exists and deploys the chosen workspace', async () => {
    mockIsInteractive.mockReturnValue(true);
    mockReadinessResult({
      status: 'action-required',
      reason: 'capacity_selection_required',
      message: 'Choose an existing workspace.',
      retryable: true,
    });
    mockReadinessListWorkspaces.mockResolvedValue([
      { id: 'ws-a', displayName: 'Alpha' },
      { id: 'ws-b', displayName: 'Bravo' },
    ]);
    mockPromptWorkspaceSelection.mockResolvedValue({
      id: 'ws-b',
      displayName: 'Bravo',
    });

    await runUpV2(makeOptions({ output: 'plain' }));

    // The list is fetched with the token already acquired by `buildRequest`
    // (no second auth) and handed to the picker verbatim.
    expect(mockCreateCliFabricReadinessClient).toHaveBeenCalledWith(
      'tok-abc',
      expect.objectContaining({
        diagnostics: expect.anything(),
        signal: expect.any(AbortSignal),
      })
    );
    expect(mockReadinessListWorkspaces).toHaveBeenCalled();
    expect(
      mockRunEnsureUserLicenseWorkflow.mock.invocationCallOrder[0]
    ).toBeLessThan(mockReadinessListWorkspaces.mock.invocationCallOrder[0]);
    expect(mockPromptWorkspaceSelection).toHaveBeenCalledWith(
      [
        { id: 'ws-a', displayName: 'Alpha' },
        { id: 'ws-b', displayName: 'Bravo' },
      ],
      cliUserInteraction
    );
    const request = mockRunUpWorkflow.mock.calls[0][0];
    expect(request.workspaceId).toBe('ws-b');
    // The picker yields an id directly, so no name→id round-trip is needed.
    expect(mockResolveWorkspaceFromList).not.toHaveBeenCalled();
  });

  it('fails with an actionable error when no workspaces are accessible, without prompting', async () => {
    mockIsInteractive.mockReturnValue(true);
    mockReadinessListWorkspaces.mockResolvedValue([]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // The picker only runs on an interactive (non-json) host, so the empty-list
    // failure surfaces through stderr rather than a JSON payload.
    await expect(
      runUpV2(makeOptions({ output: 'plain' }))
    ).rejects.toBeInstanceOf(CliHandledError);

    expect(mockPromptWorkspaceSelection).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('No accessible Fabric workspaces found')
    );
  });

  it('fails with recovery guidance when accessible workspaces cannot be listed', async () => {
    mockIsInteractive.mockReturnValue(true);
    mockReadinessListWorkspaces.mockRejectedValue(
      new Error('Fabric API unavailable')
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      runUpV2(makeOptions({ output: 'plain' }))
    ).rejects.toBeInstanceOf(CliHandledError);

    expect(mockPromptWorkspaceSelection).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unable to list Fabric workspaces')
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Fabric API unavailable')
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Run `rayfin login` and retry, or pass --workspace-id <id>'
      )
    );
  });

  it('(b) fails hard on an unknown --exclude-services value before any auth or workflow', async () => {
    await expect(
      runUpV2(makeOptions({ output: 'json', excludeServices: 'foo' }))
    ).rejects.toBeInstanceOf(CliHandledError);

    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
    expect(parseLastJson()).toEqual({
      status: 'error',
      error: 'Unknown service: foo. Allowed: staticHosting, functions',
    });
  });

  it('preserves --exclude-services staticHosting for existing dev scripts', async () => {
    await runUpV2(
      makeOptions({
        output: 'json',
        workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
        excludeServices: 'staticHosting',
      })
    );

    expect(mockRunUpWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeStaticHosting: true,
        excludeFunctions: false,
      }),
      expect.anything()
    );
  });

  it('(c) --dry-run resolves the workspace without provisioning or running the workflow', async () => {
    await expect(
      runUpV2(
        makeOptions({
          output: 'plain',
          dryRun: true,
          workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
        })
      )
    ).resolves.toBeUndefined();

    expect(mockEnsureAuthenticated).toHaveBeenCalledOnce();
    expect(mockPromptWorkspaceResolution).not.toHaveBeenCalled();
    expect(mockGetWorkspace).toHaveBeenCalledWith(SUCCESS_RESULT.workspaceId);
    expect(mockCreateItem).not.toHaveBeenCalled();
    expect(createUpDeps).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
  });

  it.each(['name', 'ambient', 'registry'] as const)(
    'uses the deployment targeting precedence for a dry run from %s',
    async (source) => {
      const workspaceId = '11111111-1111-4111-8111-111111111111';
      const options: UpCommandOptions = { output: 'json', dryRun: true };
      if (source === 'name') {
        options.workspace = 'Preview Workspace';
        mockReadinessListWorkspaces.mockResolvedValueOnce([
          {
            id: workspaceId,
            displayName: 'Preview Workspace',
          },
        ]);
        mockResolveWorkspaceFromList.mockReturnValueOnce({
          id: workspaceId,
          displayName: 'Preview Workspace',
        });
        mockGetAmbientWorkspaceId.mockReturnValue(
          '22222222-2222-4222-8222-222222222222'
        );
      } else if (source === 'ambient') {
        mockGetAmbientWorkspaceId.mockReturnValue(workspaceId);
      } else {
        mockListDeploymentsState.mockReturnValue({
          deployments: [
            {
              workspaceName: 'preview',
              active: true,
              record: {
                workspaceId,
                itemId: '33333333-3333-4333-8333-333333333333',
                apiUrl: 'https://api.example.com',
              },
            },
          ],
          warnings: [],
        });
      }

      await runUpV2(options);

      expect(mockGetWorkspace).toHaveBeenCalledWith(workspaceId);
      expect(parseLastJson()).toMatchObject({
        status: 'dry-run',
        plan: { workspaceId, workspaceName: 'Workspace' },
      });
      expect(mockRunUpWorkflow).not.toHaveBeenCalled();
      expect(mockCreateItem).not.toHaveBeenCalled();
    }
  );

  it('treats an unrecorded ambient workspace as an existing dry-run target', async () => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    mockGetAmbientWorkspaceId.mockReturnValue(workspaceId);

    await runUpV2(makeOptions({ output: 'json', dryRun: true }));

    expect(mockEnsureAuthenticated).toHaveBeenCalledOnce();
    expect(mockGetWorkspace).toHaveBeenCalledWith(workspaceId);
    expect(parseLastJson()).toMatchObject({
      status: 'dry-run',
      plan: {
        workspaceId,
        targeting: {
          fabricReadiness: {
            target: 'existing-workspace',
            createWorkspaceIfNeeded: false,
          },
        },
      },
    });
  });

  it('uses the recorded item name in dry-run after resolving the workspace', async () => {
    mockListDeploymentsState.mockReturnValue({
      deployments: [
        {
          workspaceName: 'workspace',
          active: true,
          record: {
            itemId: 'item-1',
            itemName: 'recorded-app',
            apiUrl: 'https://api.test/item-1',
            workspaceId: SUCCESS_RESULT.workspaceId,
          },
        },
      ],
      warnings: [],
    });

    await runUpV2(
      makeOptions({
        output: 'json',
        dryRun: true,
        workspaceId: 'ws-explicit',
      })
    );

    expect(mockEnsureAuthenticated).toHaveBeenCalledOnce();
    expect(parseLastJson()).toMatchObject({
      status: 'dry-run',
      plan: { itemName: 'recorded-app' },
    });
  });

  it('uses the active deployment item name in an untargeted dry-run', async () => {
    mockListDeploymentsState.mockReturnValue({
      deployments: [
        {
          workspaceName: 'workspace',
          active: true,
          record: {
            itemId: 'item-1',
            itemName: 'active-app',
            apiUrl: 'https://api.test/item-1',
            workspaceId: 'ws-active',
          },
        },
      ],
      warnings: [],
    });

    await runUpV2(makeOptions({ output: 'json', dryRun: true }));

    expect(parseLastJson()).toMatchObject({
      status: 'dry-run',
      plan: { itemName: 'active-app' },
    });
  });

  it('uses the ambient workspace deployment item name in dry-run', async () => {
    mockGetAmbientWorkspaceId.mockReturnValue('ws-ambient');
    mockListDeploymentsState.mockReturnValue({
      deployments: [
        {
          workspaceName: 'workspace',
          active: false,
          record: {
            itemId: 'item-1',
            itemName: 'ambient-app',
            apiUrl: 'https://api.test/item-1',
            workspaceId: 'ws-ambient',
          },
        },
      ],
      warnings: [],
    });

    await runUpV2(makeOptions({ output: 'json', dryRun: true }));

    expect(parseLastJson()).toMatchObject({
      status: 'dry-run',
      plan: { itemName: 'ambient-app' },
    });
  });

  it('matches a workspace-name dry-run to its sanitized registry key', async () => {
    mockReadinessListWorkspaces.mockResolvedValueOnce([
      {
        id: 'ws-named',
        displayName: 'My Workspace',
      },
    ]);
    mockResolveWorkspaceFromList.mockReturnValueOnce({
      id: 'ws-named',
      displayName: 'My Workspace',
    });
    mockListDeploymentsState.mockReturnValue({
      deployments: [
        {
          workspaceName: 'my-workspace',
          active: false,
          record: {
            itemId: 'item-1',
            itemName: 'named-workspace-app',
            apiUrl: 'https://api.test/item-1',
            workspaceId: 'ws-named',
          },
        },
      ],
      warnings: [],
    });

    await runUpV2(
      makeOptions({
        output: 'json',
        dryRun: true,
        workspace: 'My Workspace',
      })
    );

    expect(parseLastJson()).toMatchObject({
      status: 'dry-run',
      plan: { itemName: 'named-workspace-app' },
    });
  });

  it('uses the first recorded deployment in a non-interactive dry-run', async () => {
    mockListDeploymentsState.mockReturnValue({
      deployments: [
        {
          workspaceName: 'first-workspace',
          active: false,
          record: {
            itemId: 'first-item',
            itemName: 'first-app',
            apiUrl: 'https://api.test/first',
            workspaceId: 'first-id',
          },
        },
        {
          workspaceName: 'second-workspace',
          active: false,
          record: {
            itemId: 'second-item',
            itemName: 'second-app',
            apiUrl: 'https://api.test/second',
            workspaceId: 'second-id',
          },
        },
      ],
      warnings: [],
    });

    await runUpV2(
      makeOptions({
        output: 'json',
        dryRun: true,
        capacityId: '11111111-1111-4111-8111-111111111111',
      })
    );

    expect(parseLastJson()).toMatchObject({
      status: 'dry-run',
      plan: {
        itemName: 'first-app',
        targeting: {
          fabricReadiness: {
            target: 'recorded-deployment',
            checkCapacity: false,
            capacitySelection: 'skipped',
            startTrialIfNeeded: false,
            createWorkspaceIfNeeded: false,
            assignCapacityIfNeeded: false,
          },
        },
      },
      warnings: [
        'Ignoring --capacity-id because an existing deployment keeps its current workspace capacity.',
      ],
    });
    expect(
      (
        parseLastJson() as {
          plan: { targeting: { fabricReadiness: Record<string, unknown> } };
        }
      ).plan.targeting.fabricReadiness
    ).not.toHaveProperty('capacityId');
  });

  it('resolves an old recorded item name during dry-run', async () => {
    mockGetCliFabricItemById.mockResolvedValueOnce({
      id: 'item-1',
      displayName: 'existing-backend',
      type: 'AppBackend',
      workspaceId: SUCCESS_RESULT.workspaceId,
    });
    mockListDeploymentsState.mockReturnValue({
      deployments: [
        {
          workspaceName: 'workspace',
          active: true,
          record: {
            itemId: 'item-1',
            apiUrl: 'https://api.test/item-1',
            workspaceId: SUCCESS_RESULT.workspaceId,
          },
        },
      ],
      warnings: [],
    });

    await runUpV2(
      makeOptions({
        output: 'json',
        dryRun: true,
        workspaceId: 'ws-explicit',
        itemName: 'existing-backend',
      })
    );

    expect(parseLastJson()).toMatchObject({
      status: 'dry-run',
      plan: { itemName: 'existing-backend' },
    });
    expect(mockGetCliFabricItemById).toHaveBeenCalledOnce();
  });

  it('rejects a conflicting recorded item name in dry-run', async () => {
    mockListDeploymentsState.mockReturnValue({
      deployments: [
        {
          workspaceName: 'workspace',
          active: true,
          record: {
            itemId: 'item-1',
            itemName: 'recorded-app',
            apiUrl: 'https://api.test/item-1',
            workspaceId: SUCCESS_RESULT.workspaceId,
          },
        },
      ],
      warnings: [],
    });

    await expect(
      runUpV2(
        makeOptions({
          output: 'json',
          dryRun: true,
          workspaceId: 'ws-explicit',
          itemName: 'different-app',
        })
      )
    ).rejects.toThrow(CliHandledError);

    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
    expect(parseLastJson()).toMatchObject({
      status: 'error',
      error: expect.stringContaining(
        'This project already deploys to "recorded-app"'
      ),
    });
  });

  it('accepts application authentication during a non-interactive dry-run', async () => {
    mockLoadRayfinConfig.mockReturnValueOnce({
      ...BASE_CONFIG,
      services: {
        ...BASE_CONFIG.services,
        functions: { enabled: true, auth: { type: 'application' } },
      },
    } as RayfinConfig);

    await expect(
      runUpV2(
        makeOptions({
          output: 'plain',
          dryRun: true,
          yes: true,
          workspaceId: 'ws-explicit',
        })
      )
    ).resolves.toBeUndefined();

    expect(mockEnsureAuthenticated).toHaveBeenCalledOnce();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
  });
  it('defaults an unauthored posture before authenticating', async () => {
    mockFeatureFlagGet.mockImplementation(
      (name) => name === 'cli-up-anonstatic'
    );
    mockLoadRayfinConfig.mockReturnValueOnce({
      ...BASE_CONFIG,
      services: {
        ...BASE_CONFIG.services,
        staticHosting: { enabled: true },
      },
    } as RayfinConfig);

    await expect(
      runUpV2(
        makeOptions({
          output: 'json',
          workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
        })
      )
    ).resolves.toBeUndefined();

    expect(mockEnsureAuthenticated).toHaveBeenCalled();
    expect(mockRunUpWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ staticHostingPosture: 'protected' }),
      expect.anything()
    );
  });

  it.each([
    { enabled: true, auth: undefined, excludeServices: undefined },
    { enabled: true, auth: {}, excludeServices: undefined },
    {
      enabled: true,
      auth: { type: 'delegated' },
      excludeServices: undefined,
    },
    {
      enabled: false,
      auth: { type: 'delegated' },
      excludeServices: undefined,
    },
    {
      enabled: true,
      auth: { type: 'delegated' },
      excludeServices: 'functions',
    },
  ])(
    'rejects missing or unsupported auth before real and dry-run deployment: %j',
    async ({ enabled, auth, excludeServices }) => {
      mockLoadRayfinConfig.mockReturnValue({
        ...BASE_CONFIG,
        services: {
          ...BASE_CONFIG.services,
          functions: { enabled, auth },
        },
      });
      for (const dryRun of [false, true]) {
        stdoutWrites = [];
        await expect(
          runUpV2({ output: 'json', dryRun, excludeServices })
        ).rejects.toThrow(CliHandledError);
        expect(stdoutWrites).toHaveLength(1);
        expect(parseLastJson()).toMatchObject({
          status: 'error',
          code: 'invalid-functions-config',
          error: expect.stringContaining(
            'Set services.functions.auth.type to "application".'
          ),
        });
        expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
        expect(mockRunUpWorkflow).not.toHaveBeenCalled();
      }
    }
  );

  it.each([
    { enabled: true, excludeServices: undefined },
    { enabled: false, excludeServices: undefined },
    { enabled: true, excludeServices: 'functions' },
  ])(
    'accepts application auth without opt-in during deployment: %j',
    async ({ enabled, excludeServices }) => {
      mockLoadRayfinConfig.mockReturnValue({
        ...BASE_CONFIG,
        services: {
          ...BASE_CONFIG.services,
          functions: { enabled, auth: { type: 'application' } },
        },
      });
      await runUpV2(
        makeOptions({
          output: 'json',
          workspaceId: 'ws-explicit',
          excludeServices,
        })
      );
      expect(mockRunUpWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            services: expect.objectContaining({
              functions: { enabled, auth: { type: 'application' } },
            }),
          }),
        }),
        expect.anything()
      );
    }
  );

  it.each(['plain', 'json'] as const)(
    'rejects invalid functions authentication before dry-run in %s mode',
    async (output) => {
      mockLoadRayfinConfig.mockReturnValueOnce({
        ...BASE_CONFIG,
        services: {
          ...BASE_CONFIG.services,
          functions: {
            enabled: true,
            auth: { type: 'appAuth' },
          },
        },
      } as unknown as RayfinConfig);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        runUpV2(
          makeOptions({
            output,
            dryRun: true,
            yes: true,
            workspaceId: 'ws-explicit',
          })
        )
      ).rejects.toBeInstanceOf(CliHandledError);

      expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
      expect(mockRunUpWorkflow).not.toHaveBeenCalled();
      if (output === 'json') {
        expect(parseLastJson()).toEqual({
          status: 'error',
          error:
            'functions block in rayfin.yml has validation errors:\n' +
            '  • services.functions.auth.type: ' +
            'Invalid services.functions.auth.type: found "appAuth". ' +
            'Only application authentication is supported. ' +
            'Set services.functions.auth.type to "application".',
          code: 'invalid-functions-config',
          warnings: [],
        });
      } else {
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            'Invalid services.functions.auth.type: found "appAuth"'
          )
        );
      }
    }
  );

  it('rejects an unsupported posture before authenticating', async () => {
    mockFeatureFlagGet.mockImplementation(
      (name) => name === 'cli-up-anonstatic'
    );
    mockLoadRayfinConfig.mockReturnValueOnce({
      ...BASE_CONFIG,
      services: {
        ...BASE_CONFIG.services,
        staticHosting: { enabled: true, assetAccess: 'private' },
      },
    } as unknown as RayfinConfig);

    await expect(
      runUpV2(
        makeOptions({
          output: 'json',
          workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
        })
      )
    ).rejects.toBeInstanceOf(CliHandledError);

    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    {
      inspection: {
        state: 'outdated',
        packages: ['@microsoft/rayfin-auth'],
      },
      code: 'auth-sdk-outdated',
      message: '@microsoft/rayfin-auth',
    },
    {
      inspection: {
        state: 'unresolved',
        reason: 'Cannot resolve @microsoft/rayfin-auth',
      },
      code: 'auth-sdk-unresolved',
      message: 'Cannot resolve @microsoft/rayfin-auth',
    },
  ])(
    'rejects $code before authentication or Fabric readiness',
    async ({ inspection, code, message }) => {
      mockFeatureFlagGet.mockImplementation(
        (name) => name === 'cli-up-anonstatic'
      );
      mockLoadRayfinConfig.mockReturnValueOnce({
        ...BASE_CONFIG,
        services: {
          ...BASE_CONFIG.services,
          staticHosting: { enabled: true, assetAccess: 'protected' },
        },
      } as RayfinConfig);
      mockInspectAuthSdk.mockResolvedValueOnce(inspection);

      await expect(
        runUpV2(
          makeOptions({
            output: 'json',
            workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
          })
        )
      ).rejects.toBeInstanceOf(CliHandledError);

      expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
      expect(mockRunFabricReadinessWorkflow).not.toHaveBeenCalled();
      expect(mockRunUpWorkflow).not.toHaveBeenCalled();
      expect(parseLastJson()).toMatchObject({
        status: 'error',
        code,
        error: expect.stringContaining(message),
      });
    }
  );

  it('collects interactive auth SDK upgrade consent before Fabric readiness', async () => {
    mockFeatureFlagGet.mockImplementation(
      (name) => name === 'cli-up-anonstatic'
    );
    mockIsInteractive.mockReturnValue(true);
    mockLoadRayfinConfig.mockReturnValueOnce({
      ...BASE_CONFIG,
      services: {
        ...BASE_CONFIG.services,
        staticHosting: { enabled: true, assetAccess: 'protected' },
      },
    } as RayfinConfig);
    mockInspectAuthSdk.mockResolvedValueOnce({
      state: 'outdated',
      packages: ['@microsoft/rayfin-auth'],
    });
    const confirmSpy = vi
      .spyOn(cliUserInteraction, 'confirm')
      .mockResolvedValue(true);

    await runUpV2(
      makeOptions({
        output: 'interactive',
        workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
      })
    );

    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(mockUpgradeAuthSdk).toHaveBeenCalledOnce();
    expect(mockUpgradeAuthSdk.mock.invocationCallOrder[0]).toBeLessThan(
      mockEnsureAuthenticated.mock.invocationCallOrder[0]
    );
    expect(mockUpgradeAuthSdk.mock.invocationCallOrder[0]).toBeLessThan(
      mockRunFabricReadinessWorkflow.mock.invocationCallOrder[0]
    );
  });

  it('blocks interactive readiness when auth SDK upgrade is declined', async () => {
    mockFeatureFlagGet.mockImplementation(
      (name) => name === 'cli-up-anonstatic'
    );
    mockIsInteractive.mockReturnValue(true);
    mockLoadRayfinConfig.mockReturnValueOnce({
      ...BASE_CONFIG,
      services: {
        ...BASE_CONFIG.services,
        staticHosting: { enabled: true, assetAccess: 'protected' },
      },
    } as RayfinConfig);
    mockInspectAuthSdk.mockResolvedValueOnce({
      state: 'outdated',
      packages: ['@microsoft/rayfin-auth'],
    });
    vi.spyOn(cliUserInteraction, 'confirm').mockResolvedValue(false);

    await expect(
      runUpV2(
        makeOptions({
          output: 'interactive',
          workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
        })
      )
    ).rejects.toBeInstanceOf(CliHandledError);

    expect(mockUpgradeAuthSdk).not.toHaveBeenCalled();
    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
    expect(mockRunFabricReadinessWorkflow).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
  });

  it('rejects an invalid storage dependency before dry-run or authentication', async () => {
    mockLoadRayfinConfig.mockReturnValueOnce({
      id: 'proj',
      services: {
        auth: { enabled: false },
        data: { enabled: false },
        storage: { enabled: true },
      },
    } as unknown as RayfinConfig);

    await expect(
      runUpV2(
        makeOptions({
          output: 'json',
          dryRun: true,
          workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
        })
      )
    ).rejects.toBeInstanceOf(CliHandledError);

    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
    expect(parseLastJson()).toEqual({
      status: 'error',
      error:
        'Storage requires the Data service.\n' +
        '   Enable services.data or disable services.storage in rayfin.yml.',
    });
  });

  it('serializes an explicit env-file load failure in json mode', async () => {
    mockLoadRayfinConfig.mockImplementationOnce(() => {
      throw new Error('Environment file not found: /proj/missing.env');
    });

    await expect(
      runUpV2(
        makeOptions({
          output: 'json',
          envFile: 'missing.env',
          workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
        })
      )
    ).rejects.toBeInstanceOf(CliHandledError);

    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
    expect(parseLastJson()).toEqual({
      status: 'error',
      error: 'Environment file not found: /proj/missing.env',
    });
  });

  it('renders a human-readable error when an explicit env-file load fails (plain mode)', async () => {
    mockLoadRayfinConfig.mockImplementationOnce(() => {
      throw new Error('Environment file not found: /proj/missing.env');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      runUpV2(
        makeOptions({
          output: 'plain',
          envFile: 'missing.env',
          workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
        })
      )
    ).rejects.toBeInstanceOf(CliHandledError);

    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
    // failUp renders `❌ <message>` to stderr (via console.error) in
    // non-json modes; the json test above covers the machine-readable shape.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '❌ Environment file not found: /proj/missing.env'
      )
    );
  });

  it.each(['interactive', 'plain'] as const)(
    'renders an actionable functions auth validation error in %s mode without prompting',
    async (output) => {
      mockIsInteractive.mockReturnValue(output === 'interactive');
      mockRunUpWorkflow.mockResolvedValueOnce({
        status: 'failed',
        error: {
          code: 'invalid-functions-config',
          message: INVALID_FUNCTIONS_AUTH_ERROR,
        },
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        runUpV2(
          makeOptions({
            output,
            yes: output === 'plain',
            workspaceId: 'ws-explicit',
          })
        )
      ).rejects.toBeInstanceOf(CliHandledError);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(INVALID_FUNCTIONS_AUTH_ERROR)
      );
      expect(stdoutWrites).toEqual([]);
      expect(mockPromptWorkspaceSelection).not.toHaveBeenCalled();
      expect(mockRunUpWorkflow).toHaveBeenCalledOnce();
    }
  );

  it('serializes the actionable functions auth validation error in json mode', async () => {
    mockRunUpWorkflow.mockResolvedValueOnce({
      status: 'failed',
      error: {
        code: 'invalid-functions-config',
        message: INVALID_FUNCTIONS_AUTH_ERROR,
      },
    });

    await expect(
      runUpV2(
        makeOptions({
          output: 'json',
          yes: true,
          workspaceId: 'ws-explicit',
        })
      )
    ).rejects.toBeInstanceOf(CliHandledError);

    expect(stdoutWrites).toHaveLength(1);
    expect(parseLastJson()).toEqual({
      status: 'error',
      error: INVALID_FUNCTIONS_AUTH_ERROR,
      code: 'invalid-functions-config',
      warnings: [],
    });
    expect(mockPromptWorkspaceSelection).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).toHaveBeenCalledOnce();
  });

  it('selects a terminal mirror without passing verbose into workflow deps', async () => {
    await runUpV2(
      makeOptions({
        output: 'plain',
        verbose: true,
        workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
      })
    );

    expect(vi.mocked(createUpDeps)).toHaveBeenCalledWith(
      expect.objectContaining({ diagnostics: { debug: expect.any(Function) } })
    );
    expect(vi.mocked(createUpDeps).mock.calls[0][0]).not.toHaveProperty(
      'verbose'
    );
    expect(createCliDiagnosticSession).toHaveBeenCalledWith(
      expect.objectContaining({ mirror: expect.any(Function) })
    );
  });

  it('threads declared connectors into the workflow request', async () => {
    mockLoadRayfinConfig.mockReturnValueOnce({
      ...BASE_CONFIG,
      connectors: [
        {
          name: 'inventory',
          type: 'fabric-sqldatabase',
          config: { workspaceId: 'source-ws', itemId: 'source-item' },
          auth: { type: 'delegated' },
        },
      ],
    } as RayfinConfig);

    await runUpV2(
      makeOptions({
        output: 'json',
        workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
      })
    );

    expect(mockRunUpWorkflow.mock.calls[0][0].connectorsEnabled).toBe(true);
  });

  it('leaves connectors off the workflow request when none are declared', async () => {
    await runUpV2(makeOptions({ output: 'json', workspaceId: 'ws-explicit' }));

    expect(mockRunUpWorkflow.mock.calls[0][0].connectorsEnabled).toBe(false);
  });

  it('rejects --verbose with json output before authentication or workflow', async () => {
    await expect(
      runUpV2(
        makeOptions({
          output: 'json',
          verbose: true,
          workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
        })
      )
    ).rejects.toBeInstanceOf(CliHandledError);

    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
    expect(parseLastJson()).toEqual({
      status: 'error',
      error:
        '--verbose cannot be combined with JSON output.\n' +
        '   JSON output requires a single JSON object on stdout; verbose logging would corrupt it.\n' +
        '   Re-run with either JSON output or --verbose, not both.',
    });
  });

  it('(c) emits a structured dry-run payload in json mode', async () => {
    vi.mocked(findRayfinProjectRoot).mockReturnValueOnce(process.cwd());
    mockFeatureFlagGet.mockImplementation(
      (name) => name === 'cli-up-anonstatic'
    );
    mockLoadRayfinConfig.mockReturnValueOnce({
      ...BASE_CONFIG,
      services: {
        ...BASE_CONFIG.services,
        staticHosting: {
          enabled: true,
          folder: 'dist',
          buildCommand: 'npm run build',
        },
      },
    } as RayfinConfig);
    mockCollectLegacyMigrationWarnings.mockReturnValueOnce([
      'Detected env-strategy v1 artifacts.',
    ]);

    await expect(
      runUpV2(
        makeOptions({
          output: 'json',
          dryRun: true,
          workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
        })
      )
    ).resolves.toBeUndefined();

    expect(mockEnsureAuthenticated).toHaveBeenCalledOnce();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
    expect(parseLastJson()).toMatchObject({
      status: 'dry-run',
      blocked: false,
      plan: {
        projectName: 'proj',
        itemName: 'proj',
        preflight: [{ blocking: false }],
      },
      warnings: ['Detected env-strategy v1 artifacts.'],
    });
  });

  it('describes no-target readiness operations as conditional in JSON dry-run', async () => {
    await runUpV2(makeOptions({ output: 'json', dryRun: true }));

    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
    expect(parseLastJson()).toMatchObject({
      status: 'dry-run',
      plan: {
        targeting: {
          fabricReadiness: {
            target: 'conditional',
            checkCapacity: true,
            capacitySelection: 'fallback',
            assignmentConsent: 'automatic',
            ambiguousCapacitySelection: 'capacity-id-required',
            startTrialIfNeeded: true,
            createWorkspaceIfNeeded: true,
            assignCapacityIfNeeded: true,
          },
        },
      },
    });
  });

  it('describes automatic assignment in a plain no-target dry-run', async () => {
    await runUpV2(makeOptions({ output: 'plain', dryRun: true }));

    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
    expect(vi.mocked(process.stderr.write)).toHaveBeenCalledWith(
      '  ✓ Assign capacity automatically when selection is deterministic; require --capacity-id when multiple capacities are available\n'
    );
  });

  it('retains assignment confirmation in an interactive no-target dry-run', async () => {
    mockIsInteractive.mockReturnValue(true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runUpV2(makeOptions({ output: 'interactive', dryRun: true }));

    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      '  ✓ Require confirmation before assigning the selected or trial capacity'
    );
  });

  it('describes an explicit capacity in the JSON dry-run plan', async () => {
    await runUpV2(
      makeOptions({
        output: 'json',
        dryRun: true,
        capacityId: '11111111-1111-4111-8111-111111111111',
      })
    );

    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
    expect(parseLastJson()).toMatchObject({
      plan: {
        targeting: {
          fabricReadiness: {
            capacitySelection: 'explicit',
            capacityId: '11111111-1111-4111-8111-111111111111',
            assignmentConsent: 'explicit-capacity',
            startTrialIfNeeded: false,
          },
        },
      },
    });
  });

  it('describes --yes capacity consent in the JSON dry-run plan', async () => {
    await runUpV2(makeOptions({ output: 'json', dryRun: true, yes: true }));

    expect(mockEnsureAuthenticated).not.toHaveBeenCalled();
    expect(parseLastJson()).toMatchObject({
      plan: {
        targeting: {
          fabricReadiness: {
            capacitySelection: 'fallback',
            assignmentConsent: 'automatic',
            ambiguousCapacitySelection: 'capacity-id-required',
            startTrialIfNeeded: true,
          },
        },
      },
    });
  });

  it('includes existing-workspace readiness operations in the text dry-run plan', async () => {
    mockIsInteractive.mockReturnValue(true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runUpV2(
      makeOptions({
        output: 'interactive',
        dryRun: true,
        workspaceId: SUCCESS_RESULT.workspaceId,
      })
    );

    expect(logSpy).toHaveBeenCalledWith(
      '  ✓ Check whether the target workspace has usable Fabric capacity'
    );
    expect(logSpy).toHaveBeenCalledWith(
      '  ✓ Select one premium capacity automatically or ask when several are available'
    );
    expect(logSpy).toHaveBeenCalledWith('  ✓ Start a Fabric trial if required');
    expect(logSpy).toHaveBeenCalledWith(
      '  ✓ Require confirmation before assigning the selected or trial capacity'
    );
  });

  it('routes plain readiness milestones to stderr without polluting stdout', () => {
    const { logger } = createConsole('plain', false);

    logger.log('Created Fabric workspace "workspace".');

    expect(stdoutWrites).toEqual([]);
    expect(vi.mocked(process.stderr.write)).toHaveBeenCalledWith(
      'Created Fabric workspace "workspace".\n'
    );
  });

  it('includes storage enablement and config apply in the dry-run plan', async () => {
    mockLoadRayfinConfig.mockReturnValueOnce({
      ...BASE_CONFIG,
      services: {
        ...BASE_CONFIG.services,
        data: { enabled: true },
        storage: { enabled: true },
      },
      connectors: [
        {
          name: 'inventory',
          type: 'fabric-sqldatabase',
          config: { workspaceId: 'source-ws', itemId: 'source-item' },
          auth: { type: 'delegated' },
        },
      ],
    } as RayfinConfig);

    await runUpV2(
      makeOptions({
        output: 'json',
        dryRun: true,
        workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
      })
    );

    const plan = parseLastJson();
    expect(plan).toMatchObject({
      plan: {
        services: { storage: true },
        configurationApplies: { storage: true },
        connectors: [{ name: 'inventory', type: 'fabric-sqldatabase' }],
      },
    });
  });

  it('renders storage config apply in the human-readable dry-run plan', async () => {
    mockLoadRayfinConfig.mockReturnValueOnce({
      ...BASE_CONFIG,
      services: {
        ...BASE_CONFIG.services,
        data: { enabled: true },
        storage: { enabled: true },
      },
    } as RayfinConfig);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runUpV2(
      makeOptions({
        output: 'interactive',
        dryRun: true,
        workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
      })
    );

    expect(logSpy).toHaveBeenCalledWith(
      '  ✓ Generate and apply storage configuration'
    );
  });

  it('renders declared connectors in the human-readable dry-run plan', async () => {
    mockLoadRayfinConfig.mockReturnValueOnce({
      ...BASE_CONFIG,
      connectors: [
        {
          name: 'inventory',
          type: 'fabric-sqldatabase',
          config: { workspaceId: 'source-ws', itemId: 'source-item' },
          auth: { type: 'delegated' },
        },
      ],
    } as RayfinConfig);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runUpV2(
      makeOptions({
        output: 'interactive',
        dryRun: true,
        workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
      })
    );

    expect(logSpy).toHaveBeenCalledWith(
      '  ✓ Generate and apply connector configs:'
    );
    expect(logSpy).toHaveBeenCalledWith(
      '      • inventory (fabric-sqldatabase)'
    );
  });

  it('omits the connector plan entirely when none are declared', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runUpV2(
      makeOptions({
        output: 'interactive',
        dryRun: true,
        workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
      })
    );

    expect(logSpy).not.toHaveBeenCalledWith(
      '  ✓ Generate and apply connector configs:'
    );
  });

  it('(d) maps an ok Result to a success JSON payload and exit 0', async () => {
    mockRunUpWorkflow.mockResolvedValue({
      status: 'ok',
      data: SUCCESS_RESULT,
    });

    await expect(
      runUpV2(
        makeOptions({
          output: 'json',
          workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
        })
      )
    ).resolves.toBeUndefined();

    expect(parseLastJson()).toMatchObject({
      status: 'success',
      deployment: {
        rayfinItemId: 'item-1',
        itemName: 'proj',
      },
      persistence: {
        workspaceKey: 'workspace',
        configUpdated: false,
        envBackup: null,
      },
    });
  });

  it('includes structured readiness resource identities in success JSON', async () => {
    mockRunUpWorkflow.mockResolvedValue({
      status: 'ok',
      data: {
        ...SUCCESS_RESULT,
        workspaceCreated: true,
        trialStarted: true,
        readinessNotices: [
          {
            kind: 'trial-started',
            capacityId: 'cap-1',
            capacityName: 'Trial Capacity',
          },
          {
            kind: 'workspace-created',
            workspaceId: 'ws-explicit',
            workspaceName: 'Workspace',
          },
        ],
      },
    });

    await runUpV2(makeOptions({ output: 'json', workspaceId: 'ws-explicit' }));

    expect(parseLastJson()).toMatchObject({
      status: 'success',
      notices: [
        {
          kind: 'trial-started',
          capacityId: 'cap-1',
          capacityName: 'Trial Capacity',
        },
        {
          kind: 'workspace-created',
          workspaceId: 'ws-explicit',
          workspaceName: 'Workspace',
        },
      ],
    });
  });

  it('surfaces skipped connector generation outcomes in success JSON (AB#2279031)', async () => {
    mockRunUpWorkflow.mockResolvedValue({
      status: 'ok',
      data: {
        ...SUCCESS_RESULT,
        generate: [
          { name: 'northwind', status: 'success' },
          {
            name: 'm2mlakehouse',
            status: 'skipped',
            skipReason: 'missing-generated-config',
            reason:
              'No generated connector config found; run generation first.',
          },
        ],
      },
    });

    await runUpV2(makeOptions({ output: 'json', workspaceId: 'ws-explicit' }));

    expect(parseLastJson()).toMatchObject({
      status: 'success',
      generate: [
        { name: 'northwind', status: 'success' },
        {
          name: 'm2mlakehouse',
          status: 'skipped',
          skipReason: 'missing-generated-config',
        },
      ],
      skippedConnectors: [
        {
          name: 'm2mlakehouse',
          reason: 'No generated connector config found; run generation first.',
        },
      ],
    });
  });

  it('includes migration warnings and persistence facts in success JSON', async () => {
    mockCollectLegacyMigrationWarnings.mockReturnValueOnce([
      'Detected env-strategy v1 artifacts.',
    ]);
    mockRunUpWorkflow.mockResolvedValue({
      status: 'ok',
      data: {
        ...SUCCESS_RESULT,
        configUpdated: true,
        envBackup: {
          sourcePath: '/proj/rayfin/.env',
          backupPath: '/proj/rayfin/.env.bak',
        },
      },
    });

    await runUpV2(
      makeOptions({
        output: 'json',
        workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
      })
    );

    expect(parseLastJson()).toMatchObject({
      status: 'success',
      persistence: {
        workspaceKey: 'workspace',
        configUpdated: true,
        envBackup: {
          sourcePath: '/proj/rayfin/.env',
          backupPath: '/proj/rayfin/.env.bak',
        },
      },
      warnings: ['Detected env-strategy v1 artifacts.'],
    });
  });

  it('serializes malformed-registry targeting warnings in JSON', async () => {
    mockListDeploymentsState.mockReturnValueOnce({
      deployments: [],
      warnings: ['Could not parse /proj/rayfin/.deployments.json'],
    });

    await runUpV2(
      makeOptions({
        output: 'json',
        workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
      })
    );

    expect(parseLastJson()).toMatchObject({
      status: 'success',
      warnings: ['Could not parse /proj/rayfin/.deployments.json'],
    });
  });

  it('does not prompt in JSON mode and serializes targeting failure warnings', async () => {
    mockListDeploymentsState.mockReturnValue({
      deployments: [],
      warnings: ['Could not parse /proj/rayfin/.deployments.json'],
    });

    await expect(
      runUpV2(makeOptions({ output: 'json' }))
    ).rejects.toBeInstanceOf(CliHandledError);

    expect(mockPromptWorkspaceSelection).not.toHaveBeenCalled();
    expect(mockRunUpWorkflow).not.toHaveBeenCalled();
    expect(parseLastJson()).toMatchObject({
      status: 'action_required',
      warnings: ['Could not parse /proj/rayfin/.deployments.json'],
    });
  });

  it('deduplicates pre-flight and workflow warnings in JSON', async () => {
    const warning = 'Could not parse /proj/rayfin/.deployments.json';
    mockListDeploymentsState.mockReturnValue({
      deployments: [],
      warnings: [warning],
    });
    mockRunUpWorkflow.mockResolvedValue({
      status: 'ok',
      data: SUCCESS_RESULT,
      warnings: [warning],
    });

    await runUpV2(
      makeOptions({
        output: 'json',
        workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
      })
    );

    expect(parseLastJson()).toMatchObject({ warnings: [warning] });
  });

  it('renders a sanitized workspace name exactly once after interactive progress stops', async () => {
    mockRunUpWorkflow.mockResolvedValue({
      status: 'ok',
      data: {
        ...SUCCESS_RESULT,
        workspaceName: 'My Workspace',
        workspaceKey: 'my-workspace',
      },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runUpV2(
      makeOptions({
        output: 'interactive',
        workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
      })
    );

    expect(
      logSpy.mock.calls.filter(([message]) =>
        String(message).includes(
          'Workspace name sanitized: "My Workspace" → "my-workspace"'
        )
      )
    ).toHaveLength(1);
  });

  it('renders project discovery once and config updates after the workflow', async () => {
    mockRunUpWorkflow.mockResolvedValue({
      status: 'ok',
      data: { ...SUCCESS_RESULT, configUpdated: true },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runUpV2(
      makeOptions({
        output: 'interactive',
        workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
      })
    );

    expect(
      logSpy.mock.calls.filter(([message]) =>
        String(message).includes('Found Rayfin project root: /proj')
      )
    ).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledWith('✅ Updated rayfin.yml configuration');
  });

  it('keeps readiness completion logs visible exactly once', async () => {
    mockRunFabricReadinessWorkflow.mockImplementation(async (_input, deps) => {
      deps.logger?.log('Created Fabric trial capacity "Trial".');
      deps.logger?.log(
        'Created Fabric workspace "proj". If this command is interrupted, delete it manually in the Fabric portal.'
      );
      deps.logger?.log('Assigned Fabric workspace "proj" to capacity "Trial".');
      return {
        status: 'ok',
        data: {
          result: {
            status: 'ready',
            workspace: { id: 'ws-new', displayName: 'proj' },
            capacityId: 'cap-1',
            capacitySource: 'new-trial',
            workspaceCreated: true,
          },
          notices: [],
        },
      };
    });
    mockRunUpWorkflow.mockResolvedValue({
      status: 'ok',
      data: {
        ...SUCCESS_RESULT,
        workspaceName: 'proj',
        workspaceKey: 'proj',
        workspaceCreated: true,
        trialStarted: true,
      },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runUpV2(makeOptions({ output: 'interactive', yes: true }));

    expect(logSpy).toHaveBeenCalledWith(
      '✅ Created Fabric trial capacity "Trial".'
    );
    expect(logSpy).toHaveBeenCalledWith(
      '✅ Created Fabric workspace "proj". If this command is interrupted, delete it manually in the Fabric portal.'
    );
    expect(logSpy).toHaveBeenCalledWith(
      '✅ Assigned Fabric workspace "proj" to capacity "Trial".'
    );
    expect(
      logSpy.mock.calls.filter(([message]) =>
        String(message).includes('Created Fabric workspace "proj"')
      )
    ).toHaveLength(1);
    expect(
      logSpy.mock.calls.filter(([message]) =>
        String(message).includes('Started a Fabric trial capacity')
      )
    ).toHaveLength(0);
    expect(
      logSpy.mock.calls.filter(([message]) =>
        String(message).includes('Created Fabric trial capacity "Trial"')
      )
    ).toHaveLength(1);
    expect(
      logSpy.mock.calls.filter(([message]) =>
        String(message).includes('Assigned Fabric workspace')
      )
    ).toHaveLength(1);

    logSpy.mockClear();

    await runUpV2(makeOptions({ output: 'plain', yes: true }));

    expect(stdoutWrites).toEqual([]);
    const plainOutput = vi
      .mocked(process.stderr.write)
      .mock.calls.map(([chunk]) => String(chunk))
      .join('');
    expect(plainOutput).toContain('Created Fabric trial capacity "Trial".');
    expect(plainOutput).toContain(
      'Created Fabric workspace "proj". If this command is interrupted, delete it manually in the Fabric portal.'
    );
    expect(plainOutput).toContain(
      'Assigned Fabric workspace "proj" to capacity "Trial".'
    );
  });

  it('stays silent about readiness when it reused an existing workspace', async () => {
    mockRunUpWorkflow.mockResolvedValue({ status: 'ok', data: SUCCESS_RESULT });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runUpV2(
      makeOptions({ output: 'interactive', workspaceId: 'ws-explicit' })
    );

    expect(
      logSpy.mock.calls.filter(([message]) =>
        String(message).includes('Created Fabric workspace')
      )
    ).toHaveLength(0);
  });

  it('renders migration warnings before workflow progress starts', async () => {
    mockCollectLegacyMigrationWarnings.mockReturnValueOnce([
      '⚠️  Detected env-strategy v1 artifacts.',
    ]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runUpV2(
      makeOptions({
        output: 'interactive',
        workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
      })
    );

    expect(warnSpy).toHaveBeenCalledWith(
      '⚠️  Detected env-strategy v1 artifacts.'
    );
  });

  it('renders environment backup facts after the workflow', async () => {
    mockRunUpWorkflow.mockResolvedValue({
      status: 'ok',
      data: {
        ...SUCCESS_RESULT,
        envBackup: {
          sourcePath: '/proj/rayfin/.env',
          backupPath: '/proj/rayfin/.env.bak',
        },
      },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runUpV2(
      makeOptions({
        output: 'interactive',
        workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
      })
    );

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Backed up your previous /proj/rayfin/.env to /proj/rayfin/.env.bak'
      )
    );
  });

  it('(d) maps a cancelled Result to a cancelled JSON payload and exit 0', async () => {
    mockRunUpWorkflow.mockResolvedValue({ status: 'cancelled' });

    await expect(
      runUpV2(
        makeOptions({
          output: 'json',
          workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
        })
      )
    ).resolves.toBeUndefined();

    expect(parseLastJson()).toEqual({
      status: 'cancelled',
      reason: 'reuse-declined',
      warnings: [],
    });
  });

  it('includes warnings and notices in cancelled JSON', async () => {
    mockRunUpWorkflow.mockResolvedValue({
      status: 'cancelled',
      warnings: ['partial state warning'],
      notices: [
        {
          kind: 'env-backup',
          sourcePath: '/proj/rayfin/.env',
          backupPath: '/proj/rayfin/.env.bak',
        },
      ],
    });

    await runUpV2(
      makeOptions({
        output: 'json',
        workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
      })
    );

    expect(parseLastJson()).toMatchObject({
      status: 'cancelled',
      warnings: ['partial state warning'],
      notices: [{ kind: 'env-backup' }],
    });
  });

  it('(d) maps a failed Result to a JSON error and throws CliHandledError (exit 1)', async () => {
    const cause = new HttpError('boom', 500);
    mockRunUpWorkflow.mockResolvedValue({
      status: 'failed',
      error: { code: 'E_BOOM', message: 'boom', cause },
    });

    try {
      await runUpV2(
        makeOptions({
          output: 'json',
          workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
        })
      );
      expect.fail('Expected runUpV2 to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CliHandledError);
      expect((error as CliHandledError).originalError).toBe(cause);
      expect(
        (error as CliHandledError).originalError as HttpError
      ).toHaveProperty('statusCode', 500);
    }

    expect(parseLastJson()).toEqual({
      status: 'error',
      error: 'boom',
      code: 'E_BOOM',
      warnings: [],
    });
  });

  it('includes migration warnings and workflow notices in failed JSON', async () => {
    mockCollectLegacyMigrationWarnings.mockReturnValueOnce([
      'Detected env-strategy v1 artifacts.',
    ]);
    mockRunUpWorkflow.mockResolvedValue({
      status: 'failed',
      error: { code: 'E_BOOM', message: 'boom' },
      notices: [
        {
          kind: 'env-backup',
          sourcePath: '/proj/rayfin/.env',
          backupPath: '/proj/rayfin/.env.bak',
        },
      ],
    });

    await expect(
      runUpV2(
        makeOptions({
          output: 'json',
          workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
        })
      )
    ).rejects.toBeInstanceOf(CliHandledError);

    expect(parseLastJson()).toMatchObject({
      status: 'error',
      code: 'E_BOOM',
      notices: [{ kind: 'env-backup' }],
      warnings: ['Detected env-strategy v1 artifacts.'],
    });
  });
});

describe('createConsole', () => {
  // The `(mode, interactive)` selection table is the one host branch this PR
  // added; a regression here (e.g. returning a non-suspending `ui` in
  // interactive mode) would silently re-open Bug 1. `ora` is mocked above so
  // the interactive row does not start a live spinner;
  // `createInteractiveConsole`'s real-ora wiring is left to the flag-matrix E2E.
  it.each([
    ['interactive', true, true],
    ['interactive', false, false],
    ['plain', true, true],
    ['plain', false, false],
    // Reachable: `--json` on a TTY without `--yes` yields mode=json AND
    // interactive=true. The json branch suppresses `ui` unconditionally so no
    // inquirer prompt can leak into the JSON stream.
    ['json', true, false],
    ['json', false, false],
  ] as const)(
    'mode=%s interactive=%s exposes ui=%s',
    (mode, interactive, uiPresent) => {
      const { ui } = createConsole(mode, interactive);
      expect(ui !== undefined).toBe(uiPresent);
    }
  );

  it('uses plain progress for verbose interactive output without disabling prompts', () => {
    const { progress, ui } = createConsole('interactive', true, true);

    expect(progress).toBe(plainProgress);
    expect(ui).toBe(cliUserInteraction);
  });
});
