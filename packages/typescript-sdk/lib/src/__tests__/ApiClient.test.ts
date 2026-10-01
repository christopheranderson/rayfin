import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ApiClient } from '../ApiClient.js';

/**
 * Regression tests guarding against CWE-532 (sensitive information in logs).
 *
 * A previous implementation of `ApiClient.post` attached a `.then(...)` handler
 * that logged the full response body to the console on every POST. For the
 * `/auth/v1/token` endpoint this leaked the access token and refresh token to
 * the browser console in plain text. The success/error URL logging is retained
 * (the URL and error object do not carry tokens), but these tests assert that
 * the response payload is never written to the console.
 */
describe('ApiClient logging hygiene', () => {
  const ACCESS_TOKEN = 'super-secret-access-token';
  const REFRESH_TOKEN = 'super-secret-refresh-token';

  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  function createClient(): ApiClient {
    return new ApiClient({
      baseUrl: 'https://api.example.com',
      publishableKey: 'pk_test_123',
      useProxy: false,
    });
  }

  function mockJsonResponse(body: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      )
    );
  }

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not log the response body (including tokens) on POST', async () => {
    mockJsonResponse({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
    });

    const client = createClient();
    const result = await client.post<{
      accessToken: string;
      refreshToken: string;
    }>('/auth/v1/token', { grantType: 'password' });

    // Sanity check: the call still returns the parsed payload to the caller.
    expect(result.accessToken).toBe(ACCESS_TOKEN);
    expect(result.refreshToken).toBe(REFRESH_TOKEN);

    // The tokens must never reach the console.
    const allConsoleArgs = [
      ...logSpy.mock.calls,
      ...errorSpy.mock.calls,
      ...infoSpy.mock.calls,
      ...debugSpy.mock.calls,
      ...warnSpy.mock.calls,
    ]
      .flat()
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg ?? '')))
      .join(' ');

    expect(allConsoleArgs).not.toContain(ACCESS_TOKEN);
    expect(allConsoleArgs).not.toContain(REFRESH_TOKEN);

    // The success log is retained but must record only the URL, never the
    // response body, so it is called with a single string argument.
    const successCall = logSpy.mock.calls.find((call) =>
      String(call[0]).includes('POST Success')
    );
    expect(successCall).toBeDefined();
    expect(successCall).toHaveLength(1);
  });

  it('does not log on GET requests', async () => {
    mockJsonResponse({ ok: true });

    const client = createClient();
    await client.get('/health');

    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe('ApiClient useProxy deprecation', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  /**
   * Builds a minimal JSON `Response` stub compatible with the subset of the
   * `Response` API that `ApiClient` consumes.
   */
  function jsonResponse(body: unknown = {}): Response {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? 'application/json' : null,
      },
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }

  beforeEach(() => {
    // Reset modules so the one-time deprecation warning flag is fresh per test.
    vi.resetModules();
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn(async () => jsonResponse());
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    warnSpy.mockRestore();
  });

  it('preserves an absolute baseUrl regardless of a dev-like environment', async () => {
    // Simulate a Vite-like dev server that the old auto-detection would have matched.
    const win = globalThis as unknown as { window?: unknown };
    const originalWindow = win.window;
    win.window = {
      location: { hostname: 'localhost', port: '5173', protocol: 'http:' },
    };
    try {
      const { ApiClient } = await import('../ApiClient.js');
      const client = new ApiClient({
        baseUrl: 'http://localhost:5168',
        publishableKey: 'pk-test',
      });

      await client.get('/api/todos');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(
        'http://localhost:5168/api/todos'
      );
    } finally {
      win.window = originalWindow;
    }
  });

  it('does not change routing when useProxy is provided', async () => {
    const { ApiClient } = await import('../ApiClient.js');

    const withFlag = new ApiClient({
      baseUrl: 'http://localhost:5168',
      publishableKey: 'pk-test',
      useProxy: true,
    });
    await withFlag.get('/api/todos');

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:5168/api/todos');
  });

  it('preserves an absolute baseUrl when useProxy:false is passed (legacy default)', async () => {
    // Every sample historically passed `useProxy: false`; confirm that path still
    // routes directly to the configured backend now that the option is ignored.
    const { ApiClient } = await import('../ApiClient.js');

    const client = new ApiClient({
      baseUrl: 'http://localhost:5168',
      publishableKey: 'pk-test',
      useProxy: false,
    });
    await client.get('/api/todos');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:5168/api/todos');
  });

  it('routes through a relative baseUrl for dev-server proxies', async () => {
    const { ApiClient } = await import('../ApiClient.js');
    const client = new ApiClient({
      baseUrl: '',
      publishableKey: 'pk-test',
    });

    await client.get('/api/todos');

    // An empty baseUrl keeps the request same-origin so a dev proxy can forward it.
    expect(fetchMock.mock.calls[0][0]).toBe('/api/todos');
  });

  it('warns at most once when useProxy is explicitly provided', async () => {
    const { ApiClient } = await import('../ApiClient.js');

    new ApiClient({
      baseUrl: 'http://localhost:5168',
      publishableKey: 'pk-test',
      useProxy: false,
    });
    new ApiClient({
      baseUrl: 'http://localhost:5168',
      publishableKey: 'pk-test',
      useProxy: true,
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('useProxy');
  });

  it('does not warn when useProxy is omitted', async () => {
    const { ApiClient } = await import('../ApiClient.js');

    new ApiClient({
      baseUrl: 'http://localhost:5168',
      publishableKey: 'pk-test',
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('ApiClient binary responses', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  /**
   * Builds a `Response` stub that exposes both `arrayBuffer()` and `text()`,
   * mirroring the subset of the `Response` API that `ApiClient` consumes.
   */
  function binaryResponse(bytes: Uint8Array, contentType: string): Response {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {
        get: (name: string) => {
          const key = name.toLowerCase();
          if (key === 'content-type') return contentType;
          if (key === 'content-length') return String(bytes.byteLength);
          return null;
        },
      },
      arrayBuffer: async () =>
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ),
      text: async () => {
        throw new Error('text() must not be called for a binary response');
      },
    } as unknown as Response;
  }

  function jsonResponse(body: unknown): Response {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? 'application/json' : null,
      },
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }

  function createClient(): ApiClient {
    return new ApiClient({
      baseUrl: 'https://api.example.com',
      publishableKey: 'pk-test',
    });
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns an ArrayBuffer for an Apache Arrow stream content type', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    fetchMock.mockResolvedValue(
      binaryResponse(bytes, 'application/vnd.apache.arrow.stream')
    );

    const result = await createClient().post<ArrayBuffer>(
      '/connector-invoke/salesModel',
      { operation: 'executeQuery' },
      { responseType: 'arraybuffer' }
    );

    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(result))).toEqual([1, 2, 3, 4]);
  });

  it('returns an ArrayBuffer for an application/octet-stream content type', async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    fetchMock.mockResolvedValue(
      binaryResponse(bytes, 'application/octet-stream')
    );

    const result = await createClient().post<ArrayBuffer>('/blob', {});

    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(result))).toEqual([9, 8, 7]);
  });

  it('parses JSON even when responseType is arraybuffer (content type wins)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ rows: [{ Sales: 1 }] }));

    const result = await createClient().post<{ rows: unknown[] }>(
      '/connector-invoke/salesModel',
      { operation: 'executeQuery' },
      { responseType: 'arraybuffer' }
    );

    expect(result).toEqual({ rows: [{ Sales: 1 }] });
  });

  it('does not forward responseType to fetch as a request option', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await createClient().post(
      '/connector-invoke/salesModel',
      { operation: 'executeQuery' },
      { responseType: 'arraybuffer' }
    );

    const fetchInit = fetchMock.mock.calls[0][1] as Record<string, unknown>;
    expect(fetchInit).not.toHaveProperty('responseType');
  });
});

/**
 * Regression tests for the caller-signal listener leak in `fetchWithTimeout`
 * (via `post`/`get`/etc.) and `requestRaw`.
 *
 * Both methods link a caller-supplied `AbortSignal` to their internal
 * `AbortController` with `addEventListener('abort', fn, { once: true })`.
 * `{ once: true }` only removes the listener when the signal actually *fires*.
 * On a successful (or failed-but-not-aborted) request the caller's signal
 * never aborts, so without an explicit `removeEventListener` the listener —
 * and the per-request controller its closure retains — leaks. A caller that
 * reuses one signal across many requests would accumulate one listener per
 * request and eventually trip Node's MaxListenersExceededWarning. The fix
 * detaches the listener in a `finally` block; these tests assert every added
 * `'abort'` listener is subsequently removed.
 */
describe('ApiClient caller-signal cleanup', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  function jsonResponse(body: unknown): Response {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? 'application/json' : null,
      },
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }

  function createClient(): ApiClient {
    return new ApiClient({
      baseUrl: 'https://api.example.com',
      publishableKey: 'pk-test',
    });
  }

  /** Number of `addEventListener`/`removeEventListener` calls for `'abort'`. */
  function abortCalls(spy: ReturnType<typeof vi.spyOn>): number {
    return spy.mock.calls.filter((c) => c[0] === 'abort').length;
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    // getFetch() captures globalThis.fetch at construction, so stub before
    // createClient().
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('removes the abort listener after each successful post that reuses one signal', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const client = createClient();

    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, 'addEventListener');
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    for (let i = 0; i < 3; i++) {
      await client.post('/x', { i }, { signal: controller.signal });
    }

    // Every added 'abort' listener must have been detached — a leak would
    // leave removeSpy at 0.
    expect(abortCalls(addSpy)).toBe(3);
    expect(abortCalls(removeSpy)).toBe(3);
    // The same handler reference added is the one removed each round.
    const added = addSpy.mock.calls
      .filter((c) => c[0] === 'abort')
      .map((c) => c[1]);
    const removed = removeSpy.mock.calls
      .filter((c) => c[0] === 'abort')
      .map((c) => c[1]);
    expect(removed).toEqual(added);
  });

  it('removes the abort listener even when the request rejects', async () => {
    fetchMock.mockRejectedValue(new TypeError('boom'));
    const client = createClient();

    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, 'addEventListener');
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    await expect(
      client.post('/x', {}, { signal: controller.signal })
    ).rejects.toBeTruthy();

    // `finally` must detach the listener on the error path too.
    expect(abortCalls(addSpy)).toBe(1);
    expect(abortCalls(removeSpy)).toBe(1);
  });

  it('removes the abort listener after each successful requestRaw that reuses one signal', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
    const client = createClient();

    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, 'addEventListener');
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    for (let i = 0; i < 3; i++) {
      await client.requestRaw('/raw', { signal: controller.signal });
    }

    expect(abortCalls(addSpy)).toBe(3);
    expect(abortCalls(removeSpy)).toBe(3);
  });
});

describe('ApiClient.requestRaw URL construction', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  const FABRIC_BASE =
    'https://host.net/webapi/capacities/abc/workloads/BaaS/BaaSService/automatic/v1/workspaces/def/appbackends/53894d18-32b0-4c47-a2ef-4a876904488f';

  function createClient(baseUrl: string): ApiClient {
    return new ApiClient({ baseUrl, publishableKey: 'pk-test' });
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('preserves the full Fabric base path for a relative data-plane path', async () => {
    await createClient(FABRIC_BASE).requestRaw('api/storage/upload', {
      method: 'POST',
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${FABRIC_BASE}/api/storage/upload`
    );
  });

  it('preserves the base path when the path has a leading slash', async () => {
    await createClient(FABRIC_BASE).requestRaw('/api/storage/download', {
      method: 'POST',
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${FABRIC_BASE}/api/storage/download`
    );
  });

  it('uses an absolute SAS URL verbatim when proxy joining is disabled', async () => {
    const sas = 'https://onelake.blob.core.windows.net/ws/item/file?sig=abc';

    await createClient(FABRIC_BASE).requestRaw(sas, {
      method: 'PUT',
      allowProxyPath: false,
      skipAuth: true,
    });

    expect(fetchMock.mock.calls[0][0]).toBe(sas);
  });

  it('stays same-origin when baseUrl is empty', async () => {
    await createClient('').requestRaw('api/storage/upload', { method: 'POST' });

    expect(fetchMock.mock.calls[0][0]).toBe('api/storage/upload');
  });
});
