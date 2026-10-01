/**
 * Helper invoked from `rayfin init` (and equivalents) after template scaffolding
 * finishes. Best-effort: a failure here surfaces a warning but does not abort the
 * init flow — the user already has a scaffolded project.
 */

import { AgentFilesManager } from '../../services/agent-files/manager.js';
import type { ItemId } from '../../services/agent-files/types.js';
import { modeLog, modeWarn, type OutputMode } from '../../utils/output-mode.js';

/**
 * Machine-readable summary of what {@link installAgentFilesAfterScaffold} did,
 * so JSON-mode callers can fold the outcome into their single result envelope
 * (human-mode logging is suppressed in JSON mode and would otherwise be lost).
 */
export interface AgentFilesInstallSummary {
  installed: string[];
  updated: string[];
  warnings: { id: string; reason: string }[];
  /** Present when the install step itself threw (best-effort failure). */
  error?: string;
}

export interface InstallAgentFilesOptions {
  /**
   * Restrict the install to specific managed item ids (for example
   * `['skill:rayfin-connectors']`). When omitted, every managed item is
   * installed — the correct behavior for a full project scaffold.
   */
  ids?: readonly ItemId[];
}

export function installAgentFilesAfterScaffold(
  projectRoot: string,
  mode: OutputMode,
  options: InstallAgentFilesOptions = {}
): AgentFilesInstallSummary {
  try {
    const mgr = new AgentFilesManager(projectRoot);
    // No `ids` scope → install every managed item (full scaffold). A scope is
    // only applied when the caller explicitly narrows it (e.g. `connector add`
    // installing just the `rayfin-connectors` skill).
    const report = options.ids
      ? mgr.install({ ids: options.ids })
      : mgr.install();
    const summary: AgentFilesInstallSummary = {
      installed: report.installed.map((id) => String(id)),
      updated: report.updated.map((id) => String(id)),
      warnings: report.warnings.map((w) => ({
        id: String(w.id),
        reason: w.reason,
      })),
    };
    const total =
      report.installed.length + report.updated.length + report.warnings.length;
    if (total === 0) return summary;

    modeLog(mode, '');
    modeLog(mode, '🛠️  Installed Rayfin agent files:');
    for (const id of report.installed) {
      modeLog(mode, `   ✓ ${id}`);
    }
    for (const id of report.updated) {
      modeLog(mode, `   ↗ ${id}`);
    }
    if (report.warnings.length > 0) {
      for (const w of report.warnings) {
        modeWarn(
          mode,
          `   ⚠ ${w.id} (${w.reason}) — run 'rayfin init ai-files status' for details`
        );
      }
    }
    return summary;
  } catch (err) {
    modeWarn(
      mode,
      `⚠️  Could not install Rayfin agent files: ${(err as Error).message}`
    );
    modeWarn(
      mode,
      `   The project was scaffolded successfully. Run 'rayfin init ai-files install' to retry.`
    );
    return {
      installed: [],
      updated: [],
      warnings: [],
      error: (err as Error).message,
    };
  }
}
