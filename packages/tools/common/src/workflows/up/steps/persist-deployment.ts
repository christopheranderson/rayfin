/**
 * `up` workflow step: persist the deployment to the registry.
 *
 * Records the completed deployment in `rayfin/.deployments.json` (and mirrors
 * the matching `RAYFIN_PUBLIC_*` values into `rayfin/.env`) through the
 * {@link DeploymentRegistryService}. Persistence is its own step so the
 * registry write is a discrete, typed side effect rather than a closure buried
 * in another operation.
 *
 * Two non-fatal observations are surfaced as warnings rather than thrown: a
 * tenant mismatch against a prior deployment (silently re-stamping would mask
 * a multi-tenant misconfiguration) and the presence of other registered
 * workspace deployments (a redeploy-target reminder). "Other" is every entry
 * whose registry key differs from the one we just deployed, independent of the
 * active flag — matching legacy, which listed all deployments except the
 * current workspace and never relied on a single-active invariant.
 */
import type {
  DeploymentRecord,
  DeploymentRegistryService,
} from '../../../services/deployment-registry/index.js';
import type { Step } from '../../types.js';

/** Inputs for {@link persistDeployment}. */
export interface PersistDeploymentInput {
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
  /** Workspace display name the deployment is keyed under. */
  workspaceName: string;
  /** The deployment metadata to record (the registry stamps `deployedAt`). */
  record: Omit<DeploymentRecord, 'deployedAt'>;
}

/** Outcome of {@link persistDeployment}. */
export interface PersistDeploymentResult {
  /** Storage key actually written after workspace-name normalization. */
  workspaceKey: string;
  /** Original env file backed up before its first v2-format rewrite. */
  envBackup?: { sourcePath: string; backupPath: string };
  /** Non-fatal advisories (tenant mismatch, other registered workspaces). */
  warnings: string[];
}

/** Capabilities {@link persistDeployment} composes. */
export interface PersistDeploymentDeps {
  registry: DeploymentRegistryService;
}

/**
 * Persist the deployment record and collect non-fatal advisories.
 *
 * @throws When the registry write fails.
 */
export const persistDeployment: Step<
  PersistDeploymentInput,
  PersistDeploymentResult,
  PersistDeploymentDeps
> = async (input, { registry }) => {
  const warnings: string[] = [];

  const priorResult = await registry.readDeployment(
    input.projectRoot,
    input.workspaceName
  );
  warnings.push(...priorResult.warnings);
  const prior = priorResult.record;
  if (
    prior?.tenantId &&
    input.record.tenantId &&
    prior.tenantId !== input.record.tenantId
  ) {
    warnings.push(
      `Workspace was previously deployed against tenant ${prior.tenantId}, ` +
        `but the current sign-in is in tenant ${input.record.tenantId}. ` +
        `Pass \`--tenant ${prior.tenantId}\` or run ` +
        `\`rayfin login --tenant ${prior.tenantId}\` if this was unintended.`
    );
  }

  const persistence = await registry.persistDeployment(
    input.projectRoot,
    input.workspaceName,
    input.record
  );
  warnings.push(...persistence.warnings);

  try {
    const deploymentList = await registry.listDeployments(input.projectRoot);
    warnings.push(...deploymentList.warnings);
    const others = deploymentList.deployments.filter(
      (entry) =>
        entry.workspaceName !== persistence.workspaceKey &&
        entry.workspaceName !== input.workspaceName
    );
    if (others.length > 0) {
      warnings.push(
        `Other workspace deployments registered: ${others
          .map((entry) => entry.workspaceName)
          .join(', ')}`
      );
    }
  } catch (error) {
    warnings.push(
      `Could not list registered workspace deployments: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return {
    workspaceKey: persistence.workspaceKey,
    envBackup: persistence.envBackup,
    warnings,
  };
};
