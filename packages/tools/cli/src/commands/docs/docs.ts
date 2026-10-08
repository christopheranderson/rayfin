/**
 * `rayfin docs` - query Rayfin documentation from the CLI.
 *
 * The CLI surface is a thin wrapper over `DocsService` from `@microsoft/rayfin-docs`,
 * serving docs discovered from installed packages that declare `rayfinDocs`.
 * Both the MCP server and this CLI use the same docs library and catalog, so
 * search results and content stay aligned across surfaces.
 *
 * The CLI is intended as an offline, no-MCP, and scripting surface for Builders.
 *
 * Subcommands:
 * - `rayfin docs list [--module <name>] [--json]`
 * - `rayfin docs search <query> [--module <name>] [--scope <docs|symbols|all>] [--limit N] [--json]`
 * - `rayfin docs get [--id <id> | --path <path> | --symbol <name>] [--module <name>] [--limit N] [--json]`
 * - `rayfin docs discover <query> [--limit N] [--json]` (Phase 4: catalog-backed package discovery)
 */

import { Command } from 'commander';

import { catalogCommand, createCatalogCommand } from './catalog.js';
import { createDiscoverCommand, discoverCommand } from './discover.js';
import { createGetCommand, getCommand } from './get.js';
import { createListCommand, listCommand } from './list.js';
import { createSearchCommand, searchCommand } from './search.js';

/**
 * Factory that builds a fresh `rayfin docs` command tree. Used by the runtime
 * default export below and by tests that need an isolated tree per test
 * (Commander retains parsed option values across `parseAsync` calls).
 */
export function createDocsCommand(): Command {
  return new Command('docs')
    .description(
      'Query Rayfin docs from installed packages; use discover for packages not yet installed.'
    )
    .addCommand(createListCommand())
    .addCommand(createSearchCommand())
    .addCommand(createGetCommand())
    .addCommand(createDiscoverCommand())
    .addCommand(createCatalogCommand());
}

/** Default `rayfin docs` instance registered by the top-level CLI program. */
export const docsCommand = new Command('docs')
  .description(
    'Query Rayfin docs from installed packages; use discover for packages not yet installed.'
  )
  .addCommand(listCommand)
  .addCommand(searchCommand)
  .addCommand(getCommand)
  .addCommand(discoverCommand)
  .addCommand(catalogCommand);
