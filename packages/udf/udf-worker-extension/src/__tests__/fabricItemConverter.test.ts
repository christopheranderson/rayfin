import { describe, test, expect } from '@jest/globals';

import { UserDataFunctionInternalError } from '../errors/udfErrors.js';
import { decode } from '../internal/fabricItemConverter.js';
import { FabricItem } from '../types/fabricItem.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    AliasName: 'myAlias',
    Endpoints: {
      SqlEndpoint: {
        ConnectionString: 'Server=myserver.database.windows.net',
        AccessToken: 'eyJ0eXAi...',
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// null / undefined input
// ---------------------------------------------------------------------------

describe('decode — null / undefined input', () => {
  test('throws for null', () => {
    expect(() => decode(null)).toThrow(UserDataFunctionInternalError);
  });

  test('throws for undefined', () => {
    expect(() => decode(undefined)).toThrow(UserDataFunctionInternalError);
  });
});

// ---------------------------------------------------------------------------
// non-object input
// ---------------------------------------------------------------------------

describe('decode — non-object input', () => {
  test('throws for number', () => {
    expect(() => decode(42)).toThrow(UserDataFunctionInternalError);
  });

  test('throws for boolean', () => {
    expect(() => decode(true)).toThrow(UserDataFunctionInternalError);
  });
});

// ---------------------------------------------------------------------------
// string input (JSON parsing)
// ---------------------------------------------------------------------------

describe('decode — string input', () => {
  test('parses a valid JSON string', () => {
    const payload = makePayload();
    const result = decode(JSON.stringify(payload));
    expect(result).toBeInstanceOf(FabricItem);
    expect((result as FabricItem).aliasName).toBe('myAlias');
  });

  test('throws UserDataFunctionInternalError for invalid JSON string', () => {
    expect(() => decode('not json')).toThrow(UserDataFunctionInternalError);
  });
});

// ---------------------------------------------------------------------------
// ErrorMessage
// ---------------------------------------------------------------------------

describe('decode — ErrorMessage', () => {
  test('throws with reason when ErrorMessage is present', () => {
    const payload = makePayload({ ErrorMessage: 'host error' });
    let caught: unknown;
    try {
      decode(payload);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UserDataFunctionInternalError);
    expect((caught as UserDataFunctionInternalError).properties.reason).toBe(
      'host error'
    );
  });
});

// ---------------------------------------------------------------------------
// AliasName validation
// ---------------------------------------------------------------------------

describe('decode — AliasName', () => {
  test('throws when AliasName is missing', () => {
    const { AliasName, ...payload } = makePayload();
    expect(() => decode(payload)).toThrow(UserDataFunctionInternalError);
  });

  test('throws when AliasName is empty string', () => {
    const payload = makePayload({ AliasName: '' });
    expect(() => decode(payload)).toThrow(UserDataFunctionInternalError);
  });
});

// ---------------------------------------------------------------------------
// Endpoint parsing
// ---------------------------------------------------------------------------

describe('decode — endpoint parsing', () => {
  test('lowercases endpoint keys', () => {
    const payload = makePayload();
    const result = decode(payload) as FabricItem;
    expect(result.endpoints.has('sqlendpoint')).toBe(true);
    expect(result.endpoints.has('SqlEndpoint')).toBe(false);
  });

  test('extracts ConnectionString and AccessToken', () => {
    const payload = makePayload();
    const result = decode(payload) as FabricItem;
    const ep = result.endpoints.get('sqlendpoint')!;
    expect(ep.connectionString).toBe('Server=myserver.database.windows.net');
    expect(ep.accessToken).toBe('eyJ0eXAi...');
  });

  test('defaults missing ConnectionString and AccessToken to empty string', () => {
    const payload = makePayload({
      Endpoints: { MyEndpoint: { Other: 'value' } },
    });
    const result = decode(payload) as FabricItem;
    const ep = result.endpoints.get('myendpoint')!;
    expect(ep.connectionString).toBe('');
    expect(ep.accessToken).toBe('');
  });
});

// ---------------------------------------------------------------------------
// parseType routing
// ---------------------------------------------------------------------------

describe('decode — always returns FabricItem', () => {
  test('returns FabricItem', () => {
    const payload = makePayload();
    const result = decode(payload);
    expect(result).toBeInstanceOf(FabricItem);
  });
});
