import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Command } from 'commander';
import ora from 'ora';

import { CliCancelledError, CliHandledError } from '../../errors.js';
import { resolveDockerComposeOverrides } from '../../local-services/dev/docker-lifecycle.js';
import { AgentFilesManager } from '../../services/agent-files/manager.js';
import { loadRayfinConfig } from '../../utils/config-utils.js';
import {
  copyOrOverwriteDockerComposeFile,
  extractProfilesFromComposeFile,
} from '../../utils/docker-compose-utils.js';
import {
  checkDockerAvailable,
  checkDockerComposeAvailable,
  purgeDockerServices,
  shutdownDockerServices,
  stopDockerServices,
  type ServiceConfig,
} from '../../utils/docker-utils.js';
import {
  readEnvFile,
  removePortVariables,
} from '../../utils/env-file-utils.js';
import { createCliFeatureFlags } from '../../utils/feature-flags.js';
import { warnAboutLegacyMigrations } from '../../utils/migration-utils.js';
import {
  createProgress,
  emitJsonError,
  isInteractive,
  modeError,
  modeLog,
  modeWarn,
  resolveOutputMode,
  resolveRootOutputFlags,
  type OutputMode,
  type ProgressIndicator,
  wrapOraSpinner,
} from '../../utils/output-mode.js';
import { findRayfinProjectRoot } from '../../utils/project-utils.js';

import { devDbCommand } from './dev-db.js';
import { devFunctionsCommand } from './dev-functions.js';
import { devStatusCommand } from './dev-status.js';
import { devStorageCommand } from './dev-storage.js';
import { watchCommand } from './watch.js';

interface DevOptions {
  stop: boolean;
  down: boolean;
  purge: boolean;
  verbose: boolean;
  exportEnv: boolean;
  skipDbApply: boolean;
  envFile?: string;
  provider?: string;
  tenant?: string;
  encryptionFallbackEnabled?: boolean;
  /** Fabric workspace display name for a first-run backend (v2 path). */
  workspace?: string;
  /** Fabric workspace GUID for a first-run backend (v2 path). */
  workspaceId?: string;
  capacityId?: string;
  /** When false, skip auto-running `rayfin env` after dev startup. */
  emitEnv?: boolean;
}

export interface DevConfig {
  projectRoot: string;
  projectName: string;
  composePath: string;
  healthTimeout: number;
  pollingInterval: number;
  ports: {
    webservice: number;
    sqlserver: number;
  };
  verbose: boolean;
  resetDockerComposeConfig?: boolean;
}

interface DevCommandBuildOptions {
  envFile?: string;
  processEnv?: typeof process.env;
  /** Test seam for retained Docker maintenance routing. */
  dockerMaintenanceEnabled?: boolean;
}

interface DevProgress extends ProgressIndicator {
  text: string;
  warn: (message?: string) => void;
}

const CONSTANTS = {
  PROJECT_NAME: 'rayfin',
  COMPOSE_PATH: 'rayfin/.temp/docker-compose.yml',
  DEFAULT_HEALTH_TIMEOUT: 60_000,
  DEFAULT_POLLING_INTERVAL: 2_000,
  PORTS: {
    WEBSERVICE: 5168,
    SQLSERVER: 1433,
  },
} as const;

function makeProgress(
  mode: OutputMode,
  message: string,
  emoji: string
): DevProgress {
  if (mode !== 'interactive') {
    const indicator = createProgress(mode, message, { prefix: '[rayfin dev]' });
    let text = message;
    return {
      ...indicator,
      get text() {
        return text;
      },
      set text(value: string) {
        text = value;
      },
      warn(warnMessage?: string) {
        if (mode === 'plain') {
          modeWarn(mode, `[rayfin dev] ⚠ ${warnMessage ?? message}`);
        }
      },
    };
  }

  const oraSpinner = ora({
    text: `${emoji} ${message}...`,
    color: 'blue',
  }).start();
  const wrapped = wrapOraSpinner(oraSpinner, message);
  return {
    ...wrapped,
    get text() {
      return oraSpinner.text;
    },
    set text(value: string) {
      oraSpinner.text = value;
    },
    warn(warnMessage?: string) {
      oraSpinner.warn(warnMessage ?? message);
    },
  };
}

function emitAiFilesDriftNudge(projectRoot: string, mode: OutputMode): void {
  try {
    const line = new AgentFilesManager(projectRoot).driftLine();
    if (line) {
      modeWarn(mode, `ℹ️  ${line}`);
    }
  } catch {
    // Agent-file drift is advisory and must never block maintenance actions.
  }
}

async function createDevConfig(
  projectPath: string,
  options: DevOptions
): Promise<DevConfig> {
  const startPath = resolve(process.cwd(), projectPath);
  const projectRoot = findRayfinProjectRoot(startPath, {
    silent: options.exportEnv,
  });

  if (!options.exportEnv) {
    warnAboutLegacyMigrations(projectRoot);
  }

  const rayfinConfig = loadRayfinConfig(projectRoot, {
    silent: options.exportEnv,
    envFile: options.envFile,
    command: 'dev',
  });

  return {
    projectRoot,
    projectName: rayfinConfig?.id || CONSTANTS.PROJECT_NAME,
    composePath: join(projectRoot, CONSTANTS.COMPOSE_PATH),
    healthTimeout: CONSTANTS.DEFAULT_HEALTH_TIMEOUT,
    pollingInterval: CONSTANTS.DEFAULT_POLLING_INTERVAL,
    ports: {
      webservice: CONSTANTS.PORTS.WEBSERVICE,
      sqlserver: CONSTANTS.PORTS.SQLSERVER,
    },
    verbose: options.verbose,
  };
}

async function validateDockerEnvironment(
  config: DevConfig,
  mode: OutputMode
): Promise<{ composeCommand: string }> {
  const dockerInfo = checkDockerAvailable();
  if (!dockerInfo.available) {
    throw new Error(`Docker Error: ${dockerInfo.error}`);
  }
  modeLog(mode, '✅ Docker is available:', dockerInfo.version);

  const composeInfo = checkDockerComposeAvailable();
  if (!composeInfo.available) {
    throw new Error(`Docker Compose Error: ${composeInfo.error}`);
  }
  modeLog(mode, '✅ Docker Compose is available:', composeInfo.version);

  const composeFileAlreadyExists = existsSync(config.composePath);
  const rayfinDir = join(config.projectRoot, 'rayfin');
  const { updated } = await copyOrOverwriteDockerComposeFile(
    rayfinDir,
    config.resetDockerComposeConfig
  );

  if (config.resetDockerComposeConfig) {
    modeLog(
      mode,
      '✅ Forced reset of docker-compose.yml due to configuration change'
    );
  } else if (!composeFileAlreadyExists) {
    modeLog(mode, '✅ Created docker-compose.yml');
  } else if (updated) {
    modeLog(mode, '✅ Updated docker-compose.yml (CLI version changed)');
  } else {
    modeLog(mode, '✅ docker-compose.yml is up to date');
  }

  return { composeCommand: composeInfo.command! };
}

async function createMaintenanceServiceConfig(
  config: DevConfig,
  mode: OutputMode
): Promise<ServiceConfig> {
  const { composeCommand } = await validateDockerEnvironment(config, mode);
  const profiles = await extractProfilesFromComposeFile(config.composePath);
  const overrides = resolveDockerComposeOverrides(config.projectRoot);
  const envFilePath = join(config.projectRoot, 'rayfin', '.env');
  return {
    composePath: config.composePath,
    additionalComposePaths: overrides.additionalComposePaths,
    composeCommand,
    projectName: config.projectName,
    projectDirectory: overrides.projectDirectory,
    envFilePath: existsSync(envFilePath) ? envFilePath : undefined,
    detach: false,
    pull: false,
    verbose: config.verbose,
    profiles,
  };
}

function failDevAction(mode: OutputMode, message: string, hint: string): never {
  if (mode === 'json') {
    emitJsonError(mode, message, { hint });
  }
  modeError(mode, `❌ ${message}`);
  modeError(mode, `   ${hint}`);
  throw new CliHandledError(new Error(message));
}

async function confirmPurge(mode: OutputMode, yes: boolean): Promise<void> {
  modeWarn(
    mode,
    '⚠️  Purge removes all local Docker containers and volumes, including database data.'
  );
  if (yes) return;
  if (mode === 'json' || !isInteractive()) {
    failDevAction(
      mode,
      'Purge requires confirmation in non-interactive mode.',
      'Re-run with `--yes` to confirm permanent data loss.'
    );
  }
  const { cliUserInteraction } =
    await import('../../adapters/user-interaction.js');
  const confirmed = await cliUserInteraction.confirm(
    'Purge all local Docker data when this operation completes?',
    { default: false }
  );
  if (!confirmed) {
    modeLog(mode, 'Operation cancelled.');
    throw new CliCancelledError();
  }
}

async function purgeDevEnvironment(
  config: DevConfig,
  mode: OutputMode
): Promise<void> {
  const serviceConfig = await createMaintenanceServiceConfig(config, mode);
  const progress = makeProgress(mode, 'Purging services and volumes', '🧹');
  try {
    await purgeDockerServices(serviceConfig);
    await removePortVariables(join(config.projectRoot, 'rayfin'));
    progress.succeed('Development environment purged successfully!');
  } catch (error) {
    progress.fail('Failed to purge services');
    throw error;
  }
}

async function stopDevEnvironment(
  config: DevConfig,
  mode: OutputMode
): Promise<void> {
  modeLog(mode, '🛑 Stopping Rayfin development environment...\n');
  const serviceConfig = await createMaintenanceServiceConfig(config, mode);
  const progress = makeProgress(mode, 'Stopping services', '🛑');

  try {
    await stopDockerServices(serviceConfig);
    await removePortVariables(join(config.projectRoot, 'rayfin'));
    progress.succeed('Development environment stopped successfully!');
  } catch (error) {
    progress.fail('Failed to stop services');
    throw error;
  }
}

async function shutdownDevEnvironment(
  config: DevConfig,
  mode: OutputMode
): Promise<void> {
  modeLog(mode, '🛑 Shutting down Rayfin development environment...\n');
  const serviceConfig = await createMaintenanceServiceConfig(config, mode);
  const progress = makeProgress(mode, 'Shutting down services', '🛑');

  try {
    await shutdownDockerServices(serviceConfig);
    await removePortVariables(join(config.projectRoot, 'rayfin'));
    progress.succeed('Development environment shut down successfully!');
  } catch (error) {
    progress.fail('Failed to shut down services');
    throw error;
  }
}

async function exportEnvVariables(
  config: DevConfig,
  mode: OutputMode
): Promise<void> {
  const envVars = await readEnvFile(join(config.projectRoot, 'rayfin'));
  for (const envVar of envVars) {
    modeLog(mode, `${envVar.key}=${envVar.value}`);
  }
}

/** Return whether an invocation belongs to the retained Docker maintenance path. */
export function isDevMaintenanceAction(
  options: Pick<DevOptions, 'stop' | 'down' | 'exportEnv'>
): boolean {
  return options.stop || options.down || options.exportEnv;
}

async function runDevMaintenance(
  projectPath: string,
  options: DevOptions,
  mode: OutputMode,
  dockerEnabled: boolean,
  yes: boolean
): Promise<void> {
  if (!dockerEnabled) {
    const message = 'Docker maintenance actions are not available.';
    modeError(mode, `❌ ${message}`);
    modeError(
      mode,
      '   Enable Docker local development before retrying this action.'
    );
    throw new CliHandledError(new Error(message));
  }

  try {
    const config = await createDevConfig(projectPath, options);
    if (!options.exportEnv) {
      emitAiFilesDriftNudge(config.projectRoot, mode);
    }

    if (options.purge) {
      await confirmPurge(mode, yes);
      await purgeDevEnvironment(config, mode);
    } else if (options.exportEnv) {
      await exportEnvVariables(config, mode);
    } else if (options.stop) {
      await stopDevEnvironment(config, mode);
    } else if (options.down) {
      await shutdownDevEnvironment(config, mode);
    }
  } catch (error) {
    if (error instanceof CliCancelledError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    modeError(mode, `❌ Error: ${message}`);
    modeError(
      mode,
      '   Resolve the reported issue, then retry the Docker maintenance action.'
    );
    throw new CliHandledError(error);
  }
}

export const dev = (
  startPath: string = process.cwd(),
  buildOptions: DevCommandBuildOptions = {}
) => {
  const featureFlags = createCliFeatureFlags(startPath, {
    command: 'dev',
    envFile: buildOptions.envFile,
    processEnv: buildOptions.processEnv,
    silent: true,
  });

  const command = new Command('dev')
    .description('Start a local development session against a Rayfin backend')
    .argument(
      '[project-path]',
      'Path to the project root directory (defaults to current directory)',
      '.'
    )
    .option('--stop', 'Stop the Docker provider services', false)
    .option(
      '--down',
      'Shut down Docker provider services and remove containers while preserving data',
      false
    )
    .option(
      '--purge',
      'Purge Docker volumes when the session ends; combine with --down for immediate purge',
      false
    )
    .option(
      '--export-env',
      'Export Docker provider environment variables to stdout in .env format',
      false
    )
    .option(
      '--skip-db-apply',
      'Skip automatic database configuration apply',
      false
    )
    .option(
      '--env-file <path>',
      'Path to .env file for rayfin.yml interpolation (defaults to rayfin/.env)',
      undefined
    )
    .option(
      '--provider <provider>',
      'Backend provider for managed Rayfin services (fabric | docker; defaults to fabric)',
      'fabric'
    )
    .option(
      '-w, --workspace <name>',
      'Fabric workspace display name to provision a first-run backend into (resolved to ID via the Fabric API)'
    )
    .option(
      '--workspace-id <id>',
      'Fabric workspace GUID to provision a first-run backend into'
    )
    .option(
      '--capacity-id <id>',
      'ID of the Fabric capacity to assign when the target workspace has no usable capacity'
    )
    .option(
      '-t, --tenant <id>',
      'Entra ID tenant GUID. Use when your account spans multiple tenants'
    )
    .option(
      '--encryption-fallback-enabled',
      'Allow plaintext token storage when the OS keychain is unavailable. Required only when login fails with a keychain error.',
      false
    )
    .option(
      '--no-emit-env',
      'Skip auto-regenerating the framework .env.local. The CLI will leave any existing .env.local untouched; your dev server will use whatever values are already there (or fail with missing-env errors if none exist). Useful when you manage .env.local by hand.'
    )
    .option('-v, --verbose', 'Enable verbose logging', false)
    .action(
      async (
        projectPath: string,
        parsedOptions: DevOptions,
        action: Command
      ) => {
        const root = resolveRootOutputFlags(action);
        const globalYes = action.optsWithGlobals().yes ?? false;
        const options: DevOptions = {
          ...parsedOptions,
          verbose: Boolean(parsedOptions.verbose) || root.verbose,
        };

        const mode = resolveOutputMode({
          json: root.json,
          output: root.output,
        });
        if (options.purge && (options.stop || options.exportEnv)) {
          const message =
            '`--purge` cannot be combined with `--stop` or `--export-env`.';
          failDevAction(
            mode,
            message,
            'Use `--down --purge` for immediate cleanup, or `--provider docker --purge` for session teardown.'
          );
        }

        if (!isDevMaintenanceAction(options)) {
          if (options.purge && options.provider !== 'docker') {
            const message = '`--purge` requires `--provider docker`.';
            failDevAction(
              mode,
              message,
              'Re-run with `--provider docker --purge`, or omit `--purge` for Fabric.'
            );
          }
          if (options.purge) {
            await confirmPurge(mode, globalYes);
          }
          const { runDevV2 } = await import('./dev-v2.js');
          return runDevV2(projectPath, {
            provider: options.provider,
            purge: options.purge,
            skipDataApply: options.skipDbApply,
            envFile: options.envFile,
            emitEnv: options.emitEnv,
            workspace: options.workspace,
            workspaceId: options.workspaceId,
            capacityId: options.capacityId,
            tenant: options.tenant,
            encryptionFallbackEnabled: options.encryptionFallbackEnabled,
            verbose: options.verbose,
            json: root.json,
            output: root.output,
            yes: globalYes,
          });
        }

        return runDevMaintenance(
          projectPath,
          options,
          mode,
          buildOptions.dockerMaintenanceEnabled ??
            featureFlags.get('docker-local-dev') === true,
          globalYes
        );
      }
    );

  if (featureFlags.get('docker-local-dev') === true) {
    command.addCommand(devDbCommand).addCommand(devStatusCommand);
  }

  if (featureFlags.get('storage') === true) {
    command.addCommand(devStorageCommand);
  }

  command.addCommand(devFunctionsCommand);

  if (featureFlags.get('docker-local-dev') === true) {
    command.addCommand(devWatchCommand);
  }

  return command;
};

const devWatchCommand = watchCommand
  .copyInheritedSettings(new Command('watch'))
  .description(
    'Watch ./rayfin/data or ./rayfin/storage and auto-apply config to local development server'
  );

export const devCommand = dev();
