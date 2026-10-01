import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { loadRayfinConfig } from '../config';

const validConfig = {
  apiUrl: 'http://localhost:5168/',
  publishableKey: 'pk-test-123',
};

describe('loadRayfinConfig', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetchSuccess(body: unknown) {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'application/json' },
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  }

  function mockFetchFailure(status: number, statusText: string) {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status,
      statusText,
      json: () => Promise.reject(new Error('not json')),
    });
  }

  function mockFetchNetworkError(message: string) {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error(message)
    );
  }

  it('fetches and returns valid config', async () => {
    mockFetchSuccess(validConfig);
    const config = await loadRayfinConfig();
    expect(config).toEqual(validConfig);
    expect(fetch).toHaveBeenCalledWith('/rayfin.config.json');
  });

  it('uses custom path when provided', async () => {
    mockFetchSuccess(validConfig);
    await loadRayfinConfig('/custom/path.json');
    expect(fetch).toHaveBeenCalledWith('/custom/path.json');
  });

  it('includes optional fabric fields when present', async () => {
    const fabricConfig = {
      ...validConfig,
      workspaceId: 'ws-123',
      portalUrl: 'https://app.fabric.microsoft.com',
      tenantId: 'tenant-123',
    };
    mockFetchSuccess(fabricConfig);
    const config = await loadRayfinConfig();
    expect(config!.workspaceId).toBe('ws-123');
    expect(config!.portalUrl).toBe('https://app.fabric.microsoft.com');
    expect(config!.tenantId).toBe('tenant-123');
  });

  it('throws CONFIG_LOAD_FAILED on a fetch-level network error instead of treating it as absent', async () => {
    mockFetchNetworkError('Failed to fetch');
    await expect(loadRayfinConfig()).rejects.toMatchObject({
      code: 'CONFIG_LOAD_FAILED',
    });
  });

  it('returns null on 404 (genuinely absent)', async () => {
    mockFetchFailure(404, 'Not Found');
    expect(await loadRayfinConfig()).toBeNull();
  });

  it('throws CONFIG_LOAD_FAILED on a 500 server error instead of treating it as absent', async () => {
    mockFetchFailure(500, 'Internal Server Error');
    await expect(loadRayfinConfig()).rejects.toMatchObject({
      code: 'CONFIG_LOAD_FAILED',
    });
  });

  it('throws CONFIG_LOAD_FAILED on a 403 auth failure instead of treating it as absent', async () => {
    mockFetchFailure(403, 'Forbidden');
    await expect(loadRayfinConfig()).rejects.toMatchObject({
      code: 'CONFIG_LOAD_FAILED',
    });
  });

  it('returns null when the server responds with an SPA fallback (HTML)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'text/html' },
      text: () =>
        Promise.resolve('<!DOCTYPE html>\n<html><body>app</body></html>'),
    });
    expect(await loadRayfinConfig()).toBeNull();
  });

  it('returns null when the body is HTML despite a mislabeled content type', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'application/octet-stream' },
      text: () =>
        Promise.resolve('<!DOCTYPE html>\n<html><body>app</body></html>'),
    });
    expect(await loadRayfinConfig()).toBeNull();
  });

  it('throws CONFIG_PARSE_FAILED on invalid JSON', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'application/json' },
      text: () => Promise.resolve('{ not valid json'),
    });
    await expect(loadRayfinConfig()).rejects.toMatchObject({
      code: 'CONFIG_PARSE_FAILED',
    });
  });

  it('throws CONFIG_INVALID when config is not an object', async () => {
    mockFetchSuccess('not an object');
    await expect(loadRayfinConfig()).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });

  it('throws CONFIG_INVALID when config is an array', async () => {
    mockFetchSuccess([1, 2, 3]);
    await expect(loadRayfinConfig()).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });

  it('throws CONFIG_INCOMPLETE when required fields are missing', async () => {
    mockFetchSuccess({});
    await expect(loadRayfinConfig()).rejects.toMatchObject({
      code: 'CONFIG_INCOMPLETE',
    });
  });

  it('lists missing required fields in the error message', async () => {
    mockFetchSuccess({});
    try {
      await loadRayfinConfig();
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('apiUrl');
    }
  });

  it.each(['publishableKey', 'workspaceId', 'portalUrl', 'itemId', 'tenantId'])(
    'throws CONFIG_INVALID when %s is present but not a string',
    async (field) => {
      mockFetchSuccess({ ...validConfig, [field]: 123 });
      await expect(loadRayfinConfig()).rejects.toMatchObject({
        code: 'CONFIG_INVALID',
      });
    }
  );

  it('treats an empty-string optional field as absent rather than invalid', async () => {
    mockFetchSuccess({ ...validConfig, workspaceId: '' });
    const config = await loadRayfinConfig();
    expect(config!.workspaceId).toBeUndefined();
  });
});

describe('loadRayfinConfig — real Node fetch semantics', () => {
  // These tests intentionally do not mock `fetch` — they exercise Node's
  // native implementation to verify how it actually behaves with absolute
  // versus relative URLs (the bug behind the configUrl fix on
  // RayfinServerClient.fromConfig was only observable against real fetch,
  // not a mock).
  beforeEach(() => {
    // The sibling describe above leaves `fetch` stubbed via
    // `vi.stubGlobal` — `vi.restoreAllMocks()` doesn't undo that, so
    // explicitly restore the real global here.
    vi.unstubAllGlobals();
  });

  it('loads config from an absolute URL against a real HTTP server', async () => {
    const http = await import('node:http');
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(validConfig));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const config = await loadRayfinConfig(
        `http://127.0.0.1:${port}/rayfin.config.json`
      );
      expect(config).toEqual(validConfig);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('throws CONFIG_LOAD_FAILED for the default relative path when a browser window is present, since fetch has no origin to resolve it against', async () => {
    // A browser window is present (jsdom, mirroring a real browser), so the
    // fetch is attempted rather than skipped. Node's real fetch rejects with
    // a TypeError since there's no document origin to resolve a relative URL
    // against — that rejection is a real failure, not evidence of absence.
    await expect(loadRayfinConfig()).rejects.toMatchObject({
      code: 'CONFIG_LOAD_FAILED',
    });
  });

  it('skips the fetch and returns null on the default path when no browser window is present', async () => {
    vi.stubGlobal('window', undefined);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await loadRayfinConfig()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
