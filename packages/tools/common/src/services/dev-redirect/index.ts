/**
 * Dev-redirect product-service contract (Layer 3).
 *
 * Resolves a project's local frontend dev-server port and extends its auth
 * redirect allow-list with origins for that exact port. Workflows declare this
 * in their `Deps` and never touch the port file or origin construction
 * directly.
 *
 * It is intentionally Node-free: port probing and filesystem persistence live
 * in the host (`cli/src/rayfin-services/`). Separating resolution from the pure
 * config update lets a workflow resolve once and use one authoritative port
 * for backend settings and frontend wiring.
 *
 * Auth-gating and non-fatal handling are the workflow step's responsibility.
 * The asynchronous resolution operation may reject; the append operation is a
 * pure config transformation for an already-resolved port.
 */
import type { RayfinConfig } from '../../config/index.js';

/** Available primary port plus occupied prior ports that remain valid origins. */
export interface FrontendDevPortResolution {
  port: number;
  redirectPorts: number[];
}

export interface DevRedirectService {
  /**
   * Resolve and persist an available frontend dev-server port for a project.
   * A valid persisted port is preferred while it remains available.
   */
  resolveFrontendDevPort(
    projectRoot: string
  ): Promise<FrontendDevPortResolution>;

  /**
   * Append local frontend origins for `port` to the auth redirect allow-list.
   * Returns a new services object without mutating the input.
   */
  appendLocalDevRedirectUris(
    services: RayfinConfig['services'],
    port: number
  ): RayfinConfig['services'];
}
