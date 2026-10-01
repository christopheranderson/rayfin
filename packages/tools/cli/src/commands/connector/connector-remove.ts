import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

import type { ConnectorEntry } from '@microsoft/rayfin-tools-common/_internal/config';
import { normalizeConnectorsBlock } from '@microsoft/rayfin-tools-common/_internal/config';
import { Command } from 'commander';
import inquirer from 'inquirer';
import { parse, stringify } from 'yaml';

import { CliHandledError } from '../../errors.js';
import { removeConnectorArtifacts } from '../../services/connector-artifacts.js';
import {
  regenerateConnectorWiring,
  reportConnectorWiring,
} from '../../services/connector-wiring.js';
import {
  emitJson,
  emitJsonError,
  isInteractive,
  modeError,
  modeLog,
  resolveCommandFlags,
} from '../../utils/output-mode.js';
import { findRayfinProjectRoot } from '../../utils/project-utils.js';

export const connectorRemoveCommand = new Command('remove')
  .description('Remove a data source from your Rayfin project')
  .argument('<name>', 'Name of the source to remove')
  .option('-v, --verbose', 'Enable verbose output', false)
  .option('-y, --yes', 'Auto-accept all confirmation prompts', false)
  .option('--json', 'Emit machine-readable JSON output', false)
  .action(async (name: string, _options, command: Command) => {
    const { mode, verbose, yes } = resolveCommandFlags(command);

    const projectRoot = findRayfinProjectRoot(process.cwd(), {
      verbose,
    });
    const rayfinYmlPath = resolve(projectRoot, 'rayfin', 'rayfin.yml');

    if (!existsSync(rayfinYmlPath)) {
      const message = 'No rayfin.yml found. Run `rayfin init` first.';
      if (mode === 'json') {
        emitJsonError(mode, message);
      }
      modeError(mode, message);
      throw new CliHandledError(message);
    }

    const yamlContent = readFileSync(rayfinYmlPath, 'utf-8');
    const config = parse(yamlContent) as Record<string, unknown>;
    const connectors: ConnectorEntry[] =
      normalizeConnectorsBlock(config.connectors) ?? [];

    if (!connectors.some((e) => e.name === name)) {
      // No-op: removing something that doesn't exist isn't a failure,
      // just tell the Builder and exit cleanly. This flag-free path only
      // covers the not-declared case; removing an existing connector in a
      // non-interactive context (CI, non-TTY) still requires `--yes`.
      const declaredNames = connectors.map((e) => e.name);
      if (mode === 'json') {
        emitJson({
          status: 'success',
          action: 'connector.remove',
          name,
          removed: false,
          reason: 'not-declared',
          declaredConnectors: declaredNames,
        });
        return;
      }
      const declared = declaredNames.join(', ');
      const hint = declared
        ? ` Declared connectors: ${declared}.`
        : ' No connectors are declared in rayfin.yml.';
      modeLog(
        mode,
        `Connector "${name}" is not declared in rayfin.yml — nothing to remove.${hint}`
      );
      return;
    }

    if (!yes) {
      if (mode !== 'json' && isInteractive({ yes })) {
        const { confirm } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: `Remove connector "${name}" from rayfin.yml?`,
            default: false,
          },
        ]);
        if (!confirm) {
          modeLog(mode, 'Cancelled.');
          return;
        }
      } else {
        const summary = `Refusing to remove connector "${name}" without confirmation.`;
        const hint =
          'Re-run with --yes to remove the connector in a non-interactive context.';

        modeError(mode, `❌ ${summary}`);
        modeError(mode, `   ${hint}`);
        emitJsonError(mode, `${summary} ${hint}`, {
          action: 'connector.remove',
          name,
        });
      }
    }

    // Remove from YAML (always write the array form)
    const remaining = connectors.filter((e) => e.name !== name);
    if (remaining.length === 0) {
      delete config.connectors;
    } else {
      config.connectors = remaining;
    }
    writeFileSync(rayfinYmlPath, stringify(config, { lineWidth: 0 }));

    // Remove the connector directory and temp artifacts unconditionally.
    // Removing a connector from rayfin.yml implies removing its on-disk
    // representation — there is no meaningful half-removed state where
    // rayfin.yml has no entry but the scaffold and temp files still exist.
    const { connectorDirRemoved } = removeConnectorArtifacts(projectRoot, name);

    // Keep the app-side wiring a pure function of rayfin.yml: regenerate from
    // what remains so the removed connector stops being imported.
    const wiring = regenerateConnectorWiring(projectRoot, remaining);
    reportConnectorWiring(mode, wiring, verbose);

    if (connectorDirRemoved) {
      modeLog(
        mode,
        `✅ Connector "${name}" removed from rayfin.yml and rayfin/connectors/${name}/ deleted.`
      );
    } else {
      modeLog(mode, `✅ Connector "${name}" removed from rayfin.yml.`);
    }

    if (mode === 'json') {
      emitJson({
        status: 'success',
        action: 'connector.remove',
        name,
        removed: true,
        directoryDeleted: connectorDirRemoved,
        // `reportConnectorWiring` writes through modeLog/modeWarn, which no-op
        // in JSON mode. Surface the wiring outcome here so `--json` callers can
        // see whether the app file was rewritten or left for a manual edit.
        wiring,
      });
    }
  });
