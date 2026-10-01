/**
 * Auth SDK compatibility product-service contract (Layer 3).
 *
 * Static-hosting access control changes how a deployed app acquires its
 * session, so an app whose frontend still bundles an older
 * `@microsoft/rayfin-auth` can deploy successfully and then fail to sign anyone
 * in. This service reports whether the installed SDK meets the supported floor
 * and raises it in place when it does not.
 *
 * Scope is deliberately narrow: it upgrades an SDK already present in the
 * installed dependency graph. It never installs the SDK when it is absent,
 * because whether an app needs it is the Builder's decision, not a deploy-time
 * one.
 *
 * Node-free: the host implementation owns module resolution and running the
 * project's package manager (`cli/src/rayfin-services/auth-sdk.ts`).
 */
import type { RayfinConfig } from '../../config/index.js';

/** Locates the frontend package whose dependencies a deploy ships. */
export interface AuthSdkRequest {
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
  /** Current `services` config, used to resolve `staticHosting.path`. */
  services: RayfinConfig['services'];
}

/** Outcome of inspecting the frontend package's Rayfin auth packages. */
export type AuthSdkInspection =
  /** Installed and at or above the floor, or not depended on at all. */
  | { state: 'satisfied' }
  /**
   * The floor is not knowable in this build, so no comparison was made.
   * Reported rather than treated as satisfied so the host can say the check
   * did not run instead of implying it passed.
   */
  | { state: 'unknown-floor'; reason: string }
  /** Installed but behind the floor. `packages` names every package to move. */
  | { state: 'outdated'; packages: string[] }
  /** The effective version could not be determined. */
  | { state: 'unresolved'; reason: string };

/** Result of an attempted in-place upgrade. */
export type AuthSdkUpgrade =
  | { status: 'upgraded' }
  | { status: 'failed'; error: string };

export interface AuthSdkService {
  /** Report whether the deploy's Rayfin auth packages meet the supported floor. */
  inspect(request: AuthSdkRequest): Promise<AuthSdkInspection>;

  /**
   * Raise the named packages to the supported floor, updating both manifest and
   * lockfile. They ship in lockstep, so every name is upgraded in one
   * resolution — raising one on its own leaves whatever depends on it behind.
   */
  upgrade(
    request: AuthSdkRequest & { packages: string[] }
  ): Promise<AuthSdkUpgrade>;
}
