import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Command-layer tests for `rayfin connector search`: scope resolution
// (validateCommandSyntax / resolveScope) and the `silent` auth wiring.
// No test file existed for this command before.

let testProjectDir: string;

vi.mock('../utils/project-utils.js', () => ({
  findRayfinProjectRoot: () => testProjectDir,
}));

const mocks = vi.hoisted(() => ({
  ensureAuthenticated: vi.fn().mockResolvedValue({ token: 'user-token' }),
  listDeployments: vi.fn().mockReturnValue([]),
  discover: vi.fn().mockResolvedValue([]),
}));

vi.mock('../auth/index.js', () => ({
  ensureAuthenticated: mocks.ensureAuthenticated,
}));

vi.mock('../utils/deployments-registry.js', () => ({
  listDeployments: mocks.listDeployments,
}));

vi.mock('../services/connectors/discovery/engine.js', () => ({
  createDiscoveryEngine: () => ({ name: 'mock', discover: mocks.discover }),
}));

import { connectorSearchCommand } from '../commands/connector/connector-search';

/**
 * Run `rayfin connector search <args>` via Commander, resetting cached
 * option state first (avoids leaking option values between tests).
 */
async function runSearch(args: string[]): Promise<void> {
  (
    connectorSearchCommand as unknown as {
      _optionValues: Record<string, unknown>;
    }
  )._optionValues = {};
  (
    connectorSearchCommand as unknown as {
      _optionValueSources: Record<string, unknown>;
    }
  )._optionValueSources = {};

  const parent = new Command('rayfin');
  parent.addCommand(connectorSearchCommand);
  parent.exitOverride();
  await parent.parseAsync(['node', 'rayfin', 'search', ...args]);
}

/**
 * Deployment record shaped like `listDeployments()`'s return value.
 * `listDeployments()` never returns an entry without a workspace ID (the
 * registry filters those out), so `workspaceId` is required here too.
 */
function deployment(workspaceId: string) {
  return {
    workspaceName: 'my-workspace',
    active: true,
    record: {
      itemId: 'item-1',
      apiUrl: 'https://example.com',
      workspaceId,
      portalUrl: undefined,
    },
  };
}

describe('connector search', () => {
  // Overloaded `write` signature doesn't fit MockInstance's generic shape;
  // matches the `let stderrSpy: any` pattern used elsewhere in this package.
  let stderrSpy: any;
  let stdoutSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureAuthenticated.mockResolvedValue({ token: 'user-token' });
    mocks.listDeployments.mockReturnValue([]);
    mocks.discover.mockResolvedValue([]);
    testProjectDir = mkdtempSync(join(tmpdir(), 'rayfin-search-test-'));
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    rmSync(testProjectDir, { recursive: true, force: true });
  });

  describe('scope resolution', () => {
    it('rejects with no scope and no deployments', async () => {
      await expect(runSearch(['--json'])).rejects.toThrow();

      const emitted = JSON.parse(stdoutSpy.mock.calls[0]![0] as string);
      expect(emitted.status).toBe('error');
      expect(emitted.error).toContain('workspace scope is required');
    });

    it('defaults to deployment workspace IDs when no scope flag is given', async () => {
      mocks.listDeployments.mockReturnValue([deployment('ws-1')]);

      await runSearch(['--json']);

      expect(mocks.discover).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            scope: { workspaceIds: ['ws-1'] },
          }),
        })
      );
    });

    it('scopes to a single workspace with --workspace-id --type', async () => {
      await runSearch([
        '--workspace-id',
        'ws-1',
        '--type',
        'fabric-warehouse',
        '--json',
      ]);

      expect(mocks.discover).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({ scope: { workspaceId: 'ws-1' } }),
        })
      );
    });

    it('scopes to every workspace with --all-workspaces --type', async () => {
      await runSearch([
        '--all-workspaces',
        '--type',
        'fabric-warehouse',
        '--json',
      ]);

      expect(mocks.discover).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({ scope: { allWorkspaces: true } }),
        })
      );
    });
  });

  describe('silent auth wiring', () => {
    it('passes silent: true to ensureAuthenticated in --json mode', async () => {
      await runSearch([
        '--all-workspaces',
        '--type',
        'fabric-warehouse',
        '--json',
      ]);

      expect(mocks.ensureAuthenticated).toHaveBeenCalledWith(undefined, {
        silent: true,
      });
    });

    it('passes silent: false to ensureAuthenticated outside --json mode', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runSearch([
        '--all-workspaces',
        '--type',
        'fabric-warehouse',
        '--output',
        'plain',
      ]);

      expect(mocks.ensureAuthenticated).toHaveBeenCalledWith(undefined, {
        silent: false,
      });
      logSpy.mockRestore();
    });
  });
});
