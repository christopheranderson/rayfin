/**
 * `rayfin docs get [--id <id> | --path <path> | --symbol <name>] [--module <name>] [--limit N] [--json]`
 *
 * Fetch a doc entry by id or path, or resolve a symbol name to one or more
 * doc sections. Exactly one of `--id` / `--path` / `--symbol` must be provided.
 *
 * - `--id <id>` returns the full entry (matches the MCP `get_doc` shape).
 * - `--path <path>` returns the full entry by relative path.
 * - `--symbol <name>` returns matching sections (symbol → DocSectionRef[]),
 *   optionally limited and module-filtered.
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
  trimSnippet,
} from './helpers.js';

/**
 * Build a fresh `get` subcommand. Factory rather than module-scoped const so
 * tests can construct an isolated Commander tree per test.
 */
export function createGetCommand(): Command {
  return new Command('get')
    .description(
      'Fetch a doc entry by id or path, or resolve a symbol name to its docs.'
    )
    .option('-i, --id <id>', 'Doc id (e.g. `guide:guide/data/overview.md`).')
    .option('-p, --path <path>', 'Doc path (e.g. `guide/data/overview.md`).')
    .option(
      '-s, --symbol <name>',
      "Symbol name (e.g. RayfinClient, '@entity')."
    )
    .option(
      '-m, --module <name>',
      'When using --symbol, limit results to one docs area: guide, host, or ts-sdk.'
    )
    .option(
      '-l, --limit <n>',
      'When using --symbol, max sections to return. 1-50. Default: all matches.'
    )
    .option(
      '--json',
      'Emit a JSON object to stdout instead of formatted lines.'
    )
    .option(
      '--lean',
      'With --json: emit only the inner array/object, no `status`/`schemaVersion`/`count` envelope. Saves ~25-30% of bytes for LLM consumers.'
    )
    .option('--no-cache', NO_CACHE_OPTION_DESC)
    .action(
      (
        options: {
          id?: string;
          path?: string;
          symbol?: string;
          module?: string;
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
          const provided = [options.id, options.path, options.symbol].filter(
            Boolean
          );
          if (provided.length === 0) {
            throw new Error(
              'rayfin docs get requires exactly one of --id, --path, or --symbol. Try `rayfin docs list` to find an id, or `rayfin docs search` to search by keyword.'
            );
          }
          if (provided.length > 1) {
            throw new Error(
              'rayfin docs get accepts only one of --id, --path, or --symbol per invocation.'
            );
          }

          const moduleFilter = parseModuleFlag(options.module);
          const limit = parseLimitFlag(options.limit);
          const service = getDocsService(moduleFilter, {
            noCache: options.cache === false,
          });

          if (options.symbol) {
            const sections = service.getSymbolDocs(
              options.symbol,
              moduleFilter
            );
            const limited = limit ? sections.slice(0, limit) : sections;

            if (mode === 'json') {
              emitDocsJson(
                {
                  symbol: options.symbol,
                  module: moduleFilter ?? null,
                  count: limited.length,
                  sections: limited,
                },
                options.lean === true
              );
              return;
            }

            if (limited.length === 0) {
              modeLog(
                mode,
                `🔎 Symbol '${options.symbol}' not found${
                  moduleFilter ? ` in module '${moduleFilter}'` : ''
                }.`
              );
              return;
            }

            modeLog(
              mode,
              `🔎 ${limited.length} section${limited.length === 1 ? '' : 's'} for symbol '${options.symbol}'`
            );
            for (const section of limited) {
              modeLog(
                mode,
                `\n  ${section.module.padEnd(8)} ${section.entryId}`
              );
              modeLog(mode, `    ${section.title} → ${section.heading}`);
              modeLog(mode, `    ${trimSnippet(section.content)}`);
            }
            modeLog(
              mode,
              '\nNext: rayfin docs get --id <id> for the full entry containing a section.'
            );
            return;
          }

          let entry = options.id ? service.getDocById(options.id) : undefined;
          if (!entry && options.path) {
            const matches = service.getDocsByPath(options.path, moduleFilter);
            if (matches.length > 1) {
              throw new Error(
                `Doc path '${options.path}' is ambiguous. Use --id with one of: ${matches.map((match) => match.id).join(', ')}.`
              );
            }
            entry = matches[0];
          }

          if (!entry) {
            const lookup = options.id
              ? `id '${options.id}'`
              : `path '${options.path}'`;
            const looksHost =
              moduleFilter !== 'host' &&
              ((options.id?.startsWith('rayfin-host:') ?? false) ||
                (options.id?.startsWith('host:') ?? false) ||
                (options.path?.startsWith('host/') ?? false));
            const hint = looksHost
              ? 'This looks like a host doc; retry with --module host. Host docs are not loaded by default.'
              : 'Try `rayfin docs list` to find a valid id.';
            throw new Error(`Doc not found for ${lookup}. ${hint}`);
          }

          if (mode === 'json') {
            emitDocsJson({ entry }, options.lean === true);
            return;
          }

          modeLog(mode, `📄 ${entry.id}`);
          modeLog(mode, `   Module: ${entry.module}`);
          modeLog(mode, `   Path:   ${entry.path}`);
          modeLog(mode, `   Title:  ${entry.title}`);
          if (entry.symbols.length > 0) {
            modeLog(
              mode,
              `   Symbols: ${entry.symbols.slice(0, 8).join(', ')}`
            );
          }
          modeLog(mode, '');
          modeLog(mode, entry.content);
        } catch (err) {
          handleDocsCommandError(mode, err);
        }
      }
    );
}

export const getCommand = createGetCommand();
