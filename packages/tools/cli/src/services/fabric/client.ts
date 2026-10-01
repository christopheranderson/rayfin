import type { Diagnostics } from '@microsoft/rayfin-tools-common/_internal/adapters';
import { throwFabricError } from '@microsoft/rayfin-tools-common/_internal/external/fabric';

import { getFabricSettings } from '../../config/constants.js';
import {
  buildRemoteErrorMessage,
  fabricFetch,
} from '../../utils/http-client.js';

/** Module-level verbose flag — set via FabricApiClient.enableVerbose() */
let verboseEnabled = false;

/** Output sinks for legacy Fabric client status and diagnostics. */
export interface FabricApiClientOutput {
  diagnostics?: Diagnostics;
  log: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

const consoleOutput: FabricApiClientOutput = {
  log: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

/**
 * Base client for Microsoft Fabric API interactions.
 *
 * Uses Bearer (AAD token) authentication for all Fabric REST API calls
 * and private workload endpoint calls via `__private/*` paths.
 */
export class FabricApiClient {
  protected apiBaseUrl = getFabricSettings().fabricApiBaseUrl;

  protected accessToken: string;

  private readonly output: FabricApiClientOutput;

  constructor(
    accessToken: string,
    output: FabricApiClientOutput = consoleOutput
  ) {
    this.accessToken = accessToken;
    this.output = output;
  }

  protected verboseLog(...args: any[]): void {
    if (verboseEnabled) {
      this.output.log('[verbose][FabricApiClient]', ...args);
    }
  }

  /**
   * Emit a structured debug event to the host's diagnostics sink.
   *
   * Distinct from {@link verboseLog}: callers such as `rayfin up` construct
   * this client with silent `log`/`warn`/`error` sinks and rely entirely on
   * diagnostics, so detail routed only through `verboseLog` would be dropped
   * and never reach the command's diagnostic log.
   */
  protected debugDiagnostic(area: string, message: string): void {
    this.output.diagnostics?.debug({ area, message });
  }

  /**
   * Emit a request failure to the error sink using the same wording
   * {@link request} uses.
   *
   * For callers that retry, `request` is invoked with `suppressErrorLog` so a
   * failure a later attempt recovers from never reaches the user. They call
   * this once, with the final error, to restore the single message the sink
   * would otherwise have produced.
   */
  protected logRequestError(error: unknown): void {
    this.output.error(
      `Error making Fabric API request: ${(error as Error).message}`
    );
  }

  /** Enable verbose logging on the Fabric API client */
  public static enableVerbose(): void {
    verboseEnabled = true;
  }

  /**
   * Get the AAD access token used for standard Fabric REST API calls.
   */
  public getAccessToken(): string {
    return this.accessToken;
  }

  /**
   * Returns `Bearer <AAD token>` for Fabric API and private endpoint calls.
   */
  public getAuthorizationHeader(): string {
    return `Bearer ${this.accessToken}`;
  }

  /**
   * Helper method to make API requests to the standard Fabric REST API.
   * Always uses `Bearer <AAD token>` authentication.
   *
   * Pass `requestOptions.suppressErrorLog` when the caller treats certain
   * failures (e.g. 404 — "item doesn't exist") as an expected, handled
   * outcome rather than a real error, so this doesn't also print a raw
   * error to the console.
   */
  protected async request<T>(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET',
    body?: any,
    requestOptions?: { suppressErrorLog?: boolean }
  ): Promise<T> {
    const url = `${this.apiBaseUrl}${path}`;

    this.verboseLog(`${method} ${url}`);
    if (body) {
      this.verboseLog('Request body:', JSON.stringify(body, null, 2));
    }

    const headers: HeadersInit = {
      Authorization: `Bearer ${this.getAccessToken()}`,
      'Content-Type': 'application/json',
    };

    const options: RequestInit = {
      method,
      headers,
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    try {
      const fetchStart = Date.now();
      const response = await fabricFetch(url, options, this.output.diagnostics);
      const fetchDuration = Date.now() - fetchStart;
      this.verboseLog(
        `Response: ${response.status} ${response.statusText} (${fetchDuration}ms)`
      );
      const respHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });
      this.verboseLog('Response headers:', respHeaders);

      if (!response.ok) {
        await throwFabricError(response, 'Fabric API error');
      }

      // Handle 201 (Created) and 202 (Accepted) responses specifically
      if (response.status === 201) {
        this.output.log(`Resource created successfully`);
        const data = await response.json();
        this.verboseLog('201 Created response:', JSON.stringify(data, null, 2));
        return data as T;
      }

      if (response.status === 202) {
        // Get operation details from headers
        const operationId = response.headers.get('x-ms-operation-id');
        const operationLocation = response.headers.get('Location');
        const retryAfter = response.headers.get('Retry-After');

        // If we have an operation location, poll until completion
        if (operationLocation) {
          try {
            const result = await this.pollOperationStatus<T>(
              operationLocation,
              retryAfter ? parseInt(retryAfter, 10) : 30
            );
            return result;
          } catch (error) {
            this.output.error(
              `Error polling operation status: ${(error as Error).message}`
            );
            throw error;
          }
        }

        // For 202 responses without operation location, we return the details
        try {
          const data = await response.json();
          this.output.log(
            `Fabric API 202 response has body:`,
            JSON.stringify(data, null, 2)
          );
          return {
            ...data,
            operationId,
            operationLocation,
            retryAfter: retryAfter ? parseInt(retryAfter, 10) : 30,
            isAsyncOperation: true,
          } as T;
        } catch (e) {
          // No JSON body in response, return operation details
          this.output.log(
            `Fabric API 202 response has no body, returning operation details`
          );
          return {
            operationId,
            operationLocation,
            retryAfter: retryAfter ? parseInt(retryAfter, 10) : 30,
            isAsyncOperation: true,
          } as unknown as T;
        }
      }

      // Handle regular successful responses (200 OK)
      const data = await response.json();
      this.verboseLog(
        '200 OK response:',
        JSON.stringify(data, null, 2).substring(0, 500)
      );
      return data as T;
    } catch (error) {
      if (!requestOptions?.suppressErrorLog) {
        this.output.error(
          `Error making Fabric API request: ${(error as Error).message}`
        );
      }
      throw error;
    }
  }

  /**
   * Fetch every page of a Fabric list endpoint, following Fabric's
   * `continuationToken` / `continuationUri` pagination so callers receive the
   * full result set rather than only the first page (~100 items).
   *
   * `basePath` is the first-page request path and may already carry query
   * parameters (e.g. `?type=AppBackend`); continuation parameters are appended
   * with the correct separator for subsequent pages.
   *
   * @see https://learn.microsoft.com/en-us/rest/api/fabric/articles/pagination
   */
  protected async listAllPages<T>(basePath: string): Promise<T[]> {
    type Page = {
      value: T[];
      continuationToken?: string | null;
      continuationUri?: string | null;
    };
    const all: T[] = [];
    let path: string | undefined = basePath;
    while (path) {
      const page = await this.request<Page>(path);
      all.push(...(page.value ?? []));
      path = this.nextPagePath(basePath, page);
    }
    return all;
  }

  /**
   * Resolve the request path for the next page, or `undefined` when the current
   * page is the last.
   *
   * Prefers `continuationUri` when it targets the same origin and base path as
   * the configured `apiBaseUrl`. When `apiBaseUrl` points at a proxy whose
   * prefix differs from what Fabric returns, honoring the URI verbatim could
   * drop or duplicate the prefix, so fall back to the continuation token
   * rebuilt against `basePath`.
   */
  private nextPagePath(
    basePath: string,
    page: {
      continuationToken?: string | null;
      continuationUri?: string | null;
    }
  ): string | undefined {
    if (page.continuationUri) {
      const continuationUrl = new URL(page.continuationUri, this.apiBaseUrl);
      const apiBaseUrl = new URL(this.apiBaseUrl);
      const apiBasePath = apiBaseUrl.pathname.replace(/\/$/, '');

      const sameOrigin = continuationUrl.origin === apiBaseUrl.origin;
      const sameBasePath =
        apiBasePath === '' ||
        continuationUrl.pathname === apiBasePath ||
        continuationUrl.pathname.startsWith(`${apiBasePath}/`);

      if (sameOrigin && sameBasePath) {
        // Fabric's `continuationUri` is the authoritative, self-contained
        // next-page link: the service echoes back the full path and query it
        // needs (item type filter, page state, etc.) encoded in the URI. We
        // therefore use its path + query verbatim and intentionally discard
        // `basePath`'s query string — re-appending it could duplicate or
        // conflict with parameters the service already placed on the URI.
        const continuationPath = apiBasePath
          ? continuationUrl.pathname.slice(apiBasePath.length)
          : continuationUrl.pathname;
        return `${continuationPath}${continuationUrl.search}`;
      }

      if (!page.continuationToken) {
        // `searchParams.get` returns the decoded value, so re-encode it when
        // rebuilding the request relative to the configured base.
        const tokenFromUri =
          continuationUrl.searchParams.get('continuationToken');
        if (tokenFromUri) {
          return this.appendContinuationToken(
            basePath,
            encodeURIComponent(tokenFromUri)
          );
        }
      }
    }

    return page.continuationToken
      ? this.appendContinuationToken(basePath, page.continuationToken)
      : undefined;
  }

  /**
   * Append a `continuationToken` query parameter to a path that may already
   * carry a query string.
   */
  private appendContinuationToken(basePath: string, token: string): string {
    const separator = basePath.includes('?') ? '&' : '?';
    return `${basePath}${separator}continuationToken=${token}`;
  }

  /**
   * Polls an operation status endpoint until the operation completes or fails
   * @param operationLocation - The URL to check for operation status
   * @param initialRetryAfter - Initial retry delay in seconds
   * @param maxRetries - Maximum number of retries before giving up
   * @returns The completed operation result
   */
  protected async pollOperationStatus<T>(
    operationLocation: string,
    initialRetryAfter = 30,
    maxRetries = 30 // Increased default max retries
  ): Promise<T> {
    let retryCount = 0;
    let retryAfter = initialRetryAfter;
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;

    this.output.log(`Polling operation status at ${operationLocation}`);

    // Store last operation result for error reporting
    let lastOperationResult: any = null;

    while (retryCount < maxRetries) {
      this.output.log(
        `Waiting ${retryAfter} seconds before checking operation status (attempt ${retryCount + 1}/${maxRetries})...`
      );
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));

      try {
        this.output.log(`Checking operation status...`);
        const response = await fabricFetch(
          operationLocation,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${this.getAccessToken()}`,
              'Content-Type': 'application/json',
            },
          },
          this.output.diagnostics
        );
        // Reset consecutive errors counter on any response
        consecutiveErrors = 0;

        // Handle redirect (which might happen during long-running operations)
        if (
          response.status === 302 ||
          response.status === 303 ||
          response.status === 307
        ) {
          const newLocation = response.headers.get('Location');
          if (newLocation) {
            operationLocation = newLocation;
            continue; // Skip to next iteration with new location
          }
        }

        // Check for Retry-After header in ANY response (including 202)
        const newRetryAfter = response.headers.get('Retry-After');
        if (newRetryAfter) {
          retryAfter = parseInt(newRetryAfter, 10);
        } else {
          // Implement exponential backoff if no Retry-After header
          retryAfter = Math.min(retryAfter * 1.5, 300); // Increase by 50%, max 5 minutes
        }

        // If we receive a 202 status code, the operation is still in progress
        if (response.status === 202) {
          this.output.log(
            `Operation is still processing (202 Accepted), continuing to poll...`
          );
          retryCount++;
          continue;
        }

        // Handle non-OK responses but continue retrying if we have a valid status
        if (!response.ok) {
          const errorText = await response.text();
          const errorMessage = buildRemoteErrorMessage(
            response,
            'Operation status check failed',
            errorText
          );
          this.output.error(errorMessage);

          // If we get a 4xx status code (except 429 Too Many Requests), this is likely a terminal error
          if (
            response.status >= 400 &&
            response.status < 500 &&
            response.status !== 429
          ) {
            throw new Error(errorMessage);
          }

          // For 429 or 5xx errors, continue polling with increased backoff
          this.output.log(`Received error ${response.status}, will retry...`);
          retryCount++;
          continue;
        }

        // Try to parse operation result as JSON
        let operationResult;
        try {
          operationResult = await response.json();
          lastOperationResult = operationResult; // Store for error reporting
        } catch (e) {
          this.output.warn(
            `Could not parse operation result as JSON, received: ${await response.text()}`
          );
          // If we can't parse as JSON but got a 200 OK, consider it success
          if (response.status === 200) {
            this.output.log(
              `Operation appears to have completed successfully with status 200`
            );
            return {} as T; // Return empty object as successful result
          }

          // For other status codes, continue polling
          retryCount++;
          continue;
        }

        // Check operation status
        const status = operationResult.status?.toLowerCase();

        if (status === 'succeeded') {
          this.output.log(`Operation completed successfully`);
          // If we have a result property, return that, otherwise return the whole response
          if (operationResult.result) {
            this.output.log(
              `Result object from operation:`,
              JSON.stringify(operationResult.result, null, 2)
            );
            return operationResult.result || operationResult;
          } else {
            return operationResult;
          }
        } else if (
          status === 'failed' ||
          status === 'canceled' ||
          status === 'cancelled'
        ) {
          this.output.error(
            `Operation failed:`,
            JSON.stringify(operationResult.error || operationResult, null, 2)
          );
          throw new Error(
            `Operation failed: ${JSON.stringify(operationResult.error || 'Unknown error')}`
          );
        } else if (
          status === 'running' ||
          status === 'notstarted' ||
          status === 'pending' ||
          status === 'accepted' ||
          status === 'provisioning'
        ) {
          this.output.log(
            `Operation still in progress (${status}), continuing to poll...`
          );
        } else {
          this.output.warn(
            `Unknown operation status: ${status || 'no status field'}, treating as in-progress`
          );

          // Check for common success patterns in the response
          if (response.status === 200 && operationResult.id) {
            this.output.log(
              `Response has ID property, treating as successful completion`
            );
            return operationResult as T;
          }

          // If response is a 200 and has properties but no status, treat as success
          if (
            response.status === 200 &&
            Object.keys(operationResult).length > 0
          ) {
            this.output.log(
              `Response is 200 OK with data but no status field, treating as successful completion`
            );
            return operationResult as T;
          }
        }
      } catch (error) {
        this.output.error(
          `Error polling operation status: ${(error as Error).message}`
        );
        // Count consecutive errors, but only bail if we hit the limit
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          this.output.error(
            `Encountered ${MAX_CONSECUTIVE_ERRORS} consecutive errors, stopping operation polling`
          );
          throw error;
        }

        // Back off exponentially for errors
        retryAfter = Math.min(retryAfter * 2, 300); // Max 5 minutes between retries
      }

      retryCount++;
    }

    // If we made it here, the operation still hasn't completed after all retries
    if (lastOperationResult) {
      this.output.error(
        `Last received operation result:`,
        JSON.stringify(lastOperationResult, null, 2)
      );
    }
    throw new Error(
      `Operation did not complete after ${maxRetries} retries (last status: ${lastOperationResult?.status || 'unknown'})`
    );
  }
}

export default FabricApiClient;
