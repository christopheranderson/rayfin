import { Command } from 'commander';

import { CliHandledError } from '../../errors.js';
import { generateConnectorDabConfigs } from '../../services/connector-generator.js';
import { loadRayfinConfig } from '../../utils/config-utils.js';
import {
  applyConnectorConfigs,
  detectConnectorEntityCollisions,
  detectReservedConnectorEntityNames,
  formatConnectorEntityCollisionError,
  formatReservedConnectorEntityNameError,
  selectConnectorsToApply,
} from '../../utils/connector-apply.js';
import {
  OUTPUT_MODE,
  resolveOutputMode,
  resolveRootOutputFlags,
  createVerboseLogger,
  modeLog,
  modeError,
  emitJson,
  emitJsonError,
  formatDuration,
} from '../../utils/output-mode.js';
import { findRayfinProjectRoot } from '../../utils/project-utils.js';
import {
  getActiveDeploymentEnvVars,
  getRemoteAuthorizationHeader,
  getRemoteEndpoint,
  hasRemoteEndpoint,
} from '../../utils/remote-endpoint-utils.js';

/**
 * Roll the two-step connector pipeline (generate + apply) into a single JSON
 * envelope status. A generation error excludes its connector from apply, so the
 * apply `results` alone can look clean; the generation outcome must therefore be
 * factored in or automation would read `success` despite a failed connector.
 */
export function resolveConnectorApplyStatus(
  generateResults: readonly { status: 'generated' | 'skipped' | 'error' }[],
  applyResults: readonly { status: 'success' | 'skipped' | 'error' }[]
): 'success' | 'partial' {
  const hasError =
    generateResults.some((r) => r.status === 'error') ||
    applyResults.some((r) => r.status === 'error');
  return hasError ? 'partial' : 'success';
}

/**
 * Connector subcommand for remote deployment.
 *
 * Provides `rayfin up connector apply` — runs the same two-step pipeline
 * `rayfin up` runs inline (generate per-connector `dab-config.json`, then
 * POST it to the workload's `/__private/connectors/<name>/applyconfig`
 * endpoint). Runtime settings are NOT re-posted here; if a connector
 * isn't registered server-side yet the helper surfaces a "run `rayfin up`
 * first" hint on `UNKNOWN_CONNECTOR`.
 */
export const upConnectorCommand = new Command('connector')
  .description(
    'Connector operations for remote Rayfin item deployment (preview)'
  )
  .addCommand(
    new Command('apply')
      .description(
        'Generate and apply DAB configuration for each declared GraphQL connector'
      )
      .option(
        '--name <name>',
        'Apply only the named connector instead of every entry in rayfin.yml'
      )
      .option('-v, --verbose', 'Enable verbose output', false)
      .option('--json', 'Output result as JSON', false)
      .action(async function (
        this: Command,
        options: {
          name?: string;
          verbose?: boolean;
          json?: boolean;
        }
      ) {
        const root = resolveRootOutputFlags(this);
        const resolvedVerbose = Boolean(options.verbose) || root.verbose;
        const jsonFlag = Boolean(options.json) || root.json;
        const mode = resolveOutputMode({ json: jsonFlag });
        const verbose = createVerboseLogger(resolvedVerbose);

        const startTime = Date.now();

        try {
          if (!hasRemoteEndpoint()) {
            const msg =
              'No remote endpoint configured. Run `rayfin up` first to deploy and register connectors.';
            if (mode === OUTPUT_MODE.Json) {
              emitJsonError(mode, msg);
            }
            modeError(mode, `❌ ${msg}`);
            throw new CliHandledError(new Error(msg));
          }

          const itemEndpoint = getRemoteEndpoint();
          const envVars = getActiveDeploymentEnvVars();
          if (!itemEndpoint || !envVars?.rayfinItemId) {
            const msg = 'Could not resolve remote workload endpoint.';
            if (mode === OUTPUT_MODE.Json) {
              emitJsonError(mode, msg);
            }
            modeError(mode, `❌ ${msg}`);
            throw new CliHandledError(new Error(msg));
          }

          const projectRoot = findRayfinProjectRoot(process.cwd(), {
            verbose: false,
            silent: true,
          });

          const rayfinConfig = loadRayfinConfig(projectRoot, { silent: true });
          if (!rayfinConfig) {
            const msg = 'Could not load rayfin.yml configuration';
            if (mode === OUTPUT_MODE.Json) {
              emitJsonError(mode, msg);
            }
            modeError(mode, `❌ ${msg}`);
            throw new CliHandledError(new Error(msg));
          }

          if (
            !rayfinConfig.connectors ||
            rayfinConfig.connectors.length === 0
          ) {
            const msg = 'No connectors declared in rayfin.yml.';
            if (mode === OUTPUT_MODE.Json) {
              emitJson({ status: 'success', results: [], steps: {} });
            } else {
              modeLog(mode, `${msg} Use \`rayfin connector add\` to add one.`);
            }
            return;
          }

          if (
            options.name &&
            !rayfinConfig.connectors.some((e) => e.name === options.name)
          ) {
            const declared = rayfinConfig.connectors
              .map((e) => e.name)
              .join(', ');
            const msg = `Connector "${options.name}" is not declared in rayfin.yml. Declared connectors: ${declared}.`;
            if (mode === OUTPUT_MODE.Json) {
              emitJsonError(mode, msg);
            }
            modeError(mode, `❌ ${msg}`);
            throw new CliHandledError(new Error(msg));
          }

          const targetNames = options.name
            ? [options.name]
            : rayfinConfig.connectors.map((e) => e.name);

          // Step 1 — generate dab-config.json for each target connector.
          // Non-target connectors aren't touched on disk.
          modeLog(mode, '\n🧬 Generating connector configs...');
          const generateOutcome = await generateConnectorDabConfigs({
            projectRoot,
            connectors: rayfinConfig.connectors,
            connectorNames: targetNames,
            verbose: resolvedVerbose,
            mode,
          });

          // Step 2 — POST each generated config to the workload.
          const connectorsToApply = selectConnectorsToApply(
            rayfinConfig.connectors,
            generateOutcome.generated
          );

          // Validate only configs that will be POSTed. Other .temp configs may
          // be stale after a generation skip/failure; the workload remains
          // authoritative for collisions with already deployed connectors.
          const applyNames = connectorsToApply.map((entry) => entry.name);

          const reserved = detectReservedConnectorEntityNames(
            projectRoot,
            applyNames
          );
          if (reserved.length > 0) {
            const msg = formatReservedConnectorEntityNameError(reserved);
            if (mode === OUTPUT_MODE.Json) {
              emitJsonError(mode, msg);
            }
            modeError(mode, `❌ ${msg}`);
            throw new CliHandledError(new Error(msg));
          }

          const collisions = detectConnectorEntityCollisions(
            projectRoot,
            applyNames
          );
          if (collisions.length > 0) {
            const msg = formatConnectorEntityCollisionError(collisions);
            if (mode === OUTPUT_MODE.Json) {
              emitJsonError(mode, msg);
            }
            modeError(mode, `❌ ${msg}`);
            throw new CliHandledError(new Error(msg));
          }

          const authorizationHeader = await getRemoteAuthorizationHeader();
          modeLog(mode, '\n🔌 Applying connector configurations...');
          const { results, steps } = await applyConnectorConfigs({
            itemEndpoint,
            rayfinItemId: envVars.rayfinItemId,
            authorizationHeader,
            projectRoot,
            connectors: connectorsToApply,
            mode,
            verbose,
            connectorFilter: options.name,
            context: 'standalone',
          });

          const duration = Date.now() - startTime;
          if (mode === OUTPUT_MODE.Json) {
            emitJson({
              status: resolveConnectorApplyStatus(
                generateOutcome.results,
                results
              ),
              generate: generateOutcome.results,
              results,
              steps,
              duration: formatDuration(duration),
            });
          } else {
            const ok = results.filter((r) => r.status === 'success').length;
            const skipped = results.filter(
              (r) => r.status === 'skipped'
            ).length;
            const generateFailed = generateOutcome.results.filter(
              (r) => r.status === 'error'
            ).length;
            const failed =
              results.filter((r) => r.status === 'error').length +
              generateFailed;
            modeLog(
              mode,
              `\n📝 Connector apply summary: ${ok} applied, ${skipped} skipped, ${failed} failed`
            );
          }
        } catch (error) {
          if (error instanceof CliHandledError) {
            throw error;
          }
          if (mode === OUTPUT_MODE.Json) {
            emitJsonError(mode, (error as Error).message);
          }
          modeError(
            mode,
            `❌ Connector apply failed: ${(error as Error).message}`
          );
          throw new CliHandledError(error);
        }
      })
  );
