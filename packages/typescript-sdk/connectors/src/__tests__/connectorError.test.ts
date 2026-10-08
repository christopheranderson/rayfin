/**
 * @packageDocumentation Tests for the shared connector error contract.
 *
 * The contract is a shape connectors satisfy rather than a hook they
 * implement, so the guard has to accept a normalised failure from any
 * connector and reject the raw transport envelope a connector that has not
 * adopted it still returns.
 */

import { describe, it, expect } from 'vitest';

import { isConnectorError } from '../ConnectorsSchema';

describe('isConnectorError', () => {
  it('accepts a normalised failure carrying the shared shape', () => {
    const result = {
      status: 'error',
      error: {
        message: 'Power BI returned HTTP 401 with an empty body.',
        code: '401',
        category: 'api',
        recoveryHint: 'Check the token audience.',
      },
      requestId: 'abc',
    };

    expect(isConnectorError(result)).toBe(true);

    if (isConnectorError(result)) {
      // The narrowing is the point: the caller reads the error without
      // knowing which connector produced it.
      expect(result.error.message).toBe(
        'Power BI returned HTTP 401 with an empty body.'
      );
      expect(result.error.category).toBe('api');
      expect(result.error.recoveryHint).toBe('Check the token audience.');
    }
  });

  it('accepts an error carrying only the required message', () => {
    expect(
      isConnectorError({ status: 'error', error: { message: 'nope' } })
    ).toBe(true);
  });

  it('rejects the raw transport envelope so its failures keep their own handling', () => {
    // `connector-kusto` still resolves to this shape. Reading it as a
    // non-failure is what would let a failed query exit 0, so the guard has
    // to say no rather than guess.
    const envelope = {
      status: 'Failed',
      output: { tables: [], requestId: 'r-1', responseError: { message: 'x' } },
      errors: [],
    };

    expect(isConnectorError(envelope)).toBe(false);
  });

  it('rejects a success result', () => {
    expect(
      isConnectorError({ status: 'success', table: { columns: [], rows: [] } })
    ).toBe(false);
  });

  it('rejects a failure whose error is missing or malformed', () => {
    expect(isConnectorError({ status: 'error' })).toBe(false);
    expect(isConnectorError({ status: 'error', error: null })).toBe(false);
    expect(isConnectorError({ status: 'error', error: {} })).toBe(false);
    expect(isConnectorError({ status: 'error', error: { message: 7 } })).toBe(
      false
    );
  });

  it('rejects values that are not objects', () => {
    expect(isConnectorError(undefined)).toBe(false);
    expect(isConnectorError(null)).toBe(false);
    expect(isConnectorError('error')).toBe(false);
  });
});
