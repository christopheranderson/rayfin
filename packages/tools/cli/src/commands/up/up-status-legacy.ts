import { checkManagementEndpoint } from '@microsoft/rayfin-tools-common/_internal/external/fabric';
import type { Command } from 'commander';

import { createCommandOutput } from '../../adapters/command-output.js';
import { getAuthenticatedToken, isAuthenticated } from '../../auth/index.js';
import { getFabricSettings } from '../../config/constants.js';
import { RayfinItemManager } from '../../services/fabric/rayfin-item.js';
import { SqlManager } from '../../services/fabric/sql.js';
import { WorkspaceManager } from '../../services/fabric/workspace.js';
import {
  hasAmbientToken,
  getAmbientWorkspaceId,
} from '../../utils/ambient-env.js';
import { loadRayfinConfig } from '../../utils/config-utils.js';
import {
  type DeploymentEnvVars,
  type ResolvedDeployment,
  findExistingEnvFabricFiles,
  readDeploymentEnvFile,
  resolveDeploymentEnvFile,
} from '../../utils/env-fabric-utils.js';
import { fabricFetch } from '../../utils/http-client.js';
import {
  createVerboseLogger,
  emitJson,
  modeError,
  modeLog,
  resolveCommandFlags,
} from '../../utils/output-mode.js';
import { findRayfinProjectRoot } from '../../utils/project-utils.js';

import {
  createUpStatusJson,
  renderHumanStatus,
  toEndpointHealthView,
} from './up-status-render.js';
import {
  UP_STATUS_EXIT_CODES as EXIT_CODES,
  type DatabaseInfo,
  type EndpointHealth,
  type EnvFabricInfo,
  type ItemInfo,
  type UpStatusInfo,
  type WorkspaceInfo,
} from './up-status-types.js';

/**
 * Check management endpoint access and retrieve optional publishable-key metadata.
 */
async function probeEndpointHealth(
  endpointUrl: string,
  itemId: string,
  authHeader: string,
  verbose: (...args: any[]) => void
): Promise<EndpointHealth> {
  verbose('[probe] Checking management access');
  return toEndpointHealthView(
    await checkManagementEndpoint(
      { itemEndpoint: endpointUrl, itemId },
      {
        fetch: (url, init) => {
          const headers = new Headers(init?.headers);
          headers.set('Authorization', authHeader);
          return fabricFetch(url, { ...init, headers });
        },
      }
    )
  );
}

/**
 * Main status command implementation
 */
export async function runUpStatusLegacy(this: Command): Promise<void> {
  const globals = this.optsWithGlobals();
  const { mode, verbose: resolvedVerbose } = resolveCommandFlags(this);
  const verbose = createVerboseLogger(resolvedVerbose);
  const envFile: string | undefined = globals.envFile;

  try {
    // ── Load project config ─────────────────────────────────────────
    const projectRoot = findRayfinProjectRoot(process.cwd(), { silent: true });
    verbose('Project root:', projectRoot);

    const rayfinConfig = loadRayfinConfig(projectRoot, { silent: true });
    if (!rayfinConfig) {
      modeError(mode, '❌ Could not find rayfin.yml configuration');
      modeLog(mode, "💡 Run 'rayfin init' to create a new project\n");
      process.exit(EXIT_CODES.ERROR);
    }

    const projectName = rayfinConfig.id || 'rayfin';
    verbose('Project name:', projectName);

    const envWorkspaceId = getAmbientWorkspaceId();
    let resolved: ResolvedDeployment | null;
    if (envFile) {
      resolved = await resolveDeploymentEnvFile({
        projectRoot,
        workspaceName: envFile,
        nonInteractive: true,
      });
      if (!resolved) {
        modeError(
          mode,
          `Could not read deployment for workspace name: ${envFile}`
        );
        modeLog(
          mode,
          "Check the selected deployment or deploy with 'rayfin up'."
        );
        process.exit(EXIT_CODES.ERROR);
      }
      if (
        envWorkspaceId &&
        resolved.deployment.fabricWorkspaceId !== envWorkspaceId
      ) {
        modeError(
          mode,
          'The selected deployment belongs to a different workspace.'
        );
        modeLog(
          mode,
          'Choose a deployment that belongs to the selected workspace.'
        );
        process.exit(EXIT_CODES.UNHEALTHY);
      }
    } else if (envWorkspaceId) {
      const matchingDeployments = findExistingEnvFabricFiles(projectRoot)
        .map((file) => ({
          workspaceName: file.workspaceName,
          deployment: readDeploymentEnvFile(projectRoot, file.workspaceName),
        }))
        .filter(
          (entry) => entry.deployment?.fabricWorkspaceId === envWorkspaceId
        );
      if (matchingDeployments.length > 1) {
        modeError(
          mode,
          `Multiple deployment files match workspace ${envWorkspaceId}.`
        );
        modeLog(mode, 'Select one deployment with --env-file <name>.');
        process.exit(EXIT_CODES.UNHEALTHY);
      }
      const matched = matchingDeployments[0];
      resolved = matched?.deployment
        ? {
            workspaceName: matched.workspaceName,
            deployment: matched.deployment,
          }
        : null;
    } else {
      resolved = await resolveDeploymentEnvFile({
        projectRoot,
        nonInteractive: true,
      });
    }
    const envFabric: EnvFabricInfo = resolved
      ? {
          exists: true,
          workspaceName: resolved.workspaceName,
          apiUrl: resolved.deployment.rayfinApiUrl,
          itemId: resolved.deployment.rayfinItemId,
          publishableKey: resolved.deployment.publishableKey,
          fabricWorkspaceId: resolved.deployment.fabricWorkspaceId,
          hostingUrl: resolved.deployment.hostingUrl,
        }
      : { exists: false };
    verbose('Deployment registry info:', JSON.stringify(envFabric, null, 2));

    // Build a deployment object from the resolved file (or empty)
    const deployment: DeploymentEnvVars = resolved?.deployment ?? {
      rayfinItemId: '',
      rayfinApiUrl: '',
      fabricWorkspaceId: '',
    };

    // ── Check if deployed ───────────────────────────────────────────
    if (!deployment.rayfinItemId) {
      modeLog(mode, '\n❌ Project has not been deployed\n');
      modeLog(mode, "💡 Deploy with 'rayfin up'\n");
      process.exit(EXIT_CODES.ERROR);
    }

    // ── Enabled services ────────────────────────────────────────────
    const services = {
      auth: rayfinConfig.services?.auth?.enabled ?? false,
      data: rayfinConfig.services?.data?.enabled ?? false,
      storage: rayfinConfig.services?.storage?.enabled ?? false,
    };

    // ── Attempt live data (graceful degradation) ────────────────────
    let workspace: WorkspaceInfo | null = null;
    let item: ItemInfo | null = null;
    let database: DatabaseInfo | null = null;
    let endpointHealth: EndpointHealth | null = null;
    let authenticated = false;

    try {
      verbose('Attempting authentication...');
      const hasAuth = hasAmbientToken() || (await isAuthenticated());
      if (!hasAuth) {
        verbose('No cached account found');
        throw new Error('Not authenticated');
      }
      const fabricToken = await getAuthenticatedToken();

      authenticated = true;
      verbose('Authenticated successfully');

      const workspaceManager = new WorkspaceManager(fabricToken.token);
      const rayfinItemManager = new RayfinItemManager(fabricToken.token);

      // ── Fetch workspace info ────────────────────────────────────
      if (deployment.fabricWorkspaceId) {
        verbose('Fetching workspace:', deployment.fabricWorkspaceId);
        try {
          const ws = await workspaceManager.getWorkspace(
            deployment.fabricWorkspaceId
          );
          workspace = {
            id: ws.id,
            displayName: ws.displayName,
            capacityId: ws.capacityId,
            state: ws.state,
          };
          verbose('Workspace:', JSON.stringify(workspace, null, 2));
        } catch (error) {
          verbose('Failed to fetch workspace:', (error as Error).message);
        }
      }

      // ── Fetch item info ─────────────────────────────────────────
      if (deployment.fabricWorkspaceId && deployment.rayfinItemId) {
        verbose('Fetching Rayfin item:', deployment.rayfinItemId);
        try {
          const rayfinItem = await rayfinItemManager.getFabricItemById(
            deployment.fabricWorkspaceId,
            deployment.rayfinItemId
          );
          if (rayfinItem) {
            item = {
              id: rayfinItem.id,
              displayName: rayfinItem.displayName,
              type: rayfinItem.type,
            };
            verbose('Item:', JSON.stringify(item, null, 2));
          } else {
            verbose('Rayfin item not found (may have been deleted)');
          }
        } catch (error) {
          verbose('Failed to fetch Rayfin item:', (error as Error).message);
        }
      }

      // ── Fetch database info ─────────────────────────────────────
      if (deployment.fabricWorkspaceId && services.data) {
        verbose('Fetching SQL databases in workspace...');
        try {
          const sqlManager = new SqlManager(fabricToken.token);

          // SqlManager logs progress to console — suppress when not verbose
          // to keep status output clean (especially --json mode)
          const originalLog = console.log;
          if (!resolvedVerbose) {
            console.log = () => {};
          }
          let databases;
          try {
            databases = await sqlManager.listSqlDatabases(
              deployment.fabricWorkspaceId
            );
          } finally {
            console.log = originalLog;
          }

          verbose(`Found ${databases.length} SQL database(s)`);
          if (databases.length > 0) {
            const db = databases[0];
            const portalBase = getFabricSettings().fabricPortalUrl.replace(
              /\/$/,
              ''
            );
            database = {
              id: db.id,
              displayName: db.displayName,
              deepLink: `${portalBase}/groups/${deployment.fabricWorkspaceId}/sqldatabases/${db.id}?experience=fabric-developer`,
            };
            verbose('Database:', JSON.stringify(database, null, 2));
          }
        } catch (error) {
          verbose('Failed to fetch SQL databases:', (error as Error).message);
        }
      }

      // ── Probe endpoint health ───────────────────────────────────
      if (deployment.fabricWorkspaceId && deployment.rayfinItemId) {
        const itemEndpoint = rayfinItemManager.getRayfinItemEndpoint(
          deployment.fabricWorkspaceId,
          deployment.rayfinItemId
        );
        try {
          const bearerHeader = rayfinItemManager.getAuthorizationHeader();

          endpointHealth = await probeEndpointHealth(
            itemEndpoint,
            deployment.rayfinItemId,
            bearerHeader,
            verbose
          );
          verbose('Endpoint health:', JSON.stringify(endpointHealth, null, 2));
        } catch (error) {
          verbose('Endpoint probe failed:', (error as Error).message);
          endpointHealth = {
            url: `${itemEndpoint}/__private/publishable-key`,
            reachable: false,
            error: (error as Error).message,
            hint: "Retry 'rayfin up status' and check your network access to Fabric.",
          };
        }
      }
    } catch (error) {
      verbose('Authentication failed:', (error as Error).message);
      // Graceful degradation — continue with cached data only
    }

    // ── Build status ──────────────────────────────────────────────
    const status: UpStatusInfo = {
      projectName,
      deployment,
      services,
      workspace,
      item,
      database,
      endpointHealth,
      envFabric,
      authenticated,
    };

    // ── Determine exit code ───────────────────────────────────────
    let exitCode: number;
    if (endpointHealth?.reachable && !endpointHealth.error) {
      exitCode = EXIT_CODES.HEALTHY;
    } else if (deployment.rayfinItemId) {
      // Deployed but could not confirm health — either the endpoint is
      // unreachable or we couldn't authenticate to check. Both cases
      // are UNHEALTHY so automation doesn't assume the deployment is OK
      // when it was never actually verified.
      exitCode = EXIT_CODES.UNHEALTHY;
    } else {
      exitCode = EXIT_CODES.ERROR;
    }

    // ── Display output ────────────────────────────────────────────
    if (mode === 'json') {
      emitJson(createUpStatusJson(status));
    } else {
      renderHumanStatus(createCommandOutput(this).logger, status);
    }

    process.exit(exitCode);
  } catch (error: any) {
    if (error.message?.includes('Could not find rayfin project root')) {
      modeError(mode, '❌ Not in a Rayfin project directory');
      modeLog(
        mode,
        "💡 Navigate to a Rayfin project or run 'rayfin init' to create one\n"
      );
    } else {
      modeError(mode, '❌ Error:', error.message);
      verbose('Full error:', error);
    }
    process.exit(EXIT_CODES.ERROR);
  }
}
