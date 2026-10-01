import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import { runFabricReadinessWorkflow } from '@microsoft/rayfin-tools-common/_internal/workflows/fabric-readiness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDevDeps } from '../commands/dev/dev-deps.js';
import {
  createCliFabricClient,
  createCliRayfinWorkloadClient,
} from '../external-services/fabric/index.js';
import { createFabricDevProvider } from '../local-services/dev/fabric-dev-provider.js';
import { createCliDataService } from '../rayfin-services/index.js';

vi.mock('../config/constants.js', () => ({
  getFabricSettings: vi.fn(() => ({
    fabricPortalUrl: 'https://app.fabric.microsoft.com/',
  })),
}));
vi.mock(
  '@microsoft/rayfin-tools-common/_internal/workflows/fabric-readiness',
  () => ({
    runFabricReadinessWorkflow: vi.fn(),
  })
);
vi.mock('../external-services/fabric/index.js', () => ({
  createCliFabricClient: vi.fn(() => ({})),
  createCliRayfinWorkloadClient: vi.fn(() => ({})),
}));
vi.mock('../local-services/dev/docker-dev-provider.js', () => ({
  createDockerDevProvider: vi.fn(() => ({})),
  fetchLocalPublishableKey: vi.fn(),
}));
vi.mock('../local-services/dev/fabric-dev-provider.js', () => ({
  createFabricDevProvider: vi.fn(() => ({ id: 'fabric-provider' })),
}));
vi.mock('../local-services/dev/local-runtime-provisioner.js', () => ({
  createCliLocalRuntimeProvisioner: vi.fn(() => ({ id: 'runtimes' })),
}));
vi.mock('../rayfin-services/index.js', () => ({
  createCliDataService: vi.fn(() => ({})),
  createCliDeploymentRegistryService: vi.fn(() => ({})),
  createCliDevRedirectService: vi.fn(() => ({})),
  createCliFrameworkEnvService: vi.fn(() => ({})),
}));
vi.mock('../utils/env-file-utils.js', () => ({
  updateEnvVariables: vi.fn(),
}));

const config = {
  id: 'my-app',
  services: {
    auth: { enabled: true },
    data: { enabled: false },
  },
} as unknown as RayfinConfig;

describe('createDevDeps', () => {
  let originalTenantId: string | undefined;
  let originalWorkspaceId: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalTenantId = process.env.RAYFIN_TENANT_ID;
    originalWorkspaceId = process.env.RAYFIN_WORKSPACE_ID;
    delete process.env.RAYFIN_TENANT_ID;
    delete process.env.RAYFIN_WORKSPACE_ID;
  });

  afterEach(() => {
    if (originalTenantId === undefined) {
      delete process.env.RAYFIN_TENANT_ID;
    } else {
      process.env.RAYFIN_TENANT_ID = originalTenantId;
    }
    if (originalWorkspaceId === undefined) {
      delete process.env.RAYFIN_WORKSPACE_ID;
    } else {
      process.env.RAYFIN_WORKSPACE_ID = originalWorkspaceId;
    }
  });

  it('persists the signed-in tenant when provisioning has no explicit tenant', async () => {
    process.env.RAYFIN_WORKSPACE_ID = 'ambient-workspace';
    await createDevDeps({
      diagnostics: { debug: vi.fn() },
      provider: 'fabric',
      config,
      projectRoot: '/project',
      progress: { report: vi.fn() },
      session: {
        token: 'token',
        identityType: 'user',
        tenantId: 'auth-tenant',
      },
    });

    expect(createFabricDevProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'auth-tenant',
        targetWorkspaceId: 'ambient-workspace',
        portalUrl: 'https://app.fabric.microsoft.com',
      })
    );
  });

  it('forwards the consent and disclosure inputs to the Fabric provider', async () => {
    const ui = { confirm: vi.fn(), prompt: vi.fn(), select: vi.fn() };
    const notify = vi.fn();
    await createDevDeps({
      diagnostics: { debug: vi.fn() },
      provider: 'fabric',
      config,
      projectRoot: '/project',
      progress: { report: vi.fn() },
      session: {
        token: 'token',
        identityType: 'user',
        tenantId: 'auth-tenant',
      },
      autoConfirmReuse: true,
      ui,
      notify,
    });

    expect(createFabricDevProvider).toHaveBeenCalledWith(
      expect.objectContaining({ autoConfirmReuse: true, ui, notify })
    );
  });

  it('adapts Fabric readiness with the dev host policy and cancellation', async () => {
    const controller = new AbortController();
    const cancellationToken = {
      isCancellationRequested: false,
      onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
    };
    const progress = { report: vi.fn() };
    const ui = { confirm: vi.fn(), prompt: vi.fn(), select: vi.fn() };
    const notify = vi.fn();
    const onReadinessNotice = vi.fn();
    const workspaceNotice = {
      kind: 'workspace-created' as const,
      workspaceId: 'ready-workspace',
      workspaceName: 'Ready Workspace',
    };
    vi.mocked(runFabricReadinessWorkflow).mockResolvedValueOnce({
      status: 'ok',
      data: {
        result: {
          status: 'ready',
          workspace: { id: 'ready-workspace', displayName: 'Ready Workspace' },
          capacityId: 'capacity-1',
          capacitySource: 'selected-paid',
          workspaceCreated: true,
        },
        notices: [workspaceNotice],
      },
    });

    await createDevDeps({
      diagnostics: { debug: vi.fn() },
      provider: 'fabric',
      config,
      projectRoot: '/project',
      progress,
      session: {
        token: 'token',
        identityType: 'user',
        tenantId: 'auth-tenant',
      },
      abortSignal: controller.signal,
      cancellationToken,
      ui,
      notify,
      onReadinessNotice,
    });

    expect(createCliFabricClient).toHaveBeenCalledWith('token', {
      diagnostics: expect.anything(),
      signal: controller.signal,
    });
    const providerOptions = vi.mocked(createFabricDevProvider).mock.calls[0][0];
    const prepared = await providerOptions.readiness?.prepare();
    expect(prepared).toEqual({
      status: 'ready',
      workspace: { id: 'ready-workspace', displayName: 'Ready Workspace' },
    });
    expect(notify).toHaveBeenCalledWith(
      'Fabric readiness confirmed for workspace "Ready Workspace".'
    );
    expect(onReadinessNotice).toHaveBeenCalledWith(workspaceNotice);
    expect(runFabricReadinessWorkflow).toHaveBeenCalledWith(
      {
        projectId: 'my-app',
        workspaceId: undefined,
        capacityId: undefined,
        capacityAssignmentMode: 'confirm',
      },
      expect.objectContaining({
        progress,
        ui,
        premiumCapacitySelection: 'prompt',
        signal: cancellationToken,
      })
    );
  });

  it('does not construct Fabric readiness for the Docker provider', async () => {
    await createDevDeps({
      diagnostics: { debug: vi.fn() },
      provider: 'docker',
      config,
      projectRoot: '/project',
      progress: { report: vi.fn() },
    });

    expect(createFabricDevProvider).not.toHaveBeenCalled();
    expect(runFabricReadinessWorkflow).not.toHaveBeenCalled();
  });

  it('uses non-interactive readiness policy and preserves action-required results', async () => {
    vi.mocked(runFabricReadinessWorkflow).mockResolvedValueOnce({
      status: 'ok',
      data: {
        result: {
          status: 'action-required',
          reason: 'capacity_selection_required',
          message: 'Multiple premium capacities require a selection.',
          retryable: true,
        },
        notices: [],
      },
    });

    await createDevDeps({
      diagnostics: { debug: vi.fn() },
      provider: 'fabric',
      config,
      projectRoot: '/project',
      progress: { report: vi.fn() },
      session: {
        token: 'token',
        identityType: 'user',
        tenantId: 'auth-tenant',
      },
    });

    const providerOptions = vi.mocked(createFabricDevProvider).mock.calls[0][0];
    await expect(providerOptions.readiness?.prepare()).resolves.toEqual({
      status: 'unavailable',
      code: 'fabric-readiness:capacity_selection_required',
      message: 'Multiple premium capacities require a selection.',
    });
    expect(runFabricReadinessWorkflow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ui: undefined,
        premiumCapacitySelection: 'fallback',
      })
    );
  });

  it('uses --yes as deterministic capacity consent without selecting among premium capacities', async () => {
    vi.mocked(runFabricReadinessWorkflow).mockResolvedValueOnce({
      status: 'ok',
      data: {
        result: {
          status: 'action-required',
          reason: 'capacity_selection_required',
          message: 'Selection required.',
          retryable: true,
        },
        notices: [],
      },
    });

    await createDevDeps({
      diagnostics: { debug: vi.fn() },
      provider: 'fabric',
      config,
      projectRoot: '/project',
      progress: { report: vi.fn() },
      session: {
        token: 'token',
        identityType: 'user',
        tenantId: 'auth-tenant',
      },
      autoConfirmReuse: true,
    });

    const providerOptions = vi.mocked(createFabricDevProvider).mock.calls[0][0];
    await providerOptions.readiness?.prepare();
    expect(runFabricReadinessWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        capacityAssignmentMode: 'automatic',
      }),
      expect.objectContaining({
        premiumCapacitySelection: 'fallback',
      })
    );
  });

  it('uses --capacity-id as consent to assign the selected capacity', async () => {
    vi.mocked(runFabricReadinessWorkflow).mockResolvedValueOnce({
      status: 'ok',
      data: {
        result: {
          status: 'action-required',
          reason: 'capacity_assignment_confirmation_required',
          message: 'Assignment confirmation is required.',
          retryable: true,
        },
        notices: [],
      },
    });

    await createDevDeps({
      diagnostics: { debug: vi.fn() },
      provider: 'fabric',
      config,
      projectRoot: '/project',
      progress: { report: vi.fn() },
      session: {
        token: 'token',
        identityType: 'user',
        tenantId: 'auth-tenant',
      },
      capacityId: '11111111-1111-4111-8111-111111111111',
    });
    const providerOptions = vi.mocked(createFabricDevProvider).mock.calls[0][0];
    await providerOptions.readiness?.prepare();
    expect(runFabricReadinessWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        capacityId: '11111111-1111-4111-8111-111111111111',
        capacityAssignmentMode: 'automatic',
      }),
      expect.anything()
    );
  });

  it('prefers explicit workspace targeting over the ambient workspace', async () => {
    process.env.RAYFIN_WORKSPACE_ID = 'ambient-workspace';
    await createDevDeps({
      diagnostics: { debug: vi.fn() },
      provider: 'fabric',
      config,
      projectRoot: '/project',
      progress: { report: vi.fn() },
      session: {
        token: 'token',
        identityType: 'user',
        tenantId: 'auth-tenant',
      },
      workspace: 'Team',
      workspaceId: 'flag-workspace',
    });

    expect(createFabricDevProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        targetWorkspaceId: 'flag-workspace',
        targetWorkspaceName: 'Team',
      })
    );
  });

  it('prefers an explicit workspace name over the ambient workspace ID', async () => {
    process.env.RAYFIN_WORKSPACE_ID = 'ambient-workspace';
    await createDevDeps({
      diagnostics: { debug: vi.fn() },
      provider: 'fabric',
      config,
      projectRoot: '/project',
      progress: { report: vi.fn() },
      session: {
        token: 'token',
        identityType: 'user',
        tenantId: 'auth-tenant',
      },
      workspace: 'Team',
    });

    expect(createFabricDevProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        targetWorkspaceId: undefined,
        targetWorkspaceName: 'Team',
      })
    );
  });

  it('leaves the workspace name unset so the provider never defaults one', async () => {
    process.env.RAYFIN_WORKSPACE_ID = 'ambient-workspace';
    await createDevDeps({
      diagnostics: { debug: vi.fn() },
      provider: 'fabric',
      config,
      projectRoot: '/project',
      progress: { report: vi.fn() },
      session: {
        token: 'token',
        identityType: 'user',
        tenantId: 'auth-tenant',
      },
    });

    expect(createFabricDevProvider).toHaveBeenCalledWith(
      expect.objectContaining({ targetWorkspaceName: undefined })
    );
  });
  it.each(['fabric', 'docker'] as const)(
    'injects diagnostics without changing data output policy for %s',
    async (provider) => {
      const diagnostics = { debug: vi.fn() };
      const deps = await createDevDeps({
        provider,
        diagnostics,
        config,
        projectRoot: '/project',
        progress: { report: vi.fn() },
        ...(provider === 'fabric'
          ? {
              session: {
                token: 'token',
                identityType: 'user' as const,
                tenantId: 'auth-tenant',
              },
            }
          : {}),
      });
      expect(deps.diagnostics).toBe(diagnostics);
      expect(createCliDataService).toHaveBeenCalledWith({
        diagnostics,
        captureOutput: false,
      });
      if (provider === 'fabric') {
        expect(createCliFabricClient).toHaveBeenCalledWith('token', {
          diagnostics,
        });
        expect(createCliRayfinWorkloadClient).toHaveBeenCalledWith(
          'token',
          diagnostics
        );
      }
    }
  );
});
