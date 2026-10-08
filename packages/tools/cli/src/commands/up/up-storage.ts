import { Command } from 'commander';

import { applyStorageConfig } from '../../utils/apply-storage-config.js';
import {
  resolveOutputMode,
  resolveRootOutputFlags,
  emitJson,
  emitJsonError,
  formatDuration,
} from '../../utils/output-mode.js';

/**
 * Storage subcommand for remote deployment.
 * Provides 'rayfin up storage apply' functionality.
 */
export const upStorageCommand = new Command('storage')
  .description('Storage operations for remote Rayfin item deployment')
  .addCommand(
    new Command('apply')
      .description(
        'Generate and apply storage configuration to remote Rayfin item workload endpoint'
      )
      .option(
        '--force',
        'Force storage controller to accept configuration that may result in data loss',
        false
      )
      .option('--json', 'Output result as JSON', false)
      .action(async function (
        this: Command,
        options: {
          force?: boolean;
          json?: boolean;
        }
      ) {
        const root = resolveRootOutputFlags(this);
        const jsonFlag = Boolean(options.json) || root.json;
        const mode = resolveOutputMode({ json: jsonFlag });

        const resolvedForce =
          Boolean(options.force) || Boolean(this.optsWithGlobals().force);

        const startTime = Date.now();

        try {
          await applyStorageConfig({
            remote: true,
            force: resolvedForce,
            exitOnError: true,
            mode,
          });

          if (mode === 'json') {
            const duration = Date.now() - startTime;
            emitJson({
              status: 'success',
              duration: formatDuration(duration),
            });
          }
        } catch (error) {
          if (mode === 'json') {
            const duration = Date.now() - startTime;
            emitJsonError(mode, (error as Error).message, {
              duration: formatDuration(duration),
            });
          }
          throw error;
        }
      })
  );
