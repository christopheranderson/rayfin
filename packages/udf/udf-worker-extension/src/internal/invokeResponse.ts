/**
 * Response types for User Data Function invocations.
 *
 * @internal
 */

/**
 * Wire status values expected by the host response envelope.
 *
 * @internal
 */
export const StatusCode = {
  BAD_REQUEST: 'BadRequest',
  SUCCEEDED: 'Succeeded',
  FAILED: 'Failed',
  RESPONSE_TOO_LARGE: 'ResponseTooLarge',
} as const;

/**
 * Union of supported status values in {@link StatusCode}.
 *
 * @internal
 */
export type StatusCodeValue = (typeof StatusCode)[keyof typeof StatusCode];

/**
 * Normalized error payload included in invocation responses.
 *
 * @internal
 */
export class FormattedError {
  public errorCode: string;
  public message: string;
  public properties: Record<string, string>;

  /**
   * Create a normalized error payload.
   *
   * @param errorCode - Stable classification code for the error.
   * @param message - Human-readable error message.
   * @param properties - Optional structured metadata for diagnostics.
   */
  constructor(
    errorCode: string,
    message: string,
    properties: Record<string, string> = {}
  ) {
    this.errorCode = errorCode;
    this.message = message;
    this.properties = { ...properties };
  }

  /**
   * Add or replace a property on this error payload.
   *
   * @param key - Property name.
   * @param value - Property value.
   */
  addOrUpdateProperty(key: string, value: string): void {
    this.properties[key] = value;
  }
}

/**
 * Host response envelope for user-data-function invocations.
 *
 * @internal
 */
export class UserDataFunctionInvokeResponse {
  public functionName = '';
  public invocationId = '';
  public status: StatusCodeValue = StatusCode.SUCCEEDED;
  public output: unknown = '';
  public errors: FormattedError[] = [];

  /**
   * Append an error to the response envelope.
   *
   * @param error - Formatted error to include.
   */
  addError(error: FormattedError): void {
    this.errors.push(error);
  }

  /**
   * Serialize the envelope to JSON for HTTP response bodies.
   *
   * @returns Serialized JSON response body.
   */
  toJSON(): string {
    return JSON.stringify({
      functionName: this.functionName,
      invocationId: this.invocationId,
      status: this.status,
      output: this.output,
      errors: this.errors,
    });
  }
}
