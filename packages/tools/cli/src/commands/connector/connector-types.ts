import type {
  ConnectorType,
  ConnectorMeta,
} from '@microsoft/rayfin-tools-common/_internal/config';
import { CONNECTOR_CATALOG } from '@microsoft/rayfin-tools-common/_internal/config';
import { Command, Option } from 'commander';

import { listAuthorableConnectorTypes } from '../../utils/connector-authoring.js';
import {
  emitJson,
  emitJsonError,
  modeLog,
  resolveOutputMode,
  resolveRootOutputFlags,
  type OutputMode,
} from '../../utils/output-mode.js';
import { getPackageVersion } from '../../utils/version.js';

/**
 * Version of the `connector types --json` payload. Bumped only on a breaking
 * change to the shape; additive fields keep the same version.
 */
export const CONNECTOR_TYPES_SCHEMA_VERSION = 1;

interface ConnectorPackageRow {
  name: string;
  role: 'marker' | 'runtime';
  version: string;
}

interface ConnectorTypeRow {
  type: ConnectorType;
  category: ConnectorMeta['category'];
  description: string;
  defaultAuth: string;
  allowedAuthTypes: readonly string[];
  dialect: string | null;
  allowedOperations: readonly string[];
  requiredConfig: readonly string[];
  discoverableItemTypes: readonly string[];
  requiresVersion: boolean;
  defaultVersion?: string;
  packages: readonly ConnectorPackageRow[];
}

function buildRows(): ConnectorTypeRow[] {
  // Connector SDK packages are released in lockstep with the CLI, so the CLI's
  // own version is the version an agent should install.
  const version = getPackageVersion();
  return listAuthorableConnectorTypes()
    .sort((a, b) => a.localeCompare(b))
    .map((type) => {
      const meta = CONNECTOR_CATALOG[type];
      return {
        type,
        category: meta.category,
        description: meta.description,
        defaultAuth: meta.defaultAuth,
        allowedAuthTypes: [...meta.allowedAuthTypes],
        dialect: meta.dialect,
        allowedOperations: [...meta.allowedOperations],
        requiredConfig: [...meta.requiredConfigArgs],
        discoverableItemTypes: meta.discoverable ? [meta.fabricItemType] : [],
        requiresVersion: meta.requiresVersion,
        ...(meta.defaultVersion === undefined
          ? {}
          : { defaultVersion: meta.defaultVersion }),
        packages: meta.clientPackages.map((pkg) => ({
          name: pkg.name,
          role: pkg.role,
          version,
        })),
      };
    });
}

function printRows(
  mode: OutputMode,
  rows: ConnectorTypeRow[],
  verbose: boolean
) {
  modeLog(mode, `Supported connector types (${rows.length}):`);
  for (const row of rows) {
    modeLog(mode, `  - ${row.type}: ${row.description}`);
    if (verbose) {
      modeLog(mode, `    category: ${row.category}`);
      modeLog(mode, `    default auth: ${row.defaultAuth}`);
      modeLog(mode, `    dialect: ${row.dialect ?? 'none'}`);
      modeLog(mode, `    operations: ${row.allowedOperations.join(', ')}`);
      modeLog(
        mode,
        `    discoverable item types: ${row.discoverableItemTypes.join(', ') || 'none'}`
      );
      modeLog(mode, `    requires version: ${row.requiresVersion}`);
      if (row.defaultVersion) {
        modeLog(mode, `    default version: ${row.defaultVersion}`);
      }
      modeLog(
        mode,
        `    packages: ${row.packages.map((p) => `${p.name}@${p.version} (${p.role})`).join(', ')}`
      );
    }
  }
}

export const connectorTypesCommand = new Command('types')
  .description('List supported connector types')
  .addOption(
    new Option('--output <mode>', 'Output format for this command').choices([
      'interactive',
      'plain',
      'json',
    ])
  )
  .option('--json', 'Output as machine-readable JSON', false)
  .option('-v, --verbose', 'Include connector capability details', false)
  .action(function (
    this: Command,
    options: { output?: OutputMode; json?: boolean; verbose?: boolean }
  ) {
    const root = resolveRootOutputFlags(this);
    const mode = resolveOutputMode({
      json: Boolean(options.json) || root.json,
      output: options.output ?? root.output,
    });
    const verbose = Boolean(options.verbose) || root.verbose;

    if (mode === 'json' && verbose) {
      emitJsonError(mode, 'Cannot combine --verbose with --json.', {
        recovery:
          'Use --json for machine output, or drop --json to use verbose human-readable output.',
      });
    }

    const rows = buildRows();

    if (mode === 'json') {
      emitJson({
        status: 'ok',
        schemaVersion: CONNECTOR_TYPES_SCHEMA_VERSION,
        count: rows.length,
        types: rows,
      });
      return;
    }

    printRows(mode, rows, verbose);
  });
