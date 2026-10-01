/**
 * `rayfin docs catalog show` — display the in-memory package discovery
 * catalog (bundled with `@microsoft/rayfin-docs`'s shipped JSON).
 *
 * The catalog updates ship as `@microsoft/rayfin-docs` version bumps;
 * there is no hosted-endpoint refresh path. To pick up a newer catalog,
 * upgrade the rayfin-docs install in your project.
 */
import { getCatalog } from '@microsoft/rayfin-docs';
import { Command } from 'commander';

import {
  modeLog,
  resolveOutputMode,
  resolveRootOutputFlags,
  type OutputMode,
} from '../../utils/output-mode.js';

import { emitDocsJson, handleDocsCommandError } from './helpers.js';

interface CatalogShowOptions {
  json?: boolean;
  lean?: boolean;
}

function createShowCommand(): Command {
  return new Command('show')
    .description('Display the in-memory package discovery catalog.')
    .option('--json', 'Emit JSON instead of text.')
    .option('--lean', 'Emit compact JSON without the envelope.')
    .action((options: CatalogShowOptions, command: Command) => {
      const root = resolveRootOutputFlags(command);
      const json = Boolean(options.json) || root.json;
      const mode: OutputMode = resolveOutputMode({
        json: json || options.lean,
      });
      try {
        const catalog = getCatalog();
        if (mode === 'json') {
          emitDocsJson(
            { catalog, count: catalog.packages.length },
            options.lean === true
          );
          return;
        }
        modeLog(
          mode,
          `Catalog (schema v${catalog.schemaVersion}, generated ${catalog.generatedAt}):\n`
        );
        modeLog(mode, `Total packages: ${catalog.packages.length}\n`);
        for (const pkg of catalog.packages) {
          modeLog(mode, `  ${pkg.name}  (${pkg.kind})`);
        }
      } catch (err) {
        handleDocsCommandError(mode, err);
      }
    });
}

export function createCatalogCommand(): Command {
  return new Command('catalog')
    .description('Inspect the Rayfin package discovery catalog.')
    .addCommand(createShowCommand());
}

export const catalogCommand = createCatalogCommand();
