/**
 * `up` workflow step: build, package, and deploy the static frontend.
 *
 * Orchestrates the {@link StaticHostingService} operations in order
 * (build → validate → package → deploy) and derives the workload deploy URL +
 * moniker header from the resolved target. Only runs when static hosting is
 * enabled and not excluded — that gating is the workflow's decision, not this
 * step's.
 *
 * Build/validation/deploy failures are fatal (thrown): a failed static deploy
 * is the legacy `failedStep = 'static'` path. Transient endpoint-readiness
 * retry belongs in the {@link StaticHostingService} implementation, not here.
 */
import type { StaticHostingConfig } from '../../../config/index.js';
import type { WorkloadTarget } from '../../../external/fabric/index.js';
import { MONIKER_HEADER } from '../../../fabric.js';
import type { StaticHostingService } from '../../../services/static-hosting/index.js';
import type { Step } from '../../types.js';

/** Inputs for {@link deployStatic}. */
export interface DeployStaticInput {
  /** Resolved workload coordinates for the deployed item. */
  target: WorkloadTarget;
  /** The `services.staticHosting` block from `rayfin.yml`. */
  config: StaticHostingConfig;
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
}

/** Outcome of {@link deployStatic}. */
export interface DeployStaticResult {
  /** Public hosting URL for the deployed content, when the API returns one. */
  hostingUrl?: string;
  /** Server-assigned deployment id, when provided. */
  deploymentId?: string;
  /** Number of files deployed. */
  fileCount: number;
  /** Total deployed payload size in bytes. */
  totalSizeBytes: number;
}

/** Capabilities {@link deployStatic} composes. */
export interface DeployStaticDeps {
  staticHosting: StaticHostingService;
}

/**
 * Build (when configured), validate, package, and deploy the static folder.
 *
 * @throws When the build command fails, the folder is missing or empty, or the
 *   deploy is rejected.
 */
export const deployStatic: Step<
  DeployStaticInput,
  DeployStaticResult,
  DeployStaticDeps
> = async (input, { staticHosting }) => {
  const { target, config, projectRoot } = input;

  if (config.buildCommand) {
    const built = await staticHosting.runBuild(projectRoot, config);
    if (!built) {
      throw new Error(
        'Static build command failed. Fix the build errors and re-run, ' +
          "or use 'rayfin up staticapp deploy --skip-build' to deploy existing content."
      );
    }
  }

  const validation = await staticHosting.validateFolder(projectRoot, config);
  if (!validation.exists) {
    throw new Error(validation.message || 'Static folder not found');
  }
  if (validation.empty) {
    throw new Error(
      'Static folder is empty. Build your project first, ' +
        "or use 'rayfin up staticapp deploy --skip-build' after building manually."
    );
  }

  const pkg = await staticHosting.packageFolder(validation.resolvedPath);
  const result = await staticHosting.deploy(
    pkg,
    `${target.itemEndpoint}/__private/webapp/deploy`,
    target.authorizationHeader,
    { [MONIKER_HEADER]: target.itemId }
  );

  if (!result.success) {
    throw new Error(result.errorMessage || 'Static content deployment failed');
  }

  return {
    hostingUrl: result.hostingUrl,
    deploymentId: result.deploymentId,
    fileCount: validation.fileCount,
    totalSizeBytes: validation.totalSizeBytes,
  };
};
