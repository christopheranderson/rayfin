/**
 * `rayfin docs list [--module <name>] [--json]`
 *
 * List available doc entries. With `--module`, scope to a single docs area
 * (guide / host / ts-sdk).
 */

import { Command } from 'commander';

import {
  modeLog,
  resolveOutputMode,
  resolveRootOutputFlags,
} from '../../utils/output-mode.js';

import {
  emitDocsJson,
  getDocsService,
  handleDocsCommandError,
  NO_CACHE_OPTION_DESC,
  parseModuleFlag,
} from './helpers.js';

/**
 * Build a fresh `list` subcommand. Factory rather than module-scoped const so
 * tests can construct an isolated Commander tree per test (Commander retains
 * parsed option values across `parseAsync` calls on the same instance).
 */
export function createListCommand(): Command {
  return new Command('list')
    .description(
      'List available Rayfin doc entries. Filter to a single docs area with --module.'
    )
    .option(
      '-m, --module <name>',
      'Limit results to one docs area: guide, host, or ts-sdk.'
    )
    .option(
      '--json',
      'Emit a JSON object to stdout instead of formatted lines.'
    )
    .option(
      '--lean',
      'With --json: emit only the inner array, no `status`/`schemaVersion`/`count` envelope. Saves ~25-30% of bytes for LLM consumers.'
    )
    .option('--no-cache', NO_CACHE_OPTION_DESC)
    .action(
      (
        options: {
          module?: string;
          json?: boolean;
          lean?: boolean;
          cache?: boolean;
        },
        command: Command
      ) => {
        const root = resolveRootOutputFlags(command);
        const json = Boolean(options.json) || root.json;
        const mode = resolveOutputMode({ json: json || options.lean });
        try {
          const moduleFilter = parseModuleFlag(options.module);
          const items = getDocsService(moduleFilter, {
            noCache: options.cache === false,
          }).listDocs(moduleFilter);

          if (mode === 'json') {
            emitDocsJson(
              {
                module: moduleFilter ?? null,
                count: items.length,
                items,
              },
              options.lean === true
            );
            return;
          }

          if (items.length === 0) {
            modeLog(
              mode,
              moduleFilter
                ? `No doc entries found for module '${moduleFilter}'.`
                : 'No doc entries found.'
            );
            return;
          }

          modeLog(
            mode,
            `📚 ${items.length} doc entr${items.length === 1 ? 'y' : 'ies'}${
              moduleFilter ? ` (module: ${moduleFilter})` : ''
            }`
          );
          for (const item of items) {
            modeLog(
              mode,
              `  ${item.module.padEnd(8)} ${item.id}  ${item.title}`
            );
          }
          modeLog(
            mode,
            '\nNext: rayfin docs get --id <id> for full content, or rayfin docs search "<query>" to find by keyword.'
          );
        } catch (err) {
          handleDocsCommandError(mode, err);
        }
      }
    );
}

export const listCommand = createListCommand();
