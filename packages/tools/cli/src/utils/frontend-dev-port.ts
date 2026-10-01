/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  addAllowedRedirectUri,
  type RayfinConfig,
} from '@microsoft/rayfin-tools-common/_internal/config';
import type { FrontendDevPortResolution } from '@microsoft/rayfin-tools-common/_internal/services/dev-redirect';

export type { FrontendDevPortResolution } from '@microsoft/rayfin-tools-common/_internal/services/dev-redirect';

import {
  checkPortAvailability,
  findAvailableEphemeralPort,
  findAvailablePort,
  PortRangeExhaustedError,
} from './docker-utils.js';
import { readEnvMap, upsertEnvVariables } from './env-file-utils.js';

/**
 * `rayfin/.env` variable holding the stable local dev-server port assigned to
 * this project's frontend. Lives in the `RAYFIN_PUBLIC_*` namespace so
 * `rayfin env` maps it into the framework-specific port variable (e.g.
 * `VITE_PORT`) that the dev server reads to pin itself.
 */
export const FRONTEND_DEV_PORT_ENV_VAR = 'RAYFIN_PUBLIC_FRONTEND_PORT';

/** Prior assigned ports kept allow-listed while a listener still owns them. */
export const RETAINED_FRONTEND_DEV_PORTS_ENV_VAR =
  'RAYFIN_FRONTEND_DEV_PORT_ALIASES';

/** Vite's default dev-server port; the preferred starting point for allocation. */
export const DEFAULT_FRONTEND_DEV_PORT = 5173;

const MAX_PORT = 65535;
const PORT_SEARCH_ATTEMPTS = 100;
const DECIMAL_PORT_PATTERN = /^\d+$/;

/**
 * The redirect-URI origins a local frontend will present when it runs on
 * `port`. Both `localhost` and `127.0.0.1` are returned because browsers
 * treat them as distinct origins and the backend validates redirect URIs by
 * exact origin (scheme + host + port).
 */
export function localDevRedirectUrisForPort(port: number): string[] {
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

/**
 * Append local frontend origins for an already-resolved port without reading
 * or writing project state.
 */
export function appendLocalDevRedirectUrisForPort(
  services: RayfinConfig['services'],
  port: number
): RayfinConfig['services'] {
  let next = services;
  for (const uri of localDevRedirectUrisForPort(port)) {
    next = addAllowedRedirectUri(next, uri);
  }
  return next;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || !DECIMAL_PORT_PATTERN.test(value)) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_PORT
    ? parsed
    : undefined;
}

function parseRetainedPorts(value: string | undefined): number[] {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(',')
        .map((entry) => parsePort(entry.trim()))
        .filter((port): port is number => port !== undefined)
    ),
  ];
}

async function findAvailableFrontendPort(
  preferredPort: number,
  reservedPorts?: Set<number>
): Promise<number> {
  const maxAttempts = Math.min(
    PORT_SEARCH_ATTEMPTS,
    MAX_PORT - preferredPort + 1
  );
  try {
    return await findAvailablePort(preferredPort, reservedPorts, maxAttempts);
  } catch (preferredError) {
    if (!(preferredError instanceof PortRangeExhaustedError)) {
      throw preferredError;
    }
    if (preferredPort !== DEFAULT_FRONTEND_DEV_PORT) {
      try {
        return await findAvailablePort(
          DEFAULT_FRONTEND_DEV_PORT,
          reservedPorts,
          PORT_SEARCH_ATTEMPTS
        );
      } catch (defaultRangeError) {
        if (!(defaultRangeError instanceof PortRangeExhaustedError)) {
          throw defaultRangeError;
        }
        // Fall through to an OS-assigned port below.
      }
    }

    try {
      return await findAvailableEphemeralPort(reservedPorts);
    } catch {
      // Report one stable, actionable error below.
    }

    throw new Error(
      `No available frontend dev-server port was found. Free a local port or set ${FRONTEND_DEV_PORT_ENV_VAR} in rayfin/.env and retry.`,
      { cause: preferredError }
    );
  }
}

/**
 * Resolve the stable frontend dev-server port for a project, reusing the
 * persisted preference while it remains available and persisting a replacement
 * when it is occupied.
 *
 * The port is written to `rayfin/.env` so it is deterministic across runs and
 * unique per project — multiple local frontends no longer collide on 5173 and
 * the deployed backend can allow-list predictable redirect origins instead of
 * a guessed port range. Occupied prior assignments remain in `redirectPorts`
 * until their listeners stop, preserving already-running frontends.
 *
 * @param rayfinDir - Absolute path to the project's `rayfin/` directory.
 * @returns The primary available port and all loopback ports to allow-list.
 */
export async function resolveFrontendDevPort(
  rayfinDir: string,
  reservedPorts?: Set<number>
): Promise<FrontendDevPortResolution> {
  const envVars = await readEnvMap(rayfinDir);
  const existing = envVars.get(FRONTEND_DEV_PORT_ENV_VAR);
  const existingPort = parsePort(existing);
  const retainedValue = envVars.get(RETAINED_FRONTEND_DEV_PORTS_ENV_VAR);
  const retainedPorts: number[] = [];
  for (const port of parseRetainedPorts(retainedValue)) {
    if (port !== existingPort && !(await checkPortAvailability(port))) {
      retainedPorts.push(port);
    }
  }

  const preferredPort = existingPort ?? DEFAULT_FRONTEND_DEV_PORT;
  const existingPortReserved =
    existingPort !== undefined && reservedPorts?.has(existingPort) === true;
  const port = await findAvailableFrontendPort(preferredPort, reservedPorts);
  if (
    existingPort !== undefined &&
    port !== existingPort &&
    !existingPortReserved
  ) {
    retainedPorts.push(existingPort);
  }

  const normalizedRetainedPorts = [
    ...new Set(retainedPorts.filter((retainedPort) => retainedPort !== port)),
  ];
  const nextRetainedValue = normalizedRetainedPorts.join(',');
  const updates = [];
  if (String(port) !== existing) {
    updates.push({ key: FRONTEND_DEV_PORT_ENV_VAR, value: String(port) });
  }
  if (nextRetainedValue !== (retainedValue ?? '')) {
    updates.push({
      key: RETAINED_FRONTEND_DEV_PORTS_ENV_VAR,
      value: nextRetainedValue,
    });
  }
  if (updates.length > 0) {
    await upsertEnvVariables(rayfinDir, updates);
  }

  return { port, redirectPorts: [port, ...normalizedRetainedPorts] };
}

/** Resolve and persist the primary frontend dev-server port. */
export async function ensureFrontendDevPort(
  rayfinDir: string,
  reservedPorts?: Set<number>
): Promise<number> {
  return (await resolveFrontendDevPort(rayfinDir, reservedPorts)).port;
}

/**
 * Append the local frontend's dev-server redirect origins to a services
 * config, resolving (and persisting) the project's stable port first.
 *
 * Returns a new services object without mutating the input, matching the
 * {@link addAllowedRedirectUri} convention. This is the single seam shared by
 * `rayfin up` and the runtime-settings sync path so both register the exact
 * same origins the dev server will pin itself to.
 *
 * @param services - The services config to append redirect URIs to.
 * @param rayfinDir - Absolute path to the project's `rayfin/` directory.
 * @returns A new services object with the local dev origins appended.
 */
export async function appendLocalDevRedirectUris(
  services: RayfinConfig['services'],
  rayfinDir: string
): Promise<RayfinConfig['services']> {
  const resolution = await resolveFrontendDevPort(rayfinDir);
  let next = services;
  for (const port of resolution.redirectPorts) {
    next = appendLocalDevRedirectUrisForPort(next, port);
  }
  return next;
}

/**
 * Non-fatal frontend-port preparation for the `rayfin up` deployment path.
 *
 * The frontend port is always resolved so auth-disabled projects also replace
 * stale occupied ports. When auth is enabled, the local dev origins are
 * appended. Any failure is reported via `onError` and swallowed so deployment
 * can still proceed.
 *
 * @param services - The services config to conditionally extend.
 * @param rayfinDir - Absolute path to the project's `rayfin/` directory.
 * @param onError - Optional callback invoked when port resolution or redirect
 *   preparation fails; the original services are returned in that case.
 * @returns The services config, with local dev origins appended when auth is
 *   enabled and preparation succeeds; otherwise the input unchanged.
 */
export async function ensureLocalDevRedirectUris(
  services: RayfinConfig['services'],
  rayfinDir: string,
  onError?: (message: string) => void
): Promise<RayfinConfig['services']> {
  try {
    const resolution = await resolveFrontendDevPort(rayfinDir);
    if (!services.auth?.enabled) return services;

    let next = services;
    for (const port of resolution.redirectPorts) {
      next = appendLocalDevRedirectUrisForPort(next, port);
    }
    return next;
  } catch (err) {
    onError?.((err as Error).message);
    return services;
  }
}
