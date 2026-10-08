/**
 * Fabric trial capacity activation.
 *
 * A tenant gets a small, fixed number of trials, so this module never starts a
 * second one speculatively: every "already exists" and "provisioning in
 * progress" signal is recovered by rediscovering the capacity, never by
 * re-issuing the `POST`.
 */
import type {
  FabricPollableOperation,
  FabricCapacity,
} from '../../../external/fabric/index.js';
import { isActiveCapacity } from '../../../external/fabric/index.js';

import {
  cancelledReadiness,
  isReadinessCancelled,
  problem,
  reportPhase,
} from './outcomes.js';
import {
  MAX_TRANSIENT_POLL_ERRORS,
  type PollPacing,
  delay,
  nextDelayMs,
  trialPacing,
  untilDeadline,
} from './polling.js';
import {
  eligibilityProblem,
  fabricProblem,
  isCapacityCreationFailure,
  isExistingTrialError,
  isTransientFabricError,
} from './problems.js';
import type {
  CapacitySelection,
  EnsureFabricTargetDeps,
  TrialLookup,
} from './types.js';

/** Activate the delegated user's Fabric trial and return its capacity. */
export async function selectTrialCapacity(
  deps: EnsureFabricTargetDeps
): Promise<CapacitySelection> {
  const pacing = trialPacing(deps.polling);
  if (isReadinessCancelled(deps)) return cancelledReadiness();

  let eligibility;
  try {
    eligibility = await deps.fabric.checkTrialEligibility();
    if (isReadinessCancelled(deps)) return cancelledReadiness();
  } catch (error) {
    const expected = fabricProblem(error);
    if (expected) return { status: 'problem', problem: expected };
    throw error;
  }

  if (!eligibility.eligible) {
    // `TrialAlreadyExists` is a discovery instruction, not a blocked state: the
    // entitlement is already granted and only the capacity lookup is stale.
    if (eligibility.reason === 'TrialAlreadyExists') {
      const existing = await awaitExistingTrial(deps, pacing);
      if (existing.status !== 'not-found') return fromLookup(existing);
      return { status: 'problem', problem: trialTimeout() };
    }
    return {
      status: 'problem',
      problem: eligibilityProblem(eligibility.reason),
    };
  }

  let operation: FabricPollableOperation;
  try {
    if (isReadinessCancelled(deps)) return cancelledReadiness();
    reportPhase(deps, 'trial', 'Activating Fabric trial capacity');
    operation = await deps.fabric.startTrial();
    if (isReadinessCancelled(deps)) return cancelledReadiness();
  } catch (error) {
    if (isExistingTrialError(error)) {
      const existing = await awaitExistingTrial(deps, pacing);
      if (existing.status !== 'not-found') return fromLookup(existing);
      return { status: 'problem', problem: trialTimeout() };
    }
    if (isCapacityCreationFailure(error)) {
      return recoverCapacityCreationFailure(deps, pacing);
    }
    const expected = fabricProblem(error);
    if (expected) return { status: 'problem', problem: expected };
    throw error;
  }

  return pollTrialOperation(operation, deps, pacing);
}

/** One pass over the tenant's capacities looking for an active trial. */
async function rediscoverTrial(
  deps: EnsureFabricTargetDeps
): Promise<TrialLookup> {
  let trial: FabricCapacity | undefined;
  try {
    trial = await deps.fabric.findTrialCapacity();
  } catch (error) {
    const expected = fabricProblem(error);
    if (expected) return { status: 'problem', problem: expected };
    throw error;
  }

  return trial ? { status: 'found', capacity: trial } : { status: 'not-found' };
}

/**
 * Poll the capacity list until a trial Fabric has confirmed exists becomes
 * visible. Used when Start Trial reports the trial already exists or is still
 * provisioning — the capacity is coming, only the listing lags.
 */
async function awaitExistingTrial(
  deps: EnsureFabricTargetDeps,
  pacing: PollPacing
): Promise<TrialLookup> {
  const deadline = Date.now() + pacing.timeoutMs;
  let delayMs = 0;
  let transientErrors = 0;

  for (;;) {
    await delay(untilDeadline(delayMs, deadline), deps.signal);

    let lookup: TrialLookup;
    try {
      const trial = await deps.fabric.findTrialCapacity();
      lookup = trial
        ? { status: 'found', capacity: trial }
        : { status: 'not-found' };
      transientErrors = 0;
    } catch (error) {
      transientErrors += 1;
      if (
        isTransientFabricError(error) &&
        transientErrors < MAX_TRANSIENT_POLL_ERRORS &&
        Date.now() < deadline
      ) {
        delayMs = nextDelayMs(pacing, delayMs, error.retryAfterMs);
        continue;
      }
      const expected = fabricProblem(error);
      if (expected) return { status: 'problem', problem: expected };
      throw error;
    }

    if (lookup.status !== 'not-found') return lookup;
    if (Date.now() >= deadline) return { status: 'not-found' };

    delayMs = nextDelayMs(pacing, delayMs);
  }
}

/** Drive the trial provisioning operation to a terminal state. */
async function pollTrialOperation(
  operation: FabricPollableOperation,
  deps: EnsureFabricTargetDeps,
  pacing: PollPacing
): Promise<CapacitySelection> {
  const deadline = Date.now() + pacing.timeoutMs;
  // The 202's `Retry-After` paces the first poll; without one the operation may
  // already be complete, so the first status read is not delayed.
  let delayMs = operation.retryAfterMs ?? 0;
  let transientErrors = 0;

  for (;;) {
    await delay(untilDeadline(delayMs, deadline), deps.signal);

    let status;
    try {
      status = await deps.fabric.getOperationStatus(
        operation.operationLocation,
        operation.operationId
      );
      transientErrors = 0;
    } catch (error) {
      transientErrors += 1;
      if (
        isTransientFabricError(error) &&
        transientErrors < MAX_TRANSIENT_POLL_ERRORS &&
        Date.now() < deadline
      ) {
        delayMs = nextDelayMs(pacing, delayMs, error.retryAfterMs);
        continue;
      }
      const expected = fabricProblem(error);
      if (expected) return { status: 'problem', problem: expected };
      throw error;
    }

    if (status.status === 'Succeeded') {
      return resolveProvisionedTrial(operation, deps);
    }
    if (
      status.status === 'Failed' ||
      status.status === 'Canceled' ||
      status.status === 'Cancelled'
    ) {
      return failedProvisioning(operation, deps);
    }

    if (Date.now() >= deadline) break;
    reportPhase(
      deps,
      'trial',
      // Deliberately no percentage or elapsed time. Fabric's operation status
      // carries a `percentComplete`, but it stays at 0 until the operation
      // completes — a 0-to-100 jump saying nothing the phase transition does
      // not already say, rendered as a spinner frozen at `(0%)` for the full
      // ten-minute budget. The animated spinner is the liveness signal.
      'Waiting for Fabric to finish provisioning trial capacity'
    );
    delayMs = nextDelayMs(pacing, delayMs, status.retryAfterMs);
  }

  return { status: 'problem', problem: trialTimeout() };
}

/**
 * Read the capacity a completed trial operation produced.
 *
 * The result is not re-classified as a trial. It is whatever Start Trial
 * created, so provenance already answers that question — and answering it
 * again through {@link TRIAL_CAPACITY_SKUS} would fail a run whose trial was
 * provisioned successfully, purely because Fabric shipped a trial SKU this
 * allowlist has not learned yet. That allowlist exists to *find* a trial among
 * a tenant's many capacities, not to second-guess the one just handed back.
 *
 * Usability is still checked: the capacity is about to be deployed onto.
 */
async function resolveProvisionedTrial(
  operation: FabricPollableOperation,
  deps: EnsureFabricTargetDeps
): Promise<CapacitySelection> {
  let capacity: FabricCapacity;
  try {
    // Fabric wraps the created capacity in an envelope — `{ capacity: { id,
    // state } }` — so the payload is unwrapped before use. A bare capacity is
    // still accepted so a future unwrapped response cannot regress this path.
    const result = await deps.fabric.getOperationResult<
      { capacity?: FabricCapacity } & Partial<FabricCapacity>
    >(operation.operationId);
    const resolved = result?.capacity ?? (result as FabricCapacity | undefined);
    if (!resolved?.state) {
      return {
        status: 'problem',
        problem: problem(
          'failed',
          'capacity_not_usable',
          'Fabric reported the trial capacity was provisioned but returned no capacity details.',
          true
        ),
      };
    }
    capacity = resolved;
  } catch (error) {
    const expected = fabricProblem(error);
    if (expected) return { status: 'problem', problem: expected };
    throw error;
  }

  if (!isActiveCapacity(capacity)) {
    return {
      status: 'problem',
      problem: problem(
        'failed',
        'capacity_not_usable',
        `Fabric finished provisioning the trial capacity but it reports state "${capacity.state}" and cannot host a deployment.`,
        true
      ),
    };
  }

  return { status: 'selected', capacity, source: 'new-trial' };
}

/**
 * A reported provisioning failure can still have left a usable trial behind
 * (Fabric's `CapacityCreationFailure` is raised after the entitlement is
 * granted), so rediscovery runs before the failure is reported.
 */
async function failedProvisioning(
  operation: FabricPollableOperation,
  deps: EnsureFabricTargetDeps
): Promise<CapacitySelection> {
  const existing = await rediscoverTrial(deps);
  if (existing.status !== 'not-found') return fromLookup(existing);

  return {
    status: 'problem',
    problem: problem(
      'failed',
      'trial_provisioning_failed',
      `Fabric trial capacity provisioning failed (operation ${operation.operationId}).`,
      true
    ),
  };
}

async function recoverCapacityCreationFailure(
  deps: EnsureFabricTargetDeps,
  pacing: PollPacing
): Promise<CapacitySelection> {
  const existing = await awaitExistingTrial(deps, pacing);
  if (existing.status !== 'not-found') return fromLookup(existing);

  return {
    status: 'problem',
    problem: problem(
      'failed',
      'trial_provisioning_failed',
      'Fabric trial capacity provisioning failed.',
      true
    ),
  };
}

function fromLookup(
  lookup: Exclude<TrialLookup, { status: 'not-found' }>
): CapacitySelection {
  return lookup.status === 'found'
    ? {
        status: 'selected',
        capacity: lookup.capacity,
        source: 'existing-trial',
      }
    : { status: 'problem', problem: lookup.problem };
}

function trialTimeout() {
  return problem(
    'retry-later',
    'trial_provisioning_timeout',
    'Fabric is still provisioning the trial capacity.',
    true
  );
}
