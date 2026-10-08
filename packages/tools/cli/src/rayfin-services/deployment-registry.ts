/**
 * CLI implementation of the {@link DeploymentRegistryService} product-service
 * contract.
 *
 * Thin delegation to the existing deployment-registry and deployment-env-file
 * utils. `persistDeployment` maps the universal record onto the util's
 * `DeploymentEnvVars` shape and delegates to `writeDeploymentEnvFile`, which
 * upserts the registry and mirrors `RAYFIN_PUBLIC_*` into `rayfin/.env`; the
 * read/query operations delegate to the registry getters (which already return
 * the clean record shape).
 *
 * Each method has an `async` body so a synchronous throw from the underlying
 * util surfaces as a rejection rather than at the call site.
 */
import { join } from 'path';

import type {
  ActiveDeployment,
  DeploymentListResult,
  DeploymentPersistenceResult,
  DeploymentReadResult,
  DeploymentRecord,
  DeploymentRegistryService,
} from '@microsoft/rayfin-tools-common/_internal/services/deployment-registry';

import {
  deploymentToPublicEnv,
  getActiveDeployment,
  getDeployment,
  getDeploymentState,
  listDeploymentsState,
  setActiveDeployment,
} from '../utils/deployments-registry.js';
import { persistDeploymentEnvFile } from '../utils/env-fabric-utils.js';
import { replaceDeploymentEnvInFile } from '../utils/env-file-utils.js';

/** Construct the CLI-host {@link DeploymentRegistryService}. */
export function createCliDeploymentRegistryService(): DeploymentRegistryService {
  return {
    async persistDeployment(
      projectRoot: string,
      workspaceName: string,
      record: Omit<DeploymentRecord, 'deployedAt'>
    ): Promise<DeploymentPersistenceResult> {
      const persistence = await persistDeploymentEnvFile(
        projectRoot,
        workspaceName,
        {
          rayfinItemId: record.itemId,
          rayfinItemName: record.itemName,
          rayfinApiUrl: record.apiUrl,
          fabricWorkspaceId: record.workspaceId,
          fabricTenantId: record.tenantId,
          publishableKey: record.publishableKey,
          fabricPortalUrl: record.portalUrl,
          hostingUrl: record.hostingUrl,
        }
      );
      return {
        workspaceKey: persistence.workspaceKey,
        warnings: persistence.warnings || [],
        envBackup: persistence.backup,
      };
    },

    async readDeployment(
      projectRoot: string,
      workspaceName: string
    ): Promise<DeploymentReadResult> {
      return getDeploymentState(projectRoot, workspaceName);
    },

    async getActiveDeployment(
      projectRoot: string
    ): Promise<ActiveDeployment | null> {
      return getActiveDeployment(projectRoot);
    },

    async listDeployments(projectRoot: string): Promise<DeploymentListResult> {
      const result = listDeploymentsState(projectRoot);
      return {
        deployments: result.deployments,
        warnings: result.warnings,
      };
    },

    async setActiveDeployment(
      projectRoot: string,
      workspaceName: string
    ): Promise<boolean> {
      if (!setActiveDeployment(projectRoot, workspaceName)) {
        return false;
      }
      // The service owns both the registry and the rayfin/.env mirror: refresh
      // RAYFIN_PUBLIC_* so apps and generated framework env files point at the
      // newly-active backend, matching what `rayfin up switch` does.
      const record = getDeployment(projectRoot, workspaceName);
      if (record) {
        await replaceDeploymentEnvInFile(
          join(projectRoot, 'rayfin'),
          deploymentToPublicEnv(record)
        );
      }
      return true;
    },
  };
}
