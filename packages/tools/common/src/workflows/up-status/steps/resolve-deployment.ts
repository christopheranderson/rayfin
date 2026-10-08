import type { ActiveDeployment } from '../../../services/deployment-registry/index.js';
import { failed, ok, type Result } from '../../types.js';
import type { UpStatusDeps, UpStatusRequest } from '../types.js';

export async function resolveDeployment(
  request: UpStatusRequest,
  projectRoot: string,
  deps: Pick<UpStatusDeps, 'registry'>
): Promise<Result<ActiveDeployment>> {
  if (request.deploymentName) {
    const { record, warnings } = await deps.registry.readDeployment(
      projectRoot,
      request.deploymentName
    );
    if (!record)
      return failed(
        'deployment-not-found',
        'The selected deployment was not found.',
        undefined,
        undefined,
        warnings
      );
    if (request.workspaceId && record.workspaceId !== request.workspaceId) {
      return failed(
        'deployment-workspace-mismatch',
        'The selected deployment belongs to a different workspace.'
      );
    }
    return ok({ workspaceName: request.deploymentName, record }, warnings);
  }
  if (!request.workspaceId) {
    const active = await deps.registry.getActiveDeployment(projectRoot);
    if (active) return ok(active);
  }
  const { deployments, warnings } =
    await deps.registry.listDeployments(projectRoot);
  const matching = request.workspaceId
    ? deployments.filter(
        ({ record }) => record.workspaceId === request.workspaceId
      )
    : deployments;
  if (matching.length === 0) {
    return failed(
      'deployment-not-found',
      'No deployment was found for this project and target.',
      undefined,
      undefined,
      warnings
    );
  }
  if (matching.length > 1) {
    return failed(
      'deployment-ambiguous',
      'Multiple deployments match the requested target.',
      undefined,
      undefined,
      warnings
    );
  }
  const { record, workspaceName } = matching[0];
  return ok({ record, workspaceName }, warnings);
}
