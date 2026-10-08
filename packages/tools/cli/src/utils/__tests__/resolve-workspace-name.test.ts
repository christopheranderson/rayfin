/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, vi, beforeEach } from 'vitest';

import * as workspaceModule from '../../services/fabric/workspace.js';
import {
  resolveWorkspaceIdByName,
  resolveWorkspaceIdByNameFuzzy,
} from '../resolve-workspace-name.js';

vi.mock('../../services/fabric/workspace.js');

const listWorkspacesMock = vi.fn();

describe('resolveWorkspaceIdByName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listWorkspacesMock.mockReset();
    // Stub WorkspaceManager so each test controls listWorkspaces() output.
    vi.spyOn(workspaceModule, 'WorkspaceManager').mockImplementation(
      () =>
        ({
          listWorkspaces: listWorkspacesMock,
        }) as unknown as workspaceModule.WorkspaceManager
    );
  });

  it('throws when name is empty', async () => {
    await expect(
      resolveWorkspaceIdByName('   ', { token: 't' })
    ).rejects.toThrow(/--workspace value is empty/);
    expect(listWorkspacesMock).not.toHaveBeenCalled();
  });

  it('returns the workspace on a case-sensitive exact match', async () => {
    listWorkspacesMock.mockResolvedValue([
      { id: 'id-1', displayName: 'My Workspace' },
      { id: 'id-2', displayName: 'Other Workspace' },
    ]);
    const result = await resolveWorkspaceIdByName('My Workspace', {
      token: 'tok',
    });
    expect(result).toEqual({ id: 'id-1', displayName: 'My Workspace' });
  });

  it('falls back to a case-insensitive match when exact misses', async () => {
    listWorkspacesMock.mockResolvedValue([
      { id: 'id-1', displayName: 'My Workspace' },
    ]);
    const result = await resolveWorkspaceIdByName('my workspace', {
      token: 'tok',
    });
    expect(result).toEqual({ id: 'id-1', displayName: 'My Workspace' });
  });

  it('throws on multiple case-insensitive matches with disambiguation hint', async () => {
    listWorkspacesMock.mockResolvedValue([
      { id: 'id-1', displayName: 'Work Space' },
      { id: 'id-2', displayName: 'work space' },
    ]);
    await expect(
      resolveWorkspaceIdByName('WORK SPACE', { token: 'tok' })
    ).rejects.toThrow(/Multiple workspaces match/);
  });

  it('throws on multiple case-sensitive exact matches', async () => {
    listWorkspacesMock.mockResolvedValue([
      { id: 'id-1', displayName: 'Dup' },
      { id: 'id-2', displayName: 'Dup' },
    ]);
    await expect(
      resolveWorkspaceIdByName('Dup', { token: 'tok' })
    ).rejects.toThrow(/Multiple workspaces match "Dup" exactly/);
  });

  it('throws a short, user-friendly message when no workspace matches', async () => {
    listWorkspacesMock.mockResolvedValue([
      { id: 'id-1', displayName: 'Workspace A' },
      { id: 'id-2', displayName: 'Workspace B' },
    ]);
    await expect(
      resolveWorkspaceIdByName('Nonexistent', { token: 'tok' })
    ).rejects.toThrow(
      'Workspace "Nonexistent" not found. Please retry with a valid workspace name.'
    );
  });

  it('uses the same short message even when the account has no workspaces', async () => {
    listWorkspacesMock.mockResolvedValue([]);
    await expect(
      resolveWorkspaceIdByName('Anything', { token: 'tok' })
    ).rejects.toThrow(
      'Workspace "Anything" not found. Please retry with a valid workspace name.'
    );
  });
});

describe('resolveWorkspaceIdByNameFuzzy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listWorkspacesMock.mockReset();
    vi.spyOn(workspaceModule, 'WorkspaceManager').mockImplementation(
      () =>
        ({
          listWorkspaces: listWorkspacesMock,
        }) as unknown as workspaceModule.WorkspaceManager
    );
  });

  it('returns an exact match without falling back to the loose pass', async () => {
    listWorkspacesMock.mockResolvedValue([
      { id: 'id-1', displayName: 'My Workspace' },
    ]);
    const result = await resolveWorkspaceIdByNameFuzzy('My Workspace', {
      token: 'tok',
    });
    expect(result).toEqual({ id: 'id-1', displayName: 'My Workspace' });
  });

  it('falls back to a normalized match ignoring dashes/underscores/punctuation', async () => {
    listWorkspacesMock.mockResolvedValue([
      { id: 'id-1', displayName: 'Test-Wk-1' },
    ]);
    const result = await resolveWorkspaceIdByNameFuzzy('testwk1', {
      token: 'tok',
    });
    expect(result).toEqual({ id: 'id-1', displayName: 'Test-Wk-1' });
    // The normalized fallback must reuse the list already fetched for the
    // strict passes rather than re-listing workspaces a second time.
    expect(listWorkspacesMock).toHaveBeenCalledTimes(1);
  });

  it('normalized match also ignores non-alphanumeric characters in the input', async () => {
    listWorkspacesMock.mockResolvedValue([
      { id: 'id-1', displayName: 'Test-Wk-1' },
    ]);
    const result = await resolveWorkspaceIdByNameFuzzy('test--wk?1', {
      token: 'tok',
    });
    expect(result).toEqual({ id: 'id-1', displayName: 'Test-Wk-1' });
  });

  it('preserves Unicode letters when matching normalized names', async () => {
    listWorkspacesMock.mockResolvedValue([
      { id: 'id-1', displayName: 'Ω-mega' },
    ]);
    const result = await resolveWorkspaceIdByNameFuzzy('Ωmega', {
      token: 'tok',
    });
    expect(result).toEqual({ id: 'id-1', displayName: 'Ω-mega' });
  });

  it('does not resolve a different non-ASCII workspace through an empty normalized name', async () => {
    listWorkspacesMock.mockResolvedValue([{ id: 'id-1', displayName: '東京' }]);
    await expect(
      resolveWorkspaceIdByNameFuzzy('北京', { token: 'tok' })
    ).rejects.toThrow(
      'Workspace "北京" not found. Please retry with a valid workspace name.'
    );
  });

  it('does not fuzzy-match punctuation-only workspace names', async () => {
    listWorkspacesMock.mockResolvedValue([{ id: 'id-1', displayName: '---' }]);
    await expect(
      resolveWorkspaceIdByNameFuzzy('???', { token: 'tok' })
    ).rejects.toThrow(
      'Workspace "???" not found. Please retry with a valid workspace name.'
    );
  });

  it('throws on multiple normalized matches', async () => {
    listWorkspacesMock.mockResolvedValue([
      { id: 'id-1', displayName: 'test-wk-1' },
      { id: 'id-2', displayName: 'test--wk1' },
    ]);
    await expect(
      resolveWorkspaceIdByNameFuzzy('testwk1', { token: 'tok' })
    ).rejects.toThrow(/Multiple workspaces match "testwk1"/);
  });

  it('still throws the short not-found message when no pass matches', async () => {
    listWorkspacesMock.mockResolvedValue([
      { id: 'id-1', displayName: 'Workspace A' },
    ]);
    await expect(
      resolveWorkspaceIdByNameFuzzy('Nonexistent', { token: 'tok' })
    ).rejects.toThrow(
      'Workspace "Nonexistent" not found. Please retry with a valid workspace name.'
    );
  });

  it('does not run the loose pass when the failure is a multiple-match error', async () => {
    listWorkspacesMock.mockResolvedValue([
      { id: 'id-1', displayName: 'Dup' },
      { id: 'id-2', displayName: 'Dup' },
    ]);
    await expect(
      resolveWorkspaceIdByNameFuzzy('Dup', { token: 'tok' })
    ).rejects.toThrow(/Multiple workspaces match "Dup" exactly/);
    // Only the initial listWorkspaces() call from resolveWorkspaceIdByName;
    // the loose fallback must not re-list workspaces for this error type.
    expect(listWorkspacesMock).toHaveBeenCalledTimes(1);
  });
});
