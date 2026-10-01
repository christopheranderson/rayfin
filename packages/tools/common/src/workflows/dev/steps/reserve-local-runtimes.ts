/**
 * `dev` workflow step: reserve the local runtimes before backend wiring.
 *
 * Phase one of the two-phase local-runtime handshake. The host claims what a
 * runtime needs to exist at all — a free port, a present toolchain — and
 * returns the resulting URLs so {@link prepareLocalWiring} can fold them into
 * the frontend env. A configured runtime the host cannot supply comes back as
 * a typed `unavailable` outcome, never a thrown error.
 */
import type { CancellationToken } from '../../../adapters/index.js';
import type { Step } from '../../types.js';
import type {
  LocalRuntimeProvisioner,
  ReserveLocalRuntimesResult,
} from '../runtimes.js';

/** Capabilities {@link reserveLocalRuntimes} composes. */
export interface ReserveLocalRuntimesDeps {
  runtimes: LocalRuntimeProvisioner;
  signal?: CancellationToken;
}

/** Reserve host resources for every configured local runtime. */
export const reserveLocalRuntimes: Step<
  Record<string, never>,
  ReserveLocalRuntimesResult,
  ReserveLocalRuntimesDeps
> = async (_input, { runtimes, signal }) => runtimes.reserve({ signal });

/**
 * Collect the reserved base URLs as an id-keyed map for the backend provider.
 * Reservations without a URL (the runtime picks its own port at start time)
 * are omitted rather than mapped to an empty string.
 */
export function reservedRuntimeUrls(
  result: ReserveLocalRuntimesResult
): Record<string, string> {
  if (result.status !== 'reserved') return {};
  const urls: Record<string, string> = {};
  for (const reservation of result.reservations) {
    if (reservation.url) urls[reservation.id] = reservation.url;
  }
  return urls;
}
