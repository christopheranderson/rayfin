/**
 * Runtime-config product-service contract (Layer 3).
 *
 * Writes and removes the deploy-time `rayfin.config.json` artifact that lets a
 * compiled SPA bundle read its backend coordinates at runtime instead of
 * baking them in at build time. `rayfin up` writes this file into the
 * static-hosting `public/` directory before the build so it is bundled
 * alongside the app, then removes it once the deploy finishes (or fails) so a
 * stray copy never shadows local-dev `VITE_*` values on the next `rayfin dev`.
 * If a `rayfin.config.json` already exists at that path, it is left untouched
 * and reused as-is for this deploy instead of being overwritten — and it must
 * not be removed afterward, since it wasn't written by this run.
 *
 * The interface is intentionally fine-grained so the host implementation
 * (`cli/src/rayfin-services/runtime-config.ts`) is a thin delegation to the
 * existing filesystem util. It is Node-free at the contract level: path
 * resolution and disk access are the host implementation's concern, mirroring
 * how `StaticHostingService` resolves `config.path` internally.
 */
import type { StaticHostingConfig } from '../../config/index.js';

/** Deployment-specific values written into `rayfin.config.json`. */
export interface RuntimeConfigValues {
  /** BaaS / workload endpoint the client calls (required). */
  apiUrl: string;
  publishableKey?: string;
  workspaceId?: string;
  itemId?: string;
  portalUrl?: string;
  tenantId?: string;
}

/** Result of {@link RuntimeConfigService.write}. */
export interface WriteRuntimeConfigResult {
  /** Absolute path of the file that was written (or left in place). */
  path: string;
  /**
   * True when a `rayfin.config.json` already existed at the path. The
   * existing file is left untouched — not overwritten — and reused as-is for
   * this deploy. Callers must not remove the file afterward: it is normally
   * a CLI-managed transient, so a pre-existing copy is either a leftover from
   * an interrupted `rayfin up` or a hand-committed file that should be
   * gitignored. See {@link differences} for whether callers should warn.
   */
  preexisting: boolean;
  /**
   * Fields where a preexisting file's value differs from what this run would
   * have written. Always empty when `preexisting` is false. Callers should
   * warn only when this is non-empty — a preexisting file that already
   * matches is the expected steady state (e.g. an intentionally
   * hand-committed file), and warning on every run trains people to ignore
   * the warning.
   */
  differences: string[];
}

export interface RuntimeConfigService {
  /**
   * Write `rayfin.config.json` into the static-hosting `public/` directory
   * derived from `projectRoot`/`config`, so the subsequent static build
   * bundles it. Creates the directory if missing. If a file already exists
   * at that path, it is left untouched and reused as-is — see
   * {@link WriteRuntimeConfigResult.preexisting}.
   *
   * @throws When the file cannot be written (e.g. permissions, invalid path).
   */
  write(
    projectRoot: string,
    config: StaticHostingConfig,
    values: RuntimeConfigValues
  ): Promise<WriteRuntimeConfigResult>;

  /**
   * Remove a previously written runtime config file. A no-op when `path` is
   * `undefined`; never throws — cleanup must not mask the deploy's outcome.
   */
  remove(path: string | undefined): Promise<void>;
}
