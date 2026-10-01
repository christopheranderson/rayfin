import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findRayfinProjectRoot: vi.fn<
    (
      startPath?: string,
      options?: { verbose?: boolean; silent?: boolean }
    ) => string
  >(() => '/tmp/proj'),
  listDeployments: vi.fn<
    () => Array<{
      workspaceName: string;
      record: {
        itemId: string;
        apiUrl: string;
        workspaceId: string;
        publishableKey?: string;
        deployedAt?: string;
      };
      active: boolean;
    }>
  >(() => []),
}));

vi.mock('../utils/project-utils.js', () => ({
  findRayfinProjectRoot: mocks.findRayfinProjectRoot,
}));

vi.mock('../utils/deployments-registry.js', () => ({
  listDeployments: mocks.listDeployments,
}));

import { upListCommand } from '../commands/up/up-list.js';

interface CommanderInternals {
  _optionValues: Record<string, unknown>;
  _optionValueSources: Record<string, unknown>;
  processedArgs: unknown[];
  rawArgs: unknown[];
  args: unknown[];
}

function resetCommand(command: Command): void {
  const internals = command as unknown as CommanderInternals;
  internals._optionValues = {};
  internals._optionValueSources = {};
  internals.processedArgs = [];
  internals.rawArgs = [];
  internals.args = [];
}

function makeRoot(): Command {
  resetCommand(upListCommand);
  const root = new Command('rayfin')
    .exitOverride()
    .option('--json', 'Emit machine-readable JSON output', false);
  const up = new Command('up');
  up.addCommand(upListCommand);
  root.addCommand(up);
  return root;
}

describe('rayfin up list', () => {
  let stdoutWrites: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutWrites = [];
    mocks.findRayfinProjectRoot.mockReturnValue('/tmp/proj');
    mocks.listDeployments.mockReturnValue([
      {
        workspaceName: 'test-ws',
        active: true,
        record: {
          itemId: 'item-123',
          apiUrl: 'https://example.invalid/endpoint',
          workspaceId: 'ws-456',
          publishableKey: 'pk-test',
          deployedAt: '2026-05-14T18:27:06.722Z',
        },
      },
    ]);
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('honors root-level `rayfin --json up list` and suppresses project-root discovery logging', async () => {
    await makeRoot().parseAsync(['--json', 'up', 'list'], { from: 'user' });

    expect(mocks.findRayfinProjectRoot).toHaveBeenCalledWith(process.cwd(), {
      silent: true,
    });
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining('Found Rayfin project root')
    );
    const output = stdoutWrites.join('');
    expect(output).not.toContain('Found Rayfin project root');
    const parsed = JSON.parse(output) as unknown[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      workspaceName: 'test-ws',
      active: true,
      itemId: 'item-123',
      workspaceId: 'ws-456',
    });
  });

  it('keeps project-root discovery visible in human output mode', async () => {
    await makeRoot().parseAsync(['up', 'list'], { from: 'user' });

    expect(mocks.findRayfinProjectRoot).toHaveBeenCalledWith(process.cwd(), {
      silent: false,
    });
  });
});
