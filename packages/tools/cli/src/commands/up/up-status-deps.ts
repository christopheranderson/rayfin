import {
  noopCancellationToken,
  type CancellationToken,
  type Diagnostics,
} from '@microsoft/rayfin-tools-common/_internal/adapters';
import type { UpStatusDeps } from '@microsoft/rayfin-tools-common/_internal/workflows';

import { createDiagnosticProgress } from '../../adapters/progress.js';
import { tryCreateCliFabricStatusClient } from '../../external-services/fabric/status-client.js';
import { readProject } from '../../local-services/project-reader.js';
import { createCliDeploymentRegistryService } from '../../rayfin-services/deployment-registry.js';

/** Supply host-backed readers and a strictly non-interactive Fabric session. @internal */
export function createUpStatusDeps(
  diagnostics: Diagnostics,
  cancellation: CancellationToken = noopCancellationToken
): UpStatusDeps {
  return {
    project: { load: readProject },
    registry: createCliDeploymentRegistryService(),
    fabric: { tryConnect: tryCreateCliFabricStatusClient },
    cancellation,
    diagnostics,
    progress: createDiagnosticProgress(diagnostics, 'up-status'),
  };
}
