/**
 * `rayfin docs discover <query>` - find Rayfin packages by query when
 * the user's installed corpus doesn't cover what they're looking for.
 *
 * Closes the negative-task agent failure mode the round-5 LLM eval
 * surfaced: queries about packages the user hasn't installed
 * ("how do I do realtime?", "stripe integration?") get a structured
 * "you could install or update X" answer instead of grep-spiraling
 * through unrelated docs.
 *
 * Mirrors the MCP server's `discover_packages` tool surface.
 */
import { discoverPackages, mapDiscoverResult } from '@microsoft/rayfin-docs';
import { Command } from 'commander';

import {
  modeLog,
  resolveOutputMode,
  resolveRootOutputFlags,
  type OutputMode,
} from '../../utils/output-mode.js';

import {
  emitDocsJson,
  handleDocsCommandError,
  parseLimitFlag,
} from './helpers.js';

export interface DiscoverCommandOptions {
  json?: boolean;
  lean?: boolean;
  limit?: string;
}

export function createDiscoverCommand(): Command {
  return new Command('discover')
    .description(
      'Find Rayfin packages by query - useful when the installed corpus does not contain what you are looking for. Returns a ranked list with name, kind, summary, and the install command.'
    )
    .argument('<query>', 'Free-form query (e.g. "react auth", "graphql").')
    .option('--json', 'Emit JSON instead of text.')
    .option(
      '--lean',
      'Emit compact JSON without the status/schemaVersion envelope (LLM-optimized).'
    )
    .option('-l, --limit <n>', 'Max results (1-50, default 10).')
    .action(
      (query: string, options: DiscoverCommandOptions, command: Command) => {
        const root = resolveRootOutputFlags(command);
        const json = Boolean(options.json) || root.json;
        const mode: OutputMode = resolveOutputMode({
          json: json || options.lean,
        });
        try {
          const limit = parseLimitFlag(options.limit) ?? 10;
          const allResults = discoverPackages(query);
          const items = allResults.slice(0, limit).map(mapDiscoverResult);
          if (mode === 'json') {
            emitDocsJson(
              { items, count: items.length, total: allResults.length, query },
              options.lean === true,
              { items, total: allResults.length, query }
            );
            return;
          }
          if (items.length === 0) {
            modeLog(
              mode,
              `No Rayfin packages match "${query}".\n\n` +
                'Suggestions:\n' +
                `  - Try a broader query (one or two key terms instead of a full sentence).\n` +
                `  - The catalog covers Rayfin's first-party packages only; integrations with third-party services\n` +
                `    (Stripe, Auth0, etc.) are typically built on top of the SDK rather than shipped as Rayfin packages.\n` +
                `  - The Rayfin docs site at https://learn.microsoft.com/fabric may have broader coverage.\n`
            );
            return;
          }
          modeLog(
            mode,
            `Found ${items.length} Rayfin package${items.length === 1 ? '' : 's'} matching "${query}":\n\n`
          );
          for (const item of items) {
            modeLog(mode, `  ${item.name}  (${item.kind})`);
            modeLog(mode, `    ${item.summary}`);
            modeLog(mode, `    Install: ${item.installCommand}`);
            modeLog(mode, `    If already installed: ${item.updateCommand}\n`);
            if (item.homepageUrl) {
              modeLog(mode, `    Docs:    ${item.homepageUrl}`);
            }
            modeLog(mode, '');
          }
        } catch (err) {
          handleDocsCommandError(mode, err);
        }
      }
    );
}

/** Default registered discover command. Tests construct fresh trees via
 *  {@link createDiscoverCommand}. */
export const discoverCommand = createDiscoverCommand();
