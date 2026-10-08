/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { join } from 'path';

import { Command } from 'commander';

import { loadAuthState } from '../../auth/state.js';
import {
  deploymentToPublicEnv,
  getActiveDeployment,
  getDeployment,
  listDeployments,
  sanitizeWorkspaceName,
  setActiveDeployment,
} from '../../utils/deployments-registry.js';
import { replaceDeploymentEnvInFile } from '../../utils/env-file-utils.js';
import { createCliFeatureFlags } from '../../utils/feature-flags.js';
import { detectFrontendFramework } from '../../utils/frontend-detect.js';
import { findRayfinProjectRoot } from '../../utils/project-utils.js';
import { writeFrameworkEnvFile } from '../env/env.js';

/**
 * Select a recorded deployment and rewrite env output for it.
 * Use `--list` to inspect records, or `--workspace-id` to target by Fabric ID.
 */
export const upSwitchCommand = new Command('switch')
  .description(
    'Switch the active Fabric deployment (rewrites rayfin/.env accordingly)'
  )
  .argument('[workspace]', 'Workspace name (or slug) to activate')
  .option(
    '--workspace-id <id>',
    'Fabric workspace ID to activate (resolved against the recorded deployments)'
  )
  .option('-l, --list', 'List recorded deployments for this project')
  .option(
    '--no-emit-env',
    'Skip auto-regenerating the framework .env.local. The CLI will leave any existing .env.local untouched; your dev server will use whatever values are already there (or fail with missing-env errors if none exist). Useful when you manage .env.local by hand.'
  )
  .action(
    async (
      workspace: string | undefined,
      options: { emitEnv?: boolean; list?: boolean; workspaceId?: string },
      command: Command
    ) => {
      const workspaceId =
        options.workspaceId ??
        (command.optsWithGlobals().workspaceId as string | undefined);
      let projectRoot: string;
      try {
        projectRoot = findRayfinProjectRoot(process.cwd());
      } catch {
        console.error('❌ Not inside a Rayfin project (no `rayfin/` folder).');
        process.exit(1);
      }

      const minorFixesOn =
        createCliFeatureFlags(projectRoot).get('cli-minor-fixes') === true;

      // Only --list dumps the registry; bare invocation requires a target.
      if (options.list) {
        const all = listDeployments(projectRoot);
        if (all.length === 0) {
          console.log(
            'No deployments found. Run `rayfin up` to deploy to a Fabric workspace.'
          );
          return;
        }
        const active = getActiveDeployment(projectRoot);
        console.log('Recorded workspaces:');
        for (const d of all) {
          const marker = d.active ? '* ' : '  ';
          console.log(`${marker}${d.workspaceName}`);
        }
        if (active) {
          console.log(`\nActive: ${active.workspaceName}`);
        }
        return;
      }

      // Require an explicit workspace target with actionable usage text.
      if (!workspace && !workspaceId) {
        console.error(
          'Please provide a workspace to switch the deployment to.'
        );
        console.error(
          'Usage: rayfin up switch <workspace>  (see `rayfin up list` for details)'
        );
        process.exit(1);
      }

      // `--workspace-id` takes precedence over the positional name/slug.
      let slug: string | undefined;
      let record: ReturnType<typeof getDeployment> = null;
      if (workspaceId) {
        const all = listDeployments(projectRoot);
        const match = all.find((d) => d.record.workspaceId === workspaceId);
        if (match) {
          slug = match.workspaceName;
          record = match.record;
        }
      } else if (workspace) {
        slug = sanitizeWorkspaceName(workspace);
        record = getDeployment(projectRoot, slug);
      }

      if (!record || !slug) {
        const target = workspaceId
          ? `workspace-id "${workspaceId}"`
          : `workspace "${workspace}"`;
        console.error(`❌ No deployment found for ${target}.`);
        const all = listDeployments(projectRoot);
        if (all.length > 0) {
          console.error('   Known deployments:');
          for (const d of all) {
            console.error(
              minorFixesOn
                ? `   - ${d.workspaceName} (workspace-id: ${d.record.workspaceId})`
                : `   - ${d.workspaceName}`
            );
          }
        } else if (minorFixesOn) {
          console.error(
            '   No deployments recorded yet. Run `rayfin up` to deploy to a Fabric workspace and register it.'
          );
        }
        process.exit(1);
      }

      if (minorFixesOn) {
        const activeBefore = getActiveDeployment(projectRoot);
        if (activeBefore?.workspaceName === slug) {
          console.log(`✅ Already active: ${slug}`);
          console.log('   Nothing to do.');
          return;
        }
      }

      if (!setActiveDeployment(projectRoot, slug)) {
        // Unreachable — getDeployment above guarantees presence.
        console.error(`❌ Failed to set "${slug}" as active.`);
        process.exit(1);
      }

      const rayfinDir = join(projectRoot, 'rayfin');
      await replaceDeploymentEnvInFile(
        rayfinDir,
        deploymentToPublicEnv(record)
      );
      console.log(`✅ Active deployment: ${slug}`);
      console.log(`   Updated rayfin/.env with RAYFIN_PUBLIC_* values.`);

      // Warn when the deployment was recorded against a different Entra
      // tenant than the user is currently signed in to. Operations like
      // `rayfin up` and `rayfin up db apply` use the active auth state, so
      // a silent tenant mismatch will fail or — worse — target the wrong
      // tenant.
      if (record.tenantId) {
        const authState = await loadAuthState();
        const activeTenant = authState?.tenantId;
        if (activeTenant && activeTenant !== record.tenantId) {
          console.warn(
            `\n⚠️  Active sign-in tenant (${activeTenant}) differs from the` +
              ` deployment's recorded tenant (${record.tenantId}).`
          );
          console.warn(
            `   Run \`rayfin login --tenant ${record.tenantId}\` before` +
              ` \`rayfin up\` or other deployment commands.`
          );
        } else if (!activeTenant) {
          console.warn(
            `\n⚠️  Not signed in. This deployment targets tenant` +
              ` ${record.tenantId}.`
          );
          console.warn(
            `   Run \`rayfin login --tenant ${record.tenantId}\` before` +
              ` \`rayfin up\`.`
          );
        }
      }
      if (options.emitEnv === false) {
        return;
      }

      const framework = detectFrontendFramework(projectRoot);
      if (framework) {
        const outputPath = await writeFrameworkEnvFile({
          projectRoot,
          framework,
          outputDir: '.',
        });
        console.log(`   ${framework} detected — regenerated ${outputPath}.`);
      } else {
        console.log(
          `\nℹ️  No frontend framework detected — skipping .env.local generation.` +
            `\n   To generate manually: rayfin env --framework <vite|nextjs|plain>`
        );
      }
    }
  );
