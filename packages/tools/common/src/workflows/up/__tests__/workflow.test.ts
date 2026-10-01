import { describe, expect, it, vi } from 'vitest';

import type { CancellationToken } from '../../../adapters/index.js';
import { noopTelemetryHandle } from '../../../adapters/index.js';
import { parseRayfinYaml, type RayfinConfig } from '../../../config/index.js';
import { FabricError } from '../../../external/fabric/index.js';
import { CONNECTOR_CONFIG_SKIP_REASON } from '../../../services/connectors/index.js';
import { noopDeploymentTelemetryCollector } from '../../../services/project-telemetry/index.js';
import { toRuntimeSettingsServices } from '../../../services/runtime-settings/index.js';
import { StorageApplyError } from '../../../services/storage/index.js';
import type { UpDeps, UpRequest } from '../types.js';
import { runUpWorkflow } from '../workflow.js';

const target = {
  itemId: 'i1',
  itemEndpoint: 'https://api/i1',
  baasEndpoint: 'https://baas/i1',
  authorizationHeader: 'Bearer t',
};

function config(
  services: Partial<RayfinConfig['services']> = {},
  connectors?: RayfinConfig['connectors']
): RayfinConfig {
  return {
    id: 'my-app',
    name: 'My App',
    version: '1',
    services: {
      auth: { enabled: true },
      data: { enabled: true },
      staticHosting: { enabled: true, folder: 'dist' },
      functions: { enabled: true, auth: { type: 'application' } },
      ...services,
    },
    connectors,
  } as unknown as RayfinConfig;
}

function baseRequest(overrides: Partial<UpRequest> = {}): UpRequest {
  return {
    config: config(),
    itemName: 'my-app',
    projectRoot: '/p',
    workspaceId: 'w1',
    portalBaseUrl: 'https://portal',
    functionsEnabled: true,
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<UpDeps> = {}): UpDeps {
  return {
    diagnostics: { debug: vi.fn() },
    fabric: {
      findTrialCapacity: vi.fn().mockResolvedValue(undefined),
      listCapacities: vi.fn().mockResolvedValue([]),
      getCapacity: vi.fn().mockResolvedValue({
        id: 'c1',
        displayName: 'c1',
        sku: 'F2',
        state: 'Active',
      }),
      checkTrialEligibility: vi.fn(),
      startTrial: vi.fn(),
      getOperationStatus: vi.fn(),
      getOperationResult: vi.fn(),
      listWorkspaces: vi.fn(),
      isWorkspaceAdmin: vi.fn().mockResolvedValue(true),
      getWorkspace: vi
        .fn()
        .mockResolvedValue({ id: 'w1', displayName: 'My Workspace' }),
      createWorkspace: vi.fn(),
      assignWorkspaceToCapacity: vi.fn(),
      getItemByName: vi.fn().mockResolvedValue(undefined),
      createItem: vi.fn().mockResolvedValue({
        id: 'i1',
        displayName: 'my-app',
        type: 'AppBackend',
        workspaceId: 'w1',
      }),
    },
    workload: {
      resolveTarget: vi.fn().mockResolvedValue(target),
      getPublishableKey: vi.fn().mockResolvedValue('pk_123'),
      applyRuntimeSettings: vi.fn().mockResolvedValue(undefined),
    },
    connectors: { applyConfigs: vi.fn().mockResolvedValue({ results: [] }) },
    data: { applyDatabaseConfig: vi.fn().mockResolvedValue(undefined) },
    storage: { applyStorageConfig: vi.fn().mockResolvedValue(undefined) },
    staticHosting: {
      validateFolder: vi.fn().mockResolvedValue({
        exists: true,
        empty: false,
        resolvedPath: '/p/dist',
        fileCount: 2,
        totalSizeBytes: 50,
      }),
      runBuild: vi.fn().mockResolvedValue(true),
      packageFolder: vi.fn().mockResolvedValue(new Uint8Array([1])),
      deploy: vi.fn().mockResolvedValue({
        success: true,
        hostingUrl: 'https://app.example',
        deploymentId: 'd1',
        errorMessage: null,
      }),
      persistHostingUrl: vi.fn().mockResolvedValue({
        configUpdated: true,
        workspaceKey: 'my-workspace',
        warnings: [],
      }),
      persistAssetAccess: vi.fn().mockResolvedValue({ status: 'persisted' }),
    },
    runtimeConfig: {
      write: vi.fn().mockResolvedValue({
        path: '/p/public/rayfin.config.json',
        preexisting: false,
        differences: [],
      }),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    registry: {
      persistDeployment: vi
        .fn()
        .mockResolvedValue({ workspaceKey: 'my-workspace', warnings: [] }),
      readDeployment: vi.fn().mockResolvedValue({ record: null, warnings: [] }),
      getActiveDeployment: vi.fn(),
      listDeployments: vi
        .fn()
        .mockResolvedValue({ deployments: [], warnings: [] }),
      setActiveDeployment: vi.fn(),
    },
    frameworkEnv: {
      detectFramework: vi.fn().mockResolvedValue('vite'),
      writeEnvFile: vi.fn().mockResolvedValue('/p/.env.local'),
    },
    functions: { deploy: vi.fn().mockResolvedValue(undefined) },
    devRedirect: {
      resolveFrontendDevPort: vi
        .fn()
        .mockResolvedValue({ port: 5173, redirectPorts: [5173] }),
      appendLocalDevRedirectUris: vi
        .fn()
        .mockImplementation((services) => services),
    },
    authSdk: {
      inspect: vi.fn().mockResolvedValue({ state: 'satisfied' }),
      upgrade: vi.fn().mockResolvedValue({ status: 'upgraded' }),
    },
    packageInventory: {
      resolveDeployPackageVersions: vi.fn().mockResolvedValue({}),
    },
    telemetry: noopTelemetryHandle,
    projectTelemetry: noopDeploymentTelemetryCollector,
    progress: { report: vi.fn() },
    ...overrides,
  };
}

describe('runUpWorkflow', () => {
  it('runs the full pipeline and returns a structured result', async () => {
    const deps = fakeDeps();

    const result = await runUpWorkflow(baseRequest(), deps);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data).toMatchObject({
      itemId: 'i1',
      itemName: 'my-app',
      apiUrl: 'https://baas/i1',
      workspaceId: 'w1',
      workspaceName: 'My Workspace',
      workspaceKey: 'my-workspace',
      publishableKey: 'pk_123',
      hostingUrl: 'https://app.example',
      configUpdated: true,
      excludedServices: [],
    });
    expect(result.data.portalUrl).toContain('https://portal');

    expect(deps.workload.applyRuntimeSettings).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ label: 'runtime-settings' })
    );
    expect(deps.data.applyDatabaseConfig).toHaveBeenCalledOnce();
    expect(deps.staticHosting.deploy).toHaveBeenCalledOnce();
    expect(deps.staticHosting.persistHostingUrl).toHaveBeenCalledOnce();
    expect(deps.functions.deploy).toHaveBeenCalledOnce();
    expect(deps.progress.report).toHaveBeenNthCalledWith(1, {
      phase: 'dependencies',
      message: 'Inspecting project dependencies',
    });
    expect(deps.diagnostics.debug).toHaveBeenCalledWith({
      area: 'up.data',
      message: 'Applying database configuration',
    });
  });

  it('infers and persists the MSIT portal from the resolved backend', async () => {
    const deps = fakeDeps();
    vi.mocked(deps.workload.resolveTarget).mockResolvedValue({
      ...target,
      baasEndpoint:
        'https://cluster-msit.pbidedicated.windows.net/webapi/capacities/c1',
    });

    const result = await runUpWorkflow(
      baseRequest({ portalBaseUrl: undefined, tenantId: 'tenant-1' }),
      deps
    );

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(deps.registry.persistDeployment).toHaveBeenCalledWith(
      '/p',
      'My Workspace',
      expect.objectContaining({ portalUrl: 'https://msit.powerbi.com' })
    );
    expect(result.data.portalUrl).toBe(
      'https://msit.powerbi.com/groups/w1/appbackends/i1'
    );
  });

  it('strips all trailing slashes from the configured portal URL', async () => {
    const deps = fakeDeps();

    const result = await runUpWorkflow(
      baseRequest({ portalBaseUrl: 'https://portal.example///' }),
      deps
    );

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(deps.registry.persistDeployment).toHaveBeenCalledWith(
      '/p',
      'My Workspace',
      expect.objectContaining({ portalUrl: 'https://portal.example' })
    );
    expect(result.data.portalUrl).toBe(
      'https://portal.example/groups/w1/appbackends/i1'
    );
  });

  it('infers the MSIT portal from a retained hosting URL', async () => {
    const deps = fakeDeps();

    const result = await runUpWorkflow(
      baseRequest({
        portalBaseUrl: undefined,
        retainedHostingUrl: 'https://webapp.msit.fabricapps.net/app-id',
      }),
      deps
    );

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(deps.registry.persistDeployment).toHaveBeenCalledWith(
      '/p',
      'My Workspace',
      expect.objectContaining({ portalUrl: 'https://msit.powerbi.com' })
    );
    expect(result.data.portalUrl).toBe(
      'https://msit.powerbi.com/groups/w1/appbackends/i1'
    );
  });

  it('skips both access-control steps when the feature gate is off', async () => {
    const deps = fakeDeps();

    const result = await runUpWorkflow(
      baseRequest({ staticHostingAccessControlEnabled: false }),
      deps
    );

    expect(result.status).toBe('ok');
    expect(deps.staticHosting.persistAssetAccess).not.toHaveBeenCalled();
    expect(deps.authSdk.inspect).not.toHaveBeenCalled();
  });

  it('runs both access-control steps when the feature gate is on', async () => {
    const deps = fakeDeps();

    const result = await runUpWorkflow(
      baseRequest({
        staticHostingAccessControlEnabled: true,
        staticHostingPosture: 'protected',
      }),
      deps
    );

    expect(result.status).toBe('ok');
    expect(deps.authSdk.inspect).toHaveBeenCalledOnce();
  });

  it('reports capacity assignment only for a workspace it did not create', async () => {
    const cases = [
      // An existing trial was attached to the Builder's workspace: nothing was
      // started, so `trialStarted` cannot carry this.
      { req: { capacitySource: 'existing-trial' as const }, assigned: true },
      { req: { capacitySource: 'new-trial' as const }, assigned: true },
      // Capacity the workspace already had. Nothing was assigned.
      { req: { capacitySource: 'workspace' as const }, assigned: false },
      // Readiness did not run.
      { req: {}, assigned: false },
      // A workspace this run created is announced as created instead.
      {
        req: { capacitySource: 'new-trial' as const, workspaceCreated: true },
        assigned: false,
      },
    ];

    for (const { req, assigned } of cases) {
      const result = await runUpWorkflow(baseRequest(req), fakeDeps());
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.data.capacityAssigned).toBe(assigned);
    }
  });

  it('preserves readiness resource identities when deployment later fails', async () => {
    const readinessNotices = [
      {
        kind: 'workspace-created' as const,
        workspaceId: 'w1',
        workspaceName: 'My Workspace',
      },
      {
        kind: 'capacity-assigned' as const,
        workspaceId: 'w1',
        workspaceName: 'My Workspace',
        capacityId: 'c1',
        capacityName: 'Trial Capacity',
      },
    ];
    const deps = fakeDeps({
      workload: {
        resolveTarget: vi
          .fn()
          .mockRejectedValue(new Error('deployment failed')),
        getPublishableKey: vi.fn(),
        applyRuntimeSettings: vi.fn(),
      },
    });

    const result = await runUpWorkflow(baseRequest({ readinessNotices }), deps);

    expect(result).toMatchObject({
      status: 'failed',
      notices: readinessNotices,
    });
  });

  it('preserves readiness resource identities when request validation fails', async () => {
    const readinessNotices = [
      {
        kind: 'workspace-created' as const,
        workspaceId: 'w1',
        workspaceName: 'My Workspace',
      },
    ];

    const result = await runUpWorkflow(
      baseRequest({ workspaceId: undefined, readinessNotices }),
      fakeDeps()
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'invalid-request' },
      notices: readinessNotices,
    });
  });

  it('preserves readiness resource identities when deployment is cancelled', async () => {
    const readinessNotices = [
      {
        kind: 'trial-started' as const,
        capacityId: 'c1',
        capacityName: 'Trial Capacity',
      },
    ];
    const signal: CancellationToken = {
      isCancellationRequested: true,
      onCancellationRequested: () => ({ dispose() {} }),
    };

    const result = await runUpWorkflow(
      baseRequest({ readinessNotices }),
      fakeDeps({ signal })
    );

    expect(result).toEqual({
      status: 'cancelled',
      notices: readinessNotices,
    });
  });

  it('returns readiness resource identities on success', async () => {
    const readinessNotices = [
      {
        kind: 'workspace-created' as const,
        workspaceId: 'w1',
        workspaceName: 'My Workspace',
      },
    ];

    const result = await runUpWorkflow(
      baseRequest({ readinessNotices }),
      fakeDeps()
    );

    expect(result).toMatchObject({
      status: 'ok',
      data: { readinessNotices },
    });
  });

  it('fails with invalid-connectors without applying settings', async () => {
    const deps = fakeDeps();
    const req = baseRequest({
      config: config({}, [{ name: 'bad', type: 'fabric-sqldatabase' }]),
    });

    const result = await runUpWorkflow(req, deps);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('invalid-connectors');
    }
    expect(deps.workload.applyRuntimeSettings).not.toHaveBeenCalled();
  });

  it('fails with invalid-functions-config without applying settings', async () => {
    const deps = fakeDeps();
    const req = baseRequest({
      config: config({
        functions: {
          enabled: true,
          auth: { type: 'appAuth' },
        } as unknown as RayfinConfig['services']['functions'],
      }),
    });

    const result = await runUpWorkflow(req, deps);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('invalid-functions-config');
      expect(result.error.message).toContain(
        'services.functions.auth.type: found "appAuth"'
      );
    }
    expect(deps.workload.applyRuntimeSettings).not.toHaveBeenCalled();
    expect(deps.fabric.getWorkspace).not.toHaveBeenCalled();
    expect(deps.fabric.createItem).not.toHaveBeenCalled();
    expect(deps.devRedirect.appendLocalDevRedirectUris).not.toHaveBeenCalled();
  });

  it.each([
    { enabled: true, auth: '' },
    { enabled: true, auth: 'auth: {}' },
    { enabled: true, auth: 'auth: { type: delegated }' },
    { enabled: false, auth: 'auth: { type: delegated }' },
    { enabled: false, auth: 'auth: null' },
    { enabled: false, auth: 'auth: []' },
    { enabled: true, auth: 'auth: { type: Application }' },
  ])(
    'rejects invalid Functions before any side effects, even when excluded: %j',
    async ({ enabled, auth }) => {
      const deps = fakeDeps();
      const req = baseRequest({
        config: parseRayfinYaml(
          `id: my-app\nservices:\n  functions:\n    enabled: ${enabled}\n    ${auth}\n`
        ),
        excludeFunctions: true,
        functionsEnabled: false,
        staticHostingAccessControlEnabled: true,
      });
      const before = structuredClone(req.config);

      const result = await runUpWorkflow(req, deps);

      expect(result).toMatchObject({
        status: 'failed',
        error: {
          code: 'invalid-functions-config',
          message: expect.stringContaining(
            'Set services.functions.auth.type to "application".'
          ),
        },
      });
      expect(req.config).toEqual(before);
      expect(deps.progress.report).not.toHaveBeenCalled();
      expect(deps.fabric.getWorkspace).not.toHaveBeenCalled();
      expect(deps.fabric.createItem).not.toHaveBeenCalled();
      expect(deps.authSdk.inspect).not.toHaveBeenCalled();
      expect(deps.authSdk.upgrade).not.toHaveBeenCalled();
      expect(deps.staticHosting.persistAssetAccess).not.toHaveBeenCalled();
      expect(deps.staticHosting.runBuild).not.toHaveBeenCalled();
      expect(deps.workload.resolveTarget).not.toHaveBeenCalled();
      expect(deps.workload.applyRuntimeSettings).not.toHaveBeenCalled();
      expect(
        deps.devRedirect.appendLocalDevRedirectUris
      ).not.toHaveBeenCalled();
      expect(deps.registry.persistDeployment).not.toHaveBeenCalled();
      expect(deps.functions.deploy).not.toHaveBeenCalled();
    }
  );

  it.each(['"true"', '"false"', 'yes', 'on', '1'])(
    'rejects missing auth for truthy non-boolean enabled: %s before deployment',
    async (enabled) => {
      const deps = fakeDeps();
      const req = baseRequest({
        config: parseRayfinYaml(
          `id: my-app\nservices:\n  functions:\n    enabled: ${enabled}\n`
        ),
      });

      expect(req.config.services.functions?.enabled).toBeTruthy();
      const result = await runUpWorkflow(req, deps);

      expect(result).toMatchObject({
        status: 'failed',
        error: {
          code: 'invalid-functions-config',
          message: expect.stringContaining(
            'Set services.functions.auth.type to "application".'
          ),
        },
      });
      expect(deps.fabric.getWorkspace).not.toHaveBeenCalled();
      expect(deps.fabric.createItem).not.toHaveBeenCalled();
      expect(deps.workload.applyRuntimeSettings).not.toHaveBeenCalled();
      expect(deps.functions.deploy).not.toHaveBeenCalled();
    }
  );

  it('preserves application auth through initial settings, serialization, and redirect updates', async () => {
    const deps = fakeDeps();
    const req = baseRequest();
    const functions = req.config.services.functions;
    vi.mocked(deps.staticHosting.persistHostingUrl).mockImplementation(
      async ({ services, postSettings }) => {
        await postSettings?.({
          ...services,
          auth: {
            ...services.auth,
            allowedRedirectUris: ['https://app.example'],
          },
        });
        return { configUpdated: true, warnings: [] };
      }
    );

    const result = await runUpWorkflow(req, deps);

    expect(result.status).toBe('ok');
    const calls = vi.mocked(deps.workload.applyRuntimeSettings).mock.calls;
    expect(calls.map(([, request]) => request.label)).toEqual([
      'runtime-settings',
      'runtime-settings-patch',
    ]);
    for (const [, request] of calls) {
      expect(request.services.functions).toEqual(functions);
      expect(toRuntimeSettingsServices(request.services).functions).toEqual(
        functions
      );
    }
    expect(req.config.services.functions).toBe(functions);
  });

  it('preserves prior warnings when connector validation fails', async () => {
    const deps = fakeDeps({
      devRedirect: {
        resolveFrontendDevPort: vi
          .fn()
          .mockRejectedValue(new Error('port allocation failed')),
        appendLocalDevRedirectUris: vi.fn(),
      },
    });
    const req = baseRequest({
      config: config({}, [{ name: 'bad', type: 'fabric-sqldatabase' }]),
    });

    const result = await runUpWorkflow(req, deps);

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error.code).toBe('invalid-connectors');
    expect(result.warnings).toContain('port allocation failed');
  });

  it('cancels when the user declines to reuse an existing item', async () => {
    const deps = fakeDeps({
      fabric: {
        findTrialCapacity: vi.fn(),
        listCapacities: vi.fn(),
        getCapacity: vi.fn().mockResolvedValue({
          id: 'c1',
          displayName: 'c1',
          sku: 'F2',
          state: 'Active',
        }),
        checkTrialEligibility: vi.fn(),
        startTrial: vi.fn(),
        getOperationStatus: vi.fn(),
        getOperationResult: vi.fn(),
        listWorkspaces: vi.fn(),
        isWorkspaceAdmin: vi.fn().mockResolvedValue(true),
        getWorkspace: vi
          .fn()
          .mockResolvedValue({ id: 'w1', displayName: 'My Workspace' }),
        createWorkspace: vi.fn(),
        assignWorkspaceToCapacity: vi.fn(),
        getItemByName: vi
          .fn()
          .mockResolvedValue({ id: 'existing', displayName: 'my-app' }),
        createItem: vi.fn(),
      },
      ui: {
        prompt: vi.fn(),
        confirm: vi.fn().mockResolvedValue(false),
        select: vi.fn(),
      },
    });

    const result = await runUpWorkflow(baseRequest(), deps);

    expect(result.status).toBe('cancelled');
    expect(deps.workload.resolveTarget).not.toHaveBeenCalled();
  });

  it('preserves up-specific recovery when non-interactive reuse needs consent', async () => {
    const deps = fakeDeps({
      fabric: {
        findTrialCapacity: vi.fn(),
        listCapacities: vi.fn(),
        getCapacity: vi.fn().mockResolvedValue({
          id: 'c1',
          displayName: 'c1',
          sku: 'F2',
          state: 'Active',
        }),
        checkTrialEligibility: vi.fn(),
        startTrial: vi.fn(),
        getOperationStatus: vi.fn(),
        getOperationResult: vi.fn(),
        listWorkspaces: vi.fn(),
        isWorkspaceAdmin: vi.fn().mockResolvedValue(true),
        getWorkspace: vi
          .fn()
          .mockResolvedValue({ id: 'w1', displayName: 'My Workspace' }),
        createWorkspace: vi.fn(),
        assignWorkspaceToCapacity: vi.fn(),
        getItemByName: vi
          .fn()
          .mockResolvedValue({ id: 'existing', displayName: 'my-app' }),
        createItem: vi.fn(),
      },
      ui: undefined,
    });

    const result = await runUpWorkflow(baseRequest(), deps);

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error.message).toContain(
      'Run `rayfin up` in an interactive terminal to confirm reuse'
    );
    expect(deps.workload.resolveTarget).not.toHaveBeenCalled();
  });

  it('returns cancelled when the token is already cancelled', async () => {
    const signal: CancellationToken = {
      isCancellationRequested: true,
      onCancellationRequested: () => ({ dispose() {} }),
    };
    const collectDeploymentTelemetry = vi.fn();
    const deps = fakeDeps({
      signal,
      projectTelemetry: { collectDeploymentTelemetry },
    });

    const result = await runUpWorkflow(baseRequest(), deps);

    expect(result.status).toBe('cancelled');
    expect(collectDeploymentTelemetry).not.toHaveBeenCalled();
    expect(deps.fabric.getWorkspace).not.toHaveBeenCalled();
  });

  it('reuses a known redeployment item without create/reuse prompts', async () => {
    const deps = fakeDeps();

    const result = await runUpWorkflow(
      baseRequest({ knownItemId: 'recorded-item' }),
      deps
    );

    expect(result.status).toBe('ok');
    expect(deps.fabric.getItemByName).not.toHaveBeenCalled();
    expect(deps.fabric.createItem).not.toHaveBeenCalled();
    expect(deps.workload.resolveTarget).toHaveBeenCalledWith(
      'w1',
      'recorded-item'
    );
  });

  it('uses the requested Fabric item name without changing project identity', async () => {
    const deps = fakeDeps();

    const result = await runUpWorkflow(
      baseRequest({ itemName: 'unique-app' }),
      deps
    );

    expect(result.status).toBe('ok');
    expect(deps.fabric.getItemByName).toHaveBeenCalledWith('w1', 'unique-app');
    expect(deps.fabric.createItem).toHaveBeenCalledWith('w1', 'unique-app');
    expect(deps.registry.persistDeployment).toHaveBeenCalledWith(
      '/p',
      'My Workspace',
      expect.objectContaining({
        itemId: 'i1',
        itemName: 'unique-app',
      })
    );
  });

  it('skips the static deploy and retains the hosting URL when excluded', async () => {
    const deps = fakeDeps();

    const result = await runUpWorkflow(
      baseRequest({
        excludeStaticHosting: true,
        retainedHostingUrl: 'https://old',
      }),
      deps
    );

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.hostingUrl).toBe('https://old');
    expect(result.data.excludedServices).toEqual(['staticHosting']);
    expect(deps.staticHosting.deploy).not.toHaveBeenCalled();
    expect(deps.staticHosting.persistHostingUrl).not.toHaveBeenCalled();
  });

  it('skips the data apply when data is disabled', async () => {
    const deps = fakeDeps();
    const req = baseRequest({
      config: config({
        data: { enabled: false } as RayfinConfig['services']['data'],
      }),
    });

    const result = await runUpWorkflow(req, deps);

    expect(result.status).toBe('ok');
    expect(deps.data.applyDatabaseConfig).not.toHaveBeenCalled();
  });

  it('applies storage configuration when storage is enabled', async () => {
    const deps = fakeDeps();
    const req = baseRequest({
      config: config({ storage: { enabled: true } }),
      force: true,
    });

    const result = await runUpWorkflow(req, deps);

    expect(result.status).toBe('ok');
    expect(deps.progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'storage' })
    );
    expect(deps.storage.applyStorageConfig).toHaveBeenCalledWith({
      target,
      projectRoot: '/p',
      force: true,
    });
  });

  it('skips storage configuration when storage is disabled', async () => {
    const deps = fakeDeps();

    const result = await runUpWorkflow(baseRequest(), deps);

    expect(result.status).toBe('ok');
    expect(deps.storage.applyStorageConfig).not.toHaveBeenCalled();
  });

  it('surfaces a non-fatal storage failure as a warning', async () => {
    const deps = fakeDeps({
      storage: {
        applyStorageConfig: vi
          .fn()
          .mockRejectedValue(
            new StorageApplyError('workload 503', 503, 'request-failed')
          ),
      },
    });
    const req = baseRequest({
      config: config({ storage: { enabled: true } }),
    });

    const result = await runUpWorkflow(req, deps);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.warnings).toContain(
      'Storage configuration was not applied: workload 503. ' +
        'Run `rayfin up storage apply` to retry.'
    );
  });

  it('fails when storage changes are blocked', async () => {
    const deps = fakeDeps({
      storage: {
        applyStorageConfig: vi
          .fn()
          .mockRejectedValue(
            new StorageApplyError(
              'folders contain objects',
              409,
              'removal-blocked'
            )
          ),
      },
    });
    const req = baseRequest({
      config: config({ storage: { enabled: true } }),
    });

    const result = await runUpWorkflow(req, deps);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.message).toContain('folders contain objects');
    }
  });

  it('returns a stable failure code when item creation exhausts capacity', async () => {
    const cause = new FabricError(
      'Create item failed: 429',
      429,
      'CapacityLimitExceeded'
    );
    const deps = fakeDeps({
      fabric: {
        ...fakeDeps().fabric,
        getWorkspace: vi
          .fn()
          .mockResolvedValue({ id: 'w1', displayName: 'My Workspace' }),
        getItemByName: vi.fn().mockResolvedValue(undefined),
        createItem: vi.fn().mockRejectedValue(cause),
      },
    });

    const result = await runUpWorkflow(baseRequest(), deps);

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error).toMatchObject({
      code: 'fabric-capacity-exhausted',
      cause,
    });
    expect(deps.workload.resolveTarget).not.toHaveBeenCalled();
  });

  it('fails and skips later deployment steps when data configuration fails', async () => {
    const error = Object.assign(new Error('TypeScript compilation failed'), {
      authorization: 'Bearer private-token',
    });
    const deps = fakeDeps({
      data: {
        applyDatabaseConfig: vi.fn().mockRejectedValue(error),
      },
    });

    const result = await runUpWorkflow(baseRequest(), deps);

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error.code).toBe('up-failed');
    expect(result.error.message).toContain('TypeScript compilation failed');
    expect(result.error.cause).toBe(error);
    expect(deps.diagnostics.debug).toHaveBeenCalledWith({
      area: 'up',
      message: 'Workflow failed',
      data: { code: 'up-failed' },
    });
    expect(
      JSON.stringify(vi.mocked(deps.diagnostics.debug).mock.calls)
    ).not.toContain('private-token');
    expect(deps.registry.persistDeployment).not.toHaveBeenCalled();
    expect(deps.staticHosting.deploy).not.toHaveBeenCalled();
    expect(deps.functions.deploy).not.toHaveBeenCalled();
  });

  it('returns up-failed and skips later steps when the static deploy throws', async () => {
    const deps = fakeDeps();
    deps.registry.persistDeployment = vi.fn().mockResolvedValue({
      workspaceKey: 'my-workspace',
      warnings: [],
      envBackup: {
        sourcePath: '/p/rayfin/.env',
        backupPath: '/p/rayfin/.env.bak',
      },
    });
    deps.staticHosting.deploy = vi
      .fn()
      .mockRejectedValue(new Error('deploy failed'));

    const result = await runUpWorkflow(baseRequest(), deps);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('up-failed');
      expect(result.notices).toEqual([
        {
          kind: 'env-backup',
          sourcePath: '/p/rayfin/.env',
          backupPath: '/p/rayfin/.env.bak',
        },
      ]);
    }
    expect(deps.functions.deploy).not.toHaveBeenCalled();
    expect(deps.staticHosting.persistHostingUrl).not.toHaveBeenCalled();
    // Cleanup still runs on a failed deploy so the emitted file is never left
    // on disk to shadow local-dev VITE_* values on the next `rayfin dev`.
    expect(deps.runtimeConfig.remove).toHaveBeenCalledWith(
      '/p/public/rayfin.config.json'
    );
  });

  it('emits rayfin.config.json before the static build and removes it after a successful deploy', async () => {
    const deps = fakeDeps();

    const result = await runUpWorkflow(baseRequest(), deps);

    expect(result.status).toBe('ok');
    expect(deps.runtimeConfig.write).toHaveBeenCalledWith(
      '/p',
      expect.objectContaining({ enabled: true }),
      {
        apiUrl: 'https://baas/i1',
        publishableKey: 'pk_123',
        workspaceId: 'w1',
        itemId: 'i1',
        portalUrl: 'https://portal',
      }
    );
    expect(deps.runtimeConfig.remove).toHaveBeenCalledWith(
      '/p/public/rayfin.config.json'
    );

    const writeOrder = vi.mocked(deps.runtimeConfig.write).mock
      .invocationCallOrder[0];
    const deployOrder = vi.mocked(deps.staticHosting.deploy).mock
      .invocationCallOrder[0];
    const removeOrder = vi.mocked(deps.runtimeConfig.remove).mock
      .invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(deployOrder);
    expect(deployOrder).toBeLessThan(removeOrder);
  });

  it('fails the deploy (does not warn-and-continue) when runtime config emission fails', async () => {
    const deps = fakeDeps({
      runtimeConfig: {
        write: vi
          .fn()
          .mockRejectedValue(new Error('EACCES: permission denied')),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    });

    const result = await runUpWorkflow(baseRequest(), deps);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('up-failed');
      expect(result.error.message).toContain('EACCES');
    }
    expect(deps.staticHosting.deploy).not.toHaveBeenCalled();
  });

  it('warns and reuses (without overwriting or removing) a pre-existing rayfin.config.json that does not match', async () => {
    const deps = fakeDeps({
      runtimeConfig: {
        write: vi.fn().mockResolvedValue({
          path: '/p/public/rayfin.config.json',
          preexisting: true,
          differences: [
            'apiUrl: existing="https://old" vs this deploy="https://new"',
          ],
        }),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    });

    const result = await runUpWorkflow(baseRequest(), deps);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.warnings?.some((w) => w.includes('rayfin.config.json'))).toBe(
      true
    );
    // The existing file is left in place — this run neither overwrote it
    // (that's the write mock's responsibility to report, verified by
    // `preexisting: true` above) nor deletes it afterward.
    expect(deps.runtimeConfig.remove).not.toHaveBeenCalled();
  });

  it('does not warn when a pre-existing rayfin.config.json already matches this deploy', async () => {
    const deps = fakeDeps({
      runtimeConfig: {
        write: vi.fn().mockResolvedValue({
          path: '/p/public/rayfin.config.json',
          preexisting: true,
          differences: [],
        }),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    });

    const result = await runUpWorkflow(baseRequest(), deps);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(
      result.warnings?.some((w) => w.includes('rayfin.config.json')) ?? false
    ).toBe(false);
    expect(deps.runtimeConfig.remove).not.toHaveBeenCalled();
  });

  it('does not emit or remove rayfin.config.json when the static deploy is excluded', async () => {
    const deps = fakeDeps();

    const result = await runUpWorkflow(
      baseRequest({
        excludeStaticHosting: true,
        retainedHostingUrl: 'https://old',
      }),
      deps
    );

    expect(result.status).toBe('ok');
    expect(deps.runtimeConfig.write).not.toHaveBeenCalled();
    expect(deps.runtimeConfig.remove).not.toHaveBeenCalled();
  });

  it('deploys functions when the Layer 1 flag is off but services.functions.enabled is true', async () => {
    const deps = fakeDeps();

    const result = await runUpWorkflow(
      baseRequest({ functionsEnabled: false }),
      deps
    );

    expect(result.status).toBe('ok');
    expect(deps.functions.deploy).toHaveBeenCalledOnce();
  });

  it('skips functions deploy when excludeFunctions is true', async () => {
    const deps = fakeDeps();

    const result = await runUpWorkflow(
      baseRequest({ excludeFunctions: true }),
      deps
    );

    expect(result.status).toBe('ok');
    expect(deps.functions.deploy).not.toHaveBeenCalled();
  });

  it('skips functions deploy when services.functions.enabled is false', async () => {
    const deps = fakeDeps();
    const req = baseRequest({
      config: config({
        functions: { enabled: false } as RayfinConfig['services']['functions'],
      }),
    });

    const result = await runUpWorkflow(req, deps);

    expect(result.status).toBe('ok');
    expect(deps.functions.deploy).not.toHaveBeenCalled();
  });

  it('applies connector configs when the Layer 1 connector gate is enabled', async () => {
    const deps = fakeDeps();
    const connectors: NonNullable<RayfinConfig['connectors']> = [
      {
        name: 'inventory',
        type: 'fabric-sqldatabase',
        config: { workspaceId: 'source-ws', itemId: 'source-item' },
        auth: { type: 'delegated' },
      },
    ];

    const result = await runUpWorkflow(
      baseRequest({ config: config({}, connectors), connectorsEnabled: true }),
      deps
    );

    expect(result.status).toBe('ok');
    expect(deps.connectors.applyConfigs).toHaveBeenCalledWith({
      projectRoot: '/p',
      connectors,
      itemEndpoint: target.itemEndpoint,
      itemId: target.itemId,
      authorizationHeader: target.authorizationHeader,
    });
  });

  it('surfaces connector generation outcomes in result.data.generate (AB#2279031)', async () => {
    const connectors: NonNullable<RayfinConfig['connectors']> = [
      {
        name: 'inventory',
        type: 'fabric-sqldatabase',
        config: { workspaceId: 'source-ws', itemId: 'source-item' },
        auth: { type: 'delegated' },
      },
    ];
    const deps = fakeDeps({
      connectors: {
        applyConfigs: vi.fn().mockResolvedValue({
          results: [
            {
              name: 'inventory',
              status: 'skipped',
              skipReason: CONNECTOR_CONFIG_SKIP_REASON.MissingGeneratedConfig,
              reason: 'Generated connector configuration was not found.',
            },
          ],
        }),
      },
    });

    const result = await runUpWorkflow(
      baseRequest({ config: config({}, connectors), connectorsEnabled: true }),
      deps
    );

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.generate).toContainEqual(
      expect.objectContaining({ name: 'inventory', status: 'skipped' })
    );
  });

  it('does not apply connector configs when the connector gate is disabled', async () => {
    const deps = fakeDeps();

    const result = await runUpWorkflow(baseRequest(), deps);

    expect(result.status).toBe('ok');
    expect(deps.connectors.applyConfigs).not.toHaveBeenCalled();
  });

  it('applies connectors before static and functions deploy, persisting hosting afterward', async () => {
    const deps = fakeDeps();

    const result = await runUpWorkflow(
      baseRequest({ connectorsEnabled: true }),
      deps
    );

    expect(result.status).toBe('ok');
    expect(deps.connectors.applyConfigs).toHaveBeenCalledOnce();
    expect(deps.staticHosting.deploy).toHaveBeenCalledOnce();
    expect(deps.functions.deploy).toHaveBeenCalledOnce();
    expect(deps.staticHosting.persistHostingUrl).toHaveBeenCalledOnce();

    const connectorsOrder = vi.mocked(deps.connectors.applyConfigs).mock
      .invocationCallOrder[0];
    const staticOrder = vi.mocked(deps.staticHosting.deploy).mock
      .invocationCallOrder[0];
    const functionsOrder = vi.mocked(deps.functions.deploy).mock
      .invocationCallOrder[0];
    const hostingPersistenceOrder = vi.mocked(
      deps.staticHosting.persistHostingUrl
    ).mock.invocationCallOrder[0];
    expect(connectorsOrder).toBeLessThan(staticOrder);
    expect(connectorsOrder).toBeLessThan(functionsOrder);
    expect(connectorsOrder).toBeLessThan(hostingPersistenceOrder);
  });

  it('keeps connector apply failures non-fatal', async () => {
    const deps = fakeDeps({
      connectors: {
        applyConfigs: vi.fn().mockRejectedValue(new Error('compile failed')),
      },
    });

    const result = await runUpWorkflow(
      baseRequest({ connectorsEnabled: true }),
      deps
    );

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Connector apply step failed: compile failed'),
      ])
    );
  });

  it('refreshes the configured frontend before building without a false warning', async () => {
    const deps = fakeDeps();
    const staticHosting = {
      enabled: true,
      path: 'packages/frontend',
      folder: 'dist',
      buildCommand: 'npm run build',
    };
    const result = await runUpWorkflow(
      baseRequest({ config: config({ staticHosting }) }),
      deps
    );

    expect(result.status).toBe('ok');
    expect(deps.frameworkEnv.detectFramework).toHaveBeenCalledWith(
      '/p',
      staticHosting
    );
    expect(deps.frameworkEnv.writeEnvFile).toHaveBeenCalledWith({
      projectRoot: '/p',
      framework: 'vite',
      staticHosting,
    });
    expect(
      vi.mocked(deps.frameworkEnv.writeEnvFile).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(deps.staticHosting.runBuild).mock.invocationCallOrder[0]
    );
    expect(result.warnings ?? []).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining('no frontend framework could be auto-detected'),
      ])
    );
  });

  it.each(['detection', 'write'] as const)(
    'warns when framework env %s fails',
    async (stage) => {
      const deps = fakeDeps({
        frameworkEnv: {
          detectFramework:
            stage === 'detection'
              ? vi.fn().mockRejectedValue(new Error('fs error'))
              : vi.fn().mockResolvedValue('vite'),
          writeEnvFile: vi.fn().mockRejectedValue(new Error('fs error')),
        },
      });

      const result = await runUpWorkflow(baseRequest(), deps);

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(
        result.warnings?.some((w) =>
          w.includes('Could not refresh framework .env.local')
        )
      ).toBe(true);
    }
  );

  it('warns about a missing framework only when static hosting is enabled', async () => {
    const deps = fakeDeps({
      frameworkEnv: {
        detectFramework: vi.fn().mockResolvedValue(undefined),
        writeEnvFile: vi.fn(),
      },
    });

    const result = await runUpWorkflow(baseRequest(), deps);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(
      result.warnings?.some((w) =>
        w.includes('no frontend framework could be auto-detected')
      )
    ).toBe(true);
    expect(deps.frameworkEnv.writeEnvFile).not.toHaveBeenCalled();
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('rayfin env --framework <vite|nextjs|plain>'),
      ])
    );
  });

  it('does not warn about a missing framework when static hosting is disabled', async () => {
    const deps = fakeDeps({
      frameworkEnv: {
        detectFramework: vi.fn().mockResolvedValue(undefined),
        writeEnvFile: vi.fn(),
      },
    });
    const req = baseRequest({
      config: config({
        staticHosting: {
          enabled: false,
        } as RayfinConfig['services']['staticHosting'],
      }),
    });

    const result = await runUpWorkflow(req, deps);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(
      (result.warnings ?? []).some((w) =>
        w.includes('no frontend framework could be auto-detected')
      )
    ).toBe(false);
  });

  it('forwards a dev-redirect warning to the result', async () => {
    const deps = fakeDeps({
      devRedirect: {
        resolveFrontendDevPort: vi
          .fn()
          .mockRejectedValue(new Error('port allocation failed')),
        appendLocalDevRedirectUris: vi.fn(),
      },
    });

    const result = await runUpWorkflow(baseRequest(), deps);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(
      result.warnings?.some((w) => w.includes('port allocation failed'))
    ).toBe(true);
  });

  it('forwards persist-deployment advisories to the result', async () => {
    const deps = fakeDeps();
    deps.registry.listDeployments = vi.fn().mockResolvedValue({
      deployments: [{ workspaceName: 'Other Workspace' }],
      warnings: [],
    });

    const result = await runUpWorkflow(baseRequest(), deps);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(
      result.warnings?.some((w) =>
        w.includes('Other workspace deployments registered')
      )
    ).toBe(true);
  });

  it('forwards hosting persistence advisories to the result', async () => {
    const deps = fakeDeps();
    deps.staticHosting.persistHostingUrl = vi.fn().mockResolvedValue({
      configUpdated: false,
      warnings: ['Could not record the static hosting URL'],
    });

    const result = await runUpWorkflow(baseRequest(), deps);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.configUpdated).toBe(false);
    expect(result.warnings).toContain(
      'Could not record the static hosting URL'
    );
  });

  it('honors cancellation requested mid-flight between steps', async () => {
    let reads = 0;
    // Cancel after the local preflights and before workspace resolution.
    const signal: CancellationToken = {
      get isCancellationRequested() {
        return ++reads > 1;
      },
      onCancellationRequested: () => ({ dispose() {} }),
    };
    const deps = fakeDeps({ signal });

    const result = await runUpWorkflow(baseRequest(), deps);

    expect(result.status).toBe('cancelled');
    expect(deps.fabric.getWorkspace).not.toHaveBeenCalled();
    expect(deps.workload.resolveTarget).not.toHaveBeenCalled();
    expect(deps.staticHosting.deploy).not.toHaveBeenCalled();
  });

  it('maps an exception raised after cancellation to a cancelled result', async () => {
    const state = { requested: false };
    const signal: CancellationToken = {
      get isCancellationRequested() {
        return state.requested;
      },
      onCancellationRequested: () => ({ dispose() {} }),
    };
    const deps = fakeDeps({ signal });
    deps.fabric.getWorkspace = vi.fn().mockImplementation(async () => {
      state.requested = true;
      throw new Error('aborted request');
    });

    const result = await runUpWorkflow(baseRequest(), deps);

    expect(result.status).toBe('cancelled');
  });
});
