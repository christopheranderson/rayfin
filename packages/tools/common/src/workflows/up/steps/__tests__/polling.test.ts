import { describe, expect, it } from 'vitest';

import {
  DEFAULT_POLL_DELAY_MS,
  MAX_POLL_DELAY_MS,
  nextDelayMs,
  trialPacing,
  untilDeadline,
} from '../../../fabric-readiness/steps/polling.js';

const pacing = trialPacing();

describe('nextDelayMs', () => {
  // `Retry-After` reaches this function already normalized to milliseconds by
  // the transport. Asserting the value verbatim is what pins that unit: a
  // seconds-valued hint would sleep 1000x too short and poll Fabric in a spin.
  it('honors a service pacing hint verbatim, in milliseconds', () => {
    expect(nextDelayMs(pacing, DEFAULT_POLL_DELAY_MS, 12_000)).toBe(12_000);
  });

  it('honors a hint that exceeds the local backoff ceiling', () => {
    const hint = MAX_POLL_DELAY_MS * 3;
    expect(nextDelayMs(pacing, DEFAULT_POLL_DELAY_MS, hint)).toBe(hint);
  });

  it('doubles the previous delay when the service sends no hint', () => {
    expect(nextDelayMs(pacing, DEFAULT_POLL_DELAY_MS)).toBe(
      DEFAULT_POLL_DELAY_MS * 2
    );
  });

  it('ignores a non-positive hint and backs off locally instead', () => {
    expect(nextDelayMs(pacing, DEFAULT_POLL_DELAY_MS, 0)).toBe(
      DEFAULT_POLL_DELAY_MS * 2
    );
  });

  it('clamps locally-derived backoff to the ceiling', () => {
    expect(nextDelayMs(pacing, MAX_POLL_DELAY_MS)).toBe(MAX_POLL_DELAY_MS);
  });

  it('starts from the initial delay when the previous delay was zero', () => {
    expect(nextDelayMs(pacing, 0)).toBe(DEFAULT_POLL_DELAY_MS);
  });
});

describe('untilDeadline', () => {
  it('trims a delay that would sleep past the deadline', () => {
    expect(untilDeadline(60_000, Date.now() + 5_000)).toBeLessThanOrEqual(
      5_000
    );
  });

  it('never returns a negative delay for an elapsed deadline', () => {
    expect(untilDeadline(1_000, Date.now() - 5_000)).toBe(0);
  });
});
