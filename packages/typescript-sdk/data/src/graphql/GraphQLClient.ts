import type { ApiClient } from '@microsoft/rayfin-lib';

import {
  AGGREGATION_NOT_SUPPORTED_PATTERN,
  AggregationNotSupportedError,
} from './errors';

/**
 * GraphQL request payload.
 */
export interface GraphQLRequest {
  /** The GraphQL query or mutation document. */
  query: string;
  /** Optional variables referenced by the query document. */
  variables?: Record<string, any>;
  /** Optional operation name when the document defines multiple operations. */
  operationName?: string;
}

/**
 * GraphQL response payload.
 *
 * @typeParam T - The shape of the `data` field returned by the server.
 */
export interface GraphQLResponse<T = any> {
  /** The response data, present when the operation succeeded. */
  data?: T;
  /** GraphQL errors returned by the server, if any. */
  errors?: Array<{
    /** Human-readable error message. */
    message: string;
    /** Source locations in the query document associated with the error. */
    locations?: Array<{ line: number; column: number }>;
    /** Response path to the field that raised the error. */
    path?: Array<string | number>;
    /** Implementation-specific error metadata. */
    extensions?: Record<string, any>;
  }>;
}

/**
 * GraphQL client for executing raw queries and mutations against a Data API
 * Builder endpoint.
 *
 * Prefer the fluent entity API (`dataApi.<Entity>`) for typical access; use
 * this client when you need to send a hand-written GraphQL document.
 */
export class GraphQLClient {
  /**
   * @param apiClient - The {@link ApiClient} used to send HTTP requests.
   * @param endpoint - The GraphQL endpoint path. Defaults to `/graphql`.
   */
  constructor(
    private apiClient: ApiClient,
    private endpoint = '/graphql'
  ) {}

  /**
   * Execute a GraphQL query or mutation.
   *
   * @typeParam T - The expected shape of the returned `data`.
   * @param query - The GraphQL document to execute.
   * @param variables - Optional variables referenced by the document.
   * @param operationName - Optional operation name for multi-operation documents.
   * @returns The `data` payload from the response.
   * @throws {@link AggregationNotSupportedError} - When an aggregation query runs
   * against an endpoint that does not have GraphQL aggregation enabled.
   * @throws `Error` - When the response contains other GraphQL errors or no data.
   */
  async request<T = any>(
    query: string,
    variables?: Record<string, any>,
    operationName?: string
  ): Promise<T> {
    const payload: GraphQLRequest = {
      query,
      variables,
      operationName,
    };

    const response = await this.apiClient.post<GraphQLResponse<T>>(
      this.endpoint,
      payload
    );

    if (response.errors && response.errors.length > 0) {
      const errorMessage = response.errors
        .map((err: any) => err.message)
        .join(', ');

      if (AGGREGATION_NOT_SUPPORTED_PATTERN.test(errorMessage)) {
        throw new AggregationNotSupportedError(errorMessage);
      }

      throw new Error(`GraphQL errors: ${errorMessage}`);
    }

    if (response.data === undefined) {
      throw new Error('GraphQL response contains no data');
    }

    return response.data;
  }

  /**
   * Execute a GraphQL query.
   *
   * @typeParam T - The expected shape of the returned `data`.
   * @param query - The GraphQL query document to execute.
   * @param variables - Optional variables referenced by the document.
   * @returns The `data` payload from the response.
   * @throws `Error` - When the response contains GraphQL errors or no data.
   */
  async query<T = any>(
    query: string,
    variables?: Record<string, any>
  ): Promise<T> {
    return this.request<T>(query, variables);
  }

  /**
   * Execute a GraphQL mutation.
   *
   * @typeParam T - The expected shape of the returned `data`.
   * @param mutation - The GraphQL mutation document to execute.
   * @param variables - Optional variables referenced by the document.
   * @returns The `data` payload from the response.
   * @throws `Error` - When the response contains GraphQL errors or no data.
   */
  async mutation<T = any>(
    mutation: string,
    variables?: Record<string, any>
  ): Promise<T> {
    return this.request<T>(mutation, variables);
  }
}
