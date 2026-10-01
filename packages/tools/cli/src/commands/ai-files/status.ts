/**
 * `rayfin init ai-files status` — print one-line-per-item state summary.
 */

import { Command } from 'commander';

import type { ItemStatus } from '../../services/agent-files/types.js';
import {
  emitJson,
  resolveOutputMode,
  resolveRootOutputFlags,
} from '../../utils/output-mode.js';

import { buildManager, handleCommandError, modeLog } from './helpers.js';

export const statusCommand = new Command('status')
  .description(
    'Show the state of Rayfin-managed agent files (up-to-date, update-available, user-modified, missing, disabled, orphaned, unreadable).'
  )
  .option(
    '--json',
    'emit a single JSON object to stdout instead of formatted lines'
  )
  .action(async (options: { json?: boolean }, command: Command) => {
    const json = Boolean(options.json) || resolveRootOutputFlags(command).json;
    const mode = resolveOutputMode({ json });
    try {
      const mgr = buildManager();
      const statuses = mgr.status();
      if (mode === 'json') {
        emitJson({ status: 'ok', schemaVersion: 1, items: statuses });
        return;
      }
      modeLog(mode, '📊 rayfin init ai-files status');
      if (statuses.length === 0) {
        modeLog(mode, '  No managed items.');
        return;
      }
      for (const status of statuses) {
        modeLog(mode, formatStatus(status));
      }
    } catch (err) {
      handleCommandError(mode, err);
    }
  });

function formatStatus(status: ItemStatus): string {
  const { id, state } = status;
  switch (state.kind) {
    case 'up-to-date':
      return `  ✓ ${id}  up-to-date`;
    case 'update-available':
      return `  ↗ ${id}  update-available  (run \`rayfin init ai-files install\`)`;
    case 'user-modified':
      return `  ⚠ ${id}  user-modified  (local edits will be preserved)`;
    case 'missing':
      return `  ✗ ${id}  missing`;
    case 'not-installed':
      return `  · ${id}  not-installed`;
    case 'disabled':
      return `  − ${id}  disabled`;
    case 'orphaned':
      return `  ⚠ ${id}  orphaned  (no longer shipped by this CLI)`;
    case 'unreadable':
      return `  ⚠ ${id}  unreadable  (${state.message})`;
    default: {
      // Compile-time exhaustiveness guard. If a new ItemState kind is added to
      // types.ts, this assignment becomes a type error so the missing case
      // surfaces at build time instead of as `undefined` at runtime.
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}
