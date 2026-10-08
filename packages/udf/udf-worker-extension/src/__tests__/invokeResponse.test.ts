import { describe, test, expect } from '@jest/globals';

import {
  StatusCode,
  FormattedError,
  UserDataFunctionInvokeResponse,
} from '../internal/invokeResponse.js';

describe('FormattedError', () => {
  test('stores fields from constructor', () => {
    const err = new FormattedError('InvalidInput', 'bad param', { key: 'val' });
    expect(err.errorCode).toBe('InvalidInput');
    expect(err.message).toBe('bad param');
    expect(err.properties).toEqual({ key: 'val' });
  });

  test('defaults properties to empty object', () => {
    const err = new FormattedError('X', 'msg');
    expect(err.properties).toEqual({});
  });

  test('addOrUpdateProperty mutates properties', () => {
    const err = new FormattedError('X', 'msg');
    err.addOrUpdateProperty('a', '1');
    expect(err.properties).toEqual({ a: '1' });
    err.addOrUpdateProperty('a', '2');
    expect(err.properties).toEqual({ a: '2' });
  });
});

describe('UserDataFunctionInvokeResponse', () => {
  test('has correct defaults', () => {
    const resp = new UserDataFunctionInvokeResponse();
    expect(resp.functionName).toBe('');
    expect(resp.invocationId).toBe('');
    expect(resp.status).toBe(StatusCode.SUCCEEDED);
    expect(resp.output).toBe('');
    expect(resp.errors).toEqual([]);
  });

  test('addError appends to errors list', () => {
    const resp = new UserDataFunctionInvokeResponse();
    const err = new FormattedError('X', 'msg');
    resp.addError(err);
    expect(resp.errors).toHaveLength(1);
    expect(resp.errors[0]).toBe(err);
  });

  test('toJSON produces the expected envelope shape', () => {
    const resp = new UserDataFunctionInvokeResponse();
    resp.functionName = 'hello_fabric';
    resp.invocationId = 'abc-123';
    resp.status = StatusCode.SUCCEEDED;
    resp.output = 'Hello Alice, you are 30 years old!';

    const parsed = JSON.parse(resp.toJSON());
    expect(parsed).toEqual({
      functionName: 'hello_fabric',
      invocationId: 'abc-123',
      status: 'Succeeded',
      output: 'Hello Alice, you are 30 years old!',
      errors: [],
    });
  });

  test('toJSON includes errors', () => {
    const resp = new UserDataFunctionInvokeResponse();
    resp.functionName = 'fn';
    resp.invocationId = 'id';
    resp.status = StatusCode.FAILED;
    resp.addError(new FormattedError('InternalError', 'boom', { detail: 'x' }));

    const parsed = JSON.parse(resp.toJSON());
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toEqual({
      errorCode: 'InternalError',
      message: 'boom',
      properties: { detail: 'x' },
    });
  });
});
