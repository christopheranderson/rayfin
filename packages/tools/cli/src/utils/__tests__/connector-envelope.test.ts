import { describe, expect, it } from 'vitest';

import {
  failedEnvelopeMessage,
  invocationIdNotPropagated,
} from '../connector-envelope.js';

/**
 * The body the deployed BaaS route returned on 2026-09-02 for a rejected
 * first-deploy semantic-model query, copied from a HAR so parsing is tested
 * against the wire.
 *
 * The all-zero invocation id means the platform synthesized this failure
 * envelope; it does not establish whether the function ran.
 */
const FIRST_DEPLOY_UNAUTHORIZED = {
  functionName: 'rayfin_semantic_model_v1',
  invocationId: '00000000-0000-0000-0000-000000000000',
  status: 'Failed',
  errors: [
    {
      errorCode: 'WorkloadException',
      subErrorCode: 'Unauthorized',
      message:
        "User data function: 'rayfin_semantic_model_v1' invocation failed.",
    },
  ],
};

describe('failedEnvelopeMessage', () => {
  it('reads the observed first-deploy rejection', () => {
    const message = failedEnvelopeMessage(FIRST_DEPLOY_UNAUTHORIZED);

    expect(message).toContain('WorkloadException/Unauthorized');
    expect(message).toContain('invocation failed');
    expect(message).toContain('No invocation id was propagated');
  });

  it('says nothing about a successful envelope', () => {
    expect(
      failedEnvelopeMessage({
        status: 'Succeeded',
        output: { tables: [] },
        errors: [],
      })
    ).toBeUndefined();
  });

  it('treats a non-empty errors array as failure whatever the status says', () => {
    // An envelope carrying errors has failed; trusting `status` alone would
    // report a call that errored as a success.
    const message = failedEnvelopeMessage({
      status: 'Succeeded',
      errors: [{ errorCode: 'Boom', message: 'it broke' }],
    });

    expect(message).toBe('Boom: it broke');
  });

  it('treats status Failed as failure when no errors array is present', () => {
    expect(failedEnvelopeMessage({ status: 'Failed' })).toBe(
      'The workload reported a failed invocation.'
    );
  });

  it('matches status case-insensitively', () => {
    expect(failedEnvelopeMessage({ status: 'FAILED' })).toBeDefined();
    expect(failedEnvelopeMessage({ status: 'failed' })).toBeDefined();
  });

  it('joins several errors rather than reporting only the first', () => {
    const message = failedEnvelopeMessage({
      status: 'Failed',
      errors: [
        { errorCode: 'One', message: 'first' },
        { errorCode: 'Two', message: 'second' },
      ],
    });

    expect(message).toBe('One: first; Two: second');
  });

  it('accepts a bare string error entry', () => {
    expect(
      failedEnvelopeMessage({ status: 'Failed', errors: ['plain text'] })
    ).toBe('plain text');
  });

  it('reports a code with no message, and a message with no code', () => {
    expect(
      failedEnvelopeMessage({
        status: 'Failed',
        errors: [{ errorCode: 'Solo' }],
      })
    ).toBe('Solo');
    expect(
      failedEnvelopeMessage({
        status: 'Failed',
        errors: [{ message: 'text' }],
      })
    ).toBe('text');
  });

  it('falls back to a generic message when entries carry nothing usable', () => {
    // Otherwise the caller gets an empty string and reports a failure with no
    // stated reason.
    expect(
      failedEnvelopeMessage({ status: 'Failed', errors: [{}, null, 42] })
    ).toBe('The workload reported a failed invocation.');
  });

  it('reports the missing invocation id only when it is all zeros', () => {
    const real = failedEnvelopeMessage({
      status: 'Failed',
      invocationId: 'a2aa0978-2ae1-43fe-98f8-3de81d21e374',
      errors: [{ errorCode: 'Boom' }],
    });

    expect(real).toBe('Boom');
    expect(real).not.toContain('No invocation id was propagated');
  });

  it('ignores payloads that are not objects', () => {
    for (const value of [undefined, null, 'failed', 42, true]) {
      expect(failedEnvelopeMessage(value)).toBeUndefined();
    }
  });

  it('ignores an object with neither status nor errors', () => {
    expect(failedEnvelopeMessage({ output: { tables: [] } })).toBeUndefined();
  });
});

describe('invocationIdNotPropagated', () => {
  it('recognizes the all-zero GUID', () => {
    expect(
      invocationIdNotPropagated('00000000-0000-0000-0000-000000000000')
    ).toBe(true);
  });

  it('recognizes all-zero ids without hyphens', () => {
    expect(invocationIdNotPropagated('00000000000000000000000000000000')).toBe(
      true
    );
  });

  it('rejects a real invocation id', () => {
    expect(
      invocationIdNotPropagated('a2aa0978-2ae1-43fe-98f8-3de81d21e374')
    ).toBe(false);
  });

  it('rejects an id that merely starts with zeros', () => {
    // `000d1568-...` is a real invocation and must not be read as a synthesized failure.
    expect(
      invocationIdNotPropagated('000d1568-57a1-4ed0-89da-1b8c3a7bbaef')
    ).toBe(false);
  });

  it('rejects empty, hyphen-only, short, and non-string values', () => {
    expect(invocationIdNotPropagated('')).toBe(false);
    expect(invocationIdNotPropagated('----')).toBe(false);
    // Only the all-zero GUID is the sentinel.
    expect(invocationIdNotPropagated('0')).toBe(false);
    expect(invocationIdNotPropagated('00')).toBe(false);
    expect(invocationIdNotPropagated('0000-0000')).toBe(false);
    expect(invocationIdNotPropagated(undefined)).toBe(false);
    expect(invocationIdNotPropagated(null)).toBe(false);
    expect(invocationIdNotPropagated(0)).toBe(false);
  });
});
