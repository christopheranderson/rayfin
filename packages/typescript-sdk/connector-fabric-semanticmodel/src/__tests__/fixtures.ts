/**
 * Shared fixtures for the `fabric-semanticmodel` connector tests.
 */

import type {
  InvokeContext,
  InvokeHttpClient,
} from '@microsoft/rayfin-connectors';
import { tableFromArrays, tableToIPC } from 'apache-arrow';

/** A target that exercises the `/groups/` URL shape. */
export const TARGET = { workspaceId: 'ws-1', itemId: 'model-1' };

/** Encode named columns as an Arrow IPC stream. */
export function arrowStream(columns: Record<string, unknown[]>): Uint8Array {
  return tableToIPC(tableFromArrays(columns), 'stream');
}

/** A two-row, two-column result used across the success-path tests. */
export const SAMPLE_ROWS = {
  'Sales[Region]': ['North', 'South'],
  'Sales[Units]': [10, 20],
};

/** A recorded outgoing request. */
export interface RecordedCall {
  url: string;
  init?: RequestInit;
}

/** An `InvokeHttpClient` that records calls and replays canned responses. */
export interface FakeHttpClient extends InvokeHttpClient {
  calls: RecordedCall[];
}

/**
 * Build an HTTP client that returns `responses` in order, repeating the last
 * one once exhausted so a test never fails for an unrelated reason.
 */
export function httpReturning(...responses: Response[]): FakeHttpClient {
  const calls: RecordedCall[] = [];
  let index = 0;
  return {
    calls,
    fetch: (input, init) => {
      calls.push({ url: String(input), init });
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return Promise.resolve(response);
    },
  };
}

/** An HTTP client whose `fetch` rejects, simulating a transport failure. */
export function httpThrowing(err: unknown): FakeHttpClient {
  const calls: RecordedCall[] = [];
  return {
    calls,
    fetch: (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.reject(err);
    },
  };
}

/** An Arrow response carrying a server-assigned request id. */
export function arrowResponse(
  columns: Record<string, unknown[]> = SAMPLE_ROWS,
  requestId = 'pbi-request-id'
): Response {
  const bytes = arrowStream(columns);
  return new Response(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    {
      status: 200,
      headers: { requestid: requestId },
    }
  );
}

/** Build an `InvokeContext`, defaulting to the CLI host. */
export function buildContext(
  overrides: Partial<InvokeContext> = {}
): InvokeContext {
  return {
    connectorName: 'salesModel',
    operation: 'executeQuery',
    input: { query: 'EVALUATE Sales' },
    host: { type: 'cli' },
    ...overrides,
  } as InvokeContext;
}

/** Read the parsed JSON body of a recorded call. */
export function bodyOf(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

/** Read a request header from a recorded call. */
export function headerOf(call: RecordedCall, name: string): string | undefined {
  const headers = call.init?.headers as Record<string, string> | undefined;
  return headers?.[name];
}
