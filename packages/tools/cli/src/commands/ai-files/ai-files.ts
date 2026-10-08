/**
 * Parent command `rayfin init ai-files` with two subcommands.
 *
 * The subcommands manage Rayfin-shipped agent files in a project:
 * - `AGENTS.md` (one-time install)
 * - `.mcp.json` `mcpServers.rayfin` (versioned, updateable)
 * - `.agents/skills/rayfin/SKILL.md` (versioned, updateable)
 *
 * `install` is idempotent — safe to run repeatedly. Re-runs auto-reconcile
 * to the current bundled content (auto-update on content drift, install
 * newly-shipped descriptors, clean up orphans).
 *
 * State is recorded in `rayfin/.lockfile.json`.
 */

import { Command } from 'commander';

import { installCommand } from './install.js';
import { statusCommand } from './status.js';

export const aiFilesCommand = new Command('ai-files')
  .description(
    'Manage Rayfin agent files (AGENTS.md, .mcp.json, .agents/skills/) in this project.'
  )
  .addCommand(installCommand)
  .addCommand(statusCommand);
