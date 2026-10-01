/**
 * `dev` workflow step: prepare the reserved local runtimes for start.
 *
 * Phase two of the two-phase local-runtime handshake. The host now has the
 * backend wiring env, so it can write per-runtime settings, run pre-start
 * builds, and open watchers — returning startable specs. Anything acquired
 * here is released through each spec's `dispose`, which the workflow calls
 * when the session ends.
 */
import type { CancellationToken } from '../../../adapters/index.js';
import type { Step } from '../../types.js';
import type {
  LocalRuntimeProvisioner,
  PrepareLocalRuntimesResult,
  LocalRuntimeReservation,
} from '../runtimes.js';

/** Inputs for {@link prepareLocalRuntimes}. */
export interface PrepareLocalRuntimesStepInput {
  /** Backend wiring env produced by `prepareForLocalFrontend`. */
  env: Record<string, string>;
  /** Reservations returned by the reserve step. */
  reservations: LocalRuntimeReservation[];
}

/** Capabilities {@link prepareLocalRuntimes} composes. */
export interface PrepareLocalRuntimesDeps {
  runtimes: LocalRuntimeProvisioner;
  signal?: CancellationToken;
}

/** Turn the reservations plus the backend wiring env into startable specs. */
export const prepareLocalRuntimes: Step<
  PrepareLocalRuntimesStepInput,
  PrepareLocalRuntimesResult,
  PrepareLocalRuntimesDeps
> = async ({ env, reservations }, { runtimes, signal }) =>
  runtimes.prepare({ env, reservations, signal });
