import { describe, it, expect, vi, beforeEach } from 'vitest';

import * as rayfinItemModule from '../../services/fabric/rayfin-item.js';
import { resolveItemIdByName } from '../resolve-item-name.js';

vi.mock('../../services/fabric/rayfin-item.js');

const listItemsMock = vi.fn();

describe('resolveItemIdByName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listItemsMock.mockReset();
    vi.spyOn(rayfinItemModule, 'RayfinItemManager').mockImplementation(
      () =>
        ({
          listItems: listItemsMock,
        }) as unknown as rayfinItemModule.RayfinItemManager
    );
  });

  it('throws when name is empty', async () => {
    await expect(
      resolveItemIdByName('ws-1', '   ', { token: 't' })
    ).rejects.toThrow(/--item value is empty/);
  });

  it('passes the type filter through to listItems', async () => {
    listItemsMock.mockResolvedValue([
      { id: 'item-1', displayName: 'Sales DB', type: 'SQLDatabase' },
    ]);
    await resolveItemIdByName('ws-1', 'Sales DB', {
      token: 'tok',
      type: 'SQLDatabase',
    });
    expect(listItemsMock).toHaveBeenCalledWith('ws-1', 'SQLDatabase');
  });

  it('returns the item on a case-sensitive exact match', async () => {
    listItemsMock.mockResolvedValue([
      { id: 'item-1', displayName: 'Sales DB', type: 'SQLDatabase' },
      { id: 'item-2', displayName: 'Other DB', type: 'SQLDatabase' },
    ]);
    const result = await resolveItemIdByName('ws-1', 'Sales DB', {
      token: 'tok',
    });
    expect(result).toEqual({
      id: 'item-1',
      displayName: 'Sales DB',
      type: 'SQLDatabase',
    });
  });

  it('falls back to a case-insensitive match when exact misses', async () => {
    listItemsMock.mockResolvedValue([
      { id: 'item-1', displayName: 'Sales DB', type: 'SQLDatabase' },
    ]);
    const result = await resolveItemIdByName('ws-1', 'sales db', {
      token: 'tok',
    });
    expect(result).toEqual({
      id: 'item-1',
      displayName: 'Sales DB',
      type: 'SQLDatabase',
    });
  });

  it('falls back to a normalized match ignoring dashes/underscores/punctuation', async () => {
    listItemsMock.mockResolvedValue([
      { id: 'item-1', displayName: 'Test-Wk-1', type: 'Lakehouse' },
    ]);
    const result = await resolveItemIdByName('ws-1', 'test--wk?1', {
      token: 'tok',
    });
    expect(result).toEqual({
      id: 'item-1',
      displayName: 'Test-Wk-1',
      type: 'Lakehouse',
    });
  });

  it('preserves Unicode letters when matching normalized names', async () => {
    listItemsMock.mockResolvedValue([
      { id: 'item-1', displayName: 'Ω-mega', type: 'Lakehouse' },
    ]);
    const result = await resolveItemIdByName('ws-1', 'Ωmega', {
      token: 'tok',
    });
    expect(result.id).toBe('item-1');
  });

  it('does not resolve a different non-ASCII item through an empty normalized name', async () => {
    listItemsMock.mockResolvedValue([
      { id: 'item-1', displayName: '東京', type: 'Lakehouse' },
    ]);
    await expect(
      resolveItemIdByName('ws-1', '北京', { token: 'tok' })
    ).rejects.toThrow('Item "北京" not found in this workspace.');
  });

  it('does not fuzzy-match punctuation-only item names', async () => {
    listItemsMock.mockResolvedValue([
      { id: 'item-1', displayName: '---', type: 'Lakehouse' },
    ]);
    await expect(
      resolveItemIdByName('ws-1', '???', { token: 'tok' })
    ).rejects.toThrow('Item "???" not found in this workspace.');
  });

  it('throws on multiple normalized matches', async () => {
    listItemsMock.mockResolvedValue([
      { id: 'item-1', displayName: 'test-wk-1', type: 'Lakehouse' },
      { id: 'item-2', displayName: 'test--wk1', type: 'Lakehouse' },
    ]);
    await expect(
      resolveItemIdByName('ws-1', 'testwk1', { token: 'tok' })
    ).rejects.toThrow(/Multiple items match "testwk1"/);
  });

  it('throws a type-aware message when nothing matches and a type filter was applied', async () => {
    listItemsMock.mockResolvedValue([]);
    await expect(
      resolveItemIdByName('ws-1', 'Nonexistent', {
        token: 'tok',
        type: 'Warehouse',
      })
    ).rejects.toThrow(
      'Item "Nonexistent" not found in this workspace (filtered to type Warehouse).'
    );
  });
});
