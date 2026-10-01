import type { Logger } from '@microsoft/rayfin-tools-common/_internal/adapters';
import { composeFabricItemDeepLink } from '@microsoft/rayfin-tools-common/_internal/config';
import type { ManagementEndpointHealth } from '@microsoft/rayfin-tools-common/_internal/external/fabric';
import type {
  Result,
  UpStatusData,
} from '@microsoft/rayfin-tools-common/_internal/workflows';

import type { CommandOutput } from '../../adapters/command-output.js';

import {
  UP_STATUS_EXIT_CODES,
  type EndpointHealth,
  type UpStatusInfo,
} from './up-status-types.js';

export function createUpStatusJson(status: UpStatusInfo) {
  return {
    projectName: status.projectName,
    deployed: Boolean(status.deployment.rayfinItemId),
    authenticated: status.authenticated,
    deployment: {
      rayfinItemId: status.deployment.rayfinItemId || null,
      rayfinApiUrl: status.deployment.rayfinApiUrl || null,
      fabricWorkspaceId: status.deployment.fabricWorkspaceId || null,
      fabricPortalUrl:
        status.deployment.fabricPortalUrl &&
        status.deployment.fabricWorkspaceId &&
        status.deployment.rayfinItemId
          ? composeFabricItemDeepLink(
              status.deployment.fabricPortalUrl,
              status.deployment.fabricWorkspaceId,
              status.deployment.rayfinItemId,
              status.deployment.fabricTenantId
            )
          : null,
      publishableKey: status.deployment.publishableKey || null,
      hostingUrl: status.deployment.hostingUrl || null,
    },
    services: status.services,
    workspace: status.workspace,
    item: status.item,
    database: status.database
      ? {
          id: status.database.id,
          displayName: status.database.displayName,
          deepLink: status.database.deepLink,
        }
      : null,
    endpointHealth: status.endpointHealth
      ? {
          scope: 'management',
          url: status.endpointHealth.url,
          reachable: status.endpointHealth.reachable,
          httpStatus: status.endpointHealth.httpStatus ?? null,
          authenticated: status.endpointHealth.authenticated ?? null,
          publishableKey: status.endpointHealth.publishableKey || null,
          metadata: {
            publishableKeyRetrieved: Boolean(
              status.endpointHealth.publishableKey
            ),
            error: status.endpointHealth.metadataError || null,
          },
          error: status.endpointHealth.error || null,
          errorCode: status.endpointHealth.errorCode || null,
          hint: status.endpointHealth.hint || null,
        }
      : null,
    envFabric: {
      exists: status.envFabric.exists,
      workspaceName: status.envFabric.workspaceName || null,
      apiUrl: status.envFabric.apiUrl || null,
      publishableKey: status.envFabric.publishableKey || null,
    },
  };
}

function managementHint(health: ManagementEndpointHealth): string | undefined {
  if (!health.error) return undefined;
  if (health.errorCode === 'redirect')
    return "Check the configured Fabric endpoint and sign in again with 'rayfin login'.";
  if (health.errorCode !== 'http')
    return "Retry 'rayfin up status' and check your network access to Fabric if the error persists.";
  if (health.httpStatus === 401)
    return "Run 'rayfin login', then retry 'rayfin up status'.";
  if (health.httpStatus === 403)
    return 'Check that your account has access to this Fabric workspace and app.';
  if (health.httpStatus === 404)
    return 'Check that the app still exists in the selected Fabric workspace.';
  return "Retry 'rayfin up status' and check the Fabric service status if the error persists.";
}

export function toEndpointHealthView(
  health: ManagementEndpointHealth
): EndpointHealth {
  return {
    ...health,
    hint: managementHint(health),
  };
}

function toStatusView(data: UpStatusData, portalUrl: string): UpStatusInfo {
  const { record, workspaceName } = data.deployment;
  const workspace = data.workspace;
  return {
    projectName: data.projectName,
    services: data.services,
    authenticated: data.authenticated,
    workspace: workspace
      ? {
          id: workspace.id,
          displayName: workspace.displayName,
          capacityId: workspace.capacityId,
          state: workspace.state,
        }
      : null,
    item: data.item
      ? {
          id: data.item.id,
          displayName: data.item.displayName,
          type: data.item.type,
        }
      : null,
    database: data.database
      ? {
          ...data.database,
          deepLink: `${(record.portalUrl || portalUrl).replace(/\/$/, '')}/groups/${record.workspaceId}/sqldatabases/${data.database.id}?experience=fabric-developer`,
        }
      : null,
    endpointHealth: data.endpointHealth
      ? toEndpointHealthView(data.endpointHealth)
      : null,
    deployment: {
      rayfinItemId: record.itemId,
      rayfinApiUrl: record.apiUrl,
      fabricWorkspaceId: record.workspaceId,
      fabricTenantId: record.tenantId,
      fabricPortalUrl: record.portalUrl,
      publishableKey: record.publishableKey,
      hostingUrl: record.hostingUrl,
    },
    envFabric: {
      exists: true,
      workspaceName,
      apiUrl: record.apiUrl,
      itemId: record.itemId,
      fabricWorkspaceId: record.workspaceId,
      publishableKey: record.publishableKey,
    },
  };
}

function section(logger: Logger, title: string): void {
  logger.log('');
  logger.log(title);
  logger.log('-'.repeat(60));
}

function renderManagement(logger: Logger, status: UpStatusInfo): void {
  const health = status.endpointHealth;
  if (!health) {
    logger.warn(
      status.authenticated
        ? 'Management endpoint could not be checked.'
        : 'Could not authenticate - showing cached data only.'
    );
    logger.log(
      status.authenticated
        ? "Retry 'rayfin up status' and check network access to Fabric."
        : "Sign in with 'rayfin login' for live status."
    );
    return;
  }
  section(logger, 'Management Endpoint');
  logger.log(`  URL: ${health.url}`);
  logger.log(
    `  Status: ${health.reachable ? (health.error ? 'Check failed (endpoint reachable)' : 'Reachable') : 'Unreachable'}`
  );
  if (health.error) logger.error(`  Error: ${health.error}`);
  if (health.hint) logger.log(`         ${health.hint}`);
  if (health.metadataError) {
    logger.log(
      '  Metadata: Publishable key unavailable: unexpected response format from the management endpoint.'
    );
    logger.log(
      "  Retry 'rayfin up status'; the saved deployment key is unchanged."
    );
  }
}

export function renderHumanStatus(logger: Logger, status: UpStatusInfo): void {
  logger.log('Rayfin Cloud Deployment Status');
  logger.log(`Project: ${status.projectName}`);
  section(logger, 'Deployment');
  const deployment = status.deployment;
  logger.log(`  Rayfin Item ID:  ${deployment.rayfinItemId}`);
  logger.log(`  Workspace ID:    ${deployment.fabricWorkspaceId}`);
  logger.log(`  Endpoint:        ${deployment.rayfinApiUrl}`);
  if (deployment.fabricPortalUrl)
    logger.log(
      `  Portal:          ${composeFabricItemDeepLink(deployment.fabricPortalUrl, deployment.fabricWorkspaceId, deployment.rayfinItemId, deployment.fabricTenantId)}`
    );
  if (deployment.publishableKey)
    logger.log(`  Publishable Key: ${deployment.publishableKey}`);
  if (deployment.hostingUrl)
    logger.log(`  Static app:      ${deployment.hostingUrl}`);
  section(logger, 'Services:');
  logger.log(`    auth:    ${status.services.auth ? 'enabled' : 'disabled'}`);
  logger.log(`    data:    ${status.services.data ? 'enabled' : 'disabled'}`);
  if (status.services.storage) logger.log('    storage: enabled');
  if (status.workspace) {
    section(logger, 'Fabric Workspace');
    logger.log(`  Name: ${status.workspace.displayName}`);
    if (status.workspace.capacityId)
      logger.log(`  Capacity ID: ${status.workspace.capacityId}`);
  }
  if (status.item) {
    section(logger, 'Rayfin Item');
    logger.log(`  Name: ${status.item.displayName}`);
    logger.log(`  Type: ${status.item.type}`);
    logger.log(`  ID: ${status.item.id}`);
  }
  if (status.database) {
    section(logger, 'SQL Database');
    logger.log(`  Name: ${status.database.displayName}`);
    logger.log(`  ID: ${status.database.id}`);
    logger.log(`  Portal: ${status.database.deepLink}`);
  }
  renderManagement(logger, status);
  section(logger, 'Deployment registry');
  logger.log(`  File: ${status.envFabric.exists ? 'Present' : 'Not found'}`);
  if (!status.envFabric.exists) {
    logger.log("  Run 'rayfin up' to populate the deployment registry.");
    return;
  }
  logger.log(`  Workspace: ${status.envFabric.workspaceName}`);
  logger.log(`  RAYFIN_PUBLIC_API_URL: ${deployment.rayfinApiUrl}`);
  logger.log(`  RAYFIN_PUBLIC_ITEM_ID: ${deployment.rayfinItemId}`);
  if (deployment.publishableKey)
    logger.log(`  RAYFIN_PUBLIC_PUBLISHABLE_KEY: ${deployment.publishableKey}`);
}

function failureHint(code: string): string {
  if (code === 'project-not-found')
    return "Navigate to a Rayfin project or run 'rayfin init'.";
  if (code === 'deployment-not-found')
    return "Check the selected deployment or deploy with 'rayfin up'.";
  if (code === 'deployment-ambiguous')
    return 'Select one deployment with --env-file <name>.';
  if (code === 'deployment-workspace-mismatch')
    return 'Choose a deployment that belongs to the selected workspace.';
  return "Retry 'rayfin up status' and check the project configuration and network access.";
}

export function renderUpStatusResult(
  result: Result<UpStatusData>,
  output: CommandOutput,
  portalUrl: string
): number {
  if (result.status === 'cancelled') {
    if (output.json) output.writeJson({ status: 'cancelled' });
    else output.logger.log('Status check cancelled.');
    return UP_STATUS_EXIT_CODES.CANCELLED;
  }
  if (result.status === 'failed') {
    const hint = failureHint(result.error.code);
    if (output.json)
      output.writeJson({
        status: 'error',
        error: { code: result.error.code, message: result.error.message, hint },
      });
    else {
      output.logger.error(result.error.message);
      output.logger.log(`  ${hint}`);
    }
    return result.error.code === 'deployment-ambiguous' ||
      result.error.code === 'deployment-workspace-mismatch'
      ? UP_STATUS_EXIT_CODES.UNHEALTHY
      : UP_STATUS_EXIT_CODES.ERROR;
  }
  const status = toStatusView(result.data, portalUrl);
  if (output.json) output.writeJson(createUpStatusJson(status));
  else renderHumanStatus(output.logger, status);
  return status.endpointHealth?.reachable && !status.endpointHealth.error
    ? UP_STATUS_EXIT_CODES.HEALTHY
    : UP_STATUS_EXIT_CODES.UNHEALTHY;
}
