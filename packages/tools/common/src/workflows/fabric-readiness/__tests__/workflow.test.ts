import { describe, expect, it, vi } from 'vitest';

import { cancellationTokenFromSignal } from '../../../adapters/index.js';
import type {
  FabricCapacity,
  FabricClient,
  FabricWorkspace,
} from '../../../external/fabric/index.js';
import { runFabricReadinessWorkflow } from '../index.js';

const capacity: FabricCapacity = {
  id: 'capacity-1',
  displayName: 'Trial Capacity',
  sku: 'FT1',
  state: 'Active',
  type: 'Trial',
};

const created: FabricWorkspace = {
  id: 'workspace-1',
  displayName: 'app-20260917-100000',
};

function fakeFabric(overrides: Partial<FabricClient> = {}): FabricClient {
  const findTrialCapacity =
    overrides.findTrialCapacity ?? vi.fn().mockResolvedValue(capacity);
  return {
    findTrialCapacity,
    listCapacities:
      overrides.listCapacities ??
      vi.fn(async () => {
        const trial = await findTrialCapacity();
        return trial ? [trial] : [];
      }),
    getCapacity: vi.fn(),
    checkTrialEligibility: vi.fn(),
    startTrial: vi.fn(),
    getOperationStatus: vi.fn(),
    getOperationResult: vi.fn(),
    listWorkspaces: vi.fn(),
    isWorkspaceAdmin: vi.fn().mockResolvedValue(true),
    getWorkspace: vi.fn(),
    createWorkspace: vi.fn().mockResolvedValue(created),
    assignWorkspaceToCapacity: vi.fn().mockResolvedValue({}),
    getItemByName: vi.fn(),
    createItem: vi.fn(),
    ...overrides,
  };
}

describe('runFabricReadinessWorkflow', () => {
  it('requires consent before creating or assigning a workspace without interactive UI', async () => {
    const premiumCapacity: FabricCapacity = {
      id: 'premium-1',
      displayName: 'Premium F2',
      sku: 'F2',
      state: 'Active',
      type: 'FSkuCapacity',
    };
    const fabric = fakeFabric({
      listCapacities: vi.fn().mockResolvedValue([premiumCapacity]),
    });

    const result = await runFabricReadinessWorkflow(
      { projectId: 'app', capacityAssignmentMode: 'confirm' },
      { fabric }
    );

    expect(result).toMatchObject({
      status: 'ok',
      data: {
        result: {
          status: 'action-required',
          reason: 'capacity_assignment_confirmation_required',
        },
      },
    });
    expect(fabric.createWorkspace).not.toHaveBeenCalled();
    expect(fabric.assignWorkspaceToCapacity).not.toHaveBeenCalled();
  });

  it('assigns an explicit capacity automatically when the host opts in', async () => {
    const explicitCapacity: FabricCapacity = {
      id: 'explicit-capacity',
      displayName: 'Explicit F2',
      sku: 'F2',
      state: 'Active',
      type: 'FSkuCapacity',
    };
    const confirm = vi.fn();
    const fabric = fakeFabric({
      getCapacity: vi.fn().mockResolvedValue(explicitCapacity),
      getWorkspace: vi.fn().mockResolvedValue({
        ...created,
        capacityId: explicitCapacity.id,
        capacityAssignmentProgress: 'Completed',
      }),
    });

    const result = await runFabricReadinessWorkflow(
      {
        projectId: 'app',
        capacityId: explicitCapacity.id,
        capacityAssignmentMode: 'automatic',
      },
      {
        fabric,
        ui: {
          prompt: vi.fn(),
          confirm,
          select: vi.fn(),
        },
      }
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'ok',
      data: {
        result: {
          status: 'ready',
          capacityId: explicitCapacity.id,
          capacitySource: 'explicit',
        },
      },
    });
    expect(fabric.createWorkspace).toHaveBeenCalledOnce();
    expect(fabric.assignWorkspaceToCapacity).toHaveBeenCalledWith(
      created.id,
      explicitCapacity.id
    );
  });

  it('honors confirmation mode for an explicitly selected capacity', async () => {
    const explicitCapacity: FabricCapacity = {
      id: 'explicit-capacity',
      displayName: 'Explicit F2',
      sku: 'F2',
      state: 'Active',
      type: 'FSkuCapacity',
    };
    const confirm = vi.fn().mockResolvedValue(false);
    const fabric = fakeFabric({
      getCapacity: vi.fn().mockResolvedValue(explicitCapacity),
    });

    const result = await runFabricReadinessWorkflow(
      {
        projectId: 'app',
        capacityId: explicitCapacity.id,
        capacityAssignmentMode: 'confirm',
      },
      {
        fabric,
        ui: {
          prompt: vi.fn(),
          confirm,
          select: vi.fn(),
        },
      }
    );

    expect(confirm).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: 'ok',
      data: {
        result: {
          status: 'assignment-declined',
        },
      },
    });
    expect(fabric.createWorkspace).not.toHaveBeenCalled();
    expect(fabric.assignWorkspaceToCapacity).not.toHaveBeenCalled();
  });

  it('returns cancelled when the premium-capacity picker is dismissed', async () => {
    const firstPremium = {
      id: 'premium-1',
      displayName: 'Premium F2',
      sku: 'F2',
      state: 'Active',
      type: 'FSkuCapacity',
    };
    const secondPremium = {
      id: 'premium-2',
      displayName: 'Premium P1',
      sku: 'P1',
      state: 'Active',
      type: 'PSkuCapacity',
    };
    const result = await runFabricReadinessWorkflow(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      {
        fabric: fakeFabric({
          listCapacities: vi
            .fn()
            .mockResolvedValue([firstPremium, secondPremium]),
        }),
        ui: {
          prompt: vi.fn(),
          confirm: vi.fn(),
          select: vi.fn().mockResolvedValue(undefined),
        },
      }
    );

    expect(result).toEqual({ status: 'cancelled' });
  });

  it('retains a created workspace identity when assignment fails', async () => {
    const result = await runFabricReadinessWorkflow(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      {
        fabric: fakeFabric({
          assignWorkspaceToCapacity: vi
            .fn()
            .mockRejectedValue(new Error('assignment denied')),
        }),
      }
    );

    expect(result).toMatchObject({
      status: 'ok',
      data: {
        result: {
          status: 'failed',
          reason: 'workspace_assignment_failed',
        },
        notices: [
          {
            kind: 'workspace-created',
            workspaceId: 'workspace-1',
            workspaceName: 'app-20260917-100000',
          },
        ],
      },
    });
  });

  it('returns completed assignment identities with a ready target', async () => {
    const assigned = {
      ...created,
      capacityId: capacity.id,
      capacityAssignmentProgress: 'Completed',
    };
    const result = await runFabricReadinessWorkflow(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      {
        fabric: fakeFabric({
          getWorkspace: vi.fn().mockResolvedValue(assigned),
        }),
        polling: { initialDelayMs: 0, maxDelayMs: 0 },
      }
    );

    expect(result).toMatchObject({
      status: 'ok',
      data: {
        result: { status: 'ready', workspace: assigned },
        notices: [
          {
            kind: 'workspace-created',
            workspaceId: created.id,
          },
          {
            kind: 'capacity-assigned',
            workspaceId: created.id,
            capacityId: capacity.id,
          },
        ],
      },
    });
  });

  it('cancels assignment polling while retaining completed resource notices', async () => {
    const controller = new AbortController();
    const result = await runFabricReadinessWorkflow(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      {
        fabric: fakeFabric({
          assignWorkspaceToCapacity: vi.fn().mockImplementation(async () => {
            controller.abort();
            return { retryAfterMs: 60_000 };
          }),
        }),
        signal: cancellationTokenFromSignal(controller.signal),
      }
    );

    expect(result).toEqual({
      status: 'cancelled',
      notices: [
        {
          kind: 'workspace-created',
          workspaceId: created.id,
          workspaceName: created.displayName,
        },
      ],
    });
  });
});
