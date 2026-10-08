/**
 * `rayfin docs search <query> [--module <name>] [--scope <docs|symbols|all>] [--limit N] [--json]`
 *
 * Full-text search across Rayfin docs. Returns results with snippets and
 * ranking. `--scope symbols` filters to symbol-name matches; `--scope all`
 * combines both.
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
  parseLimitFlag,
  parseModuleFlag,
  parseScopeFlag,
  trimSnippet,
} from './helpers.js';

const DEFAULT_LIMIT = 10;

/**
 * Build a fresh `search` subcommand. Factory rather than module-scoped const
 * so tests can construct an isolated Commander tree per test.
 */
export function createSearchCommand(): Command {
  return new Command('search')
    .description(
      'Search Rayfin docs by keyword. Returns ranked results with snippets.'
    )
    .argument('<query>', 'Search query. Use quotes for multi-word phrases.')
    .option(
      '-m, --module <name>',
      'Limit results to one docs area: guide, host, or ts-sdk.'
    )
    .option(
      '-s, --scope <scope>',
      'Search scope: docs (full-text content), symbols (symbol names only), or all. Default: docs.'
    )
    .option(
      '-l, --limit <n>',
      `Maximum results to return. 1-50. Default: ${DEFAULT_LIMIT}.`
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
        query: string,
        options: {
          module?: string;
          scope?: string;
          limit?: string;
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
          const scope = parseScopeFlag(options.scope);
          const limit = parseLimitFlag(options.limit) ?? DEFAULT_LIMIT;

          const results = getDocsService(moduleFilter, {
            noCache: options.cache === false,
          }).searchDocs(query, moduleFilter, limit, scope ?? 'docs');

          if (mode === 'json') {
            emitDocsJson(
              {
                query,
                module: moduleFilter ?? null,
                scope: scope ?? 'docs',
                limit,
                count: results.length,
                results,
              },
              options.lean === true
            );
            return;
          }

          if (results.length === 0) {
            modeLog(
              mode,
              `🔍 No results for "${query}"${
                moduleFilter ? ` in module '${moduleFilter}'` : ''
              }.`
            );
            return;
          }

          modeLog(
            mode,
            `🔍 ${results.length} result${results.length === 1 ? '' : 's'} for "${query}"${
              moduleFilter ? ` (module: ${moduleFilter})` : ''
            }`
          );
          for (const result of results) {
            const headingSuffix = result.heading
              ? `  ${trimSnippet(result.heading, 60)}`
              : '';
            modeLog(
              mode,
              `\n  ${result.module.padEnd(8)} ${result.id}${headingSuffix}`
            );
            modeLog(
              mode,
              `    ${result.title}  (score: ${result.score.toFixed(2)})`
            );
            modeLog(mode, `    ${trimSnippet(result.snippet)}`);
          }
          modeLog(
            mode,
            '\nNext: rayfin docs get --id <id> for full content of a result.'
          );
        } catch (err) {
          handleDocsCommandError(mode, err);
        }
      }
    );
}

export const searchCommand = createSearchCommand();
