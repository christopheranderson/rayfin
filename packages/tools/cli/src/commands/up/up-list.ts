/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Command } from 'commander';

import { listDeployments } from '../../utils/deployments-registry.js';
import { emitJson, resolveRootOutputFlags } from '../../utils/output-mode.js';
import { findRayfinProjectRoot } from '../../utils/project-utils.js';

/**
 * `rayfin up list` — print every Fabric deployment recorded in
 * `rayfin/.deployments.json`, marking the active one.
 */
export const upListCommand = new Command('list')
  .description('List all Fabric deployments recorded for this project')
  .option('--json', 'Output as JSON')
  .action((options: { json?: boolean }, command: Command) => {
    const json = Boolean(options.json) || resolveRootOutputFlags(command).json;
    let projectRoot: string;
    try {
      projectRoot = findRayfinProjectRoot(process.cwd(), { silent: json });
    } catch {
      console.error('❌ Not inside a Rayfin project (no `rayfin/` folder).');
      process.exit(1);
    }

    const deployments = listDeployments(projectRoot);

    if (json) {
      emitJson(
        deployments.map((d) => ({
          workspaceName: d.workspaceName,
          active: d.active,
          ...d.record,
        }))
      );
      return;
    }

    if (deployments.length === 0) {
      console.log(
        'No deployments found. Run `rayfin up` to deploy to a Fabric workspace.'
      );
      return;
    }

    console.log('Fabric deployments:');
    for (const { workspaceName, record, active } of deployments) {
      const marker = active ? '* ' : '  ';
      console.log(`${marker}${workspaceName}`);
      console.log(`    apiUrl:      ${record.apiUrl}`);
      console.log(`    workspaceId: ${record.workspaceId}`);
      console.log(`    itemId:      ${record.itemId}`);
      if (record.hostingUrl) {
        console.log(`    hostingUrl:  ${record.hostingUrl}`);
      }
      if (record.deployedAt) {
        console.log(`    deployedAt:  ${record.deployedAt}`);
      }
    }
  });
