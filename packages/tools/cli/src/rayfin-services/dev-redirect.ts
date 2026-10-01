/**
 * CLI implementation of the {@link DevRedirectService} product-service
 * contract.
 *
 * Port probing and persistence delegate to the existing host utility. Redirect
 * mutation is a separate pure operation so workflows can resolve once and use
 * the same port for backend settings and frontend wiring.
 *
 * The util keys off the `rayfin/` directory; the contract takes the project
 * root (matching the other product services), so this impl resolves
 * `rayfin/` from it. Auth-gating and non-fatal handling are the workflow step's
 * responsibility.
 */
import { join } from 'node:path';

import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import type { DevRedirectService } from '@microsoft/rayfin-tools-common/_internal/services/dev-redirect';

import {
  appendLocalDevRedirectUrisForPort,
  resolveFrontendDevPort as resolveFrontendDevPortState,
} from '../utils/frontend-dev-port.js';

/** Construct the CLI-host {@link DevRedirectService}. */
export function createCliDevRedirectService(
  reservedPorts?: Set<number>
): DevRedirectService {
  return {
    resolveFrontendDevPort(projectRoot) {
      return resolveFrontendDevPortState(
        join(projectRoot, 'rayfin'),
        reservedPorts
      );
    },
    appendLocalDevRedirectUris(
      services: RayfinConfig['services'],
      port: number
    ): RayfinConfig['services'] {
      return appendLocalDevRedirectUrisForPort(services, port);
    },
  };
}
