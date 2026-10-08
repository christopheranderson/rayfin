import { Command } from 'commander';

import { CliHandledError } from '../../errors.js';
import { applyStorageConfig } from '../../utils/apply-storage-config.js';
import {
  modeLog,
  modeError,
  resolveOutputMode,
  resolveRootOutputFlags,
} from '../../utils/output-mode.js';
import { generateStorageConfig } from '../../utils/storage-config-generator.js';

/**
 * Storage subcommand for local development.
 * Provides 'rayfin dev storage apply' functionality.
 */
export const devStorageCommand = new Command('storage')
  .description('Storage operations for local development')
  .addCommand(
    new Command('apply')
      .description(
        'Generate and apply storage configuration to local development server'
      )
      .option(
        '--force',
        'Force storage controller to accept configuration that may result in data loss',
        false
      )
      .option(
        '--gen-config-only',
        'Generate configuration without applying to server',
        false
      )
      .action(async function (
        this: Command,
        options: { force?: boolean; genConfigOnly?: boolean }
      ) {
        // Honor `rayfin --json dev storage apply` by resolving the
        // root-level flag, matching the pattern used by the sibling
        // `dev db apply` command (see `dev-db.ts`).
        const mode = resolveOutputMode({
          json: resolveRootOutputFlags(this).json,
        });

        if (options.genConfigOnly) {
          // Only generate configuration without applying
          try {
            const result = await generateStorageConfig({
              verbose: true,
            });

            modeLog(mode, `✅ Storage configuration generated successfully`);
            modeLog(mode, `📄 Config written to: ${result.configPath}`);
            modeLog(
              mode,
              `📊 Generated ${result.folders.length} storage folders`
            );
            modeLog(mode, `⏱️  Completed in ${result.duration}ms`);
          } catch (error) {
            modeError(mode, '❌ Failed to generate storage configuration:');
            modeError(
              mode,
              error instanceof Error ? error.message : String(error)
            );
            throw new CliHandledError(error);
          }
        } else {
          // OR-merge the subcommand's own `--force` with any ancestor that
          // declares the same option. Commander binds a `--force` token to the
          // nearest ancestor command that declares it, which would otherwise
          // leave this subcommand's `options.force` at its `false` default.
          const resolvedForce =
            Boolean(options.force) || Boolean(this.optsWithGlobals().force);

          // Use shared applyStorageConfig function with remote: false
          await applyStorageConfig({
            remote: false,
            force: resolvedForce,
            exitOnError: true,
            mode,
          });
        }
      })
  );
