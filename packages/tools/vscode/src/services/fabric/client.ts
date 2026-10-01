/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ext } from '../../extensionVariables';

import { DEFAULT_FABRIC_SETTINGS } from './constants';
import type { FabricSettings } from './constants';
import { buildRemoteErrorMessage, throwIfNotOk } from './http-client';

/**
 * Base client for Microsoft Fabric API interactions.
 *
 * Uses Bearer (AAD token) authentication for all Fabric REST API calls
 * and private workload endpoint calls via `__private/*` paths.
 */
export class FabricApiClient {
  protected apiBaseUrl: string;

  protected accessToken: string;

  private verbose: boolean;
  private fabricSettings: FabricSettings;

  constructor(
    accessToken: string,
    verbose = false,
    fabricSettings?: FabricSettings
  ) {
    this.accessToken = accessToken;
    this.verbose = verbose;
    this.fabricSettings = fabricSettings ?? { ...DEFAULT_FABRIC_SETTINGS };
    this.apiBaseUrl = this.fabricSettings.fabricApiBaseUrl;
  }

  private verboseLog(...args: unknown[]): void {
    if (this.verbose) {
      ext.outputChannel.appendLine(
        `[verbose][FabricApiClient] ${args.map(String).join(' ')}`
      );
    }
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
   */
  protected async request<T>(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET',
    body?: unknown
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

    const options: RequestInit = { method, headers };
    if (body) {
      options.body = JSON.stringify(body);
    }

    try {
      const fetchStart = Date.now();
      const response = await fetch(url, options);
      const fetchDuration = Date.now() - fetchStart;
      this.verboseLog(
        `Response: ${response.status} ${response.statusText} (${fetchDuration}ms)`
      );

      if (!response.ok) {
        await throwIfNotOk(response, 'Fabric API error');
      }

      // Handle 201 (Created) responses
      if (response.status === 201) {
        ext.outputChannel.appendLine('Resource created successfully');
        const data = (await response.json()) as T;
        this.verboseLog('201 Created response:', JSON.stringify(data, null, 2));
        return data;
      }

      // Handle 202 (Accepted) — async operation
      if (response.status === 202) {
        const operationLocation = response.headers.get('Location');
        const retryAfter = response.headers.get('Retry-After');

        if (operationLocation) {
          try {
            return await this.pollOperationStatus<T>(
              operationLocation,
              retryAfter ? parseInt(retryAfter, 10) : 30
            );
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            ext.outputChannel.appendLine(
              `Error polling operation status: ${errorMessage}`
            );
            throw error;
          }
        }

        // 202 without Location header
        try {
          const data = (await response.json()) as Record<string, unknown>;
          const operationId = response.headers.get('x-ms-operation-id');
          // Header-sourced keys spread last so they win over body fields
          return {
            operationId,
            operationLocation,
            retryAfter: retryAfter ? parseInt(retryAfter, 10) : 30,
            isAsyncOperation: true,
            ...data,
          } as T;
        } catch {
          const operationId = response.headers.get('x-ms-operation-id');
          return {
            operationId,
            operationLocation,
            retryAfter: retryAfter ? parseInt(retryAfter, 10) : 30,
            isAsyncOperation: true,
          } as unknown as T;
        }
      }

      // Handle regular successful responses (200 OK)
      const data = (await response.json()) as T;
      this.verboseLog(
        '200 OK response:',
        JSON.stringify(data, null, 2).substring(0, 500)
      );
      return data;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      ext.outputChannel.appendLine(
        `Error making Fabric API request: ${errorMessage}`
      );
      throw error;
    }
  }

  /**
   * Polls an operation status endpoint until the operation completes or fails.
   */
  protected async pollOperationStatus<T>(
    operationLocation: string,
    initialRetryAfter = 30,
    maxRetries = 30
  ): Promise<T> {
    let retryCount = 0;
    let retryAfter = initialRetryAfter;
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;
    let lastOperationResult: Record<string, unknown> | null = null;
    let currentLocation = operationLocation;

    ext.outputChannel.appendLine(
      `Polling operation status at ${currentLocation}`
    );

    while (retryCount < maxRetries) {
      ext.outputChannel.appendLine(
        `Waiting ${retryAfter}s before checking operation status (attempt ${retryCount + 1}/${maxRetries})...`
      );
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));

      try {
        ext.outputChannel.appendLine('Checking operation status...');
        const response = await fetch(currentLocation, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.getAccessToken()}`,
            'Content-Type': 'application/json',
          },
        });

        consecutiveErrors = 0;

        // Handle redirects
        if (
          response.status === 302 ||
          response.status === 303 ||
          response.status === 307
        ) {
          const newLocation = response.headers.get('Location');
          if (newLocation) {
            currentLocation = newLocation;
            continue;
          }
        }

        // Check for Retry-After header
        const newRetryAfter = response.headers.get('Retry-After');
        if (newRetryAfter) {
          retryAfter = parseInt(newRetryAfter, 10);
        } else {
          retryAfter = Math.min(retryAfter * 1.5, 300);
        }

        // Still processing
        if (response.status === 202) {
          ext.outputChannel.appendLine(
            'Operation is still processing (202 Accepted), continuing to poll...'
          );
          retryCount++;
          continue;
        }

        // Non-OK responses
        if (!response.ok) {
          const errorText = await response.text();
          const errorMessage = buildRemoteErrorMessage(
            response,
            'Operation status check failed',
            errorText
          );
          ext.outputChannel.appendLine(errorMessage);

          // Terminal 4xx errors (except 429)
          if (
            response.status >= 400 &&
            response.status < 500 &&
            response.status !== 429
          ) {
            throw new Error(errorMessage);
          }

          retryCount++;
          continue;
        }

        // Try to parse operation result
        let operationResult: Record<string, unknown>;
        try {
          operationResult = (await response.json()) as Record<string, unknown>;
          lastOperationResult = operationResult;
        } catch {
          if (response.status === 200) {
            ext.outputChannel.appendLine(
              'Operation completed successfully with status 200'
            );
            return {} as T;
          }
          retryCount++;
          continue;
        }

        const status =
          typeof operationResult.status === 'string'
            ? operationResult.status.toLowerCase()
            : '';

        if (status === 'succeeded') {
          ext.outputChannel.appendLine('Operation completed successfully');
          if (operationResult.result) {
            return (operationResult.result || operationResult) as T;
          }
          return operationResult as T;
        } else if (
          status === 'failed' ||
          status === 'canceled' ||
          status === 'cancelled'
        ) {
          ext.outputChannel.appendLine(
            `Operation failed: ${JSON.stringify(operationResult.error || operationResult, null, 2)}`
          );
          throw new Error(
            `Operation failed: ${JSON.stringify(operationResult.error || 'Unknown error')}`
          );
        } else if (
          [
            'running',
            'notstarted',
            'pending',
            'accepted',
            'provisioning',
          ].includes(status)
        ) {
          ext.outputChannel.appendLine(
            `Operation still in progress (${status}), continuing to poll...`
          );
        } else {
          // Unknown status — attempt heuristic completion check
          if (response.status === 200 && operationResult.id) {
            ext.outputChannel.appendLine(
              'Response has ID property, treating as successful completion'
            );
            return operationResult as T;
          }
          if (
            response.status === 200 &&
            Object.keys(operationResult).length > 0
          ) {
            ext.outputChannel.appendLine(
              'Response is 200 OK with data but no status field, treating as successful completion'
            );
            return operationResult as T;
          }
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        ext.outputChannel.appendLine(
          `Error polling operation status: ${errorMessage}`
        );
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          ext.outputChannel.appendLine(
            `Encountered ${MAX_CONSECUTIVE_ERRORS} consecutive errors, stopping operation polling`
          );
          throw error;
        }
        retryAfter = Math.min(retryAfter * 2, 300);
      }

      retryCount++;
    }

    if (lastOperationResult) {
      ext.outputChannel.appendLine(
        `Last received operation result: ${JSON.stringify(lastOperationResult, null, 2)}`
      );
    }
    const lastStatus =
      lastOperationResult !== null &&
      typeof lastOperationResult.status === 'string'
        ? lastOperationResult.status
        : 'unknown';
    throw new Error(
      `Operation did not complete after ${maxRetries} retries (last status: ${lastStatus})`
    );
  }
}
