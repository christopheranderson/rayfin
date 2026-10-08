import { describe, expect, it, vi } from 'vitest';

import { cancellationTokenFromSignal } from '../../../../adapters/index.js';
import { sanitizeWorkspaceName } from '../../../../config/env.js';
import type {
  FabricCapacity,
  FabricClient,
  FabricWorkspace,
} from '../../../../external/fabric/index.js';
import { FabricError } from '../../../../external/fabric/index.js';
import { workspaceName } from '../../../fabric-readiness/steps/workspace-target.js';
import { ensureFabricTarget } from '../../../fabric-readiness/workflow.js';

/** Poll pacing that keeps assignment and trial loops instant under test. */
const instantPolling = { initialDelayMs: 0, maxDelayMs: 0 };

describe('workspaceName', () => {
  const at = (iso: string) => new Date(iso);

  it('distinguishes workspaces the same project creates at different times', () => {
    const first = workspaceName(
      'my-app',
      at('2026-09-11T20:50:55.695Z'),
      'a1b2c3d4'
    );
    const second = workspaceName(
      'my-app',
      at('2026-09-11T20:51:02.000Z'),
      'e5f6a7b8'
    );

    expect(first).toBe('my-app-20260911-205055695-a1b2c3d4');
    expect(second).toBe('my-app-20260911-205102000-e5f6a7b8');
  });

  it('distinguishes concurrent workspace creation attempts', () => {
    const now = at('2026-09-11T20:50:55.695Z');

    expect(workspaceName('my-app', now, 'a1b2c3d4')).not.toBe(
      workspaceName('my-app', now, 'e5f6a7b8')
    );
  });

  // The stamp lands in the deployment registry key too, so a character the
  // sanitizer strips would silently desync the key from the display name and
  // print a spurious "Workspace name sanitized" notice on every deploy.
  it('produces a name the deployment registry keeps verbatim', () => {
    const name = workspaceName(
      'my-app',
      at('2026-09-11T20:50:55.695Z'),
      'a1b2c3d4'
    );

    expect(sanitizeWorkspaceName(name)).toBe(name);
  });

  it('keeps long names inside the registry-safe cap without losing the suffix', () => {
    const name = workspaceName(
      'a'.repeat(400),
      at('2026-09-11T20:50:55.695Z'),
      'a1b2c3d4'
    );

    expect(name.length).toBe(200);
    expect(name).toMatch(/^a+-20260911-205055695-a1b2c3d4$/);
    expect(sanitizeWorkspaceName(name)).toBe(name);
  });

  it('never leads with the separator when the project id is blank', () => {
    expect(
      workspaceName('   ', at('2026-09-11T20:50:55.695Z'), 'a1b2c3d4')
    ).toBe('rayfin-20260911-205055695-a1b2c3d4');
  });
});

const capacity = (
  id: string,
  overrides: Partial<FabricCapacity> = {}
): FabricCapacity => ({
  id,
  displayName: id,
  sku: 'F2',
  state: 'Active',
  ...overrides,
});

const workspace = (
  id: string,
  overrides: Partial<FabricWorkspace> = {}
): FabricWorkspace => ({
  id,
  displayName: id,
  ...overrides,
});

function fakeFabric(overrides: Partial<FabricClient> = {}): FabricClient {
  const findTrialCapacity =
    overrides.findTrialCapacity ?? vi.fn().mockResolvedValue(undefined);
  return {
    findTrialCapacity,
    listCapacities:
      overrides.listCapacities ??
      vi.fn(async () => {
        const trial = await findTrialCapacity();
        return trial ? [trial] : [];
      }),
    getCapacity: vi.fn(async (id: string) => capacity(id)),
    checkTrialEligibility: vi
      .fn()
      .mockResolvedValue({ eligible: false, reason: 'IneligibleForTrial' }),
    startTrial: vi.fn(),
    getOperationStatus: vi.fn(),
    getOperationResult: vi.fn(),
    listWorkspaces: vi.fn().mockResolvedValue([]),
    isWorkspaceAdmin: vi.fn().mockResolvedValue(true),
    getWorkspace: vi.fn(),
    createWorkspace: vi.fn(),
    assignWorkspaceToCapacity: vi.fn(),
    getItemByName: vi.fn(),
    createItem: vi.fn(),
    ...overrides,
  };
}

describe('ensureFabricTarget', () => {
  it('uses an explicitly selected usable capacity without discovery fallback', async () => {
    const explicit = capacity('explicit-capacity', {
      displayName: 'Explicit Capacity',
      sku: 'F4',
    });
    const created = workspace('w-new');
    const assigned = workspace('w-new', {
      capacityId: explicit.id,
      capacityAssignmentProgress: 'Completed',
    });
    const fabric = fakeFabric({
      getCapacity: vi.fn().mockResolvedValue(explicit),
      listCapacities: vi.fn().mockResolvedValue([]),
      createWorkspace: vi.fn().mockResolvedValue(created),
      getWorkspace: vi.fn().mockResolvedValue(assigned),
      assignWorkspaceToCapacity: vi.fn().mockResolvedValue({}),
    });

    const result = await ensureFabricTarget(
      {
        projectId: 'app',
        capacityId: explicit.id,
        capacityAssignmentMode: 'automatic',
      },
      { fabric, polling: instantPolling }
    );

    expect(result).toMatchObject({
      status: 'ready',
      capacityId: explicit.id,
      capacitySource: 'explicit',
    });
    expect(fabric.getCapacity).toHaveBeenCalledWith(explicit.id);
    expect(fabric.listCapacities).not.toHaveBeenCalled();
    expect(fabric.startTrial).not.toHaveBeenCalled();
  });

  it('fails closed before mutations when deterministic assignment needs confirmation', async () => {
    const premium = capacity('premium-f2', {
      displayName: 'Team F2',
      sku: 'F2',
    });
    const fabric = fakeFabric({
      listCapacities: vi.fn().mockResolvedValue([premium]),
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'confirm' },
      { fabric }
    );

    expect(result).toMatchObject({
      status: 'action-required',
      reason: 'capacity_assignment_confirmation_required',
      message: expect.stringContaining(
        'Assigning capacity Team F2 (premium-f2)'
      ),
    });
    expect(fabric.startTrial).not.toHaveBeenCalled();
    expect(fabric.createWorkspace).not.toHaveBeenCalled();
    expect(fabric.assignWorkspaceToCapacity).not.toHaveBeenCalled();
  });

  it('fails closed before provisioning a trial without confirmation', async () => {
    const fabric = fakeFabric({
      listCapacities: vi.fn().mockResolvedValue([]),
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'confirm' },
      { fabric }
    );

    expect(result).toMatchObject({
      status: 'action-required',
      reason: 'capacity_assignment_confirmation_required',
      message: expect.stringContaining(
        'Provisioning and assigning Fabric trial capacity'
      ),
    });
    expect(fabric.checkTrialEligibility).not.toHaveBeenCalled();
    expect(fabric.startTrial).not.toHaveBeenCalled();
    expect(fabric.createWorkspace).not.toHaveBeenCalled();
  });

  it('returns assignment-declined before creating a new workspace', async () => {
    const premium = capacity('premium-f2', {
      displayName: 'Team F2',
      sku: 'F2',
    });
    const confirm = vi.fn().mockResolvedValue(false);
    const fabric = fakeFabric({
      listCapacities: vi.fn().mockResolvedValue([premium]),
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'confirm' },
      {
        fabric,
        ui: { prompt: vi.fn(), confirm, select: vi.fn() },
      }
    );

    expect(result).toEqual({ status: 'assignment-declined' });
    expect(confirm).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Assign capacity Team F2 \(premium-f2\) to workspace app-/
      ),
      { default: true }
    );
    expect(fabric.createWorkspace).not.toHaveBeenCalled();
    expect(fabric.assignWorkspaceToCapacity).not.toHaveBeenCalled();
  });

  it('prompts with only premium capacities when multiple are available', async () => {
    const existing = workspace('w1');
    const premiumP1 = capacity('premium-p1', {
      displayName: 'Team P1',
      sku: 'P1',
      type: 'PSkuCapacity',
    });
    const premiumF4 = capacity('premium-f4', {
      displayName: 'Team F4',
      sku: 'F4',
      type: 'FSkuCapacity',
    });
    const trial = capacity('trial', {
      displayName: 'Fabric Trial',
      sku: 'FT1',
      type: 'FabricTrialCapacity',
    });
    const assigned = workspace('w1', {
      capacityId: premiumF4.id,
      capacityAssignmentProgress: 'Completed',
    });
    const select = vi.fn().mockResolvedValue(premiumF4);
    const fabric = fakeFabric({
      listCapacities: vi.fn().mockResolvedValue([
        capacity('paused', {
          sku: 'F2',
          type: 'FSkuCapacity',
          state: 'Paused',
        }),
        capacity('too-small', { sku: 'F1', type: 'FSkuCapacity' }),
        premiumP1,
        trial,
        premiumF4,
      ]),
      getWorkspace: vi
        .fn()
        .mockResolvedValueOnce(existing)
        .mockResolvedValue(assigned),
      assignWorkspaceToCapacity: vi.fn().mockResolvedValue({}),
    });

    const result = await ensureFabricTarget(
      {
        projectId: 'app',
        capacityAssignmentMode: 'automatic',
        workspaceId: existing.id,
      },
      {
        fabric,
        ui: {
          prompt: vi.fn(),
          confirm: vi.fn(),
          select,
        },
        polling: instantPolling,
      }
    );

    expect(select).toHaveBeenCalledWith(
      'Which Fabric capacity should Rayfin use?',
      [
        {
          label: 'Team P1',
          value: premiumP1,
          description: 'Premium SKU P1',
        },
        {
          label: 'Team F4',
          value: premiumF4,
          description: 'Premium SKU F4',
        },
      ],
      { requireExplicitChoice: true }
    );
    expect(fabric.assignWorkspaceToCapacity).toHaveBeenCalledWith(
      existing.id,
      premiumF4.id
    );
    expect(fabric.startTrial).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'ready',
      capacityId: premiumF4.id,
      capacitySource: 'selected-paid',
      workspaceCreated: false,
    });
  });

  it('uses the first returned trial when only trial capacities are available', async () => {
    const existing = workspace('w1');
    const firstTrial = capacity('trial-1', {
      displayName: 'First Fabric Trial',
      sku: 'FT1',
      type: 'FabricTrialCapacity',
    });
    const secondTrial = capacity('trial-2', {
      displayName: 'Second Fabric Trial',
      sku: 'FTL64',
      type: 'FabricTrialCapacity',
    });
    const assigned = workspace('w1', {
      capacityId: firstTrial.id,
      capacityAssignmentProgress: 'Completed',
    });
    const fabric = fakeFabric({
      listCapacities: vi.fn().mockResolvedValue([firstTrial, secondTrial]),
      getWorkspace: vi
        .fn()
        .mockResolvedValueOnce(existing)
        .mockResolvedValue(assigned),
      assignWorkspaceToCapacity: vi.fn().mockResolvedValue({}),
    });

    const result = await ensureFabricTarget(
      {
        projectId: 'app',
        capacityAssignmentMode: 'automatic',
        workspaceId: existing.id,
      },
      { fabric, polling: instantPolling }
    );

    expect(fabric.assignWorkspaceToCapacity).toHaveBeenCalledWith(
      existing.id,
      firstTrial.id
    );
    expect(fabric.startTrial).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'ready',
      capacityId: firstTrial.id,
      capacitySource: 'existing-trial',
    });
  });

  it('automatically assigns the only premium capacity', async () => {
    const premium = capacity('premium-p1', {
      sku: 'P1',
      type: 'PSkuCapacity',
    });
    const created = workspace('w-new');
    const assigned = workspace('w-new', {
      capacityId: premium.id,
      capacityAssignmentProgress: 'Completed',
    });
    const fabric = fakeFabric({
      listCapacities: vi.fn().mockResolvedValue([premium]),
      createWorkspace: vi.fn().mockResolvedValue(created),
      getWorkspace: vi.fn().mockResolvedValue(assigned),
      assignWorkspaceToCapacity: vi.fn().mockResolvedValue({}),
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      { fabric, polling: instantPolling }
    );

    expect(result).toMatchObject({
      status: 'ready',
      capacityId: premium.id,
      capacitySource: 'selected-paid',
    });
    expect(fabric.assignWorkspaceToCapacity).toHaveBeenCalledWith(
      created.id,
      premium.id
    );
    expect(fabric.startTrial).not.toHaveBeenCalled();
  });

  it('does not create or assign a workspace after cancellation during capacity listing', async () => {
    const controller = new AbortController();
    const premium = capacity('premium-p1', {
      sku: 'P1',
      type: 'PSkuCapacity',
    });
    const createWorkspace = vi.fn();
    const assignWorkspaceToCapacity = vi.fn();
    const fabric = fakeFabric({
      listCapacities: vi.fn().mockImplementation(async () => {
        controller.abort();
        return [premium];
      }),
      createWorkspace,
      assignWorkspaceToCapacity,
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      {
        fabric,
        signal: cancellationTokenFromSignal(controller.signal),
      }
    );

    expect(result).toEqual({ status: 'cancelled' });
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(assignWorkspaceToCapacity).not.toHaveBeenCalled();
  });

  it('does not activate a trial after cancellation during eligibility', async () => {
    const controller = new AbortController();
    const startTrial = vi.fn();
    const fabric = fakeFabric({
      listCapacities: vi.fn().mockResolvedValue([]),
      checkTrialEligibility: vi.fn().mockImplementation(async () => {
        controller.abort();
        return { eligible: true };
      }),
      startTrial,
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      {
        fabric,
        signal: cancellationTokenFromSignal(controller.signal),
      }
    );

    expect(result).toEqual({ status: 'cancelled' });
    expect(startTrial).not.toHaveBeenCalled();
  });

  it('retains the created workspace notice but does not assign after cancellation', async () => {
    const controller = new AbortController();
    const premium = capacity('premium-p1', {
      sku: 'P1',
      type: 'PSkuCapacity',
    });
    const created = workspace('w-new');
    const notices: unknown[] = [];
    const assignWorkspaceToCapacity = vi.fn();
    const fabric = fakeFabric({
      listCapacities: vi.fn().mockResolvedValue([premium]),
      createWorkspace: vi.fn().mockImplementation(async () => {
        controller.abort();
        return created;
      }),
      assignWorkspaceToCapacity,
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      {
        fabric,
        signal: cancellationTokenFromSignal(controller.signal),
        onNotice: (notice) => notices.push(notice),
      }
    );

    expect(result).toEqual({ status: 'cancelled' });
    expect(assignWorkspaceToCapacity).not.toHaveBeenCalled();
    expect(notices).toEqual([
      {
        kind: 'workspace-created',
        workspaceId: created.id,
        workspaceName: created.displayName,
      },
    ]);
  });

  it('automatically assigns one premium capacity when trials are also available', async () => {
    const premium = capacity('premium-f2', {
      sku: 'F2',
      type: 'FSkuCapacity',
    });
    const trial = capacity('trial', {
      sku: 'FT1',
      type: 'FabricTrialCapacity',
    });
    const created = workspace('w-new');
    const assigned = workspace('w-new', {
      capacityId: premium.id,
      capacityAssignmentProgress: 'Completed',
    });
    const fabric = fakeFabric({
      listCapacities: vi.fn().mockResolvedValue([premium, trial]),
      createWorkspace: vi.fn().mockResolvedValue(created),
      getWorkspace: vi.fn().mockResolvedValue(assigned),
      assignWorkspaceToCapacity: vi.fn().mockResolvedValue({}),
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      { fabric, polling: instantPolling }
    );

    expect(result).toMatchObject({
      status: 'ready',
      capacityId: premium.id,
      capacitySource: 'selected-paid',
    });
    expect(fabric.assignWorkspaceToCapacity).toHaveBeenCalledWith(
      created.id,
      premium.id
    );
    expect(fabric.startTrial).not.toHaveBeenCalled();
  });

  it('returns unresolved for multiple premium capacities non-interactively', async () => {
    const fabric = fakeFabric({
      listCapacities: vi
        .fn()
        .mockResolvedValue([
          capacity('trial', { sku: 'FT1', type: 'FabricTrialCapacity' }),
          capacity('premium-f2', { sku: 'F2', type: 'FSkuCapacity' }),
          capacity('premium-p1', { sku: 'P1', type: 'PSkuCapacity' }),
        ]),
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      { fabric }
    );

    expect(result).toMatchObject({
      status: 'action-required',
      reason: 'capacity_selection_required',
    });
    expect(fabric.createWorkspace).not.toHaveBeenCalled();
  });

  it('preserves any capacity already assigned to a supplied workspace', async () => {
    const assigned = workspace('w1', {
      capacityId: 'c1',
      capacityAssignmentProgress: 'Completed',
    });
    const fabric = fakeFabric({
      findTrialCapacity: vi.fn().mockResolvedValue(undefined),
      getWorkspace: vi.fn().mockResolvedValue(assigned),
    });

    const result = await ensureFabricTarget(
      {
        projectId: 'app',
        capacityAssignmentMode: 'automatic',
        workspaceId: 'w1',
      },
      { fabric }
    );

    expect(result).toMatchObject({
      status: 'ready',
      workspace: assigned,
      capacityId: 'c1',
      capacitySource: 'workspace',
      workspaceCreated: false,
    });
    expect(fabric.checkTrialEligibility).not.toHaveBeenCalled();
    expect(fabric.findTrialCapacity).not.toHaveBeenCalled();
    expect(fabric.isWorkspaceAdmin).not.toHaveBeenCalled();
    expect(fabric.assignWorkspaceToCapacity).not.toHaveBeenCalled();
  });

  it('enters assignment when the workspace has no capacity', async () => {
    const unassigned = workspace('w1');
    const fabric = fakeFabric({
      getWorkspace: vi.fn().mockResolvedValue(unassigned),
      isWorkspaceAdmin: vi.fn().mockResolvedValue(false),
    });

    const result = await ensureFabricTarget(
      {
        projectId: 'app',
        capacityAssignmentMode: 'automatic',
        workspaceId: 'w1',
      },
      { fabric }
    );

    expect(result).toMatchObject({
      status: 'action-required',
      reason: 'workspace_admin_required',
    });
    expect(fabric.isWorkspaceAdmin).toHaveBeenCalledWith('w1');
    expect(fabric.assignWorkspaceToCapacity).not.toHaveBeenCalled();
  });

  it('enters assignment when the workspace reports a failed assignment without a capacity', async () => {
    const fabric = fakeFabric({
      getWorkspace: vi.fn().mockResolvedValue(
        workspace('w1', {
          capacityAssignmentProgress: 'Failed',
        })
      ),
      isWorkspaceAdmin: vi.fn().mockResolvedValue(false),
    });

    const result = await ensureFabricTarget(
      {
        projectId: 'app',
        capacityAssignmentMode: 'automatic',
        workspaceId: 'w1',
      },
      { fabric }
    );

    expect(result).toMatchObject({
      status: 'action-required',
      reason: 'workspace_admin_required',
    });
    expect(fabric.isWorkspaceAdmin).toHaveBeenCalledWith('w1');
    expect(fabric.getCapacity).not.toHaveBeenCalled();
  });

  it.each([
    ['expired trial', 'expired', 'Completed'],
    ['unsupported premium SKU', 'p6', 'Completed'],
    ['paused premium capacity', 'paused', 'Completed'],
    ['unsupported F-SKU', 'f3', 'Completed'],
    ['in-progress assignment', 'pending', 'InProgress'],
    ['failed assignment', 'failed', 'Failed'],
  ])(
    'skips all readiness checks for a supplied workspace with %s',
    async (_label, capacityId, capacityAssignmentProgress) => {
      const assigned = workspace('w1', {
        capacityId,
        capacityAssignmentProgress,
      });
      const fabric = fakeFabric({
        getWorkspace: vi.fn().mockResolvedValue(assigned),
        getCapacity: vi
          .fn()
          .mockRejectedValue(new Error('capacity must not be queried')),
      });

      const result = await ensureFabricTarget(
        {
          projectId: 'app',
          capacityAssignmentMode: 'automatic',
          workspaceId: 'w1',
        },
        { fabric }
      );

      expect(result).toMatchObject({
        status: 'ready',
        workspace: assigned,
        capacityId,
        capacitySource: 'workspace',
        workspaceCreated: false,
      });
      expect(fabric.getCapacity).not.toHaveBeenCalled();
      expect(fabric.listCapacities).not.toHaveBeenCalled();
      expect(fabric.isWorkspaceAdmin).not.toHaveBeenCalled();
      expect(fabric.assignWorkspaceToCapacity).not.toHaveBeenCalled();
    }
  );

  it('maps a Fabric error code to its tenant state rather than to permissions', async () => {
    const fabric = fakeFabric({
      findTrialCapacity: vi
        .fn()
        .mockRejectedValue(new FabricError('forbidden', 403, 'TrialsDisabled')),
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      { fabric }
    );

    expect(result).toMatchObject({
      status: 'action-required',
      reason: 'trials_disabled',
      retryable: false,
    });
  });

  it('reports an expired Fabric session as an authentication problem', async () => {
    const fabric = fakeFabric({
      findTrialCapacity: vi
        .fn()
        .mockRejectedValue(new FabricError('unauthorized', 401)),
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      { fabric }
    );

    expect(result).toMatchObject({
      status: 'action-required',
      reason: 'fabric_authentication_required',
      retryable: true,
    });
  });

  it('rediscovers an existing trial instead of starting a second one', async () => {
    const trial = capacity('trial', { sku: 'FT1', type: 'Trial' });
    const fabric = fakeFabric({
      findTrialCapacity: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue(trial),
      checkTrialEligibility: vi
        .fn()
        .mockResolvedValue({ eligible: true, reason: 'Eligible' }),
      startTrial: vi
        .fn()
        .mockRejectedValue(
          new FabricError('trial exists', 400, 'TrialAlreadyExists')
        ),
      createWorkspace: vi.fn().mockResolvedValue(workspace('w-new')),
      getWorkspace: vi.fn().mockResolvedValue(
        workspace('w-new', {
          capacityId: 'trial',
          capacityAssignmentProgress: 'Completed',
        })
      ),
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      { fabric, polling: instantPolling }
    );

    expect(result).toMatchObject({
      status: 'ready',
      capacityId: 'trial',
      capacitySource: 'existing-trial',
    });
    expect(fabric.startTrial).toHaveBeenCalledOnce();
  });

  it('rediscovers a trial after Start Trial reports CapacityCreationFailure', async () => {
    const trial = capacity('trial', { sku: 'FT1', type: 'Trial' });
    const fabric = fakeFabric({
      findTrialCapacity: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue(trial),
      checkTrialEligibility: vi
        .fn()
        .mockResolvedValue({ eligible: true, reason: 'Eligible' }),
      startTrial: vi
        .fn()
        .mockRejectedValue(
          new FabricError(
            'capacity creation failed',
            500,
            'CapacityCreationFailure'
          )
        ),
      createWorkspace: vi.fn().mockResolvedValue(workspace('w-new')),
      getWorkspace: vi.fn().mockResolvedValue(
        workspace('w-new', {
          capacityId: 'trial',
          capacityAssignmentProgress: 'Completed',
        })
      ),
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      { fabric, polling: instantPolling }
    );

    expect(result).toMatchObject({
      status: 'ready',
      capacityId: 'trial',
      capacitySource: 'existing-trial',
    });
    expect(fabric.startTrial).toHaveBeenCalledOnce();
    expect(fabric.findTrialCapacity).toHaveBeenCalledTimes(3);
  });

  it('rediscovers the trial when eligibility reports TrialAlreadyExists', async () => {
    // The wire value is `TrialAlreadyExists` — Fabric maps its internal
    // `ActiveTrialExists` onto it before responding. Matching the internal
    // spelling here silently turned an already-entitled tenant into an
    // `ineligible_for_trial` failure, so this pins the public contract.
    const trial = capacity('trial', { sku: 'FT1', type: 'Trial' });
    const fabric = fakeFabric({
      findTrialCapacity: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue(trial),
      checkTrialEligibility: vi
        .fn()
        .mockResolvedValue({ eligible: false, reason: 'TrialAlreadyExists' }),
      createWorkspace: vi.fn().mockResolvedValue(workspace('w-new')),
      getWorkspace: vi.fn().mockResolvedValue(
        workspace('w-new', {
          capacityId: 'trial',
          capacityAssignmentProgress: 'Completed',
        })
      ),
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      { fabric, polling: instantPolling }
    );

    expect(result).toMatchObject({
      status: 'ready',
      capacityId: 'trial',
      capacitySource: 'existing-trial',
    });
    // Entitlement already granted: a second POST must never be attempted.
    expect(fabric.startTrial).not.toHaveBeenCalled();
    expect(fabric.findTrialCapacity).toHaveBeenCalledTimes(3);
  });

  it('retries transient capacity-list failures while awaiting an existing trial', async () => {
    const trial = capacity('trial', { sku: 'FT1', type: 'Trial' });
    const fabric = fakeFabric({
      findTrialCapacity: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new FabricError('throttled', 429, undefined, 0))
        .mockResolvedValue(trial),
      checkTrialEligibility: vi
        .fn()
        .mockResolvedValue({ eligible: false, reason: 'TrialAlreadyExists' }),
      createWorkspace: vi.fn().mockResolvedValue(workspace('w-new')),
      getWorkspace: vi.fn().mockResolvedValue(
        workspace('w-new', {
          capacityId: 'trial',
          capacityAssignmentProgress: 'Completed',
        })
      ),
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      { fabric, polling: instantPolling }
    );

    expect(result).toMatchObject({
      status: 'ready',
      capacityId: 'trial',
      capacitySource: 'existing-trial',
    });
    expect(fabric.findTrialCapacity).toHaveBeenCalledTimes(3);
  });

  it('honors assignment Retry-After before the first verification read', async () => {
    vi.useFakeTimers();
    try {
      const trial = capacity('trial', { sku: 'FT1', type: 'Trial' });
      const created = workspace('w-new');
      const getWorkspace = vi.fn().mockResolvedValue(
        workspace('w-new', {
          capacityId: trial.id,
          capacityAssignmentProgress: 'Completed',
        })
      );
      const fabric = fakeFabric({
        findTrialCapacity: vi.fn().mockResolvedValue(trial),
        createWorkspace: vi.fn().mockResolvedValue(created),
        assignWorkspaceToCapacity: vi
          .fn()
          .mockResolvedValue({ retryAfterMs: 5_000 }),
        getWorkspace,
      });

      const pending = ensureFabricTarget(
        { projectId: 'app', capacityAssignmentMode: 'automatic' },
        { fabric }
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(getWorkspace).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(4_999);
      expect(getWorkspace).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ status: 'ready' });
      expect(getWorkspace).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a created workspace when verification throws unexpectedly', async () => {
    const fabric = fakeFabric({
      findTrialCapacity: vi
        .fn()
        .mockResolvedValue(capacity('trial', { sku: 'FT1', type: 'Trial' })),
      createWorkspace: vi.fn().mockResolvedValue(workspace('w-new')),
      getWorkspace: vi.fn().mockRejectedValue(new Error('network down')),
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      { fabric, polling: instantPolling }
    );

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'workspace_assignment_failed',
    });
  });

  it('uses an existing trial capacity to create and assign a workspace', async () => {
    const created = workspace('w-new');
    const assigned = workspace('w-new', {
      capacityId: 'trial',
      capacityAssignmentProgress: 'Completed',
    });
    const fabric = fakeFabric({
      findTrialCapacity: vi
        .fn()
        .mockResolvedValue(capacity('trial', { sku: 'FT1', type: 'Trial' })),
      createWorkspace: vi.fn().mockResolvedValue(created),
      getWorkspace: vi.fn().mockResolvedValue(assigned),
    });
    const log = vi.fn();

    const result = await ensureFabricTarget(
      {
        projectId: 'my-app',
        capacityAssignmentMode: 'automatic',
      },
      {
        fabric,
        logger: { log, warn: vi.fn(), error: vi.fn() },
      }
    );

    expect(result).toMatchObject({
      status: 'ready',
      capacityId: 'trial',
      capacitySource: 'existing-trial',
      workspaceCreated: true,
    });
    expect(fabric.createWorkspace).toHaveBeenCalledWith(
      expect.stringMatching(/^my-app-\d{8}-\d{9}-[a-f0-9]{8}$/)
    );
    expect(fabric.assignWorkspaceToCapacity).toHaveBeenCalledWith(
      'w-new',
      'trial'
    );
    expect(fabric.checkTrialEligibility).not.toHaveBeenCalled();
    expect(log).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('Created Fabric workspace "w-new".')
    );
    expect(log).toHaveBeenNthCalledWith(
      2,
      'Assigned Fabric workspace "w-new" to capacity "trial".'
    );
  });

  it('starts a trial when no valid capacity exists', async () => {
    const trial = capacity('trial', { sku: 'FT1', type: 'Trial' });
    const created = workspace('w-new');
    const assigned = workspace('w-new', {
      capacityId: 'trial',
      capacityAssignmentProgress: 'Completed',
    });
    const fabric = fakeFabric({
      listCapacities: vi
        .fn()
        .mockResolvedValue([
          capacity('too-small', { sku: 'F1' }),
          capacity('unsupported-premium', { sku: 'P6' }),
          capacity('paused', { sku: 'F2', state: 'Paused' }),
        ]),
      findTrialCapacity: vi.fn().mockResolvedValue(undefined),
      checkTrialEligibility: vi
        .fn()
        .mockResolvedValue({ eligible: true, reason: 'Eligible' }),
      startTrial: vi.fn().mockResolvedValue({
        operationId: 'op1',
        operationLocation: 'https://fabric.test/operations/op1',
      }),
      getOperationStatus: vi.fn().mockResolvedValue({ status: 'Succeeded' }),
      getOperationResult: vi.fn().mockResolvedValue(trial),
      createWorkspace: vi.fn().mockResolvedValue(created),
      getWorkspace: vi.fn().mockResolvedValue(assigned),
    });
    const log = vi.fn();

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      {
        fabric,
        logger: { log, warn: vi.fn(), error: vi.fn() },
      }
    );

    expect(result).toMatchObject({
      status: 'ready',
      capacityId: 'trial',
      capacitySource: 'new-trial',
    });
    expect(fabric.checkTrialEligibility).toHaveBeenCalledOnce();
    expect(fabric.startTrial).toHaveBeenCalledOnce();
    expect(fabric.getOperationStatus).toHaveBeenCalledWith(
      'https://fabric.test/operations/op1',
      'op1'
    );
    expect(log).toHaveBeenNthCalledWith(
      1,
      'Created Fabric trial capacity "trial".'
    );
    expect(log).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('Created Fabric workspace "w-new".')
    );
    expect(log).toHaveBeenNthCalledWith(
      3,
      'Assigned Fabric workspace "w-new" to capacity "trial".'
    );
  });

  it('unwraps the capacity envelope Fabric returns for a provisioned trial', async () => {
    // Fabric answers Start Trial's operation result with the capacity wrapped
    // in an envelope. Assigning that envelope straight into a FabricCapacity
    // leaves `state` undefined, which crashed the usability check.
    const trial = capacity('trial', {
      sku: 'FTL64',
      type: 'FabricTrialCapacity',
    });
    const created = workspace('w-new');
    const assigned = workspace('w-new', {
      capacityId: 'trial',
      capacityAssignmentProgress: 'Completed',
    });
    const fabric = fakeFabric({
      findTrialCapacity: vi.fn().mockResolvedValue(undefined),
      checkTrialEligibility: vi
        .fn()
        .mockResolvedValue({ eligible: true, reason: 'Eligible' }),
      startTrial: vi.fn().mockResolvedValue({
        operationId: 'op1',
        operationLocation: 'https://fabric.test/operations/op1',
      }),
      getOperationStatus: vi.fn().mockResolvedValue({ status: 'Succeeded' }),
      getOperationResult: vi.fn().mockResolvedValue({ capacity: trial }),
      createWorkspace: vi.fn().mockResolvedValue(created),
      getWorkspace: vi.fn().mockResolvedValue(assigned),
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      { fabric }
    );

    expect(result).toMatchObject({
      status: 'ready',
      capacityId: 'trial',
      capacitySource: 'new-trial',
    });
  });

  it('waits the throttle hint Fabric sends when a trial poll is rate limited', async () => {
    // A 429 states exactly when the caller may return. Retrying on local
    // backoff instead polls straight back into the throttle.
    const trial = capacity('trial', { sku: 'FTL64' });
    const created = workspace('w-new');
    const assigned = workspace('w-new', {
      capacityId: 'trial',
      capacityAssignmentProgress: 'Completed',
    });
    const throttled = new FabricError('too many requests', 429, undefined, 80);
    const fabric = fakeFabric({
      findTrialCapacity: vi.fn().mockResolvedValue(undefined),
      checkTrialEligibility: vi
        .fn()
        .mockResolvedValue({ eligible: true, reason: 'Eligible' }),
      startTrial: vi.fn().mockResolvedValue({
        operationId: 'op1',
        operationLocation: 'https://fabric.test/operations/op1',
      }),
      getOperationStatus: vi
        .fn()
        .mockRejectedValueOnce(throttled)
        .mockResolvedValue({ status: 'Succeeded' }),
      getOperationResult: vi.fn().mockResolvedValue({ capacity: trial }),
      createWorkspace: vi.fn().mockResolvedValue(created),
      getWorkspace: vi.fn().mockResolvedValue(assigned),
    });

    const startedAt = Date.now();
    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      { fabric, polling: instantPolling }
    );

    // Local pacing is zero here, so any wait at all came from the hint.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60);
    expect(result).toMatchObject({ status: 'ready', capacityId: 'trial' });
    expect(fabric.getOperationStatus).toHaveBeenCalledTimes(2);
  });

  it('treats a trial rediscovered after a failed operation as existing', async () => {
    const trial = capacity('trial', { sku: 'FT1', type: 'Trial' });
    const fabric = fakeFabric({
      findTrialCapacity: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue(trial),
      checkTrialEligibility: vi
        .fn()
        .mockResolvedValue({ eligible: true, reason: 'Eligible' }),
      startTrial: vi.fn().mockResolvedValue({
        operationId: 'op1',
        operationLocation: 'https://fabric.test/operations/op1',
      }),
      getOperationStatus: vi.fn().mockResolvedValue({ status: 'Failed' }),
      createWorkspace: vi.fn().mockResolvedValue(workspace('w-new')),
      getWorkspace: vi.fn().mockResolvedValue(
        workspace('w-new', {
          capacityId: 'trial',
          capacityAssignmentProgress: 'Completed',
        })
      ),
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      { fabric, polling: instantPolling }
    );

    expect(result).toMatchObject({
      status: 'ready',
      capacityId: 'trial',
      capacitySource: 'existing-trial',
    });
  });

  it.each(['Canceled', 'Cancelled'] as const)(
    'treats a %s trial operation as terminal',
    async (status) => {
      const fabric = fakeFabric({
        findTrialCapacity: vi.fn().mockResolvedValue(undefined),
        checkTrialEligibility: vi
          .fn()
          .mockResolvedValue({ eligible: true, reason: 'Eligible' }),
        startTrial: vi.fn().mockResolvedValue({
          operationId: 'op1',
          operationLocation: 'https://fabric.test/operations/op1',
        }),
        getOperationStatus: vi.fn().mockResolvedValue({ status }),
      });

      const result = await ensureFabricTarget(
        { projectId: 'app', capacityAssignmentMode: 'automatic' },
        { fabric, polling: instantPolling }
      );

      expect(result).toMatchObject({
        status: 'failed',
        reason: 'trial_provisioning_failed',
      });
      expect(fabric.getOperationStatus).toHaveBeenCalledOnce();
    }
  );

  it('keeps polling an assignment through a transient read failure', async () => {
    // The assignment runs service-side whether or not this read succeeds, so
    // a faulted poll must not roll back a workspace about to become ready.
    const trial = capacity('trial', { sku: 'FTL64' });
    const created = workspace('w-new');
    const assigned = workspace('w-new', {
      capacityId: 'trial',
      capacityAssignmentProgress: 'Completed',
    });
    const fabric = fakeFabric({
      findTrialCapacity: vi.fn().mockResolvedValue(trial),
      createWorkspace: vi.fn().mockResolvedValue(created),
      getWorkspace: vi
        .fn()
        .mockRejectedValueOnce(new FabricError('server error', 503))
        .mockResolvedValue(assigned),
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      { fabric, polling: instantPolling }
    );

    expect(result).toMatchObject({ status: 'ready', capacityId: 'trial' });
    expect(fabric.getWorkspace).toHaveBeenCalledTimes(2);
  });

  it('reports a problem when the trial operation result carries no capacity', async () => {
    const created = workspace('w-new');
    const fabric = fakeFabric({
      findTrialCapacity: vi.fn().mockResolvedValue(undefined),
      checkTrialEligibility: vi
        .fn()
        .mockResolvedValue({ eligible: true, reason: 'Eligible' }),
      startTrial: vi.fn().mockResolvedValue({
        operationId: 'op1',
        operationLocation: 'https://fabric.test/operations/op1',
      }),
      getOperationStatus: vi.fn().mockResolvedValue({ status: 'Succeeded' }),
      getOperationResult: vi.fn().mockResolvedValue({}),
      createWorkspace: vi.fn().mockResolvedValue(created),
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      { fabric }
    );

    expect(result).toMatchObject({ reason: 'capacity_not_usable' });
  });

  it('accepts a provisioned trial whose SKU the allowlist does not know', async () => {
    // Fabric handed this back from Start Trial, so provenance settles that it
    // is a trial; re-classifying it would fail a run that fully succeeded.
    const trial = capacity('trial', { sku: 'FTL8' });
    const created = workspace('w-new');
    const assigned = workspace('w-new', {
      capacityId: 'trial',
      capacityAssignmentProgress: 'Completed',
    });
    const fabric = fakeFabric({
      findTrialCapacity: vi.fn().mockResolvedValue(undefined),
      checkTrialEligibility: vi
        .fn()
        .mockResolvedValue({ eligible: true, reason: 'Eligible' }),
      startTrial: vi.fn().mockResolvedValue({
        operationId: 'op1',
        operationLocation: 'https://fabric.test/operations/op1',
      }),
      getOperationStatus: vi.fn().mockResolvedValue({ status: 'Succeeded' }),
      getOperationResult: vi.fn().mockResolvedValue(trial),
      createWorkspace: vi.fn().mockResolvedValue(created),
      getWorkspace: vi.fn().mockResolvedValue(assigned),
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      { fabric }
    );

    expect(result).toMatchObject({
      status: 'ready',
      capacityId: 'trial',
      capacitySource: 'new-trial',
    });
  });

  it('reports a provisioned trial that is not yet active', async () => {
    const trial = capacity('trial', { sku: 'FT1', state: 'Provisioning' });
    const fabric = fakeFabric({
      findTrialCapacity: vi.fn().mockResolvedValue(undefined),
      checkTrialEligibility: vi
        .fn()
        .mockResolvedValue({ eligible: true, reason: 'Eligible' }),
      startTrial: vi.fn().mockResolvedValue({
        operationId: 'op1',
        operationLocation: 'https://fabric.test/operations/op1',
      }),
      getOperationStatus: vi.fn().mockResolvedValue({ status: 'Succeeded' }),
      getOperationResult: vi.fn().mockResolvedValue(trial),
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      { fabric }
    );

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'capacity_not_usable',
      retryable: true,
    });
    expect(fabric.createWorkspace).not.toHaveBeenCalled();
  });

  it('activates a trial before creating and assigning a workspace', async () => {
    const trial = capacity('trial', { sku: 'FT1', type: 'Trial' });
    const created = workspace('w-new');
    const assigned = workspace('w-new', {
      capacityId: 'trial',
      capacityAssignmentProgress: 'Completed',
    });
    const fabric = fakeFabric({
      checkTrialEligibility: vi
        .fn()
        .mockResolvedValue({ eligible: true, reason: 'Eligible' }),
      startTrial: vi.fn().mockResolvedValue({
        operationId: 'op1',
        operationLocation: 'https://fabric.test/operations/op1',
      }),
      getOperationStatus: vi.fn().mockResolvedValue({ status: 'Succeeded' }),
      getOperationResult: vi.fn().mockResolvedValue(trial),
      createWorkspace: vi.fn().mockResolvedValue(created),
      getWorkspace: vi.fn().mockResolvedValue(assigned),
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      { fabric }
    );

    expect(result).toMatchObject({
      status: 'ready',
      capacityId: 'trial',
      capacitySource: 'new-trial',
    });
    expect(fabric.startTrial).toHaveBeenCalledOnce();
    expect(
      vi.mocked(fabric.checkTrialEligibility).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(fabric.startTrial).mock.invocationCallOrder[0]);
    expect(
      vi.mocked(fabric.startTrial).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(fabric.createWorkspace).mock.invocationCallOrder[0]
    );
    expect(fabric.assignWorkspaceToCapacity).toHaveBeenCalledWith(
      'w-new',
      'trial'
    );
  });

  it('narrates every phase of a full provisioning run', async () => {
    const trial = capacity('trial', { sku: 'FT1', type: 'Trial' });
    const created = workspace('w-new');
    const fabric = fakeFabric({
      checkTrialEligibility: vi
        .fn()
        .mockResolvedValue({ eligible: true, reason: 'Eligible' }),
      startTrial: vi.fn().mockResolvedValue({
        operationId: 'op1',
        operationLocation: 'https://fabric.test/operations/op1',
      }),
      getOperationStatus: vi
        .fn()
        .mockResolvedValueOnce({ status: 'Running', percentComplete: 0 })
        .mockResolvedValue({ status: 'Succeeded' }),
      getOperationResult: vi.fn().mockResolvedValue(trial),
      createWorkspace: vi.fn().mockResolvedValue(created),
      getWorkspace: vi.fn().mockResolvedValue(
        workspace('w-new', {
          capacityId: 'trial',
          capacityAssignmentProgress: 'Completed',
        })
      ),
    });
    const progress = { report: vi.fn() };

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      { fabric, progress }
    );

    expect(result.status).toBe('ready');
    // Provisioning a trial is the slowest thing `up` does; silence here reads
    // as a hang, so each phase has to announce itself as it starts.
    expect(progress.report.mock.calls.map(([update]) => update.phase)).toEqual([
      'capacity',
      'trial',
      'trial',
      'workspace',
      'assignment',
    ]);
    for (const [update] of progress.report.mock.calls) {
      expect(update.message).toBeTruthy();
    }
  });

  // Fabric holds trial provisioning at 0% for the whole run, so a rendered
  // percentage would sit frozen for up to ten minutes and read as a hang. No
  // timing is shown either — the animated spinner is the liveness signal, and
  // the phase transitions carry the progress.
  it('never reports a percentage, even when Fabric sends one', async () => {
    const trial = capacity('trial', { sku: 'FT1', type: 'Trial' });
    const fabric = fakeFabric({
      checkTrialEligibility: vi
        .fn()
        .mockResolvedValue({ eligible: true, reason: 'Eligible' }),
      startTrial: vi.fn().mockResolvedValue({
        operationId: 'op1',
        operationLocation: 'https://fabric.test/operations/op1',
      }),
      getOperationStatus: vi
        .fn()
        .mockResolvedValueOnce({ status: 'Running', percentComplete: 0 })
        .mockResolvedValue({ status: 'Succeeded' }),
      getOperationResult: vi.fn().mockResolvedValue(trial),
      createWorkspace: vi.fn().mockResolvedValue(workspace('w-new')),
      getWorkspace: vi.fn().mockResolvedValue(
        workspace('w-new', {
          capacityId: 'trial',
          capacityAssignmentProgress: 'Completed',
        })
      ),
    });
    const progress = { report: vi.fn() };

    await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      { fabric, progress }
    );

    expect(progress.report).toHaveBeenCalled();
    for (const [update] of progress.report.mock.calls) {
      expect(update.percent).toBeUndefined();
    }
  });

  it('requires workspace Admin before selecting capacity for an unassigned workspace', async () => {
    const existing = workspace('existing');
    const fabric = fakeFabric({
      getWorkspace: vi.fn().mockResolvedValue(existing),
      isWorkspaceAdmin: vi.fn().mockResolvedValue(false),
    });

    const result = await ensureFabricTarget(
      {
        projectId: 'app',
        capacityAssignmentMode: 'automatic',
        workspaceId: 'existing',
      },
      { fabric }
    );

    expect(result).toEqual({
      status: 'action-required',
      reason: 'workspace_admin_required',
      message:
        'Workspace Admin permission is required to assign capacity to "existing".',
      retryable: false,
    });
    expect(fabric.isWorkspaceAdmin).toHaveBeenCalledWith('existing');
    expect(fabric.checkTrialEligibility).not.toHaveBeenCalled();
    expect(fabric.startTrial).not.toHaveBeenCalled();
    expect(fabric.assignWorkspaceToCapacity).not.toHaveBeenCalled();
  });

  it('keeps a workspace created by this invocation when verification fails', async () => {
    const created = workspace('w-new');
    const failed = workspace('w-new', {
      capacityAssignmentProgress: 'Failed',
    });
    const fabric = fakeFabric({
      findTrialCapacity: vi
        .fn()
        .mockResolvedValue(capacity('trial', { sku: 'FT1', type: 'Trial' })),
      createWorkspace: vi.fn().mockResolvedValue(created),
      getWorkspace: vi.fn().mockResolvedValue(failed),
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      { fabric }
    );

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'workspace_assignment_failed',
    });
  });

  it('keeps a newly created workspace when capacity assignment fails', async () => {
    const log = vi.fn();
    const fabric = fakeFabric({
      findTrialCapacity: vi
        .fn()
        .mockResolvedValue(capacity('trial', { sku: 'FT1', type: 'Trial' })),
      createWorkspace: vi.fn().mockResolvedValue(workspace('w-new')),
      assignWorkspaceToCapacity: vi
        .fn()
        .mockRejectedValue(new Error('assignment denied')),
    });

    const result = await ensureFabricTarget(
      { projectId: 'app', capacityAssignmentMode: 'automatic' },
      {
        fabric,
        logger: { log, warn: vi.fn(), error: vi.fn() },
      }
    );

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'workspace_assignment_failed',
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Created Fabric workspace "w-new".')
    );
  });
});
