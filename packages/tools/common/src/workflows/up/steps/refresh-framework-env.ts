/**
 * `up` workflow step: refresh the framework-local env file before the build.
 *
 * The static build command (e.g. Vite) reads `.env.local`, not the deployment
 * registry, so the file must be regenerated *after* the new deployment values
 * land in `rayfin/.env` and *before* the bundle is built — otherwise the
 * served frontend embeds stale values pointing at a backend that no longer
 * exists.
 *
 * Detection failure (no framework) and a write failure are both non-fatal:
 * they are returned as typed outcomes so the workflow can warn and continue
 * (and decide whether "no framework" is worth surfacing, based on whether
 * static hosting is enabled).
 */
import type { StaticHostingConfig } from '../../../config/index.js';
import type { FrameworkEnvService } from '../../../services/framework-env/index.js';
import type { Step } from '../../types.js';

/** Inputs for {@link refreshFrameworkEnv}. */
export interface RefreshFrameworkEnvInput {
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
  /** Static frontend location, including workspace package path and build root. */
  staticHosting?: StaticHostingConfig;
}

/** Outcome of {@link refreshFrameworkEnv}. */
export type RefreshFrameworkEnvResult =
  | { status: 'refreshed'; framework: string; path: string }
  | { status: 'no-framework' }
  | { status: 'failed'; message: string };

/** Capabilities {@link refreshFrameworkEnv} composes. */
export interface RefreshFrameworkEnvDeps {
  frameworkEnv: FrameworkEnvService;
}

/**
 * Detect the frontend framework and regenerate its env file. Never throws:
 * "no framework detected" and any detection/write failure are returned as
 * typed, non-fatal outcomes.
 */
export const refreshFrameworkEnv: Step<
  RefreshFrameworkEnvInput,
  RefreshFrameworkEnvResult,
  RefreshFrameworkEnvDeps
> = async (input, { frameworkEnv }) => {
  try {
    const framework = await frameworkEnv.detectFramework(
      input.projectRoot,
      input.staticHosting
    );
    if (!framework) {
      return { status: 'no-framework' };
    }

    const path = await frameworkEnv.writeEnvFile({
      projectRoot: input.projectRoot,
      framework,
      ...(input.staticHosting
        ? { staticHosting: input.staticHosting }
        : { outputDir: '.' }),
    });
    return { status: 'refreshed', framework, path };
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
};
