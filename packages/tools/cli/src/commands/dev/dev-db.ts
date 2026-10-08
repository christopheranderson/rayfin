import { Dialect, DatabaseDialect } from '@microsoft/rayfin-core/analysis';
import { Command } from 'commander';

import { CliHandledError } from '../../errors.js';
import { applyDbConfig } from '../../utils/apply-db-config.js';
import {
  loadRayfinConfig,
  resolveServiceRoot,
} from '../../utils/config-utils.js';
import { generateDabConfig } from '../../utils/dab-config-generator.js';
import {
  modeLog,
  modeError,
  modeWarn,
  resolveOutputMode,
  resolveRootOutputFlags,
} from '../../utils/output-mode.js';
import { findRayfinProjectRoot } from '../../utils/project-utils.js';

/**
 * DB subcommand for local development.
 * Provides 'rayfin dev db apply' functionality.
 */
export const devDbCommand = new Command('db')
  .description('Database operations for local development')
  .addCommand(
    new Command('apply')
      .description(
        'Generate and apply DAB configuration to local development server'
      )
      .option(
        '--force',
        'Force DAB controller to accept configuration that may result in data loss',
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
        const mode = resolveOutputMode({
          json: resolveRootOutputFlags(this).json,
        });

        // Get grandparent command options (from 'rayfin dev')
        // Command hierarchy: dev -> db -> apply
        const grandparentOpts = this.parent?.parent?.opts() as
          | { envFile?: string }
          | undefined;

        // Load rayfin.yml to get the dialect configuration
        const projectRoot = findRayfinProjectRoot(process.cwd());
        const rayfinConfig = loadRayfinConfig(projectRoot, {
          envFile: grandparentOpts?.envFile,
        });

        const configuredDialect = rayfinConfig?.services?.data
          ?.dialect as Dialect;

        if (!configuredDialect) {
          modeWarn(
            mode,
            '⚠️  Warning: Database dialect not configured in rayfin.yml, defaulting to mssql'
          );
        }

        const dialect = configuredDialect || DatabaseDialect.MsSql;
        const dataServiceRoot = resolveServiceRoot(
          projectRoot,
          'data',
          rayfinConfig?.services?.data?.path ?? '.'
        );

        if (options.genConfigOnly) {
          // Only generate configuration without applying
          try {
            const result = await generateDabConfig({
              dialect,
              verbose: true,
              serviceRoot: dataServiceRoot,
              buildCommand: rayfinConfig?.services?.data?.buildCommand,
            });

            if (result.entities.length === 0) {
              modeLog(
                mode,
                'ℹ️  No entity classes found — skipping configuration generation.'
              );
              return;
            }

            modeLog(mode, `\n✅ DAB configuration generated successfully`);
            modeLog(mode, `📄 Output: ${result.configPath}`);
            modeLog(mode, `📊 Entities: ${result.entities.length}`);
            modeLog(mode, `🗄️  Database: ${result.dialect.toUpperCase()}`);
            modeLog(mode, `⏱️  Duration: ${result.duration}ms`);
          } catch (error) {
            modeError(mode, '❌ Failed to generate DAB configuration:');
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

          // Use shared applyDbConfig function with remote: false
          await applyDbConfig({
            remote: false,
            force: resolvedForce,
            exitOnError: true,
            dialect,
            mode,
            serviceRoot: dataServiceRoot,
          });
        }
      })
  );
