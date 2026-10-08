import { cancellationTokenFromSignal } from '@microsoft/rayfin-tools-common/_internal/adapters';
import { runUpStatusWorkflow } from '@microsoft/rayfin-tools-common/_internal/workflows';
import { Command } from 'commander';

import { createCommandOutput } from '../../adapters/command-output.js';
import { getFabricSettings } from '../../config/constants.js';
import { getAmbientWorkspaceId } from '../../utils/ambient-env.js';
import { createCliFeatureFlags } from '../../utils/feature-flags.js';

import { createUpStatusDeps } from './up-status-deps.js';
import { renderUpStatusResult } from './up-status-render.js';

export const upStatusCommand = new Command('status')
  .description('Display the status of the cloud deployment')
  .option('--json', 'Output status in JSON format', false)
  .option('-v, --verbose', 'Enable verbose output')
  .action(async function (this: Command) {
    const flags = createCliFeatureFlags(process.cwd(), { silent: true });
    if (flags.get('tools-arch-v2') !== true) {
      const { runUpStatusLegacy } = await import('./up-status-legacy.js');
      return runUpStatusLegacy.call(this);
    }
    const output = createCommandOutput(this);
    const options = this.optsWithGlobals();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    try {
      const result = await runUpStatusWorkflow(
        {
          projectPath: process.cwd(),
          deploymentName:
            typeof options.envFile === 'string' ? options.envFile : undefined,
          workspaceId: getAmbientWorkspaceId() ?? undefined,
        },
        createUpStatusDeps(
          output.diagnostics,
          cancellationTokenFromSignal(controller.signal)
        )
      );
      process.exitCode = renderUpStatusResult(
        result,
        output,
        getFabricSettings().fabricPortalUrl
      );
    } finally {
      process.removeListener('SIGINT', cancel);
    }
  });
