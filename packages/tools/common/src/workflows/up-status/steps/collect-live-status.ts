import type { UpStatusData, UpStatusDeps } from '../types.js';

async function inspect<T>(
  operation: () => Promise<T>,
  fallback: T,
  label: string,
  diagnostics: UpStatusDeps['diagnostics']
): Promise<T> {
  try {
    return await operation();
  } catch {
    diagnostics.debug({
      area: 'up-status',
      message: `Could not retrieve ${label}.`,
    });
    return fallback;
  }
}

export async function collectLiveStatus(
  cached: UpStatusData,
  deps: Pick<
    UpStatusDeps,
    'fabric' | 'cancellation' | 'diagnostics' | 'progress'
  >
): Promise<UpStatusData> {
  deps.progress.report({
    phase: 'authentication',
    message: 'Checking cached Fabric authentication',
  });
  const client = await inspect(
    () => deps.fabric.tryConnect(),
    null,
    'cached authentication',
    deps.diagnostics
  );
  if (!client || deps.cancellation.isCancellationRequested) return cached;
  const status = { ...cached, authenticated: true };
  const { workspaceId, itemId } = cached.deployment.record;
  if (!workspaceId) return status;
  deps.progress.report({ phase: 'workspace', message: 'Inspecting workspace' });
  status.workspace = await inspect(
    () => client.getWorkspace(workspaceId),
    null,
    'workspace',
    deps.diagnostics
  );
  if (deps.cancellation.isCancellationRequested) return status;
  deps.progress.report({ phase: 'item', message: 'Inspecting app' });
  status.item = await inspect(
    () => client.getItem(workspaceId, itemId),
    null,
    'item',
    deps.diagnostics
  );
  if (deps.cancellation.isCancellationRequested) return status;
  if (status.services.data) {
    deps.progress.report({
      phase: 'database',
      message: 'Inspecting databases',
    });
    const databases = await inspect(
      () => client.listDatabases(workspaceId),
      [],
      'databases',
      deps.diagnostics
    );
    status.database = databases[0] ?? null;
    if (deps.cancellation.isCancellationRequested) return status;
  }
  deps.progress.report({
    phase: 'management',
    message: 'Checking management endpoint',
  });
  status.endpointHealth = await inspect(
    () => client.checkManagementEndpoint(workspaceId, itemId),
    null,
    'management endpoint',
    deps.diagnostics
  );
  deps.diagnostics.debug({
    area: 'up-status',
    message: 'Management endpoint inspection complete.',
    data: {
      reachable: status.endpointHealth?.reachable ?? false,
      httpStatus: status.endpointHealth?.httpStatus ?? null,
    },
  });
  return status;
}
