import { describe, test, expect } from '@jest/globals';

import {
  UDFExceptionCodes,
  UserDataFunctionError,
  UserDataFunctionInternalError,
  UserDataFunctionInvalidInputError,
  UserDataFunctionMissingInputError,
  UserThrownError,
} from '../errors/udfErrors.js';

// ---------------------------------------------------------------------------
// UDFExceptionCodes constants
// ---------------------------------------------------------------------------

describe('UDFExceptionCodes', () => {
  test('matches the Python UDFExceptionCodes values exactly', () => {
    expect(UDFExceptionCodes.INVALID_INPUT).toBe('InvalidInput');
    expect(UDFExceptionCodes.MISSING_INPUT).toBe('MissingInput');
    expect(UDFExceptionCodes.USER_THROWN).toBe('UserThrown');
    expect(UDFExceptionCodes.INTERNAL_ERROR).toBe('InternalError');
    expect(UDFExceptionCodes.RESPONSE_TOO_LARGE).toBe('ResponseTooLarge');
  });
});

// ---------------------------------------------------------------------------
// Base class: UserDataFunctionError
// ---------------------------------------------------------------------------

describe('UserDataFunctionError', () => {
  test('stores errorCode, message, and properties', () => {
    const err = new UserDataFunctionError('TestCode', 'test message', {
      key: 'value',
    });
    expect(err.errorCode).toBe('TestCode');
    expect(err.message).toBe('test message');
    expect(err.properties).toEqual({ key: 'value' });
  });

  test('uses sensible defaults', () => {
    const err = new UserDataFunctionError('TestCode');
    expect(err.message).toBe('Known User Data Function Exception Thrown');
    expect(err.properties).toEqual({});
  });

  test('extends Error', () => {
    const err = new UserDataFunctionError('TestCode');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(UserDataFunctionError);
  });

  test('properties are a shallow copy (caller cannot mutate internals)', () => {
    const props: Record<string, string> = { a: '1' };
    const err = new UserDataFunctionError('X', 'msg', props);
    props['b'] = '2';
    expect(err.properties).toEqual({ a: '1' });
  });
});

// ---------------------------------------------------------------------------
// UserDataFunctionInternalError
// ---------------------------------------------------------------------------

describe('UserDataFunctionInternalError', () => {
  test('default errorCode and message match Python', () => {
    const err = new UserDataFunctionInternalError();
    expect(err.errorCode).toBe('InternalError');
    expect(err.message).toBe(
      'An internal execution error occured during function execution'
    );
    expect(err.properties).toEqual({});
  });

  test('accepts custom message and properties', () => {
    const err = new UserDataFunctionInternalError('custom msg', {
      detail: 'xyz',
    });
    expect(err.errorCode).toBe('InternalError');
    expect(err.message).toBe('custom msg');
    expect(err.properties).toEqual({ detail: 'xyz' });
  });

  test('is instanceof UserDataFunctionError', () => {
    const err = new UserDataFunctionInternalError();
    expect(err).toBeInstanceOf(UserDataFunctionError);
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// UserDataFunctionInvalidInputError
// ---------------------------------------------------------------------------

describe('UserDataFunctionInvalidInputError', () => {
  test('default errorCode and message match Python', () => {
    const err = new UserDataFunctionInvalidInputError();
    expect(err.errorCode).toBe('InvalidInput');
    expect(err.message).toContain('Something went wrong when parsing an input');
    expect(err.properties).toEqual({});
  });

  test('accepts custom message and properties', () => {
    const err = new UserDataFunctionInvalidInputError('bad JSON', {
      param: 'age',
    });
    expect(err.errorCode).toBe('InvalidInput');
    expect(err.message).toBe('bad JSON');
    expect(err.properties).toEqual({ param: 'age' });
  });

  test('is instanceof UserDataFunctionError', () => {
    expect(new UserDataFunctionInvalidInputError()).toBeInstanceOf(
      UserDataFunctionError
    );
  });
});

// ---------------------------------------------------------------------------
// UserDataFunctionMissingInputError
// ---------------------------------------------------------------------------

describe('UserDataFunctionMissingInputError', () => {
  test('default errorCode and message match Python', () => {
    const err = new UserDataFunctionMissingInputError();
    expect(err.errorCode).toBe('MissingInput');
    expect(err.message).toBe('Parameter does not exist in binding data');
  });

  test('accepts custom message', () => {
    const err = new UserDataFunctionMissingInputError(
      "missing 'name' parameter"
    );
    expect(err.errorCode).toBe('MissingInput');
    expect(err.message).toBe("missing 'name' parameter");
  });

  test('is instanceof UserDataFunctionError', () => {
    expect(new UserDataFunctionMissingInputError()).toBeInstanceOf(
      UserDataFunctionError
    );
  });
});

// ---------------------------------------------------------------------------
// UserThrownError
// ---------------------------------------------------------------------------

describe('UserThrownError', () => {
  test('default errorCode and message match Python', () => {
    const err = new UserThrownError();
    expect(err.errorCode).toBe('UserThrown');
    expect(err.message).toBe('User Exception Thrown');
  });

  test('accepts custom message and properties (like Python sample)', () => {
    const err = new UserThrownError(
      'You must be 18 years or older to use this service.',
      { age: '17' }
    );
    expect(err.errorCode).toBe('UserThrown');
    expect(err.message).toBe(
      'You must be 18 years or older to use this service.'
    );
    expect(err.properties).toEqual({ age: '17' });
  });

  test('can be used as a base class for custom errors', () => {
    class MyAppError extends UserThrownError {
      constructor(msg: string) {
        super(msg);
        this.name = 'MyAppError';
      }
    }
    const err = new MyAppError('app-level failure');
    expect(err).toBeInstanceOf(UserThrownError);
    expect(err).toBeInstanceOf(UserDataFunctionError);
    expect(err).toBeInstanceOf(Error);
    expect(err.errorCode).toBe('UserThrown');
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: all subclasses caught by base catch
// ---------------------------------------------------------------------------

describe('error .name matches class name', () => {
  test.each([
    ['UserDataFunctionError', new UserDataFunctionError('X')],
    ['UserDataFunctionInternalError', new UserDataFunctionInternalError()],
    [
      'UserDataFunctionInvalidInputError',
      new UserDataFunctionInvalidInputError(),
    ],
    [
      'UserDataFunctionMissingInputError',
      new UserDataFunctionMissingInputError(),
    ],
    ['UserThrownError', new UserThrownError()],
  ])('%s', (expectedName, err) => {
    expect(err.name).toBe(expectedName);
  });

  test('user subclass gets its own name', () => {
    class MyAppError extends UserThrownError {}
    expect(new MyAppError().name).toBe('MyAppError');
  });
});

describe('catch hierarchy', () => {
  const errors = [
    new UserDataFunctionInternalError(),
    new UserDataFunctionInvalidInputError(),
    new UserDataFunctionMissingInputError(),
    new UserThrownError(),
  ];

  test('every subclass is instanceof UserDataFunctionError', () => {
    for (const err of errors) {
      expect(err).toBeInstanceOf(UserDataFunctionError);
    }
  });

  test('every subclass is instanceof Error', () => {
    for (const err of errors) {
      expect(err).toBeInstanceOf(Error);
    }
  });
});
