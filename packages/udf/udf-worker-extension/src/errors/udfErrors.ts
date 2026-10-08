/**
 * This module contains the error classes that are used to represent errors that occur
 * during the invocation of a User Data Function.
 * These can be imported from the `@microsoft/fabric-user-data-functions` package.
 */

export const UDFExceptionCodes = {
  INVALID_INPUT: 'InvalidInput',
  MISSING_INPUT: 'MissingInput',
  USER_THROWN: 'UserThrown',
  INTERNAL_ERROR: 'InternalError',
  RESPONSE_TOO_LARGE: 'ResponseTooLarge',
} as const;

export type UDFExceptionCode =
  (typeof UDFExceptionCodes)[keyof typeof UDFExceptionCodes];

/**
 * The error base class for any errors raised during the invocation of a User Data Function.
 *
 * @param errorCode  - A string representing the error code associated with the exception.
 * @param message    - An optional message describing the exception.
 * @param properties - An optional dictionary containing additional properties related to the exception.
 */
export class UserDataFunctionError extends Error {
  public readonly errorCode: string;
  public readonly properties: Record<string, string>;

  constructor(
    errorCode: string,
    message = 'Known User Data Function Exception Thrown',
    properties: Record<string, string> = {}
  ) {
    super(message);
    this.name = new.target.name;
    this.errorCode = errorCode;
    this.properties = { ...properties };
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Represents an internal error that occurs during the execution of a user-defined function.
 *  This error is typically thrown when an unexpected error occurs during the execution of a
 *  function that is not related to an input or the user's code. */
export class UserDataFunctionInternalError extends UserDataFunctionError {
  constructor(
    message = 'An internal execution error occured during function execution',
    properties: Record<string, string> = {}
  ) {
    super(UDFExceptionCodes.INTERNAL_ERROR, message, properties);
  }
}

/** Represents an error that occurs when the input provided to a function is invalid.
 *  This error is typically thrown when the input provided to a function does not match
 *  the expected input type or format. */
export class UserDataFunctionInvalidInputError extends UserDataFunctionError {
  constructor(
    message = "Something went wrong when parsing an input to this function. This could be because the provided data couldn't be constructed as the data type provided, or the provided data isn't valid JSON.",
    properties: Record<string, string> = {}
  ) {
    super(UDFExceptionCodes.INVALID_INPUT, message, properties);
  }
}

/** Represents an error that occurs when a required parameter is missing from the input
 *  data provided to a function. This error is typically thrown when a parameter is expected
 *  to be present in the input data but is not found. */
export class UserDataFunctionMissingInputError extends UserDataFunctionError {
  constructor(
    message = 'Parameter does not exist in binding data',
    properties: Record<string, string> = {}
  ) {
    super(UDFExceptionCodes.MISSING_INPUT, message, properties);
  }
}

/** Represents an error that is thrown by the user's code during the execution of a function.
 *  This error is typically thrown when the user's code encounters an error that is not related
 *  to the input data and can be the base class for custom errors. */
export class UserThrownError extends UserDataFunctionError {
  constructor(
    message = 'User Exception Thrown',
    properties: Record<string, string> = {}
  ) {
    super(UDFExceptionCodes.USER_THROWN, message, properties);
  }
}
