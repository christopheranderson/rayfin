import type { MicrosoftPackageVersion } from '../../telemetry/index.js';

/** Tracked project metadata written by `create-rayfin`. */
export interface ProjectMetadata {
  _comment: string;
  version: 1;
  projectOriginId: string;
}

/** Human-readable explanation stored with generated project metadata. */
export const PROJECT_METADATA_COMMENT =
  'Created by create-rayfin to correlate anonymous scaffold and deployment telemetry. Commit this file with your project.';

/** Project-relative path of the tracked metadata file. */
export const PROJECT_METADATA_PATH = 'rayfin/.project.json';

/** Best-effort facts used to enrich one deployment invocation. */
export interface DeploymentTelemetryFacts {
  projectOriginId?: string;
  /** Undefined means collection failed; an empty array is a valid inventory. */
  microsoftPackages?: readonly MicrosoftPackageVersion[];
  /** Declared approved packages that could not be resolved to installed versions. */
  unresolvedPackageCount?: number;
}

/** Host capability for persisting create provenance. */
export interface ProjectOriginWriter {
  /**
   * Atomically persist the create invocation that originated a project.
   *
   * @throws Implementations may reject on filesystem failures. Callers must
   * contain failures so telemetry never affects scaffold outcomes or exit codes.
   */
  persistProjectOrigin(
    projectRoot: string,
    projectOriginId: string
  ): Promise<void>;
}

/** Host capability for collecting deployment telemetry facts. */
export interface DeploymentTelemetryCollector {
  /** Collect provenance and package versions without affecting deployment. */
  collectDeploymentTelemetry(
    projectRoot: string,
    packageRoots: readonly string[]
  ): Promise<DeploymentTelemetryFacts>;
}

/** Full CLI host service used by create and deployment entrypoints. */
export interface ProjectTelemetryService
  extends ProjectOriginWriter, DeploymentTelemetryCollector {}

/** Deployment collector used when telemetry is unavailable or disabled. */
export const noopDeploymentTelemetryCollector: DeploymentTelemetryCollector = {
  async collectDeploymentTelemetry(): Promise<DeploymentTelemetryFacts> {
    return {};
  },
};
