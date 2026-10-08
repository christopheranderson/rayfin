import { describe, expect, it, vi } from 'vitest';

import type {
  FabricClient,
  FabricWorkspace,
} from '../../../../external/fabric/index.js';
import { resolveWorkspace } from '../resolve-workspace.js';

function fakeFabric(overrides: Partial<FabricClient> = {}): FabricClient {
  return {
    findTrialCapacity: vi.fn().mockResolvedValue(undefined),
    listCapacities: vi.fn().mockResolvedValue([]),
    getCapacity: vi.fn(),
    checkTrialEligibility: vi.fn(),
    startTrial: vi.fn(),
    getOperationStatus: vi.fn(),
    getOperationResult: vi.fn(),
    listWorkspaces: vi.fn().mockResolvedValue([]),
    isWorkspaceAdmin: vi.fn().mockResolvedValue(true),
    getWorkspace: vi.fn(),
    createWorkspace: vi.fn(),
    assignWorkspaceToCapacity: vi.fn(),
    getItemByName: vi.fn().mockResolvedValue(undefined),
    createItem: vi.fn(),
    ...overrides,
  };
}

const ws = (id: string, displayName: string): FabricWorkspace => ({
  id,
  displayName,
});

describe('resolveWorkspace', () => {
  it('fetches by id when a workspaceId is provided', async () => {
    const target = ws('id-1', 'Anything');
    const getWorkspace = vi.fn().mockResolvedValue(target);
    const fabric = fakeFabric({ getWorkspace });

    const result = await resolveWorkspace({ workspaceId: 'id-1' }, { fabric });

    expect(getWorkspace).toHaveBeenCalledWith('id-1');
    expect(fabric.listWorkspaces).not.toHaveBeenCalled();
    expect(result).toBe(target);
  });

  it('prefers the id even when a name is also supplied', async () => {
    const target = ws('id-1', 'By Id');
    const fabric = fakeFabric({
      getWorkspace: vi.fn().mockResolvedValue(target),
    });

    const result = await resolveWorkspace(
      { workspaceId: 'id-1', workspaceName: 'By Name' },
      { fabric }
    );

    expect(result).toBe(target);
    expect(fabric.listWorkspaces).not.toHaveBeenCalled();
  });

  it('propagates a Fabric API failure from getWorkspace', async () => {
    const boom = new Error('fabric 500');
    const fabric = fakeFabric({
      getWorkspace: vi.fn().mockRejectedValue(boom),
    });

    await expect(
      resolveWorkspace({ workspaceId: 'id-x' }, { fabric })
    ).rejects.toBe(boom);
  });

  it('resolves a case-sensitive exact name match over a case-only collision', async () => {
    const target = ws('id-2', 'My Space');
    const fabric = fakeFabric({
      listWorkspaces: vi
        .fn()
        .mockResolvedValue([ws('id-1', 'my space'), target]),
    });

    const result = await resolveWorkspace(
      { workspaceName: 'My Space' },
      { fabric }
    );

    expect(result).toBe(target);
  });

  it('falls back to a single case-insensitive match', async () => {
    const target = ws('id-3', 'Data Team');
    const fabric = fakeFabric({
      listWorkspaces: vi.fn().mockResolvedValue([target]),
      isWorkspaceAdmin: vi.fn().mockResolvedValue(true),
    });

    const result = await resolveWorkspace(
      { workspaceName: 'data team' },
      { fabric }
    );

    expect(result).toBe(target);
  });

  it('trims the provided name before matching', async () => {
    const target = ws('id-4', 'Trimmed');
    const fabric = fakeFabric({
      listWorkspaces: vi.fn().mockResolvedValue([target]),
      isWorkspaceAdmin: vi.fn().mockResolvedValue(true),
    });

    const result = await resolveWorkspace(
      { workspaceName: '  Trimmed  ' },
      { fabric }
    );

    expect(result).toBe(target);
  });

  it('propagates a Fabric API failure from listWorkspaces', async () => {
    const boom = new Error('fabric 500');
    const fabric = fakeFabric({
      listWorkspaces: vi.fn().mockRejectedValue(boom),
      isWorkspaceAdmin: vi.fn().mockResolvedValue(true),
    });

    await expect(
      resolveWorkspace({ workspaceName: 'Anything' }, { fabric })
    ).rejects.toBe(boom);
  });

  it('throws on multiple case-sensitive matches, listing ids', async () => {
    const fabric = fakeFabric({
      listWorkspaces: vi
        .fn()
        .mockResolvedValue([ws('id-a', 'Dup'), ws('id-b', 'Dup')]),
    });

    await expect(
      resolveWorkspace({ workspaceName: 'Dup' }, { fabric })
    ).rejects.toThrow(
      'Multiple workspaces match "Dup" exactly. Pass --workspace-id <guid> to disambiguate. Matching IDs:\n  - id-a\n  - id-b'
    );
  });

  it('throws on multiple case-insensitive matches, listing candidates', async () => {
    const fabric = fakeFabric({
      listWorkspaces: vi
        .fn()
        .mockResolvedValue([ws('id-a', 'Team'), ws('id-b', 'team')]),
    });

    await expect(
      resolveWorkspace({ workspaceName: 'TEAM' }, { fabric })
    ).rejects.toThrow(
      'Multiple workspaces match "TEAM" (case-insensitive). Pass --workspace-id <guid> to disambiguate. Candidates:\n  - "Team" (id-a)\n  - "team" (id-b)'
    );
  });

  it('throws a user-actionable error when no workspace matches', async () => {
    const fabric = fakeFabric({
      listWorkspaces: vi.fn().mockResolvedValue([ws('id-a', 'Other')]),
      isWorkspaceAdmin: vi.fn().mockResolvedValue(true),
    });

    await expect(
      resolveWorkspace({ workspaceName: 'Missing' }, { fabric })
    ).rejects.toThrow(
      'Workspace "Missing" not found. Please retry with a valid workspace name.'
    );
  });

  it('throws when neither id nor name is provided', async () => {
    const fabric = fakeFabric();

    await expect(resolveWorkspace({}, { fabric })).rejects.toThrow(
      /requires a workspace id or name/
    );
    expect(fabric.listWorkspaces).not.toHaveBeenCalled();
  });

  it('throws when the name is blank after trimming', async () => {
    const fabric = fakeFabric();

    await expect(
      resolveWorkspace({ workspaceName: '   ' }, { fabric })
    ).rejects.toThrow('--workspace value is empty.');
    expect(fabric.listWorkspaces).not.toHaveBeenCalled();
  });
});
