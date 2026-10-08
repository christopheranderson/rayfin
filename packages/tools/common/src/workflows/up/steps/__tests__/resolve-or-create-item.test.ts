import { describe, expect, it, vi } from 'vitest';

import type { UserInteraction } from '../../../../adapters/index.js';
import {
  FabricError,
  type FabricClient,
  type FabricItem,
} from '../../../../external/fabric/index.js';
import { resolveOrCreateItem } from '../resolve-or-create-item.js';

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

function fakeUi(confirmValue: boolean): UserInteraction {
  return {
    prompt: vi.fn(),
    confirm: vi.fn().mockResolvedValue(confirmValue),
    select: vi.fn(),
  };
}

const item = (id: string, displayName: string): FabricItem => ({
  id,
  displayName,
  type: 'AppBackend',
  workspaceId: 'ws-1',
});

const input = {
  workspaceId: 'ws-1',
  displayName: 'my-app',
  workspaceDisplayName: 'My Workspace',
};

describe('resolveOrCreateItem', () => {
  it('creates a new item when no same-named item exists', async () => {
    const created = item('new-id', 'my-app');
    const createItem = vi.fn().mockResolvedValue(created);
    const fabric = fakeFabric({
      getItemByName: vi.fn().mockResolvedValue(undefined),
      createItem,
    });
    const ui = fakeUi(true);

    const result = await resolveOrCreateItem(input, { fabric, ui });

    expect(createItem).toHaveBeenCalledWith('ws-1', 'my-app');
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'resolved',
      item: created,
      created: true,
    });
  });

  it('creates even when autoConfirmReuse is set if no item exists', async () => {
    const created = item('new-id', 'my-app');
    const fabric = fakeFabric({
      getItemByName: vi.fn().mockResolvedValue(undefined),
      createItem: vi.fn().mockResolvedValue(created),
    });

    const result = await resolveOrCreateItem(
      { ...input, autoConfirmReuse: true },
      { fabric }
    );

    expect(result).toEqual({
      status: 'resolved',
      item: created,
      created: true,
    });
  });

  it('reuses an existing item without prompting when autoConfirmReuse is set', async () => {
    const existing = item('existing-id', 'my-app');
    const createItem = vi.fn();
    const fabric = fakeFabric({
      getItemByName: vi.fn().mockResolvedValue(existing),
      createItem,
    });
    const ui = fakeUi(false);

    const result = await resolveOrCreateItem(
      { ...input, autoConfirmReuse: true },
      { fabric, ui }
    );

    expect(ui.confirm).not.toHaveBeenCalled();
    expect(createItem).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'resolved',
      item: existing,
      created: false,
    });
  });

  it('prompts and reuses the existing item when the user confirms', async () => {
    const existing = item('existing-id', 'my-app');
    const fabric = fakeFabric({
      getItemByName: vi.fn().mockResolvedValue(existing),
    });
    const ui = fakeUi(true);

    const result = await resolveOrCreateItem(input, { fabric, ui });

    expect(ui.confirm).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: 'resolved',
      item: existing,
      created: false,
    });
  });

  it('returns reuse-declined when the user declines the prompt', async () => {
    const existing = item('existing-id', 'my-app');
    const createItem = vi.fn();
    const fabric = fakeFabric({
      getItemByName: vi.fn().mockResolvedValue(existing),
      createItem,
    });
    const ui = fakeUi(false);

    const result = await resolveOrCreateItem(input, { fabric, ui });

    expect(createItem).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'reuse-declined' });
  });

  it('returns reuse-required when reuse needs consent but no ui is wired', async () => {
    const existing = item('existing-id', 'my-app');
    const fabric = fakeFabric({
      getItemByName: vi.fn().mockResolvedValue(existing),
    });

    await expect(resolveOrCreateItem(input, { fabric })).resolves.toEqual({
      status: 'reuse-required',
      item: existing,
    });
  });

  it('falls back to a default workspace label when no display name is provided', async () => {
    const existing = item('existing-id', 'my-app');
    const fabric = fakeFabric({
      getItemByName: vi.fn().mockResolvedValue(existing),
    });

    const ui = fakeUi(false);
    const result = await resolveOrCreateItem(
      { workspaceId: 'ws-1', displayName: 'my-app' },
      { fabric, ui }
    );

    expect(result).toEqual({ status: 'reuse-declined' });
    expect(ui.confirm).toHaveBeenCalledWith(
      expect.stringContaining('the target workspace'),
      { default: false }
    );
  });

  it('propagates a Fabric API failure from getItemByName', async () => {
    const boom = new Error('fabric 500');
    const fabric = fakeFabric({
      getItemByName: vi.fn().mockRejectedValue(boom),
    });

    await expect(
      resolveOrCreateItem(input, { fabric, ui: fakeUi(true) })
    ).rejects.toBe(boom);
  });

  it('returns capacity-exhausted when Fabric rejects item creation at the capacity limit', async () => {
    const boom = new FabricError(
      'Create item failed: 429',
      429,
      'CapacityLimitExceeded'
    );
    const fabric = fakeFabric({
      getItemByName: vi.fn().mockResolvedValue(undefined),
      createItem: vi.fn().mockRejectedValue(boom),
    });

    await expect(resolveOrCreateItem(input, { fabric })).resolves.toEqual({
      status: 'capacity-exhausted',
      cause: boom,
    });
  });

  it('propagates unrelated structured Fabric API failures from createItem', async () => {
    const boom = new FabricError(
      'Create item failed: 500',
      500,
      'InternalError'
    );
    const fabric = fakeFabric({
      getItemByName: vi.fn().mockResolvedValue(undefined),
      createItem: vi.fn().mockRejectedValue(boom),
    });

    await expect(resolveOrCreateItem(input, { fabric })).rejects.toBe(boom);
  });
});
