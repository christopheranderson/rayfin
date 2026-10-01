/**
 * @packageDocumentation Per-function typed client.
 *
 * Each property on the proxy returned by `createFunctionsApi` is a
 * `FunctionClient` whose `invoke()` signature is derived from the schema
 * entry for that function name.
 */

import { ApiClient, SdkError, NetworkError } from '@microsoft/rayfin-lib';
import {
  FUNCTIONS_BASE_PATH,
  FUNCTIONS_INVOKE_TIMEOUT_MS,
} from '@microsoft/rayfin-lib';

import { FunctionsError } from './Functions';

/**
 * Transport response from a function invocation.
 * `FunctionClient.invoke()` returns the output value, not this envelope.
 */
export interface FunctionInvocationResponse<TOutput = any> {
  /** The name of the function that was invoked. */
  functionName: string;
  /** A unique identifier for this invocation. */
  invocationId: string;
  /** Status of the function invocation (Success, Failed, etc.) */
  status: string;
  /**
   * The output from the function.
   * When the raw response contains a JSON-encoded string, `invoke()` auto-parses it
   * so the caller receives `TOutput` directly.
   */
  output: TOutput;
  /** Any errors that occurred during the function invocation. */
  errors: Array<string | Record<string, any>>;
}

/**
 * Options that can be supplied to a single `invoke()` call.
 */
export interface InvokeOptions {
  /** Extra headers to attach to the request. */
  headers?: Record<string, string>;
  /**
   * Per-call request timeout in milliseconds, overriding the default function
   * invocation timeout (`FUNCTIONS_INVOKE_TIMEOUT_MS`, 250s). Use this
   * for functions that should fail faster than the default.
   *
   * Capped at `FUNCTIONS_INVOKE_TIMEOUT_MS` (250s): the Fabric UDF host
   * aborts the invocation at that ceiling server-side, so a larger value is
   * silently clamped down. A non-positive value falls back to the default.
   *
   * For a no-input function, pass options in the second argument slot
   * (`invoke(undefined, { timeoutMs })`) rather than as the single
   * argument, so the option is never confused with a function's own input.
   * See the note on {@link FunctionClient.invoke}.
   */
  timeoutMs?: number;
}

/**
 * Resolve the effective request timeout for an invocation.
 *
 * The Fabric UDF host aborts an invocation at `FUNCTIONS_INVOKE_TIMEOUT_MS`
 * (250s), so a per-call override larger than that can never take effect — it is
 * clamped down to the ceiling. A missing or non-positive override falls back to
 * the default (a `0`/negative value would otherwise abort the request instantly).
 */
function resolveInvokeTimeout(timeoutMs?: number): number {
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return FUNCTIONS_INVOKE_TIMEOUT_MS;
  }
  return Math.min(timeoutMs, FUNCTIONS_INVOKE_TIMEOUT_MS);
}

/**
 * A strongly-typed client for a single function.
 *
 * @typeParam TInput - The parameter object the function expects (`void` when none).
 * @typeParam TOutput - The type returned by the function.
 */
export class FunctionClient<TInput = any, TOutput = any> {
  private apiClient: ApiClient;
  private functionName: string;

  constructor(apiClient: ApiClient, functionName: string) {
    this.apiClient = apiClient;
    this.functionName = functionName;
  }

  /**
   * Invoke the function and return its typed output.
   *
   * @param args - Options always go in the **second** argument slot; the
   *   first argument is always the function's input `params`.
   *
   *   - Input functions: `invoke(params)` or `invoke(params, options)`.
   *   - No-input functions: `invoke()` or `invoke(undefined, options)`.
   *
   *   A lone argument is therefore always treated as `params`, never as
   *   options — so a real input that happens to be shaped like an option
   *   (for example `{ timeoutMs }`) is never misread. For a no-input function
   *   the type forbids a lone object, so per-call options such as `timeoutMs`
   *   must be passed in the second slot (`invoke(undefined, { timeoutMs })`).
   * @returns The function's success-path output, typed as `TOutput`.
   *
   * Failure modes throw — a non-empty `errors` array or a non-success
   * status on the wire response is surfaced as {@link FunctionsError}.
   * Network and other SDK errors propagate unchanged.
   * Unexpected errors are wrapped in {@link FunctionsError}.
   *
   * The server-side `invocationId` from the underlying envelope is
   * emitted via `console.debug` (along with the function name) so the
   * value is available in the browser/Node console for correlation
   * without polluting the public return type.
   *
   * @throws {@link FunctionsError} - If the function invocation fails.
   * @throws `NetworkError` - For network-related issues.
   * @throws `SdkError` - For any other unexpected SDK errors.
   *
   * @example
   * ```typescript
   * const greeting = await client.functions.helloWorld.invoke({
   *   firstName: 'Ada',
   *   lastName: 'Lovelace',
   * });
   * console.log(greeting); // typed as string
   *
   * // Per-call timeout override (input function):
   * await client.functions.longRunning.invoke(params, { timeoutMs: 5_000 });
   *
   * // No-input function with a per-call timeout override (second slot):
   * await client.functions.ping.invoke(undefined, { timeoutMs: 5_000 });
   * ```
   */
  public async invoke(
    ...args: TInput extends void | Record<string, never>
      ? [params?: undefined, options?: InvokeOptions]
      : [params: TInput, options?: InvokeOptions]
  ): Promise<TOutput> {
    try {
      // Options always live in the second slot; the first argument is always
      // params (`undefined` for a no-input function). A lone argument is
      // therefore never reinterpreted as options, so a real input shaped like
      // `{ timeoutMs }` is sent verbatim — no key-sniffing needed.
      const parameters = args[0] as Record<string, any> | undefined;
      const options = args[1] as InvokeOptions | undefined;

      // When a `functionsBaseUrl` is configured on the ApiClient (e.g. by
      // local-debug flows that point at a `func start` process), invoke the
      // function directly against `${functionsBaseUrl}/api/<name>` using the
      // Azure Functions Core Tools routing convention. Otherwise fall back to
      // the production path `${baseUrl}/functions/<name>/invoke` handled by
      // the Fabric `InvokeController`.
      const functionsBaseUrl = this.apiClient.getFunctionsBaseUrl();
      const url = functionsBaseUrl
        ? `${functionsBaseUrl}/api/${this.functionName}`
        : `${FUNCTIONS_BASE_PATH}/${this.functionName}/invoke`;

      const response = await this.apiClient.post<
        FunctionInvocationResponse<string | TOutput>
      >(url, parameters ?? {}, {
        headers: options?.headers,
        // The server aborts a UDF invocation at FUNCTIONS_INVOKE_TIMEOUT_MS
        // (250s), so a larger client timeout can never be honoured — clamp the
        // per-call override to that ceiling. Non-positive values fall back to
        // the default rather than timing out instantly.
        timeout: resolveInvokeTimeout(options?.timeoutMs),
      });

      // Check for errors in the response body
      if (response.errors && response.errors.length > 0) {
        const errorMessage =
          typeof response.errors[0] === 'string'
            ? response.errors[0]
            : JSON.stringify(response.errors[0]);
        throw new FunctionsError(
          `Function invocation failed: ${errorMessage}`,
          'FUNCTION_EXECUTION_ERROR'
        );
      }

      // Check for failed status
      const status = response.status.toLowerCase();
      if (status !== 'success' && status !== 'succeeded') {
        throw new FunctionsError(
          `Function invocation failed with status: ${response.status}`,
          'FUNCTION_EXECUTION_ERROR'
        );
      }

      // Auto-parse JSON-encoded output strings. The Fabric runtime
      // sometimes wraps the user's return value in an inner envelope
      // (a stringified `{ output: <value> }`); peel that off so the
      // caller always sees the original `TOutput`.
      // To-Do Investigate why the double JSON encoding is necessary on the runtime side and whether it can be eliminated.
      let output: TOutput;
      if (typeof response.output === 'string') {
        try {
          const parsed = JSON.parse(response.output);
          if (parsed && typeof parsed === 'object' && 'output' in parsed) {
            output = parsed.output as TOutput;
          } else {
            output = parsed as TOutput;
          }
        } catch {
          // Not JSON — pass through (TOutput may be `string`)
          output = response.output as TOutput;
        }
      } else {
        output = response.output as TOutput;
      }

      // Surface invocationId via console.debug so callers can correlate
      // a UI action with server-side telemetry without us having to
      // bake the envelope into the return type. This is opt-in noise
      // that DevTools / Node consoles hide unless the verbose level is
      // turned on.
      if (response.invocationId) {
        console.debug(
          `[rayfin-functions] ${this.functionName} invocationId=${response.invocationId}`
        );
      }

      return output;
    } catch (error: any) {
      if (
        error instanceof FunctionsError ||
        error instanceof NetworkError ||
        error instanceof SdkError
      ) {
        throw error;
      }

      throw new FunctionsError(
        `An unexpected error occurred during function invocation: ${error.message || error}`,
        'UNKNOWN_FUNCTION_ERROR'
      );
    }
  }
}
