import { describe, expect, it } from 'vitest';

import type { DiagnosticEvent } from '../../../adapters/index.js';
import type { Http } from '../../../adapters/index.js';
import { FabricHttpClient } from '../http-client.js';

/** Records each request and replays scripted responses (or errors) in order. */
class FakeHttp implements Http {
  public readonly calls: Array<{ input: string | URL; init?: RequestInit }> =
    [];

  /** Optional hook invoked synchronously before each scripted reply. */
  public onFetch?: (callIndex: number, init?: RequestInit) => void;

  private readonly responses: Array<Response | Error>;

  constructor(...responses: Array<Response | Error>) {
    this.responses = responses;
  }

  fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    const callIndex = this.calls.length;
    this.calls.push({ input, init });
    this.onFetch?.(callIndex, init);
    const next = this.responses.shift();
    if (!next) {
      throw new Error('FakeHttp: no scripted response left');
    }
    if (next instanceof Error) {
      return Promise.reject(next);
    }
    return Promise.resolve(next);
  }
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

const baseUrl = 'https://api.fabric.example/v1';

describe('FabricHttpClient', () => {
  it('issues a GET and returns the parsed body without setting Authorization', async () => {
    const http = new FakeHttp(jsonResponse(200, { value: 42 }));
    const client = new FabricHttpClient({ http, baseUrl });

    const result = await client.request<{ value: number }>('/items');

    expect(result).toEqual({ value: 42 });
    expect(http.calls[0].input).toBe(`${baseUrl}/items`);
    expect(http.calls[0].init?.method).toBe('GET');
    const headers = headersOf(http.calls[0].init);
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('serializes a body and sets Content-Type for writes', async () => {
    const http = new FakeHttp(jsonResponse(201, { id: 'abc' }));
    const client = new FabricHttpClient({ http, baseUrl });

    const result = await client.request<{ id: string }>('/items', 'POST', {
      name: 'x',
    });

    expect(result).toEqual({ id: 'abc' });
    expect(http.calls[0].init?.method).toBe('POST');
    expect(http.calls[0].init?.body).toBe(JSON.stringify({ name: 'x' }));
    expect(headersOf(http.calls[0].init)['Content-Type']).toBe(
      'application/json'
    );
  });

  it('treats a 204 No Content success as an empty result', async () => {
    const http = new FakeHttp(new Response(null, { status: 204 }));
    const client = new FabricHttpClient({ http, baseUrl });

    const result = await client.request('/items/1', 'DELETE');

    expect(result).toEqual({});
    expect(http.calls[0].init?.method).toBe('DELETE');
  });

  it('treats an empty 200 body as an empty result', async () => {
    const http = new FakeHttp(new Response('', { status: 200 }));
    const client = new FabricHttpClient({ http, baseUrl });

    const result = await client.request('/items');

    expect(result).toEqual({});
  });

  it('rejects an unexpected 202 rather than mistyping the operation', async () => {
    const http = new FakeHttp(
      jsonResponse(
        202,
        { queued: true },
        { 'x-ms-operation-id': 'op-9', 'Retry-After': '0' }
      )
    );
    const client = new FabricHttpClient({ http, baseUrl });

    await expect(client.request('/items', 'POST', {})).rejects.toThrow(
      /answered \/items asynchronously/
    );
    expect(http.calls).toHaveLength(1);
  });

  it('returns a pollable operation from startOperation', async () => {
    const http = new FakeHttp(
      jsonResponse(
        202,
        {},
        {
          Location: 'https://api.fabric.example/op/10',
          'x-ms-operation-id': 'op-10',
          'Retry-After': '12',
        }
      )
    );
    const client = new FabricHttpClient({ http, baseUrl });

    const result = await client.startOperation('/capacities', 'POST', {
      type: 'Trial',
    });

    expect(result).toEqual({
      operationId: 'op-10',
      operationLocation: 'https://api.fabric.example/op/10',
      retryAfterMs: 12_000,
    });
    expect(http.calls).toHaveLength(1);
  });

  it('omits retryAfterMs when a started operation has no Retry-After', async () => {
    const http = new FakeHttp(
      jsonResponse(
        202,
        {},
        {
          Location: 'https://api.fabric.example/op/11',
          'x-ms-operation-id': 'op-11',
        }
      )
    );
    const client = new FabricHttpClient({ http, baseUrl });

    const result = await client.startOperation('/capacities', 'POST', {
      type: 'Trial',
    });

    expect(result.retryAfterMs).toBeUndefined();
  });

  it('rejects a started operation that cannot be polled', async () => {
    const http = new FakeHttp(
      jsonResponse(202, {}, { 'x-ms-operation-id': 'op-12' })
    );
    const client = new FabricHttpClient({ http, baseUrl });

    await expect(
      client.startOperation('/capacities', 'POST', { type: 'Trial' })
    ).rejects.toThrow(/missing Location or x-ms-operation-id/);
  });

  it('rejects a started operation that did not return 202 Accepted', async () => {
    const http = new FakeHttp(jsonResponse(200, { id: 'cap-1' }));
    const client = new FabricHttpClient({ http, baseUrl });

    await expect(
      client.startOperation('/capacities', 'POST', { type: 'Trial' })
    ).rejects.toThrow(/expected 202 Accepted, got 200/);
  });

  it('accepts an acknowledgement-only 202 that carries no operation', async () => {
    const http = new FakeHttp(jsonResponse(202, {}));
    const client = new FabricHttpClient({ http, baseUrl });

    await expect(
      client.requestAccepted('/workspaces/ws-1/assignToCapacity', 'POST', {
        capacityId: 'cap-1',
      })
    ).resolves.toEqual({});
    expect(http.calls).toHaveLength(1);
  });

  it('returns Retry-After pacing from an acknowledgement-only response', async () => {
    const http = new FakeHttp(
      new Response(null, {
        status: 202,
        headers: { 'Retry-After': '7' },
      })
    );
    const client = new FabricHttpClient({ http, baseUrl });

    await expect(
      client.requestAccepted('/workspaces/ws-1/assignToCapacity', 'POST', {
        capacityId: 'cap-1',
      })
    ).resolves.toEqual({ retryAfterMs: 7_000 });
  });

  it('throws a structured HttpError on a non-OK response', async () => {
    const http = new FakeHttp(
      jsonResponse(
        400,
        { message: 'bad input' },
        { 'x-ms-root-activity-id': 'act-1' }
      )
    );
    const client = new FabricHttpClient({ http, baseUrl });

    await expect(client.request('/items')).rejects.toMatchObject({
      name: 'FabricError',
      statusCode: 400,
    });
  });

  it('does not issue a request when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const http = new FakeHttp(jsonResponse(200, { ok: true }));
    const client = new FabricHttpClient({ http, baseUrl });

    await expect(
      client.request('/items', 'GET', undefined, { signal: controller.signal })
    ).rejects.toThrow(/abort/i);
    expect(http.calls).toHaveLength(0);
  });

  it('uses the transport cancellation signal for every request', async () => {
    const controller = new AbortController();
    controller.abort();
    const http = new FakeHttp(jsonResponse(200, { ok: true }));
    const client = new FabricHttpClient({
      http,
      baseUrl,
      signal: controller.signal,
    });

    await expect(client.request('/items')).rejects.toThrow(/abort/i);
    expect(http.calls).toHaveLength(0);
  });

  it('forwards verbose detail through diagnostics, not the console', async () => {
    const events: DiagnosticEvent[] = [];
    const http = new FakeHttp(jsonResponse(200, { ok: true }));
    const client = new FabricHttpClient({
      http,
      baseUrl,
      diagnostics: { debug: (event) => events.push(event) },
    });

    await client.request('/items');

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.area === 'fabric')).toBe(true);
  });

  it('logs the request path but not query values in diagnostics', async () => {
    const events: DiagnosticEvent[] = [];
    const http = new FakeHttp(jsonResponse(200, { status: 'Running' }));
    const client = new FabricHttpClient({
      http,
      baseUrl,
      diagnostics: { debug: (event) => events.push(event) },
    });

    await client.request(
      '/operations/private-operation-id?continuationToken=secret'
    );

    const serialized = JSON.stringify(events);
    expect(serialized).toContain('/operations/private-operation-id');
    expect(serialized).not.toContain('secret');
  });
});
