/**
 * Poll pacing primitives for the readiness step.
 *
 * Both Fabric operations readiness drives (trial provisioning, workspace
 * capacity assignment) are long-running and service-paced: they are bounded by
 * a wall-clock budget rather than an attempt count, and the service's
 * `Retry-After` outranks any local backoff.
 */
import type { CancellationToken } from '../../../adapters/index.js';

import type { FabricPollingOptions } from './types.js';

/** Delay before the second poll when the service sends no `Retry-After`. */
export const DEFAULT_POLL_DELAY_MS = 2_000;

/** Ceiling for locally-derived backoff. A service hint may exceed it. */
export const MAX_POLL_DELAY_MS = 30_000;

/** Fabric documents trial capacity provisioning as taking up to ten minutes. */
export const TRIAL_POLL_TIMEOUT_MS = 600_000;

/** Capacity assignment is a much shorter operation than trial provisioning. */
export const ASSIGNMENT_POLL_TIMEOUT_MS = 120_000;

/** Consecutive server-side poll errors tolerated before giving up. */
export const MAX_TRANSIENT_POLL_ERRORS = 3;

/** Resolved pacing for one readiness poll loop. */
export interface PollPacing {
  initialDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
}

/** Resolve trial-provisioning pacing from optional host overrides. */
export function trialPacing(options?: FabricPollingOptions): PollPacing {
  return {
    initialDelayMs: options?.initialDelayMs ?? DEFAULT_POLL_DELAY_MS,
    maxDelayMs: options?.maxDelayMs ?? MAX_POLL_DELAY_MS,
    timeoutMs: options?.trialTimeoutMs ?? TRIAL_POLL_TIMEOUT_MS,
  };
}

/** Resolve capacity-assignment pacing from optional host overrides. */
export function assignmentPacing(options?: FabricPollingOptions): PollPacing {
  return {
    initialDelayMs: options?.initialDelayMs ?? DEFAULT_POLL_DELAY_MS,
    maxDelayMs: options?.maxDelayMs ?? MAX_POLL_DELAY_MS,
    timeoutMs: options?.assignmentTimeoutMs ?? ASSIGNMENT_POLL_TIMEOUT_MS,
  };
}

/**
 * Next delay between polls.
 *
 * A `Retry-After` from the service is honored verbatim — it is the only party
 * that knows the real queue depth — and is deliberately not clamped to
 * {@link PollPacing.maxDelayMs}. Without one, the delay doubles up to that
 * ceiling. The caller still clamps the result to the remaining budget.
 */
export function nextDelayMs(
  pacing: PollPacing,
  previousMs: number,
  retryAfterMs?: number
): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return retryAfterMs;
  }
  if (previousMs <= 0) {
    return Math.min(pacing.initialDelayMs, pacing.maxDelayMs);
  }
  const base = Math.max(previousMs, pacing.initialDelayMs);
  return Math.min(base * 2, pacing.maxDelayMs);
}

/** Trim a delay so a poll loop never sleeps past its own deadline. */
export function untilDeadline(delayMs: number, deadline: number): number {
  return Math.max(0, Math.min(delayMs, deadline - Date.now()));
}

/** Wait before the next service poll. */
export function delay(ms: number, signal?: CancellationToken): Promise<void> {
  if (signal?.isCancellationRequested === true) {
    return Promise.reject(new Error('Operation cancelled'));
  }
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const state: { subscription?: { dispose(): void } } = {};
    const timer = setTimeout(() => {
      state.subscription?.dispose();
      resolve();
    }, ms);
    state.subscription = signal?.onCancellationRequested(() => {
      clearTimeout(timer);
      state.subscription?.dispose();
      reject(new Error('Operation cancelled'));
    });
  });
}
