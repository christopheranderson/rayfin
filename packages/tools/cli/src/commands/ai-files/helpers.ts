/**
 * Shared helpers for `rayfin init ai-files` subcommands.
 */

import { CliHandledError } from '../../errors.js';
import { AgentFilesManager } from '../../services/agent-files/manager.js';
import { isManagedItemId } from '../../services/agent-files/types.js';
import type {
  ItemId,
  ManagedItemId,
  UpdateReport,
} from '../../services/agent-files/types.js';
import {
  emitJson,
  modeError,
  modeLog,
  modeWarn,
  type OutputMode,
} from '../../utils/output-mode.js';
import { findRayfinProjectRoot } from '../../utils/project-utils.js';

export function buildManager(): AgentFilesManager {
  const projectRoot = findRayfinProjectRoot(process.cwd(), {
    verbose: false,
    silent: true,
  });
  return new AgentFilesManager(projectRoot);
}

/**
 * Validate and parse a CLI-supplied id. Only ai-files-managed `skill:` or
 * `mcp:` namespaces are accepted at the CLI boundary; the lockfile itself
 * uses the broader `ItemId` type to stay forward-compatible with other
 * concerns (e.g. `deployment:prod` from a future namespace).
 */
export function parseItemId(value: string): ManagedItemId {
  if (!isManagedItemId(value)) {
    throw new Error(
      `Invalid item id "${value}". Expected "skill:<name>" or "mcp:<name>".`
    );
  }
  return value;
}

/** Commander option collector — accumulates repeatable flag values into an array. */
export function collectMulti(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Throws if the same item id appears in both `--enable` and `--disable` flag lists.
 * The two are mutually exclusive per item.
 */
export function validateEnableDisableConflict(
  enableIds: ItemId[],
  disableIds: ItemId[]
): void {
  const enableSet = new Set(enableIds);
  for (const id of disableIds) {
    if (enableSet.has(id)) {
      throw new Error(
        `Item "${id}" cannot be both --enable'd and --disable'd in the same invocation.`
      );
    }
  }
}

/**
 * Build a per-item enable map from CLI flag arrays. `enableIds[i]` becomes
 * `enable[id] = true`; `disableIds[i]` becomes `enable[id] = false`. Items
 * not in either list are absent (preserve existing state).
 */
export function buildEnableMap(
  enableIds: ItemId[],
  disableIds: ItemId[]
): Record<ItemId, boolean> {
  const map: Record<ItemId, boolean> = {};
  for (const id of enableIds) map[id] = true;
  for (const id of disableIds) map[id] = false;
  return map;
}

/** Print a report from `install()` to the user-facing output mode. */
export function printReport(mode: OutputMode, report: UpdateReport): void {
  for (const id of report.installed) {
    modeLog(mode, `✓ Installed ${id}`);
  }
  for (const id of report.updated) {
    modeLog(mode, `✓ Updated ${id}`);
  }
  for (const id of report.enabled) {
    modeLog(mode, `✓ Enabled ${id}`);
  }
  for (const id of report.disabled) {
    modeLog(mode, `− Disabled ${id}`);
  }
  for (const id of report.removed) {
    modeLog(mode, `✓ Removed ${id}`);
  }
  for (const { id, reason } of report.skipped) {
    modeLog(mode, `· Skipped ${id} (${reason})`);
  }

  if (report.warnings.length > 0) {
    modeLog(mode, '');
    for (const { id, reason, message } of report.warnings) {
      printWarning(mode, id, reason, message);
    }
  }

  if (
    report.installed.length === 0 &&
    report.updated.length === 0 &&
    report.removed.length === 0 &&
    report.disabled.length === 0 &&
    report.enabled.length === 0 &&
    report.warnings.length === 0
  ) {
    modeLog(mode, '✓ Up to date');
  }
}

function printWarning(
  mode: OutputMode,
  id: ItemId,
  reason: 'user-modified' | 'missing' | 'unreadable',
  message?: string
): void {
  const cmd = 'rayfin init ai-files install';
  modeWarn(mode, `⚠ ${id} — ${reason}`);
  if (reason === 'user-modified') {
    modeWarn(
      mode,
      `  Local edits will be preserved. To overwrite with the bundled version:`
    );
    modeWarn(mode, `    ${cmd} --force ${id}`);
    modeWarn(mode, `  To stop managing and keep your version:`);
    modeWarn(mode, `    ${cmd} --disable ${id}`);
  } else if (reason === 'missing') {
    modeWarn(mode, `  To restore from the bundled version:`);
    modeWarn(mode, `    ${cmd} --force ${id}`);
    modeWarn(mode, `  To stop tracking the missing item:`);
    modeWarn(mode, `    ${cmd} --disable ${id}`);
  } else {
    if (message) {
      modeWarn(mode, `  ${message}`);
    }
    modeWarn(mode, `  Repair the file by hand, or:`);
    modeWarn(mode, `    ${cmd} --force ${id}`);
    modeWarn(mode, `  to overwrite with the bundled version.`);
  }
  modeWarn(mode, '');
}

/**
 * Shared error handler for ai-files subcommands. Emits the error in the
 * appropriate output mode and throws `CliHandledError` so the wrapper
 * surfaces it as exit 1 without re-printing.
 */
export function handleCommandError(mode: OutputMode, err: unknown): never {
  if (mode === 'json') {
    emitJson({
      status: 'error',
      schemaVersion: 1,
      error: (err as Error).message,
    });
  } else {
    modeError(mode, `❌ ${(err as Error).message}`);
  }
  throw new CliHandledError(err);
}

export { CliHandledError, modeLog, modeWarn, modeError };
