/**
 * @packageDocumentation Tests for the typed Connectors API proxy and ConnectorClient.
 *
 * The public surface exposed via `client.connectors` is the typed proxy
 * returned by {@link createConnectorsApi}. Each schema-defined name resolves
 * to an operation proxy whose property names post `{ operation, input }` to
 * `ConnectorClient.invoke`. These tests cover the transport path, proxy
 * caching, thenable safety, and error wrapping.
 */

import { ApiClient, NetworkError } from '@microsoft/rayfin-lib';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  createConnectorsApi,
  ConnectorsError,
  detectHost,
} from '../Connectors';
import { SemanticConnectorClient } from '../category-b/SemanticConnectorClient';

// Mock @microsoft/rayfin-lib so we don't actually fetch and so that the
// SDK error classes used below are recognised via instanceof checks.
vi.mock('@microsoft/rayfin-lib', () => {
  const NetworkErrorMock = class NetworkError extends Error {
    override name = 'NetworkError';
    statusCode?: number;
    constructor(message: string, statusCode?: number) {
      super(message);
      this.statusCode = statusCode;
    }
  };

  const SdkErrorMock = class SdkError extends Error {
    override name = 'SdkError';
    code?: string;
    constructor(message: string, code?: string) {
      super(message);
      this.code = code;
    }
  };

  return {
    ApiClient: vi.fn().mockImplementation(() => ({
      post: vi.fn(),
      requestRaw: vi.fn(),
    })),
    NetworkError: NetworkErrorMock,
    SdkError: SdkErrorMock,
    CONNECTOR_INVOKE_BASE_PATH: '/connector-invoke',
  };
});

// ---- SemanticConnectorClient ----------------------------------------------

describe('SemanticConnectorClient', () => {
  let mockApiClient: ApiClient;
  let client: SemanticConnectorClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiClient = new ApiClient({
      baseUrl: 'https://api.rayfin.io',
      publishableKey: 'pk-test-key-12345678',
    });
    client = new SemanticConnectorClient(mockApiClient, 'salesModel');
  });

  it('POSTs to /connector-invoke/<name> with { operation, input }', async () => {
    (mockApiClient.post as any).mockResolvedValue({ rows: [] });

    await client.invoke('executeQuery', { query: 'EVALUATE Sales' });

    expect(mockApiClient.post).toHaveBeenCalledWith(
      '/connector-invoke/salesModel',
      { operation: 'executeQuery', input: { query: 'EVALUATE Sales' } },
      {
        headers: {
          Accept: 'application/vnd.apache.arrow.stream, application/json',
        },
        responseType: 'arraybuffer',
      }
    );
  });

  it('sends null as input when none is provided', async () => {
    (mockApiClient.post as any).mockResolvedValue({ rows: [] });

    await client.invoke('executeQuery');

    expect(mockApiClient.post).toHaveBeenCalledWith(
      '/connector-invoke/salesModel',
      { operation: 'executeQuery', input: null },
      {
        headers: {
          Accept: 'application/vnd.apache.arrow.stream, application/json',
        },
        responseType: 'arraybuffer',
      }
    );
  });

  it('forwards extra headers from InvokeOptions', async () => {
    (mockApiClient.post as any).mockResolvedValue({});

    await client.invoke('executeQuery', {}, { headers: { 'x-trace': 'abc' } });

    expect(mockApiClient.post).toHaveBeenCalledWith(
      '/connector-invoke/salesModel',
      expect.any(Object),
      {
        headers: {
          Accept: 'application/vnd.apache.arrow.stream, application/json',
          'x-trace': 'abc',
        },
        responseType: 'arraybuffer',
      }
    );
  });

  it('returns the server response directly', async () => {
    const payload = { rows: [{ Sales: 100 }] };
    (mockApiClient.post as any).mockResolvedValue(payload);

    const result = await client.invoke('executeQuery', {
      query: 'EVALUATE Sales',
    });

    expect(result).toBe(payload);
  });

  it('throws ConnectorsError when operation name is empty', async () => {
    await expect(client.invoke('')).rejects.toThrow(
      'Operation name is required.'
    );
  });

  it('propagates NetworkError unchanged', async () => {
    const networkError = new NetworkError('timeout', 504);
    (mockApiClient.post as any).mockRejectedValue(networkError);

    await expect(client.invoke('executeQuery')).rejects.toThrow('timeout');
  });

  it('wraps unknown errors in ConnectorsError', async () => {
    (mockApiClient.post as any).mockRejectedValue(new Error('boom'));

    await expect(client.invoke('executeQuery')).rejects.toBeInstanceOf(
      ConnectorsError
    );
  });
});

// ---- createConnectorsApi ---------------------------------------------------

describe('createConnectorsApi', () => {
  let mockApiClient: ApiClient;
  let connectors: ReturnType<typeof createConnectorsApi>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiClient = new ApiClient({
      baseUrl: 'https://api.rayfin.io',
      publishableKey: 'pk-test-key-12345678',
    });
    connectors = createConnectorsApi(mockApiClient, {
      salesModel: { connector: 'fabric-semanticmodel' },
    });
  });

  it('returns a callable operation function for any connector/operation name', () => {
    const op = (connectors as any).salesModel.executeQuery;
    expect(typeof op).toBe('function');
  });

  it('caches the per-connector proxy across accesses', () => {
    const first = (connectors as any).salesModel;
    const second = (connectors as any).salesModel;
    expect(first).toBe(second);
  });

  it('invokes the correct POST endpoint via the operation function', async () => {
    (mockApiClient.post as any).mockResolvedValue({ rows: [] });

    await (connectors as any).salesModel.executeQuery({
      query: 'EVALUATE Sales',
    });

    expect(mockApiClient.post).toHaveBeenCalledWith(
      '/connector-invoke/salesModel',
      { operation: 'executeQuery', input: { query: 'EVALUATE Sales' } },
      {
        headers: {
          Accept: 'application/vnd.apache.arrow.stream, application/json',
        },
        responseType: 'arraybuffer',
      }
    );
  });

  it('operation proxy is not thenable — then/catch/finally are undefined', () => {
    const connector = (connectors as any).salesModel;
    expect(connector.then).toBeUndefined();
    expect(connector.catch).toBeUndefined();
    expect(connector.finally).toBeUndefined();
  });

  it('real operations are still callable after thenable keys are blocked', () => {
    const connector = (connectors as any).salesModel;
    expect(typeof connector.executeQuery).toBe('function');
  });
});

// ---- runtime binary decoders -----------------------------------------------

describe('createConnectorsApi runtime decoders', () => {
  let mockApiClient: ApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiClient = new ApiClient({
      baseUrl: 'https://api.rayfin.io',
      publishableKey: 'pk-test-key-12345678',
    });
  });

  it('decodes an ArrayBuffer result with the registered decoder', async () => {
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    (mockApiClient.post as any).mockResolvedValue(buffer);

    const decodeBinary = vi.fn().mockReturnValue({ decoded: true });
    const connectors = createConnectorsApi(
      mockApiClient,
      { salesModel: { connector: 'fabric-semanticmodel' } },
      { salesModel: { operations: { executeQuery: { decodeBinary } } } }
    );

    const result = await (connectors as any).salesModel.executeQuery({
      query: 'EVALUATE Sales',
    });

    expect(decodeBinary).toHaveBeenCalledTimes(1);
    expect(decodeBinary.mock.calls[0][0]).toBeInstanceOf(ArrayBuffer);
    expect(result).toEqual({ decoded: true });
  });

  it('decodes an ArrayBufferView result by copying its bytes', async () => {
    const view = new Uint8Array([5, 6, 7, 8]);
    (mockApiClient.post as any).mockResolvedValue(view);

    const decodeBinary = vi.fn((data: ArrayBuffer) => new Uint8Array(data));
    const connectors = createConnectorsApi(
      mockApiClient,
      { salesModel: { connector: 'fabric-semanticmodel' } },
      { salesModel: { operations: { executeQuery: { decodeBinary } } } }
    );

    const result = (await (connectors as any).salesModel.executeQuery(
      {}
    )) as Uint8Array;

    expect(decodeBinary).toHaveBeenCalledTimes(1);
    expect(Array.from(result)).toEqual([5, 6, 7, 8]);
  });

  it('passes JSON results through untouched when a decoder is registered', async () => {
    const payload = { rows: [{ Sales: 100 }] };
    (mockApiClient.post as any).mockResolvedValue(payload);

    const decodeBinary = vi.fn();
    const connectors = createConnectorsApi(
      mockApiClient,
      { salesModel: { connector: 'fabric-semanticmodel' } },
      { salesModel: { operations: { executeQuery: { decodeBinary } } } }
    );

    const result = await (connectors as any).salesModel.executeQuery({});

    expect(decodeBinary).not.toHaveBeenCalled();
    expect(result).toBe(payload);
  });

  it('only decodes operations that have a registered decoder', async () => {
    const buffer = new Uint8Array([1]).buffer;
    (mockApiClient.post as any).mockResolvedValue(buffer);

    const connectors = createConnectorsApi(
      mockApiClient,
      { salesModel: { connector: 'fabric-semanticmodel' } },
      { salesModel: { operations: { executeQuery: {} } } }
    );

    const result = await (connectors as any).salesModel.otherOperation({});

    expect(result).toBe(buffer);
  });
});

// ---- invoke middleware -----------------------------------------------------

describe('createConnectorsApi invoke middleware', () => {
  let mockApiClient: ApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiClient = new ApiClient({
      baseUrl: 'https://api.rayfin.io',
      publishableKey: 'pk-test-key-12345678',
    });
  });

  it('(a) fires the unchanged standalone POST when no middleware is registered', async () => {
    (mockApiClient.post as any).mockResolvedValue({ rows: [] });

    const connectors = createConnectorsApi(mockApiClient, {
      salesModel: { connector: 'fabric-semanticmodel' },
    });

    await (connectors as any).salesModel.executeQuery({
      query: 'EVALUATE Sales',
    });

    expect(mockApiClient.post).toHaveBeenCalledTimes(1);
    expect(mockApiClient.post).toHaveBeenCalledWith(
      '/connector-invoke/salesModel',
      { operation: 'executeQuery', input: { query: 'EVALUATE Sales' } },
      {
        headers: {
          Accept: 'application/vnd.apache.arrow.stream, application/json',
        },
        responseType: 'arraybuffer',
      }
    );
  });

  it('(b) lets a middleware short-circuit without calling next', async () => {
    (mockApiClient.post as any).mockResolvedValue({ rows: ['unexpected'] });

    const invoke = vi.fn(async () => ({ rows: ['from-middleware'] }));
    const connectors = createConnectorsApi(
      mockApiClient,
      { salesModel: { connector: 'fabric-semanticmodel' } },
      { salesModel: { operations: { executeQuery: { invoke } } } }
    );

    const result = await (connectors as any).salesModel.executeQuery({
      query: 'EVALUATE Sales',
    });

    // Middleware serviced the call itself; the standalone transport never ran.
    expect(mockApiClient.post).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ rows: ['from-middleware'] });
  });

  it('(b) passes an InvokeContext carrying connector, operation, input, options, host, config and http', async () => {
    (mockApiClient.post as any).mockResolvedValue({});

    const invoke = vi.fn(async () => ({ ok: true }));
    const connectors = createConnectorsApi(
      mockApiClient,
      { salesModel: { connector: 'fabric-semanticmodel' } },
      { salesModel: { operations: { executeQuery: { invoke } } } }
    );

    await (connectors as any).salesModel.executeQuery(
      { query: 'EVALUATE Sales' },
      { headers: { 'x-trace': 'abc' } }
    );

    const [ctx, next] = invoke.mock.calls[0] as unknown as [any, any];
    expect(ctx).toMatchObject({
      connectorName: 'salesModel',
      operation: 'executeQuery',
      input: { query: 'EVALUATE Sales' },
      options: { headers: { 'x-trace': 'abc' } },
      connectorConfig: { connector: 'fabric-semanticmodel' },
    });
    // No explicit host was passed, so it is auto-detected.
    expect(ctx.host).toEqual(detectHost());
    // A pre-authenticated HTTP client is always supplied.
    expect(typeof ctx.http.fetch).toBe('function');
    expect(typeof next).toBe('function');
  });

  it('(b2) ctx.http.fetch delegates to the SDK requestRaw so middleware never handles auth', async () => {
    const response = { ok: true } as unknown as Response;
    (mockApiClient.requestRaw as any).mockResolvedValue(response);

    const invoke = vi.fn(async (ctx: any) => {
      const res = await ctx.http.fetch('/semantic/query', {
        method: 'POST',
        headers: { 'x-trace': 'abc' },
        body: 'EVALUATE Sales',
      });
      return { serviced: res.ok };
    });

    const connectors = createConnectorsApi(
      mockApiClient,
      { salesModel: { connector: 'fabric-semanticmodel' } },
      { salesModel: { operations: { executeQuery: { invoke } } } }
    );

    const result = await (connectors as any).salesModel.executeQuery({});

    // The standalone POST transport was never used — middleware serviced it
    // through the pre-authenticated client.
    expect(mockApiClient.post).not.toHaveBeenCalled();
    expect(mockApiClient.requestRaw).toHaveBeenCalledTimes(1);
    expect(mockApiClient.requestRaw).toHaveBeenCalledWith('/semantic/query', {
      method: 'POST',
      headers: { 'x-trace': 'abc' },
      body: 'EVALUATE Sales',
      signal: undefined,
    });
    expect(result).toEqual({ serviced: true });
  });

  it('(c) applies decodeBinary when a middleware delegates to next', async () => {
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    (mockApiClient.post as any).mockResolvedValue(buffer);

    const decodeBinary = vi.fn().mockReturnValue({ decoded: true });
    // Middleware that falls through to the default transport via `next`.
    const invoke = vi.fn((ctx: any, next: any) => next(ctx));
    const connectors = createConnectorsApi(
      mockApiClient,
      { salesModel: { connector: 'fabric-semanticmodel' } },
      { salesModel: { operations: { executeQuery: { invoke, decodeBinary } } } }
    );

    const result = await (connectors as any).salesModel.executeQuery({
      query: 'EVALUATE Sales',
    });

    // next() hit the standalone transport, and the Arrow buffer it returned
    // was still decoded.
    expect(mockApiClient.post).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(decodeBinary).toHaveBeenCalledTimes(1);
    expect(decodeBinary.mock.calls[0][0]).toBeInstanceOf(ArrayBuffer);
    expect(result).toEqual({ decoded: true });
  });

  it('(d) host is auto-detected by default and can be overridden via createConnectorsApi', async () => {
    (mockApiClient.post as any).mockResolvedValue({});

    const seenHosts: unknown[] = [];
    const invoke = vi.fn(async (ctx: any) => {
      seenHosts.push(ctx.host);
      return {};
    });

    // No host passed — auto-detected (nothing to wire up).
    const defaultApi = createConnectorsApi(
      mockApiClient,
      { salesModel: { connector: 'fabric-semanticmodel' } },
      { salesModel: { operations: { executeQuery: { invoke } } } }
    );
    await (defaultApi as any).salesModel.executeQuery({});

    // Explicit host override.
    const embeddedApi = createConnectorsApi(
      mockApiClient,
      { salesModel: { connector: 'fabric-semanticmodel' } },
      { salesModel: { operations: { executeQuery: { invoke } } } },
      { type: 'embedded' }
    );
    await (embeddedApi as any).salesModel.executeQuery({});

    expect(seenHosts).toEqual([detectHost(), { type: 'embedded' }]);
  });
});

// ---- detectHost ------------------------------------------------------------

describe('detectHost', () => {
  const hadWindow = 'window' in globalThis;
  const originalWindow = (globalThis as any).window;

  afterEach(() => {
    if (hadWindow) {
      (globalThis as any).window = originalWindow;
    } else {
      delete (globalThis as any).window;
    }
  });

  it("returns 'cli' when there is no window (Node)", () => {
    delete (globalThis as any).window;
    expect(detectHost()).toEqual({ type: 'cli' });
  });

  it("returns 'standalone' in a top-level browser document", () => {
    const win: any = {};
    win.self = win;
    win.top = win;
    (globalThis as any).window = win;
    expect(detectHost()).toEqual({ type: 'standalone' });
  });

  it("returns 'standalone' when nested in a parent frame (embedded is not auto-detected)", () => {
    const top: any = {};
    const win: any = { top };
    win.self = win;
    (globalThis as any).window = win;
    expect(detectHost()).toEqual({ type: 'standalone' });
  });

  it("returns 'standalone' even when reading window.top would throw (cross-origin)", () => {
    const win: any = {};
    win.self = win;
    Object.defineProperty(win, 'top', {
      get() {
        throw new Error('cross-origin');
      },
    });
    (globalThis as any).window = win;
    expect(detectHost()).toEqual({ type: 'standalone' });
  });
});
