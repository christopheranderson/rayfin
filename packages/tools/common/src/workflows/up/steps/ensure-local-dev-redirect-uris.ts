/**
 * `up` workflow step: ensure the local frontend dev-server origin is in the
 * auth redirect allow-list before runtime settings are applied.
 *
 * The v2 equivalent of the legacy `ensureLocalDevRedirectUris` wrapper: it
 * allow-lists the stable local dev-server origin so sign-ins from a locally-run
 * frontend against this deployed backend succeed. It runs *before*
 * `apply-runtime-settings` and produces the augmented `services` the apply step
 * posts — keeping `apply-runtime-settings` a pure "post the given services"
 * step (one verb per file).
 *
 * Non-fatal, matching the legacy behavior: port resolution runs for every
 * project so auth-disabled frontends also avoid stale occupied ports. Redirect
 * mutation remains auth-gated. A failure returns the original services with a
 * typed `warning` so deployment can still proceed.
 */
import type { RayfinConfig } from '../../../config/index.js';
import type { DevRedirectService } from '../../../services/dev-redirect/index.js';
import type { Step } from '../../types.js';

/** Inputs for {@link ensureLocalDevRedirectUris}. */
export interface EnsureLocalDevRedirectUrisInput {
  /** The `services` block from `rayfin.yml`. */
  services: RayfinConfig['services'];
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
}

/** Outcome of {@link ensureLocalDevRedirectUris}. */
export interface EnsureLocalDevRedirectUrisResult {
  /** The services to apply — augmented when auth is enabled and the append succeeded. */
  services: RayfinConfig['services'];
  /** Non-fatal failure detail when the append could not be completed. */
  warning?: string;
}

/** Capabilities {@link ensureLocalDevRedirectUris} composes. */
export interface EnsureLocalDevRedirectUrisDeps {
  devRedirect: DevRedirectService;
}

/**
 * Resolve the local frontend port and, when auth is enabled, append its origins
 * to the redirect allow-list. Never throws: a failure returns the original
 * services with a `warning`.
 */
export const ensureLocalDevRedirectUris: Step<
  EnsureLocalDevRedirectUrisInput,
  EnsureLocalDevRedirectUrisResult,
  EnsureLocalDevRedirectUrisDeps
> = async (input, { devRedirect }) => {
  try {
    const resolution = await devRedirect.resolveFrontendDevPort(
      input.projectRoot
    );
    if (!input.services.auth?.enabled) {
      return { services: input.services };
    }

    let services = input.services;
    for (const port of resolution.redirectPorts) {
      services = devRedirect.appendLocalDevRedirectUris(services, port);
    }
    return { services };
  } catch (error) {
    return {
      services: input.services,
      warning: error instanceof Error ? error.message : String(error),
    };
  }
};
