import { resolve } from 'node:path';

import type { UserInteraction } from '@microsoft/rayfin-tools-common/_internal/adapters';
import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import {
  FabricError,
  type FabricClient,
  type RayfinWorkloadClient,
} from '@microsoft/rayfin-tools-common/_internal/external/fabric';
import type { DataService } from '@microsoft/rayfin-tools-common/_internal/services/data';
import type { DeploymentRegistryService } from '@microsoft/rayfin-tools-common/_internal/services/deployment-registry';
import type { DevRedirectService } from '@microsoft/rayfin-tools-common/_internal/services/dev-redirect';
import type { FrameworkEnvService } from '@microsoft/rayfin-tools-common/_internal/services/framework-env';
import { HttpError } from '@microsoft/rayfin-tools-common/_internal/utils/retry';
import { describe, expect, it, vi } from 'vitest';

import {
  createFabricDevProvider,
  type FabricDevReadiness,
  type FabricDevTarget,
} from '../fabric-dev-provider.js';

vi.mock('../../../utils/frontend-dev-port.js', () => ({
  FRONTEND_DEV_PORT_ENV_VAR: 'RAYFIN_PUBLIC_FRONTEND_PORT',
}));

const workloadTarget = {
  itemId: 'i1',
  itemEndpoint: 'https://api/i1',
  baasEndpoint: 'https://baas/i1',
  authorizationHeader: 'Bearer t',
};

const workspace = { id: 'w1', displayName: 'My Workspace' };
const fabricItem = {
  id: 'i1',
  displayName: 'my-app',
  type: 'AppBackend',
  workspaceId: 'w1',
};

const activeDeployment = {
  workspaceName: 'My Workspace',
  record: {
    itemId: 'i1',
    apiUrl: 'https://baas/i1',
    workspaceId: 'w1',
  },
};

function config(
  overrides: Partial<RayfinConfig['services']> = {}
): RayfinConfig {
  return {
    id: 'my-app',
    name: 'My App',
    version: '1',
    services: {
      auth: { enabled: true },
      data: { enabled: true },
      ...overrides,
    },
  } as unknown as RayfinConfig;
}

function fakeWorkload(
  overrides: Partial<RayfinWorkloadClient> = {}
): RayfinWorkloadClient {
  return {
    resolveTarget: vi.fn().mockResolvedValue(workloadTarget),
    getPublishableKey: vi.fn().mockResolvedValue('pk_123'),
    applyRuntimeSettings: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeFabric(overrides: Partial<FabricClient> = {}): FabricClient {
  return {
    findTrialCapacity: vi.fn().mockResolvedValue(undefined),
    listCapacities: vi.fn().mockResolvedValue([]),
    getCapacity: vi.fn(),
    checkTrialEligibility: vi.fn(),
    startTrial: vi.fn(),
    getOperationStatus: vi.fn(),
    getOperationResult: vi.fn(),
    listWorkspaces: vi.fn().mockResolvedValue([workspace]),
    isWorkspaceAdmin: vi.fn().mockResolvedValue(true),
    getWorkspace: vi.fn().mockResolvedValue(workspace),
    createWorkspace: vi.fn(),
    assignWorkspaceToCapacity: vi.fn(),
    getItemByName: vi.fn().mockResolvedValue(undefined),
    createItem: vi.fn().mockResolvedValue(fabricItem),
    ...overrides,
  };
}

/** An interactive host that approves whatever it is asked. */
function fakeUi(): UserInteraction {
  return {
    prompt: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    select: vi.fn(),
  } as unknown as UserInteraction;
}

function fakeRegistry(active: unknown): DeploymentRegistryService {
  return {
    persistDeployment: vi.fn().mockResolvedValue({
      workspaceKey: 'My Workspace',
      warnings: [],
    }),
    readDeployment: vi.fn().mockResolvedValue({ record: null, warnings: [] }),
    getActiveDeployment: vi.fn().mockResolvedValue(active),
    listDeployments: vi
      .fn()
      .mockResolvedValue({ deployments: [], warnings: [] }),
    setActiveDeployment: vi.fn().mockResolvedValue(true),
  } as unknown as DeploymentRegistryService;
}

function build(
  opts: {
    active?: unknown;
    fabric?: FabricClient;
    workload?: RayfinWorkloadClient;
    registry?: DeploymentRegistryService;
    data?: DataService;
    devRedirect?: DevRedirectService;
    frameworkEnv?: FrameworkEnvService;
    config?: RayfinConfig;
    persistPublicEnv?: ReturnType<typeof vi.fn>;
    emitFrameworkEnv?: boolean;
    autoConfirmReuse?: boolean;
    requestedCapacityId?: string;
    ui?: UserInteraction;
    targetWorkspaceId?: string;
    targetWorkspaceName?: string;
    notify?: ReturnType<typeof vi.fn>;
    readiness?: FabricDevReadiness;
    isCancelled?: () => boolean;
  } = {}
) {
  const persistPublicEnv =
    opts.persistPublicEnv ?? vi.fn().mockResolvedValue(undefined);
  const devRedirect =
    opts.devRedirect ??
    ({
      resolveFrontendDevPort: vi
        .fn()
        .mockResolvedValue({ port: 5173, redirectPorts: [5173] }),
      appendLocalDevRedirectUris: vi
        .fn()
        .mockImplementation((services) => services),
    } as DevRedirectService);
  const fabric = opts.fabric ?? fakeFabric();
  const registry =
    opts.registry ??
    fakeRegistry('active' in opts ? opts.active : activeDeployment);
  const provider = createFabricDevProvider({
    fabric,
    workload: opts.workload ?? fakeWorkload(),
    data: opts.data ?? {
      applyDatabaseConfig: vi.fn().mockResolvedValue(undefined),
    },
    registry,
    devRedirect,
    frameworkEnv:
      opts.frameworkEnv ??
      ({
        detectFramework: vi.fn().mockResolvedValue('vite'),
        writeEnvFile: vi.fn().mockResolvedValue('/p/.env.local'),
      } as unknown as FrameworkEnvService),
    config: opts.config ?? config(),
    projectRoot: '/p',
    targetWorkspaceId: opts.targetWorkspaceId,
    // Explicit targeting: there is no silent default, so the fixture names one
    // and the "no workspace" cases pass `targetWorkspaceName: undefined`.
    targetWorkspaceName:
      'targetWorkspaceName' in opts ? opts.targetWorkspaceName : 'My Workspace',
    tenantId: 'tenant-1',
    portalUrl: 'https://app.fabric.microsoft.com',
    autoConfirmReuse: opts.autoConfirmReuse,
    requestedCapacityId: opts.requestedCapacityId,
    // `dev` is interactive by default; non-interactive cases pass `ui: undefined`.
    ui: 'ui' in opts ? opts.ui : fakeUi(),
    notify: opts.notify,
    readiness: opts.readiness,
    isCancelled: opts.isCancelled,
    persistPublicEnv,
    emitFrameworkEnv: opts.emitFrameworkEnv,
  });
  return { provider, persistPublicEnv, devRedirect, fabric, registry };
}

describe('createFabricDevProvider', () => {
  it('resolves the workload target from the active deployment', async () => {
    const { provider, fabric, registry } = build();

    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    expect(target).toMatchObject({
      provider: 'fabric',
      displayName: 'My Workspace',
      apiUrl: 'https://baas/i1',
      workload: workloadTarget,
    });
    const ready = await provider.ensureReady(target);
    expect(ready).toEqual({ status: 'ready', target });
    expect(fabric.getItemByName).not.toHaveBeenCalled();
    expect(fabric.createItem).not.toHaveBeenCalled();
    expect(registry.persistDeployment).not.toHaveBeenCalled();
  });

  it('reuses an active Fabric backend without requiring capacity readiness', async () => {
    const readiness: FabricDevReadiness = {
      prepare: vi.fn(),
    };
    const { provider } = build({ readiness });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(readiness.prepare).not.toHaveBeenCalled();
    expect(ready).toMatchObject({
      status: 'ready',
      target: { workspaceId: 'w1', workload: workloadTarget },
    });
  });

  it('warns that capacity ID is ignored for an existing deployment', async () => {
    const readiness: FabricDevReadiness = {
      prepare: vi.fn(),
    };
    const { provider } = build({
      readiness,
      requestedCapacityId: 'capacity-1',
    });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(readiness.prepare).not.toHaveBeenCalled();
    expect(ready).toMatchObject({
      status: 'ready',
      warnings: [
        'Ignoring --capacity-id because an existing deployment keeps its current workspace capacity.',
      ],
    });
  });

  it('hydrates a pre-seeded item endpoint when the recorded API URL is empty', async () => {
    const { provider } = build({
      active: {
        workspaceName: 'Portal Workspace',
        record: {
          itemId: 'i1',
          apiUrl: '',
          workspaceId: 'w1',
          publishableKey: 'pk_seeded',
        },
      },
    });

    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    expect(target).toMatchObject({
      displayName: 'Portal Workspace',
      apiUrl: 'https://baas/i1',
      publishableKey: 'pk_seeded',
      workload: workloadTarget,
    });
  });

  it('provisions an item into a workspace-only pre-seed', async () => {
    const portalWorkspace = {
      id: 'portal-workspace',
      displayName: 'Portal Workspace',
    };
    const fabric = fakeFabric({
      getWorkspace: vi.fn().mockResolvedValue(portalWorkspace),
    });
    const { provider } = build({
      fabric,
      active: {
        workspaceName: portalWorkspace.displayName,
        record: {
          itemId: '',
          apiUrl: '',
          workspaceId: portalWorkspace.id,
        },
      },
    });

    const unresolved = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });
    const ready = await provider.ensureReady(unresolved);

    expect(unresolved).toMatchObject({
      displayName: 'Portal Workspace',
      workspaceId: 'portal-workspace',
    });
    expect(unresolved.workload).toBeUndefined();
    expect(ready.status).toBe('ready');
    expect(fabric.getWorkspace).toHaveBeenCalledWith('portal-workspace');
    expect(fabric.createItem).toHaveBeenCalledWith(
      'portal-workspace',
      'my-app'
    );
  });

  it('replaces the recovered pre-seed entry instead of adding a second one', async () => {
    const portalWorkspace = {
      id: 'portal-workspace',
      displayName: 'Portal Workspace',
    };
    const fabric = fakeFabric({
      getWorkspace: vi.fn().mockResolvedValue(portalWorkspace),
    });
    const registry = fakeRegistry({
      // The portal pre-seed writer keys its record `'default'`, not by
      // workspace display name.
      workspaceName: 'default',
      record: { itemId: '', apiUrl: '', workspaceId: portalWorkspace.id },
    });
    const { provider } = build({ fabric, registry });

    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });
    await provider.ensureReady(target);

    expect(registry.persistDeployment).toHaveBeenCalledWith(
      '/p',
      'default',
      expect.objectContaining({
        itemId: 'i1',
        workspaceId: 'portal-workspace',
      })
    );
  });

  it('prefers an ambient workspace deployment over the active deployment', async () => {
    const registry = fakeRegistry(activeDeployment);
    vi.mocked(registry.listDeployments).mockResolvedValue({
      deployments: [
        {
          workspaceName: 'CI Workspace',
          active: false,
          record: {
            itemId: 'ci-item',
            apiUrl: 'https://baas/ci-item',
            workspaceId: 'ci-workspace',
          },
        },
      ],
      warnings: [],
    });
    const workload = fakeWorkload();
    const { provider } = build({
      registry,
      workload,
      targetWorkspaceId: 'ci-workspace',
    });

    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    expect(target).toMatchObject({
      displayName: 'CI Workspace',
      apiUrl: 'https://baas/ci-item',
      workspaceId: 'ci-workspace',
    });
    expect(registry.getActiveDeployment).not.toHaveBeenCalled();
    // Resolving a target is read-only; activation waits for readiness.
    expect(registry.setActiveDeployment).not.toHaveBeenCalled();
    expect(workload.resolveTarget).toHaveBeenCalledWith(
      'ci-workspace',
      'ci-item'
    );

    const ready = await provider.ensureReady(target);

    expect(ready.status).toBe('ready');
    expect(registry.setActiveDeployment).toHaveBeenCalledWith(
      '/p',
      'CI Workspace'
    );
  });

  it('leaves the active deployment untouched when readiness never succeeds', async () => {
    const registry = fakeRegistry(activeDeployment);
    vi.mocked(registry.listDeployments).mockResolvedValue({
      deployments: [
        {
          workspaceName: 'CI Workspace',
          active: false,
          record: { itemId: '', apiUrl: '', workspaceId: 'ci-workspace' },
        },
      ],
      warnings: [],
    });
    const { provider } = build({
      registry,
      targetWorkspaceId: 'ci-workspace',
      ui: undefined,
    });

    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });
    const ready = await provider.ensureReady(target);

    expect(ready).toMatchObject({
      status: 'unavailable',
      code: 'fabric-provisioning-consent-required',
    });
    expect(registry.setActiveDeployment).not.toHaveBeenCalled();
  });

  it('provisions an unregistered ambient workspace by id', async () => {
    const ambientWorkspace = {
      id: 'ci-workspace',
      displayName: 'CI Workspace',
    };
    const fabric = fakeFabric({
      getWorkspace: vi.fn().mockResolvedValue(ambientWorkspace),
    });
    const registry = fakeRegistry(activeDeployment);
    const { provider } = build({
      fabric,
      registry,
      targetWorkspaceId: ambientWorkspace.id,
    });

    const unresolved = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });
    const ready = await provider.ensureReady(unresolved);

    expect(unresolved).toMatchObject({ workspaceId: 'ci-workspace' });
    expect(ready.status).toBe('ready');
    expect(fabric.getWorkspace).toHaveBeenCalledWith('ci-workspace');
    expect(fabric.listWorkspaces).not.toHaveBeenCalled();
    expect(fabric.createItem).toHaveBeenCalledWith('ci-workspace', 'my-app');
  });

  it('provisions and persists a missing backend without deploy services', async () => {
    const workload = fakeWorkload();
    const registry = fakeRegistry(null);
    const notify = vi.fn();
    const { provider, fabric } = build({
      active: null,
      workload,
      registry,
      notify,
    });

    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });
    expect(target.workload).toBeUndefined();

    const ready = await provider.ensureReady(target);
    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') return;
    expect(ready.target).toMatchObject({
      provider: 'fabric',
      displayName: 'My Workspace',
      apiUrl: 'https://baas/i1',
      workspaceId: 'w1',
      workload: workloadTarget,
    });
    expect(fabric.listWorkspaces).toHaveBeenCalledOnce();
    expect(fabric.getItemByName).toHaveBeenCalledWith('w1', 'my-app');
    expect(fabric.createItem).toHaveBeenCalledWith('w1', 'my-app');
    expect(workload.resolveTarget).toHaveBeenCalledWith('w1', 'i1');
    expect(notify).toHaveBeenCalledWith(
      'Preparing Fabric backend "my-app" in "My Workspace"...'
    );
    expect(notify).toHaveBeenCalledWith(
      'Created Fabric backend "my-app" in "My Workspace".'
    );
    expect(registry.persistDeployment).toHaveBeenCalledWith(
      '/p',
      'My Workspace',
      {
        itemId: 'i1',
        apiUrl: 'https://baas/i1',
        workspaceId: 'w1',
        tenantId: 'tenant-1',
        publishableKey: 'pk_123',
        portalUrl: 'https://app.fabric.microsoft.com',
      }
    );
  });

  it('uses a readiness-created workspace without opening the workspace picker', async () => {
    const preparedWorkspace = {
      id: 'ready-workspace',
      displayName: 'Ready Workspace',
    };
    const readiness: FabricDevReadiness = {
      prepare: vi
        .fn()
        .mockResolvedValue({ status: 'ready', workspace: preparedWorkspace }),
    };
    const fabric = fakeFabric({
      createItem: vi.fn().mockResolvedValue({
        ...fabricItem,
        workspaceId: preparedWorkspace.id,
      }),
    });
    const { provider } = build({
      active: null,
      fabric,
      readiness,
      targetWorkspaceName: undefined,
      autoConfirmReuse: true,
      ui: undefined,
    });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(readiness.prepare).toHaveBeenCalledWith(undefined);
    expect(fabric.listWorkspaces).not.toHaveBeenCalled();
    expect(fabric.createItem).toHaveBeenCalledWith(
      preparedWorkspace.id,
      'my-app'
    );
    expect(ready).toMatchObject({
      status: 'ready',
      target: {
        displayName: preparedWorkspace.displayName,
        workspaceId: preparedWorkspace.id,
      },
    });
  });

  it('offers new workspace before existing workspace on an interactive first run', async () => {
    const preparedWorkspace = {
      id: 'ready-workspace',
      displayName: 'Ready Workspace',
    };
    const readiness: FabricDevReadiness = {
      prepare: vi
        .fn()
        .mockResolvedValue({ status: 'ready', workspace: preparedWorkspace }),
    };
    const select = vi.fn().mockResolvedValue('new');
    const ui = {
      confirm: vi.fn().mockResolvedValue(true),
      prompt: vi.fn(),
      select,
    } as unknown as UserInteraction;
    const { provider, fabric } = build({
      active: null,
      readiness,
      targetWorkspaceName: undefined,
      autoConfirmReuse: true,
      ui,
    });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(select).toHaveBeenCalledWith(
      'Choose a Fabric workspace for this deployment:',
      [
        { label: 'Use new workspace [Recommended]', value: 'new' },
        { label: 'Select existing workspace', value: 'existing' },
      ],
      { requireExplicitChoice: true }
    );
    expect(readiness.prepare).toHaveBeenCalledWith(undefined);
    expect(fabric.listWorkspaces).not.toHaveBeenCalled();
    expect(ready.status).toBe('ready');
  });

  it('skips readiness when an existing workspace is selected', async () => {
    const team = { id: 'w2', displayName: 'Team' };
    const readiness: FabricDevReadiness = {
      prepare: vi.fn(),
    };
    const fabric = fakeFabric({
      listWorkspaces: vi.fn().mockResolvedValue([workspace, team]),
      getWorkspace: vi.fn().mockResolvedValue(team),
    });
    const select = vi
      .fn()
      .mockResolvedValueOnce('existing')
      .mockResolvedValueOnce(team.id);
    const ui = {
      confirm: vi.fn().mockResolvedValue(true),
      prompt: vi.fn(),
      select,
    } as unknown as UserInteraction;
    const { provider } = build({
      active: null,
      fabric,
      readiness,
      targetWorkspaceName: undefined,
      autoConfirmReuse: true,
      ui,
    });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(select).toHaveBeenCalledTimes(2);
    expect(readiness.prepare).not.toHaveBeenCalled();
    expect(fabric.createItem).toHaveBeenCalledWith(team.id, 'my-app');
    expect(ready).toMatchObject({
      status: 'ready',
      target: { workspaceId: team.id, displayName: team.displayName },
    });
  });

  it('stops before item provisioning when Fabric readiness is unavailable', async () => {
    const readiness: FabricDevReadiness = {
      prepare: vi.fn().mockResolvedValue({
        status: 'unavailable',
        code: 'fabric-readiness:capacity_selection_required',
        message: 'Multiple premium capacities require a selection.',
      }),
    };
    const { provider, fabric } = build({
      active: null,
      readiness,
      targetWorkspaceName: undefined,
      autoConfirmReuse: true,
      ui: undefined,
    });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(ready).toEqual({
      status: 'unavailable',
      code: 'fabric-readiness:capacity_selection_required',
      message: 'Multiple premium capacities require a selection.',
    });
    expect(fabric.listWorkspaces).not.toHaveBeenCalled();
    expect(fabric.createItem).not.toHaveBeenCalled();
  });

  it('falls back to an interactive workspace after automatic readiness is unavailable', async () => {
    const team = { id: 'w2', displayName: 'Team' };
    const readiness: FabricDevReadiness = {
      prepare: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'unavailable',
          code: 'fabric-readiness:ineligible_for_trial',
          message: 'This account cannot start a Fabric trial.',
        })
        .mockResolvedValueOnce({ status: 'ready', workspace: team }),
    };
    const fabric = fakeFabric({
      listWorkspaces: vi.fn().mockResolvedValue([workspace, team]),
      getWorkspace: vi.fn().mockResolvedValue(team),
    });
    const select = vi
      .fn()
      .mockResolvedValueOnce('new')
      .mockResolvedValueOnce(team.id);
    const ui = {
      confirm: vi.fn().mockResolvedValue(true),
      prompt: vi.fn(),
      select,
    } as unknown as UserInteraction;
    const { provider } = build({
      active: null,
      fabric,
      readiness,
      targetWorkspaceName: undefined,
      ui,
    });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(readiness.prepare).toHaveBeenNthCalledWith(1, undefined);
    expect(readiness.prepare).toHaveBeenNthCalledWith(2, team.id);
    expect(select).toHaveBeenCalledTimes(2);
    expect(select).toHaveBeenNthCalledWith(
      2,
      `Which Fabric workspace should the "${config().id}" backend live in?`,
      [
        { label: workspace.displayName, value: workspace.id },
        { label: team.displayName, value: team.id },
      ]
    );
    expect(ready).toMatchObject({
      status: 'ready',
      target: { workspaceId: team.id, displayName: team.displayName },
    });
  });

  it('does not fall back when explicit-capacity readiness is unavailable', async () => {
    const readiness: FabricDevReadiness = {
      prepare: vi.fn().mockResolvedValue({
        status: 'unavailable',
        code: 'fabric-readiness:capacity_not_usable',
        message: 'The requested capacity is not accessible.',
      }),
    };
    const fabric = fakeFabric({
      listWorkspaces: vi.fn().mockResolvedValue([workspace]),
    });
    const select = vi.fn();
    const ui = {
      confirm: vi.fn().mockResolvedValue(true),
      prompt: vi.fn(),
      select,
    } as unknown as UserInteraction;
    const { provider } = build({
      active: null,
      fabric,
      readiness,
      requestedCapacityId: '11111111-1111-4111-8111-111111111111',
      targetWorkspaceName: undefined,
      ui,
    });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(ready).toEqual({
      status: 'unavailable',
      code: 'fabric-readiness:capacity_not_usable',
      message: 'The requested capacity is not accessible.',
    });
    expect(readiness.prepare).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
    expect(fabric.listWorkspaces).not.toHaveBeenCalled();
    expect(fabric.createItem).not.toHaveBeenCalled();
  });

  it('forces workspace selection after assignment is declined for a named target', async () => {
    const requested = { id: 'w-requested', displayName: 'Requested' };
    const selected = { id: 'w-selected', displayName: 'Selected' };
    const readiness: FabricDevReadiness = {
      prepare: vi.fn().mockResolvedValue({ status: 'declined' }),
    };
    const fabric = fakeFabric({
      listWorkspaces: vi.fn().mockResolvedValue([requested, selected]),
      getWorkspace: vi.fn().mockResolvedValue(selected),
      createItem: vi.fn().mockResolvedValue({
        ...fabricItem,
        workspaceId: selected.id,
      }),
    });
    const select = vi.fn().mockResolvedValue(selected.id);
    const ui = {
      confirm: vi.fn().mockResolvedValue(true),
      prompt: vi.fn(),
      select,
    } as unknown as UserInteraction;
    const { provider } = build({
      active: null,
      fabric,
      readiness,
      targetWorkspaceName: requested.displayName,
      ui,
    });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(readiness.prepare).toHaveBeenCalledWith(requested.id);
    expect(select).toHaveBeenCalledOnce();
    expect(fabric.createItem).toHaveBeenCalledWith(selected.id, 'my-app');
    expect(ready).toMatchObject({
      status: 'ready',
      target: {
        workspaceId: selected.id,
        displayName: selected.displayName,
      },
    });
  });

  it('requires backend consent before mutable automatic readiness', async () => {
    const readiness: FabricDevReadiness = {
      prepare: vi.fn().mockResolvedValue({
        status: 'unavailable',
        code: 'fabric-readiness:capacity_assignment_confirmation_required',
        message: 'Capacity assignment requires confirmation.',
      }),
    };
    const { provider, fabric } = build({
      active: null,
      readiness,
      targetWorkspaceName: undefined,
      ui: undefined,
      autoConfirmReuse: false,
    });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(ready).toMatchObject({
      status: 'unavailable',
      code: 'fabric-readiness:capacity_assignment_confirmation_required',
    });
    expect(readiness.prepare).toHaveBeenCalledWith(undefined);
    expect(fabric.createWorkspace).not.toHaveBeenCalled();
    expect(fabric.createItem).not.toHaveBeenCalled();
  });

  it('treats noninteractive --capacity-id as backend creation consent', async () => {
    const preparedWorkspace = {
      id: 'ready-workspace',
      displayName: 'Ready Workspace',
    };
    const fabric = fakeFabric({
      createItem: vi.fn().mockResolvedValue({
        ...fabricItem,
        workspaceId: preparedWorkspace.id,
      }),
    });
    const registry = fakeRegistry(null);
    const readiness: FabricDevReadiness = {
      prepare: vi
        .fn()
        .mockResolvedValue({ status: 'ready', workspace: preparedWorkspace }),
    };
    const { provider } = build({
      active: null,
      fabric,
      registry,
      readiness,
      targetWorkspaceName: undefined,
      ui: undefined,
      autoConfirmReuse: false,
      requestedCapacityId: 'capacity-1',
    });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(ready.status).toBe('ready');
    expect(readiness.prepare).toHaveBeenCalledOnce();
    expect(fabric.getItemByName).toHaveBeenCalledOnce();
    expect(fabric.createItem).toHaveBeenCalledOnce();
    expect(registry.persistDeployment).toHaveBeenCalledOnce();
  });

  it('does not treat --capacity-id as unregistered backend reuse consent', async () => {
    const preparedWorkspace = {
      id: 'ready-workspace',
      displayName: 'Ready Workspace',
    };
    const fabric = fakeFabric({
      getItemByName: vi.fn().mockResolvedValue({
        ...fabricItem,
        workspaceId: preparedWorkspace.id,
      }),
    });
    const readiness: FabricDevReadiness = {
      prepare: vi
        .fn()
        .mockResolvedValue({ status: 'ready', workspace: preparedWorkspace }),
    };
    const { provider } = build({
      active: null,
      fabric,
      readiness,
      targetWorkspaceName: undefined,
      ui: undefined,
      autoConfirmReuse: false,
      requestedCapacityId: 'capacity-1',
    });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(ready).toMatchObject({
      status: 'unavailable',
      code: 'fabric-item-reuse-required',
    });
    expect(readiness.prepare).toHaveBeenCalledOnce();
    expect(fabric.createItem).not.toHaveBeenCalled();
  });

  it('propagates readiness cancellation without provisioning an item', async () => {
    const readiness: FabricDevReadiness = {
      prepare: vi.fn().mockResolvedValue({ status: 'cancelled' }),
    };
    const { provider, fabric } = build({
      active: null,
      readiness,
      targetWorkspaceName: undefined,
    });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(ready).toEqual({ status: 'cancelled' });
    expect(fabric.createItem).not.toHaveBeenCalled();
  });

  it('maps an aborted workspace lookup to cancellation without readiness', async () => {
    const aborted = new Error('The operation was aborted');
    aborted.name = 'AbortError';
    const fabric = fakeFabric({
      getWorkspace: vi.fn().mockRejectedValue(aborted),
    });
    const { provider } = build({
      active: null,
      fabric,
      targetWorkspaceId: 'w1',
      isCancelled: () => true,
    });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(ready).toEqual({ status: 'cancelled' });
    expect(fabric.createItem).not.toHaveBeenCalled();
  });

  it('reuses the provisioning publishable key during local wiring', async () => {
    const workload = fakeWorkload();
    const { provider } = build({ active: null, workload });
    const unresolved = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });
    const ready = await provider.ensureReady(unresolved);
    if (ready.status !== 'ready') throw new Error('backend was not ready');

    const wiring = await provider.prepareForLocalFrontend(ready.target);

    expect(wiring.env.RAYFIN_PUBLIC_PUBLISHABLE_KEY).toBe('pk_123');
    expect(workload.getPublishableKey).toHaveBeenCalledOnce();
  });

  it('continues provisioning with a warning when the publishable key is temporarily unavailable', async () => {
    const getPublishableKey = vi
      .fn()
      .mockRejectedValueOnce(new Error('key unavailable'))
      .mockResolvedValueOnce('pk_retry');
    const workload = fakeWorkload({ getPublishableKey });
    const registry = fakeRegistry(null);
    const { provider } = build({ active: null, workload, registry });
    const unresolved = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(unresolved);

    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') return;
    expect(ready.warnings).toContain(
      'Could not read the Fabric publishable key while provisioning: key unavailable'
    );
    expect(registry.persistDeployment).toHaveBeenCalledWith(
      '/p',
      'My Workspace',
      expect.not.objectContaining({ publishableKey: expect.anything() })
    );

    const wiring = await provider.prepareForLocalFrontend(ready.target);
    expect(wiring.env.RAYFIN_PUBLIC_PUBLISHABLE_KEY).toBe('pk_retry');
    expect(getPublishableKey).toHaveBeenCalledTimes(2);
  });

  it('reports that the backend exists when endpoint resolution fails after creation', async () => {
    const workload = fakeWorkload({
      resolveTarget: vi.fn().mockRejectedValue(new Error('endpoint pending')),
    });
    const { provider } = build({ active: null, workload });
    const unresolved = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(unresolved);

    expect(ready).toMatchObject({
      status: 'unavailable',
      code: 'fabric-backend-setup-failed',
    });
    if (ready.status !== 'unavailable') return;
    expect(ready.message).toContain('exists in "My Workspace" (ID: i1)');
    expect(ready.message).toContain('endpoint pending');
  });

  it('reports that the backend exists when local deployment recording fails', async () => {
    const registry = fakeRegistry(null);
    vi.mocked(registry.persistDeployment).mockRejectedValue(
      new Error('registry is read-only')
    );
    const { provider } = build({ active: null, registry });
    const unresolved = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(unresolved);

    expect(ready).toMatchObject({
      status: 'unavailable',
      code: 'fabric-backend-record-failed',
    });
    if (ready.status !== 'unavailable') return;
    expect(ready.message).toContain('exists in "My Workspace" (ID: i1)');
    expect(ready.message).toContain('registry is read-only');
  });

  it('reuses a same-named Fabric item instead of creating another', async () => {
    const fabric = fakeFabric({
      getItemByName: vi.fn().mockResolvedValue(fabricItem),
    });
    const registry = fakeRegistry(null);
    const { provider } = build({
      active: null,
      fabric,
      registry,
      autoConfirmReuse: true,
    });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(ready.status).toBe('ready');
    expect(fabric.getItemByName).toHaveBeenCalledWith('w1', 'my-app');
    expect(fabric.createItem).not.toHaveBeenCalled();
    expect(registry.persistDeployment).toHaveBeenCalledOnce();
  });

  it('requires consent before reusing a same-named Fabric item', async () => {
    const fabric = fakeFabric({
      getItemByName: vi.fn().mockResolvedValue(fabricItem),
    });
    const confirm = vi.fn().mockResolvedValue(false);
    const ui = {
      confirm,
      prompt: vi.fn(),
      select: vi.fn(),
    } as unknown as UserInteraction;
    const { provider } = build({ active: null, fabric, ui });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(confirm).toHaveBeenCalledOnce();
    expect(ready).toEqual({ status: 'cancelled' });
    expect(fabric.createItem).not.toHaveBeenCalled();
  });

  it('does not reuse a same-named item non-interactively without --yes', async () => {
    const fabric = fakeFabric({
      getItemByName: vi.fn().mockResolvedValue(fabricItem),
    });
    const registry = fakeRegistry(null);
    const { provider } = build({
      active: null,
      fabric,
      registry,
      ui: undefined,
    });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(ready).toMatchObject({
      status: 'unavailable',
      code: 'fabric-item-reuse-required',
    });
    if (ready.status !== 'unavailable') return;
    expect(ready.message).toContain('is not registered for this project');
    expect(fabric.createItem).not.toHaveBeenCalled();
    expect(registry.persistDeployment).not.toHaveBeenCalled();
  });

  it('prompts for a workspace when none is recorded or specified', async () => {
    const team = { id: 'w2', displayName: 'Team' };
    const fabric = fakeFabric({
      listWorkspaces: vi.fn().mockResolvedValue([workspace, team]),
      isWorkspaceAdmin: vi.fn().mockResolvedValue(true),
      getWorkspace: vi.fn().mockResolvedValue(team),
    });
    const select = vi.fn().mockResolvedValue('w2');
    const ui = {
      confirm: vi.fn().mockResolvedValue(true),
      prompt: vi.fn(),
      select,
    } as unknown as UserInteraction;
    const { provider } = build({
      active: null,
      fabric,
      ui,
      targetWorkspaceName: undefined,
    });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(select).toHaveBeenCalledOnce();
    expect(ready.status).toBe('ready');
    expect(fabric.createItem).toHaveBeenCalledWith('w2', 'my-app');
  });

  it('never silently defaults the workspace when it cannot prompt', async () => {
    const fabric = fakeFabric();
    const registry = fakeRegistry(null);
    const { provider } = build({
      active: null,
      fabric,
      registry,
      ui: undefined,
      targetWorkspaceName: undefined,
    });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(ready).toMatchObject({
      status: 'unavailable',
      code: 'fabric-workspace-required',
    });
    expect(fabric.listWorkspaces).not.toHaveBeenCalled();
    expect(fabric.createItem).not.toHaveBeenCalled();
    expect(registry.persistDeployment).not.toHaveBeenCalled();
  });

  it('does not create a backend non-interactively without --yes', async () => {
    const fabric = fakeFabric({
      getItemByName: vi.fn().mockResolvedValue(undefined),
    });
    const registry = fakeRegistry(null);
    const { provider } = build({
      active: null,
      fabric,
      registry,
      ui: undefined,
    });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(ready).toMatchObject({
      status: 'unavailable',
      code: 'fabric-provisioning-consent-required',
    });
    if (ready.status !== 'unavailable') return;
    expect(ready.message).toContain('needs your confirmation');
    expect(fabric.createItem).not.toHaveBeenCalled();
    expect(registry.persistDeployment).not.toHaveBeenCalled();
  });

  it('creates a backend non-interactively when --yes pre-approves it', async () => {
    const fabric = fakeFabric({
      getItemByName: vi.fn().mockResolvedValue(undefined),
    });
    const { provider } = build({
      active: null,
      fabric,
      autoConfirmReuse: true,
    });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(ready.status).toBe('ready');
    expect(fabric.createItem).toHaveBeenCalledOnce();
  });
  it('treats Ctrl-C at the reuse prompt as a cancellation, not a failure', async () => {
    const fabric = fakeFabric({
      getItemByName: vi.fn().mockResolvedValue(fabricItem),
    });
    const exitPrompt = new Error('User force closed the prompt');
    exitPrompt.name = 'ExitPromptError';
    const ui = {
      confirm: vi.fn().mockRejectedValue(exitPrompt),
      prompt: vi.fn(),
      select: vi.fn(),
    } as unknown as UserInteraction;
    const registry = fakeRegistry(null);
    const { provider } = build({ active: null, fabric, registry, ui });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(ready).toEqual({ status: 'cancelled' });
    expect(fabric.createItem).not.toHaveBeenCalled();
    expect(registry.persistDeployment).not.toHaveBeenCalled();
  });

  it('returns an actionable structured failure when provisioning fails', async () => {
    const fabric = fakeFabric({
      listWorkspaces: vi.fn().mockRejectedValue(new Error('access denied')),
      isWorkspaceAdmin: vi.fn().mockResolvedValue(true),
    });
    const registry = fakeRegistry(null);
    const { provider } = build({ active: null, fabric, registry });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(ready).toMatchObject({
      status: 'unavailable',
      code: 'fabric-provisioning-failed',
    });
    if (ready.status !== 'unavailable') return;
    expect(ready.message).toContain('access denied');
    expect(ready.message).toContain('retry `rayfin dev`');
    expect(registry.persistDeployment).not.toHaveBeenCalled();
  });

  it('requires another workspace when the selected capacity is exhausted', async () => {
    const fabric = fakeFabric({
      createItem: vi
        .fn()
        .mockRejectedValue(
          new FabricError(
            'Create item failed: 429',
            429,
            'CapacityLimitExceeded'
          )
        ),
    });
    const { provider } = build({ active: null, fabric });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(ready).toMatchObject({
      status: 'unavailable',
      code: 'fabric-capacity-exhausted',
      message:
        'The Fabric capacity assigned to this workspace is exhausted and cannot create another Rayfin item.',
    });
  });

  it('fails with actionable guidance when the named workspace is absent', async () => {
    const fabric = fakeFabric({
      listWorkspaces: vi
        .fn()
        .mockResolvedValue([{ id: 'w9', displayName: 'Engineering' }]),
    });
    const registry = fakeRegistry(null);
    const { provider } = build({ active: null, fabric, registry });
    const target = await provider.resolveTarget({
      projectRoot: '/p',
      config: config(),
    });

    const ready = await provider.ensureReady(target);

    expect(ready).toMatchObject({
      status: 'unavailable',
      code: 'fabric-provisioning-failed',
    });
    if (ready.status !== 'unavailable') return;
    expect(ready.message).toContain('not found');
    expect(fabric.createItem).not.toHaveBeenCalled();
    expect(registry.persistDeployment).not.toHaveBeenCalled();
  });

  it('applies data config to the remote workload endpoint', async () => {
    const data = { applyDatabaseConfig: vi.fn().mockResolvedValue(undefined) };
    const { provider } = build({ data });
    const target: FabricDevTarget = {
      provider: 'fabric',
      displayName: 'ws',
      apiUrl: 'https://baas/i1',
      workload: workloadTarget,
    };

    await provider.applyDataConfig(target, {
      projectRoot: '/p',
      data: { enabled: true, dialect: 'mssql' },
    });

    expect(data.applyDatabaseConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'remote',
        remoteEndpoint: 'https://api/i1',
        authorizationHeader: 'Bearer t',
        itemId: 'i1',
      })
    );
    expect(data.applyDatabaseConfig.mock.calls[0]?.[0]).not.toHaveProperty(
      'retryTransientErrors'
    );
  });

  it('preserves a Fabric-dev MSSQL 500 without up-specific guidance', async () => {
    const applyError = new HttpError('internal error', 500);
    const data = {
      applyDatabaseConfig: vi.fn().mockRejectedValue(applyError),
    };
    const { provider } = build({ data });
    const target: FabricDevTarget = {
      provider: 'fabric',
      displayName: 'ws',
      apiUrl: 'https://baas/i1',
      workload: workloadTarget,
    };

    await expect(
      provider.applyDataConfig(target, {
        projectRoot: '/p',
        data: { enabled: true, dialect: 'mssql' },
      })
    ).rejects.toBe(applyError);
  });

  it('applyStorageConfig is a no-op on Fabric', async () => {
    const { provider } = build();
    await expect(
      provider.applyStorageConfig(
        { provider: 'fabric', displayName: 'ws', workload: workloadTarget },
        { projectRoot: '/p', storage: { enabled: true } }
      )
    ).resolves.toBeUndefined();
  });

  it('syncs connectors by posting runtime settings with services + connectors', async () => {
    const workload = fakeWorkload();
    const { provider } = build({ workload });
    const target: FabricDevTarget = {
      provider: 'fabric',
      displayName: 'ws',
      workload: workloadTarget,
    };

    await provider.syncConnectors(target, [
      { name: 'c1', type: 'fabric-sqldatabase' },
    ] as unknown as RayfinConfig['connectors']);

    expect(workload.applyRuntimeSettings).toHaveBeenCalledWith(
      workloadTarget,
      expect.objectContaining({ label: 'runtime-settings' })
    );
  });

  it('prepares local wiring: redirect URIs, publishable key, and persisted env', async () => {
    const workload = fakeWorkload();
    const { provider, persistPublicEnv, devRedirect } = build({ workload });
    const target: FabricDevTarget = {
      provider: 'fabric',
      displayName: 'ws',
      apiUrl: 'https://baas/i1',
      workload: workloadTarget,
    };

    const wiring = await provider.prepareForLocalFrontend(target);

    expect(workload.applyRuntimeSettings).toHaveBeenCalledWith(
      workloadTarget,
      expect.objectContaining({ label: 'runtime-settings-patch' })
    );
    expect(wiring.env.RAYFIN_PUBLIC_API_URL).toBe('https://baas/i1');
    expect(wiring.env.RAYFIN_PUBLIC_PUBLISHABLE_KEY).toBe('pk_123');
    expect(wiring.env.RAYFIN_PUBLIC_FRONTEND_PORT).toBe('5173');
    expect(devRedirect.resolveFrontendDevPort).toHaveBeenCalledOnce();
    expect(devRedirect.appendLocalDevRedirectUris).toHaveBeenCalledWith(
      expect.anything(),
      5173
    );
    expect(persistPublicEnv).toHaveBeenCalledOnce();
    expect(persistPublicEnv).toHaveBeenCalledWith(
      '/p/rayfin',
      expect.arrayContaining([
        { key: 'RAYFIN_PUBLIC_API_URL', value: 'https://baas/i1' },
        { key: 'RAYFIN_PUBLIC_PUBLISHABLE_KEY', value: 'pk_123' },
        { key: 'RAYFIN_PUBLIC_FUNCTIONS_URL', value: null },
      ])
    );
    expect(persistPublicEnv.mock.calls[0]?.[1]).not.toContainEqual({
      key: 'RAYFIN_PUBLIC_FRONTEND_PORT',
      value: '5173',
    });
  });

  it('registers primary and retained frontend redirect ports', async () => {
    const appendLocalDevRedirectUris = vi
      .fn()
      .mockImplementation((services) => services);
    const devRedirect = {
      resolveFrontendDevPort: vi
        .fn()
        .mockResolvedValue({ port: 5174, redirectPorts: [5174, 5173] }),
      appendLocalDevRedirectUris,
    } as DevRedirectService;
    const { provider } = build({ devRedirect });
    const target: FabricDevTarget = {
      provider: 'fabric',
      displayName: 'ws',
      apiUrl: 'https://baas/i1',
      workload: workloadTarget,
    };

    const wiring = await provider.prepareForLocalFrontend(target);

    expect(wiring.env.RAYFIN_PUBLIC_FRONTEND_PORT).toBe('5174');
    expect(appendLocalDevRedirectUris).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      5174
    );
    expect(appendLocalDevRedirectUris).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      5173
    );
  });

  it('resolves frontend wiring without redirect mutation when auth is disabled', async () => {
    const { provider, devRedirect } = build({
      config: config({ auth: { enabled: false } }),
    });
    const target: FabricDevTarget = {
      provider: 'fabric',
      displayName: 'ws',
      apiUrl: 'https://baas/i1',
      workload: workloadTarget,
    };

    const wiring = await provider.prepareForLocalFrontend(target);

    expect(wiring.env.RAYFIN_PUBLIC_FRONTEND_PORT).toBe('5173');
    expect(devRedirect.resolveFrontendDevPort).toHaveBeenCalledWith('/p');
    expect(devRedirect.appendLocalDevRedirectUris).not.toHaveBeenCalled();
  });

  it('persists the reserved local functions URL', async () => {
    const { provider, persistPublicEnv } = build();
    const target: FabricDevTarget = {
      provider: 'fabric',
      displayName: 'ws',
      apiUrl: 'https://baas/i1',
      workload: workloadTarget,
    };

    const wiring = await provider.prepareForLocalFrontend(target, {
      runtimeUrls: { functions: 'http://localhost:7073' },
    });

    expect(wiring.env.RAYFIN_PUBLIC_FUNCTIONS_URL).toBe(
      'http://localhost:7073'
    );
    expect(persistPublicEnv).toHaveBeenCalledWith(
      '/p/rayfin',
      expect.arrayContaining([
        {
          key: 'RAYFIN_PUBLIC_FUNCTIONS_URL',
          value: 'http://localhost:7073',
        },
      ])
    );
  });

  it('warns when the Fabric publishable key cannot be read', async () => {
    const workload = fakeWorkload({
      getPublishableKey: vi.fn().mockRejectedValue(new Error('request failed')),
    });
    const { provider } = build({ workload });
    const target: FabricDevTarget = {
      provider: 'fabric',
      displayName: 'ws',
      apiUrl: 'https://baas/i1',
      workload: workloadTarget,
    };

    const wiring = await provider.prepareForLocalFrontend(target);

    expect(wiring.env.RAYFIN_PUBLIC_PUBLISHABLE_KEY).toBeUndefined();
    expect(wiring.warnings).toContain(
      'Could not read the Fabric publishable key: request failed'
    );
  });

  it('teardown is a no-op on Fabric', async () => {
    const { provider } = build();
    await expect(
      provider.teardown(
        { provider: 'fabric', displayName: 'ws' },
        { purge: true }
      )
    ).resolves.toBeUndefined();
  });

  it('skips framework .env.local regeneration when emitFrameworkEnv is false', async () => {
    const frameworkEnv = {
      detectFramework: vi.fn().mockResolvedValue('vite'),
      writeEnvFile: vi.fn().mockResolvedValue('/p/.env.local'),
    } as unknown as FrameworkEnvService;
    const { provider } = build({ emitFrameworkEnv: false, frameworkEnv });
    const target: FabricDevTarget = {
      provider: 'fabric',
      displayName: 'ws',
      apiUrl: 'https://baas/i1',
      workload: workloadTarget,
    };

    await provider.prepareForLocalFrontend(target);

    expect(frameworkEnv.writeEnvFile).not.toHaveBeenCalled();
  });

  it('writes framework env into the configured frontend package', async () => {
    const frameworkEnv = {
      detectFramework: vi.fn(async (directory: string) =>
        directory === resolve('/p', 'apps/web') ? 'vite' : undefined
      ),
      writeEnvFile: vi.fn().mockResolvedValue('/p/apps/web/.env.local'),
    } as unknown as FrameworkEnvService;
    const { provider } = build({
      frameworkEnv,
      config: config({
        staticHosting: {
          enabled: true,
          path: 'apps/web',
          folder: 'dist',
        },
      }),
    });

    await provider.prepareForLocalFrontend({
      provider: 'fabric',
      displayName: 'ws',
      apiUrl: 'https://baas/i1',
      workload: workloadTarget,
    });

    expect(frameworkEnv.detectFramework).toHaveBeenCalledWith(
      resolve('/p', 'apps/web')
    );
    expect(frameworkEnv.writeEnvFile).toHaveBeenCalledWith({
      projectRoot: '/p',
      framework: 'vite',
      outputDir: 'apps/web',
    });
  });
});
