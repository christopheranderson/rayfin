import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import { CONNECTOR_CATALOG } from '@microsoft/rayfin-tools-common/_internal/config';
import { Command } from 'commander';

import { loadRayfinConfig } from '../../utils/config-utils.js';
import {
  emitJson,
  modeLog,
  resolveCommandFlags,
} from '../../utils/output-mode.js';
import { findRayfinProjectRoot } from '../../utils/project-utils.js';
import { formatTable } from '../../utils/table.js';

export const connectorListCommand = new Command('list')
  .description('List all configured connectors')
  .option('-v, --verbose', 'Enable verbose output', false)
  .option('--json', 'Emit machine-readable JSON output', false)
  .action((_options, command: Command) => {
    const { mode, verbose } = resolveCommandFlags(command);

    const projectRoot = findRayfinProjectRoot(process.cwd(), {
      silent: true,
    });
    const config = loadRayfinConfig(projectRoot, {
      silent: true,
    }) as RayfinConfig;
    const connectors = config.connectors ?? [];

    if (mode === 'json') {
      emitJson(connectors);
      return;
    }

    if (connectors.length === 0) {
      modeLog(
        mode,
        'No connectors configured. Use `rayfin connector add` to add one.'
      );
      return;
    }

    if (verbose) {
      // Verbose: per-connector block with catalog-driven metadata so a
      // Builder can see what the connector supports without grepping the
      // catalog or the host docs.
      modeLog(
        mode,
        `\nConnectors declared in rayfin.yml (${connectors.length}):`
      );
      for (const entry of connectors) {
        const meta = CONNECTOR_CATALOG[entry.type];
        const wsId = entry.config?.workspaceId ?? '—';
        const itemId = entry.config?.itemId ?? '—';
        const description = meta?.description ?? '(unknown connector type)';
        const dialect =
          meta?.dialect ?? '— (no SQL dialect; GraphQL apply not supported)';
        const auth = entry.auth?.type ?? meta?.defaultAuth ?? '—';
        const allowedOps = meta?.allowedOperations.join(', ') ?? '—';

        modeLog(mode, '');
        modeLog(mode, `    Name:               ${entry.name}`);
        modeLog(mode, `    Type:               ${entry.type}`);
        modeLog(mode, `    Description:        ${description}`);
        modeLog(mode, `    Workspace ID:       ${wsId}`);
        modeLog(mode, `    Item ID:            ${itemId}`);
        modeLog(mode, `    Dialect:            ${dialect}`);
        modeLog(mode, `    Auth:               ${auth}`);
        modeLog(mode, `    Allowed operations: ${allowedOps}`);
      }
      modeLog(mode, '');
      return;
    }

    // Column widths follow the data — a name like `adventure-works-dw-2020`
    // used to overflow a hardcoded pad and shift every later column.
    const rows = connectors.map((entry) => [
      entry.name,
      entry.type,
      entry.config?.workspaceId ?? '—',
      entry.config?.itemId ?? '—',
    ]);

    modeLog(mode, '');
    for (const line of formatTable(
      ['Name', 'Type', 'Workspace ID', 'Item ID'],
      rows
    )) {
      modeLog(mode, line);
    }

    modeLog(mode, '');
  });
