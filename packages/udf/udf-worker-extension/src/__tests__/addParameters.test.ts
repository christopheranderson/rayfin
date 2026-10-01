import { describe, test, expect } from '@jest/globals';

import { UserDataFunctionInvalidInputError } from '../errors/udfErrors.js';
import { tryConvert } from '../internal/addParameters.js';

// ---------------------------------------------------------------------------
// tryConvert — string
// ---------------------------------------------------------------------------

describe('tryConvert — string', () => {
  test('passes through a string', () => {
    expect(tryConvert('hello', 'string', 's')).toBe('hello');
  });

  test('converts number to string', () => {
    expect(tryConvert(42, 'string', 's')).toBe('42');
  });

  test('converts boolean to string', () => {
    expect(tryConvert(true, 'string', 's')).toBe('true');
  });

  test('returns error for object', () => {
    expect(tryConvert({}, 'string', 's')).toBeInstanceOf(
      UserDataFunctionInvalidInputError
    );
  });

  test('returns error for array', () => {
    expect(tryConvert([], 'string', 's')).toBeInstanceOf(
      UserDataFunctionInvalidInputError
    );
  });

  test('returns error for null', () => {
    expect(tryConvert(null, 'string', 's')).toBeInstanceOf(
      UserDataFunctionInvalidInputError
    );
  });
});

// ---------------------------------------------------------------------------
// tryConvert — number
// ---------------------------------------------------------------------------

describe('tryConvert — number', () => {
  test('passes through integer', () => {
    expect(tryConvert(42, 'number', 'n')).toBe(42);
  });

  test('passes through float', () => {
    expect(tryConvert(3.14, 'number', 'n')).toBe(3.14);
  });

  test('passes through negative number', () => {
    expect(tryConvert(-7, 'number', 'n')).toBe(-7);
  });

  test('converts numeric string', () => {
    expect(tryConvert('42', 'number', 'n')).toBe(42);
  });

  test('converts float string', () => {
    expect(tryConvert('3.14', 'number', 'n')).toBe(3.14);
  });

  test('returns error for non-numeric string', () => {
    expect(tryConvert('abc', 'number', 'n')).toBeInstanceOf(
      UserDataFunctionInvalidInputError
    );
  });

  test('returns error for boolean', () => {
    expect(tryConvert(true, 'number', 'n')).toBeInstanceOf(
      UserDataFunctionInvalidInputError
    );
  });

  test('returns error for object', () => {
    expect(tryConvert({}, 'number', 'n')).toBeInstanceOf(
      UserDataFunctionInvalidInputError
    );
  });

  test('returns error for null', () => {
    expect(tryConvert(null, 'number', 'n')).toBeInstanceOf(
      UserDataFunctionInvalidInputError
    );
  });
});

// ---------------------------------------------------------------------------
// tryConvert — boolean
// ---------------------------------------------------------------------------

describe('tryConvert — boolean', () => {
  test('passes through true', () => {
    expect(tryConvert(true, 'boolean', 'b')).toBe(true);
  });

  test('passes through false', () => {
    expect(tryConvert(false, 'boolean', 'b')).toBe(false);
  });

  test('returns error for arbitrary string', () => {
    expect(tryConvert('yes', 'boolean', 'b')).toBeInstanceOf(
      UserDataFunctionInvalidInputError
    );
  });

  test('returns error for object', () => {
    expect(tryConvert({}, 'boolean', 'b')).toBeInstanceOf(
      UserDataFunctionInvalidInputError
    );
  });

  test('returns error for number', () => {
    expect(tryConvert(2, 'boolean', 'b')).toBeInstanceOf(
      UserDataFunctionInvalidInputError
    );
  });
});

// ---------------------------------------------------------------------------
// tryConvert — object / Record
// ---------------------------------------------------------------------------

describe('tryConvert — object', () => {
  test('passes through plain object', () => {
    const obj = { a: 1 };
    expect(tryConvert(obj, 'object', 'o')).toBe(obj);
  });

  test('passes through for Record type', () => {
    const obj = { key: 'val' };
    expect(tryConvert(obj, 'Record', 'o')).toBe(obj);
  });

  test('returns error for array', () => {
    expect(tryConvert([1, 2], 'object', 'o')).toBeInstanceOf(
      UserDataFunctionInvalidInputError
    );
  });

  test('returns error for string', () => {
    expect(tryConvert('text', 'object', 'o')).toBeInstanceOf(
      UserDataFunctionInvalidInputError
    );
  });

  test('returns error for null', () => {
    expect(tryConvert(null, 'object', 'o')).toBeInstanceOf(
      UserDataFunctionInvalidInputError
    );
  });

  test('returns error for number', () => {
    expect(tryConvert(42, 'object', 'o')).toBeInstanceOf(
      UserDataFunctionInvalidInputError
    );
  });
});

// ---------------------------------------------------------------------------
// tryConvert — arrays
// ---------------------------------------------------------------------------

describe('tryConvert — array', () => {
  test('passes through array for T[] syntax', () => {
    const arr = [1, 2, 3];
    expect(tryConvert(arr, 'number[]', 'a')).toBe(arr);
  });

  test('passes through array for Array<T> syntax', () => {
    const arr = ['a', 'b'];
    expect(tryConvert(arr, 'Array<string>', 'a')).toBe(arr);
  });

  test('returns error for string for array type', () => {
    expect(tryConvert('not an array', 'number[]', 'a')).toBeInstanceOf(
      UserDataFunctionInvalidInputError
    );
  });

  test('returns error for object for array type', () => {
    expect(tryConvert({ a: 1 }, 'Array<number>', 'a')).toBeInstanceOf(
      UserDataFunctionInvalidInputError
    );
  });

  test('returns error for number for array type', () => {
    expect(tryConvert(42, 'string[]', 'a')).toBeInstanceOf(
      UserDataFunctionInvalidInputError
    );
  });
});

// ---------------------------------------------------------------------------
// tryConvert — passthrough cases
// ---------------------------------------------------------------------------

describe('tryConvert — passthrough', () => {
  test("passes through for 'any' type", () => {
    expect(tryConvert('anything', 'any', 'x')).toBe('anything');
  });

  test("passes through for 'unknown' type", () => {
    expect(tryConvert(123, 'unknown', 'x')).toBe(123);
  });

  test('passes through for custom/interface types', () => {
    const val = { name: 'Alice', age: 30 };
    expect(tryConvert(val, 'MyCustomType', 'x')).toBe(val);
  });

  test('passes through for empty type string', () => {
    expect(tryConvert(42, '', 'x')).toBe(42);
  });
});
