import { describe, expect, it, vi } from 'vitest';

import {
  createLinkedCancellation,
  noopCancellationToken,
  silentDiagnostics,
} from '../../../adapters/index.js';
import type { UpStatusDeps } from '../types.js';
import { runUpStatusWorkflow } from '../workflow.js';

const request = { projectPath: '/project' };
const record = {
  itemId: 'item',
  workspaceId: 'workspace',
  apiUrl: 'https://runtime.example',
  publishableKey: 'pk-saved',
};

function fixture() {
  const client = {
    getWorkspace: vi
      .fn()
      .mockResolvedValue({ id: 'workspace', displayName: 'My workspace' }),
    getItem: vi.fn().mockResolvedValue({
      id: 'item',
      displayName: 'app',
      type: 'AppBackend',
    }),
    listDatabases: vi
      .fn()
      .mockResolvedValue([{ id: 'db', displayName: 'database' }]),
    checkManagementEndpoint: vi.fn().mockResolvedValue({
      url: 'https://management.example/key',
      reachable: true,
      authenticated: true,
      httpStatus: 200,
      publishableKey: 'pk-saved',
    }),
  };
  const deps = {
    project: {
      load: vi.fn().mockResolvedValue({
        projectRoot: '/project',
        id: 'app',
        services: { auth: { enabled: true }, data: { enabled: false } },
      }),
    },
    registry: {
      getActiveDeployment: vi
        .fn()
        .mockResolvedValue({ workspaceName: 'active', record }),
      readDeployment: vi.fn().mockResolvedValue({ record, warnings: [] }),
      listDeployments: vi.fn().mockResolvedValue({
        deployments: [{ workspaceName: 'active', record, active: true }],
        warnings: [],
      }),
    },
    fabric: { tryConnect: vi.fn().mockResolvedValue(client) },
    cancellation: noopCancellationToken,
    diagnostics: { ...silentDiagnostics, debug: vi.fn() },
    progress: { report: vi.fn() },
  } satisfies UpStatusDeps;
  return { deps, client };
}

describe('up status workflow', () => {
  it('collects active deployment facts through read-only dependencies', async () => {
    const { deps, client } = fixture();
    const result = await runUpStatusWorkflow(request, deps);
    expect(result).toMatchObject({
      status: 'ok',
      data: {
        projectName: 'app',
        authenticated: true,
        endpointHealth: { httpStatus: 200, publishableKey: 'pk-saved' },
        deployment: { record },
      },
    });
    expect(client.checkManagementEndpoint).toHaveBeenCalledWith(
      'workspace',
      'item'
    );
    expect(client.listDatabases).not.toHaveBeenCalled();
    expect(JSON.stringify(deps.diagnostics.debug.mock.calls)).not.toContain(
      'pk-saved'
    );
  });

  it.each(['absent', 'expired'])(
    'returns cached data when authentication is %s',
    async (reason) => {
      const { deps, client } = fixture();
      if (reason === 'absent') deps.fabric.tryConnect.mockResolvedValue(null);
      else deps.fabric.tryConnect.mockRejectedValue(new Error('token expired'));
      expect(await runUpStatusWorkflow(request, deps)).toMatchObject({
        status: 'ok',
        data: {
          authenticated: false,
          endpointHealth: null,
          deployment: { record },
        },
      });
      expect(client.getWorkspace).not.toHaveBeenCalled();
    }
  );

  it('fails missing project configuration before authentication', async () => {
    const { deps } = fixture();
    deps.project.load.mockResolvedValue(null);
    expect(await runUpStatusWorkflow(request, deps)).toMatchObject({
      status: 'failed',
      error: { code: 'project-not-found' },
    });
    expect(deps.fabric.tryConnect).not.toHaveBeenCalled();
  });

  it('returns a structured failure when the project reader fails', async () => {
    const { deps } = fixture();
    deps.project.load.mockRejectedValue(new Error('read failed'));
    expect(await runUpStatusWorkflow(request, deps)).toMatchObject({
      status: 'failed',
      error: { code: 'status-unavailable' },
    });
  });

  it('uses an explicit deployment without requiring an ambient workspace', async () => {
    const { deps } = fixture();
    expect(
      await runUpStatusWorkflow(
        { ...request, deploymentName: 'selected' },
        deps
      )
    ).toMatchObject({
      status: 'ok',
      data: { deployment: { workspaceName: 'selected' } },
    });
    expect(deps.registry.readDeployment).toHaveBeenCalledWith(
      '/project',
      'selected'
    );
    expect(deps.registry.getActiveDeployment).not.toHaveBeenCalled();
  });

  it('rejects a selected deployment from a different workspace', async () => {
    const { deps } = fixture();
    expect(
      await runUpStatusWorkflow(
        { ...request, deploymentName: 'selected', workspaceId: 'other' },
        deps
      )
    ).toMatchObject({
      status: 'failed',
      error: { code: 'deployment-workspace-mismatch' },
    });
    expect(deps.fabric.tryConnect).not.toHaveBeenCalled();
  });

  it('selects a workspace-matched record without mixing active metadata', async () => {
    const { deps, client } = fixture();
    const otherRecord = {
      ...record,
      workspaceId: 'other',
      itemId: 'other-item',
    };
    deps.registry.listDeployments.mockResolvedValue({
      deployments: [
        { workspaceName: 'other', record: otherRecord, active: false },
      ],
      warnings: [],
    });
    expect(
      await runUpStatusWorkflow({ ...request, workspaceId: 'other' }, deps)
    ).toMatchObject({
      status: 'ok',
      data: { deployment: { workspaceName: 'other', record: otherRecord } },
    });
    expect(client.getItem).toHaveBeenCalledWith('other', 'other-item');
  });

  it.each([0, 2])(
    'rejects %s workspace matches without making live calls',
    async (count) => {
      const { deps } = fixture();
      deps.registry.listDeployments.mockResolvedValue({
        deployments: Array.from({ length: count }, () => ({
          workspaceName: 'candidate',
          record,
          active: false,
        })),
        warnings: [],
      });
      expect(
        await runUpStatusWorkflow(
          { ...request, workspaceId: 'workspace' },
          deps
        )
      ).toMatchObject({
        status: 'failed',
        error: {
          code: count === 0 ? 'deployment-not-found' : 'deployment-ambiguous',
        },
      });
      expect(deps.fabric.tryConnect).not.toHaveBeenCalled();
    }
  );

  it('falls back to a single deployment when no active entry is set', async () => {
    const { deps } = fixture();
    deps.registry.getActiveDeployment.mockResolvedValue(null);
    expect(await runUpStatusWorkflow(request, deps)).toMatchObject({
      status: 'ok',
      data: { deployment: { record } },
    });
  });

  it('collects the database only when data is enabled', async () => {
    const { deps } = fixture();
    deps.project.load.mockResolvedValue({
      projectRoot: '/project',
      id: 'app',
      services: { data: { enabled: true } },
    });
    expect(await runUpStatusWorkflow(request, deps)).toMatchObject({
      status: 'ok',
      data: { database: { id: 'db' } },
    });
  });

  it('continues the management check when optional lookups fail', async () => {
    const { deps, client } = fixture();
    client.getWorkspace.mockRejectedValue(new Error('unavailable'));
    client.getItem.mockRejectedValue(new Error('unavailable'));
    expect(await runUpStatusWorkflow(request, deps)).toMatchObject({
      status: 'ok',
      data: {
        workspace: null,
        item: null,
        endpointHealth: { httpStatus: 200 },
      },
    });
  });

  it('preserves unhealthy endpoint facts rather than throwing away cached status', async () => {
    const { deps, client } = fixture();
    client.checkManagementEndpoint.mockResolvedValue({
      url: 'https://management.example/key',
      reachable: true,
      httpStatus: 403,
      authenticated: false,
      errorCode: 'http',
      error: 'HTTP 403 Forbidden',
    });
    expect(await runUpStatusWorkflow(request, deps)).toMatchObject({
      status: 'ok',
      data: {
        authenticated: true,
        endpointHealth: {
          httpStatus: 403,
          authenticated: false,
          errorCode: 'http',
        },
      },
    });
    expect(record.publishableKey).toBe('pk-saved');
  });

  it.each(['before', 'project', 'workspace'])(
    'honors cancellation %s a step',
    async (stage) => {
      const { deps, client } = fixture();
      const cancellation = createLinkedCancellation();
      deps.cancellation = cancellation.token;
      if (stage === 'before') cancellation.cancel();
      if (stage === 'project')
        deps.project.load.mockImplementation(async () => {
          cancellation.cancel();
          return { projectRoot: '/project', id: 'app' };
        });
      if (stage === 'workspace')
        client.getWorkspace.mockImplementation(async () => {
          cancellation.cancel();
          return { id: 'workspace', displayName: 'My workspace' };
        });
      expect(await runUpStatusWorkflow(request, deps)).toMatchObject({
        status: 'cancelled',
      });
      expect(client.checkManagementEndpoint).not.toHaveBeenCalled();
      cancellation.dispose();
    }
  );
});
