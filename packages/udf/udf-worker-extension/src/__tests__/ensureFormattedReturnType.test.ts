import azureFunctions, {
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';

import {
  UserDataFunctionInternalError,
  UserDataFunctionInvalidInputError,
  UserDataFunctionMissingInputError,
  UserThrownError,
} from '../errors/udfErrors.js';
import {
  ensureFormattedReturnType,
  getLocalHttpStatusCode,
} from '../internal/ensureFormattedReturnType.js';
import {
  FormattedError,
  StatusCode,
  type StatusCodeValue,
  UserDataFunctionInvokeResponse,
} from '../internal/invokeResponse.js';

function expectResponse(
  response: HttpResponseInit,
  status: StatusCodeValue,
  output: unknown,
  errors: FormattedError[],
  httpStatus = 200
): void {
  expect(response).toEqual({
    status: httpStatus,
    body: JSON.stringify({
      functionName: 'test_function',
      invocationId: 'test-invocation-id',
      status,
      output,
      errors,
    }),
    headers: {
      'Content-Type': 'application/json',
      'x-fabric-udf-status': status,
    },
  });
}

describe.each([undefined, 'false', 'true', '', 'TRUE', '1', ' true '])(
  'HTTP response mapping with IsLocal=%p',
  (isLocal) => {
    let originalIsLocal: string | undefined;
    let originalEnvironment: string | undefined;
    let context: InvocationContext;

    beforeEach(() => {
      originalIsLocal = process.env.IsLocal;
      originalEnvironment = process.env.AZURE_FUNCTIONS_ENVIRONMENT;
      if (isLocal === undefined) {
        delete process.env.IsLocal;
      } else {
        process.env.IsLocal = isLocal;
      }
      context = new azureFunctions.InvocationContext({
        functionName: 'test_function',
        invocationId: 'test-invocation-id',
      });
      jest.spyOn(context, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      if (originalIsLocal === undefined) {
        delete process.env.IsLocal;
      } else {
        process.env.IsLocal = originalIsLocal;
      }
      if (originalEnvironment === undefined) {
        delete process.env.AZURE_FUNCTIONS_ENVIRONMENT;
      } else {
        process.env.AZURE_FUNCTIONS_ENVIRONMENT = originalEnvironment;
      }
      jest.restoreAllMocks();
    });

    test('preserves successful responses', async () => {
      const output = { value: 42 };
      const func = jest.fn<() => Promise<unknown>>().mockResolvedValue(output);

      const response = await ensureFormattedReturnType(
        func,
        context.functionName,
        context.invocationId,
        context
      );

      expectResponse(response, StatusCode.SUCCEEDED, output, []);
      expect(func).toHaveBeenCalledTimes(1);
      expect(context.error).not.toHaveBeenCalled();
    });

    test.each([
      new UserDataFunctionMissingInputError('Missing input'),
      new UserDataFunctionInvalidInputError('Invalid input'),
    ])(
      'preserves input errors without invoking the handler: %p',
      async (error) => {
        const func = jest.fn<() => Promise<unknown>>();

        const response = await ensureFormattedReturnType(
          func,
          context.functionName,
          context.invocationId,
          context,
          [error]
        );

        expectResponse(
          response,
          StatusCode.BAD_REQUEST,
          '',
          [
            new FormattedError(
              error.errorCode,
              error.message,
              error.properties
            ),
          ],
          isLocal === 'true' ? 400 : 200
        );
        expect(func).not.toHaveBeenCalled();
        expect(context.error).toHaveBeenCalledTimes(1);
      }
    );

    test.each([
      {
        error: new UserThrownError('User validation failed', { field: 'name' }),
        status: StatusCode.BAD_REQUEST,
        httpStatus: 422,
        formatted: new FormattedError('UserThrown', 'User validation failed', {
          field: 'name',
        }),
      },
      {
        error: new UserDataFunctionInternalError('Internal failure'),
        status: StatusCode.FAILED,
        httpStatus: 500,
        formatted: new FormattedError('InternalError', 'Internal failure'),
      },
      {
        error: new Error('Unexpected failure'),
        status: StatusCode.FAILED,
        httpStatus: 500,
        formatted: new FormattedError(
          'InternalError',
          new UserDataFunctionInternalError().message,
          { error_type: 'Error', error_message: 'Unexpected failure' }
        ),
      },
    ])(
      'preserves thrown errors: $error.message',
      async ({ error, status, httpStatus, formatted }) => {
        const func = jest.fn<() => Promise<unknown>>().mockRejectedValue(error);

        const response = await ensureFormattedReturnType(
          func,
          context.functionName,
          context.invocationId,
          context
        );

        expectResponse(
          response,
          status,
          '',
          [formatted],
          isLocal === 'true' ? httpStatus : 200
        );
        expect(func).toHaveBeenCalledTimes(1);
        expect(context.error).toHaveBeenCalledTimes(1);
      }
    );

    test('does not use the Development environment to enable mapping', async () => {
      process.env.AZURE_FUNCTIONS_ENVIRONMENT = 'Development';
      const error = new UserThrownError('Rejected');
      const func = jest.fn<() => Promise<unknown>>().mockRejectedValue(error);

      const response = await ensureFormattedReturnType(
        func,
        context.functionName,
        context.invocationId,
        context
      );

      expectResponse(
        response,
        StatusCode.BAD_REQUEST,
        '',
        [new FormattedError(error.errorCode, error.message)],
        isLocal === 'true' ? 422 : 200
      );
    });

    test('reads IsLocal for each response without changing the envelope', async () => {
      const func = jest
        .fn<() => Promise<unknown>>()
        .mockRejectedValue(new UserThrownError('Rejected'));
      const responses: HttpResponseInit[] = [];

      for (const value of ['false', 'true', 'false']) {
        process.env.IsLocal = value;
        responses.push(
          await ensureFormattedReturnType(
            func,
            context.functionName,
            context.invocationId,
            context
          )
        );
      }

      expect(responses.map((response) => response.status)).toEqual([
        200, 422, 200,
      ]);
      for (const response of responses) {
        expect(response.body).toBe(responses[0].body);
        expect(response.headers).toEqual(responses[0].headers);
      }
      expect(func).toHaveBeenCalledTimes(3);
    });
  }
);

describe('local HTTP status contract', () => {
  test.each([
    { status: StatusCode.SUCCEEDED, errorCodes: [], expected: 200 },
    { status: StatusCode.SUCCEEDED, errorCodes: ['UserThrown'], expected: 200 },
    { status: StatusCode.RESPONSE_TOO_LARGE, errorCodes: [], expected: 403 },
    {
      status: StatusCode.RESPONSE_TOO_LARGE,
      errorCodes: ['ResponseTooLarge'],
      expected: 403,
    },
    {
      status: StatusCode.RESPONSE_TOO_LARGE,
      errorCodes: ['UserThrown'],
      expected: 403,
    },
    { status: StatusCode.BAD_REQUEST, errorCodes: [], expected: 400 },
    { status: StatusCode.BAD_REQUEST, errorCodes: [''], expected: 400 },
    {
      status: StatusCode.BAD_REQUEST,
      errorCodes: ['UnknownError'],
      expected: 400,
    },
    {
      status: StatusCode.BAD_REQUEST,
      errorCodes: ['UserThrown'],
      expected: 422,
    },
    {
      status: StatusCode.BAD_REQUEST,
      errorCodes: ['InvalidInput', 'UserThrown'],
      expected: 400,
    },
    {
      status: StatusCode.BAD_REQUEST,
      errorCodes: ['UserThrown', 'InvalidInput'],
      expected: 422,
    },
    { status: StatusCode.FAILED, errorCodes: [], expected: 500 },
    { status: StatusCode.FAILED, errorCodes: ['UserThrown'], expected: 500 },
  ])(
    '$status with errors $errorCodes returns $expected',
    ({ status, errorCodes, expected }) => {
      const response = new UserDataFunctionInvokeResponse();
      response.status = status;
      response.errors = errorCodes.map(
        (code) => new FormattedError(code, 'Error')
      );

      expect(getLocalHttpStatusCode(response)).toBe(expected);
    }
  );
});

describe('response size enforcement', () => {
  const limitInBytes = 30 * 1024 * 1024;
  const sizeError = new FormattedError(
    'ResponseTooLarge',
    "Function's response size is larger than the 30 megabyte limit."
  );
  let originalIsLocal: string | undefined;
  let context: InvocationContext;

  beforeEach(() => {
    originalIsLocal = process.env.IsLocal;
    delete process.env.IsLocal;
    context = new azureFunctions.InvocationContext({
      functionName: 'test_function',
      invocationId: 'test-invocation-id',
    });
    jest.spyOn(context, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalIsLocal === undefined) {
      delete process.env.IsLocal;
    } else {
      process.env.IsLocal = originalIsLocal;
    }
    jest.restoreAllMocks();
  });

  function successBody(output: unknown): string {
    return JSON.stringify({
      functionName: context.functionName,
      invocationId: context.invocationId,
      status: 'Succeeded',
      output,
      errors: [],
    });
  }

  function invoke(output: unknown): Promise<HttpResponseInit> {
    return ensureFormattedReturnType(
      async () => output,
      context.functionName,
      context.invocationId,
      context
    );
  }

  function expectTooLarge(response: HttpResponseInit, httpStatus = 200): void {
    expect(response.status).toBe(httpStatus);
    expect(typeof response.body).toBe('string');
    expect(Buffer.byteLength(String(response.body), 'utf8')).toBeLessThan(1024);
    expectResponse(
      response,
      StatusCode.RESPONSE_TOO_LARGE,
      '',
      [sizeError],
      httpStatus
    );
    expect(context.error).toHaveBeenLastCalledWith(
      `Error during function invoke: ${JSON.stringify(sizeError)}`
    );
  }

  describe.each(['false', 'true'])('boundary with IsLocal=%s', (isLocal) => {
    test.each([-1, 0, 1])(
      'enforces the complete serialized response at the limit plus %i byte(s)',
      async (offset) => {
        process.env.IsLocal = isLocal;
        const overhead = Buffer.byteLength(successBody(''), 'utf8');
        const output = 'x'.repeat(limitInBytes - overhead + offset);
        const expectedBody = successBody(output);
        expect(Buffer.byteLength(expectedBody, 'utf8')).toBe(
          limitInBytes + offset
        );

        const response = await invoke(output);

        if (offset > 0) {
          expectTooLarge(response, isLocal === 'true' ? 403 : 200);
        } else {
          expect(response.status).toBe(200);
          expect(response.body === expectedBody).toBe(true);
          expect(response.headers).toEqual({
            'Content-Type': 'application/json',
            'x-fabric-udf-status': 'Succeeded',
          });
          expect(context.error).not.toHaveBeenCalled();
        }
      }
    );
  });

  test.each([undefined, 'false', 'true', '', 'TRUE', '1', ' true '])(
    'enforces the limit with IsLocal=%p',
    async (isLocal) => {
      if (isLocal !== undefined) process.env.IsLocal = isLocal;

      const response = await invoke('x'.repeat(limitInBytes));

      expectTooLarge(response, isLocal === 'true' ? 403 : 200);
      expect(context.error).toHaveBeenCalledTimes(1);
    }
  );

  test.each([
    { name: 'two-byte UTF-8', character: '\u00e9', serializedBytes: 2 },
    { name: 'four-byte UTF-8', character: '\u{1f600}', serializedBytes: 4 },
    { name: 'escaped newline', character: '\n', serializedBytes: 2 },
    { name: 'escaped null', character: '\u0000', serializedBytes: 6 },
  ])(
    'counts serialized UTF-8 bytes rather than input length: $name',
    async ({ character, serializedBytes }) => {
      const output = character.repeat(limitInBytes / serializedBytes);
      expect(output.length).toBeLessThan(limitInBytes);
      expect(Buffer.byteLength(successBody(output), 'utf8')).toBeGreaterThan(
        limitInBytes
      );

      expectTooLarge(await invoke(output));
    }
  );

  test.each([false, true])(
    'serializes user output only once, oversized=%p',
    async (oversized) => {
      const toJSON = jest
        .fn()
        .mockReturnValue(oversized ? 'x'.repeat(limitInBytes) : 'ok');

      const response = await invoke({ toJSON });

      expect(toJSON).toHaveBeenCalledTimes(1);
      if (oversized) {
        expectTooLarge(response);
      } else {
        expectResponse(response, StatusCode.SUCCEEDED, 'ok', []);
      }
    }
  );

  test('replaces oversized error details with the size error', async () => {
    const response = await ensureFormattedReturnType(
      async () => {
        throw new UserThrownError('Rejected', {
          detail: 'x'.repeat(limitInBytes),
        });
      },
      context.functionName,
      context.invocationId,
      context
    );

    expectTooLarge(response);
  });
});
