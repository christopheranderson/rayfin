import { createRequire } from 'module';

import {
  DOCS_NO_CACHE_OPTION_DESCRIPTION,
  type DocModule,
} from '@microsoft/rayfin-docs';
import { Command } from 'commander';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: string };

// Library exports — kept as a compatibility facade so consumers that
// previously imported `DocsService` from `@microsoft/rayfin-mcp` (e.g.
// `@microsoft/rayfin-cli`'s `rayfin docs` command group) continue to
// resolve the same surface. The implementation now lives in
// `@microsoft/rayfin-docs`; this package just re-exports.
export {
  DocsService,
  DOCS_DEFAULT_MODULES,
  type DocEntry,
  type DocListItem,
  type DocModule,
  type DocSearchResult,
  type DocSearchScope,
  type DocSection,
  type DocSectionRef,
} from '@microsoft/rayfin-docs';

export const cli = new Command();

cli
  .name('raymcp')
  .description('Rayfin MCP tooling')
  .version(pkg.version ?? '0.0.0');

const startCommand = new Command('start')
  .description('Start FastMCP server')
  .option('--host-docs', 'Load only host reference docs')
  .option('--no-cache', DOCS_NO_CACHE_OPTION_DESCRIPTION)
  .action(async (options: { hostDocs?: boolean; cache?: boolean }) => {
    const { startServer } = await import('./mcp.js');
    const { DOCS_DEFAULT_MODULES } = await import('@microsoft/rayfin-docs');
    const modules: readonly DocModule[] = options.hostDocs
      ? ['host']
      : DOCS_DEFAULT_MODULES;
    await startServer({ modules, noCache: options.cache === false });
  });

cli.addCommand(startCommand);
