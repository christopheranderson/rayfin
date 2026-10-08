import { HttpResponseInit, InvocationContext } from '@azure/functions';

import {
  UDFExceptionCodes,
  UserDataFunctionError,
  UserDataFunctionInternalError,
  UserThrownError,
} from '../errors/udfErrors.js';

import {
  FormattedError,
  StatusCode,
  UserDataFunctionInvokeResponse,
} from './invokeResponse.js';

const RESPONSE_SIZE_LIMIT_IN_MIB = 30;

/**
 * Wraps a user function invocation: checks args for errors,
 * calls the function if no argument errors, catches exceptions, and produces a
 * formatted HTTP response.
 */
export async function ensureFormattedReturnType(
  func: () => Promise<unknown>,
  functionName: string,
  invocationId: string,
  context: InvocationContext,
  args?: unknown[]
): Promise<HttpResponseInit> {
  const invokeResponse = new UserDataFunctionInvokeResponse();
  invokeResponse.functionName = functionName;
  invokeResponse.invocationId = invocationId;

  try {
    // Check for parameter errors before invoking the user function
    const inputExceptions = (args ?? []).filter(
      (arg): arg is UserDataFunctionError =>
        arg instanceof UserDataFunctionError
    );

    if (inputExceptions.length > 0) {
      invokeResponse.status = StatusCode.BAD_REQUEST;
      for (const exception of inputExceptions) {
        invokeResponse.addError(
          logAndConvertToFormattedError(exception, context)
        );
      }
    } else {
      // The line that actually invokes the user's function
      const result = await func();
      invokeResponse.output = result;
      invokeResponse.status = StatusCode.SUCCEEDED;
    }
  } catch (e: unknown) {
    if (e instanceof UserDataFunctionError) {
      invokeResponse.addError(logAndConvertToFormattedError(e, context));

      if (e instanceof UserThrownError) {
        invokeResponse.status = StatusCode.BAD_REQUEST;
      } else {
        invokeResponse.status = StatusCode.FAILED;
      }
    } else {
      invokeResponse.status = StatusCode.FAILED;
      const internal = new UserDataFunctionInternalError(undefined, {
        error_type: (e as Error)?.constructor?.name ?? 'Unknown',
        error_message: (e as Error)?.message ?? String(e),
      });
      invokeResponse.addError(logAndConvertToFormattedError(internal, context));
    }
  }

  return toHttpResponse(invokeResponse, context);
}

function toHttpResponse(
  invokeResponse: UserDataFunctionInvokeResponse,
  context: InvocationContext
): HttpResponseInit {
  let body = invokeResponse.toJSON();
  if (
    Buffer.byteLength(body, 'utf8') >
    RESPONSE_SIZE_LIMIT_IN_MIB * 1024 * 1024
  ) {
    invokeResponse.status = StatusCode.RESPONSE_TOO_LARGE;
    invokeResponse.output = '';
    invokeResponse.errors = [
      logAndConvertToFormattedError(
        new UserDataFunctionError(
          UDFExceptionCodes.RESPONSE_TOO_LARGE,
          `Function's response size is larger than the ${RESPONSE_SIZE_LIMIT_IN_MIB} megabyte limit.`
        ),
        context
      ),
    ];
    body = invokeResponse.toJSON();
  }

  return {
    status:
      process.env.IsLocal === 'true'
        ? getLocalHttpStatusCode(invokeResponse)
        : 200,
    body,
    headers: {
      'Content-Type': 'application/json',
      'x-fabric-udf-status': invokeResponse.status,
    },
  };
}

/**
 * Matches FuncSet's HTTP status mapping for locally formatted responses.
 * @internal
 */
export function getLocalHttpStatusCode(
  invokeResponse: UserDataFunctionInvokeResponse
): number {
  switch (invokeResponse.status) {
    case StatusCode.SUCCEEDED:
      return 200;
    case StatusCode.RESPONSE_TOO_LARGE:
      return 403;
    case StatusCode.BAD_REQUEST:
      return invokeResponse.errors[0]?.errorCode ===
        UDFExceptionCodes.USER_THROWN
        ? 422
        : 400;
    default:
      return 500;
  }
}

function logAndConvertToFormattedError(
  e: UserDataFunctionError,
  context: InvocationContext
): FormattedError {
  const formatted = new FormattedError(e.errorCode, e.message, e.properties);
  context.error(`Error during function invoke: ${JSON.stringify(formatted)}`);
  return formatted;
}
