import { cancelled, failed, ok, type Workflow } from '../types.js';

import { collectLiveStatus } from './steps/collect-live-status.js';
import { resolveDeployment } from './steps/resolve-deployment.js';
import type { UpStatusData, UpStatusDeps, UpStatusRequest } from './types.js';

/** Inspect a deployment without prompts, persistence, or host-global state. @internal */
export const runUpStatusWorkflow: Workflow<
  UpStatusRequest,
  UpStatusData,
  UpStatusDeps
> = async (request, deps) => {
  if (deps.cancellation.isCancellationRequested) return cancelled();
  try {
    deps.progress.report({
      phase: 'project',
      message: 'Reading project configuration',
    });
    const project = await deps.project.load(request.projectPath);
    if (deps.cancellation.isCancellationRequested) return cancelled();
    if (!project)
      return failed(
        'project-not-found',
        'Could not find Rayfin project configuration.'
      );

    deps.progress.report({
      phase: 'deployment',
      message: 'Resolving deployment',
    });
    const selected = await resolveDeployment(
      request,
      project.projectRoot,
      deps
    );
    if (deps.cancellation.isCancellationRequested) return cancelled();
    if (selected.status !== 'ok') return selected;
    if (!selected.data.record.itemId)
      return failed(
        'deployment-not-found',
        'The project has not been deployed.'
      );

    const cached: UpStatusData = {
      projectName: project.id,
      deployment: selected.data,
      services: {
        auth: project.services?.auth?.enabled ?? false,
        data: project.services?.data?.enabled ?? false,
        storage: project.services?.storage?.enabled ?? false,
      },
      authenticated: false,
      workspace: null,
      item: null,
      database: null,
      endpointHealth: null,
    };
    const status = await collectLiveStatus(cached, deps);
    if (deps.cancellation.isCancellationRequested) return cancelled();
    return ok(status, selected.warnings);
  } catch (error) {
    return failed(
      'status-unavailable',
      'Could not inspect deployment status.',
      error
    );
  }
};
