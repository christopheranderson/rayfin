/** Non-fatal `up` step that enriches the current deployment event. */
import type { TelemetryHandle } from '../../../adapters/index.js';
import type { RayfinConfig } from '../../../config/index.js';
import { DEFAULT_FUNCTIONS_PATH } from '../../../services/functions/index.js';
import type { DeploymentTelemetryCollector } from '../../../services/project-telemetry/index.js';
import { serializeMicrosoftPackages } from '../../../telemetry/index.js';

export interface EnrichDeploymentTelemetryInput {
  projectRoot: string;
  config: RayfinConfig;
}

export interface EnrichDeploymentTelemetryDeps {
  telemetry: TelemetryHandle;
  projectTelemetry: DeploymentTelemetryCollector;
}

/**
 * Enrich the current event without returning a workflow-control result.
 * This step has no cancellation contract and suppresses all failures so
 * telemetry can never affect deployment behavior or user output.
 */
export async function enrichDeploymentTelemetry(
  input: EnrichDeploymentTelemetryInput,
  deps: EnrichDeploymentTelemetryDeps
): Promise<void> {
  try {
    const facts = await deps.projectTelemetry.collectDeploymentTelemetry(
      input.projectRoot,
      collectPackageRoots(input.config)
    );
    if (facts.projectOriginId) {
      deps.telemetry.addProperty('project_origin_id', facts.projectOriginId);
    }
    if (facts.microsoftPackages !== undefined) {
      const serialized = serializeMicrosoftPackages(facts.microsoftPackages);
      deps.telemetry.addProperty('microsoft_packages', serialized.value);
      deps.telemetry.addMeasurement(
        'microsoft_package_count',
        serialized.count
      );
      deps.telemetry.addMeasurement(
        'package_unresolved_count',
        facts.unresolvedPackageCount ?? 0
      );
    }
  } catch {
    // Telemetry must never alter deployment behavior or user output.
  }
}

function collectPackageRoots(config: RayfinConfig): string[] {
  const roots: Array<string | undefined> = [];
  if (config.services.data.enabled) roots.push(config.services.data.path);
  if (config.services.storage?.enabled) {
    roots.push(config.services.storage.path);
  }
  if (config.services.staticHosting?.enabled) {
    roots.push(
      config.services.staticHosting.path ?? config.services.staticHosting.root
    );
  }
  if (config.services.functions?.enabled) {
    roots.push(config.services.functions.path ?? DEFAULT_FUNCTIONS_PATH);
  }
  return [...new Set(roots.filter((root): root is string => Boolean(root)))];
}
