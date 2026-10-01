import { afterEach, describe, expect, it, vi } from 'vitest';

import { MONIKER_HEADER } from '../../../fabric.js';
import {
  checkManagementEndpoint,
  createFabricStatusClient,
} from '../status-client.js';

const target = {
  itemEndpoint: 'https://api.fabric.example/v1/workspaces/ws/appBackends/item/',
  itemId: 'item',
};

afterEach(() => vi.useRealTimers());

describe('management endpoint check', () => {
  it.each([0, 1, 3, 30_000])(
    'normalizes %s trailing slashes without scanning interior slash runs',
    async (count) => {
      const base = `https://api.fabric.example/${'/'.repeat(30_000)}v1`;
      const endpoint = `${base}/workspaces/ws/appBackends/item`;
      const suffix = '/'.repeat(count);
      const http = {
        fetch: vi.fn().mockImplementation(async () => new Response('pk-test')),
      };

      await createFabricStatusClient(
        http,
        `${base}${suffix}`
      ).checkManagementEndpoint('ws', 'item');
      await checkManagementEndpoint(
        { ...target, itemEndpoint: `${endpoint}${suffix}` },
        http
      );

      for (const [url] of http.fetch.mock.calls) {
        expect(url).toBe(`${endpoint}/__private/publishable-key`);
      }
    }
  );

  it('reports a browser opaque redirect without inventing HTTP 0 or reading its body', async () => {
    const response = Response.error();
    vi.spyOn(response, 'type', 'get').mockReturnValue('opaqueredirect');
    const readBody = vi.spyOn(response, 'text');

    const result = await checkManagementEndpoint(target, {
      fetch: vi.fn().mockResolvedValue(response),
    });

    expect(result).toMatchObject({ reachable: true, errorCode: 'redirect' });
    expect(result.error).toContain('redirected');
    expect(result.httpStatus).toBeUndefined();
    expect(result.authenticated).toBeUndefined();
    expect(readBody).not.toHaveBeenCalled();
  });

  it('constructs the management URL from Fabric coordinates, not a runtime URL', async () => {
    const http = {
      fetch: vi
        .fn()
        .mockResolvedValue(new Response('{"publishableKey":"pk-test"}')),
    };
    const client = createFabricStatusClient(
      http,
      'https://api.fabric.example/v1/'
    );
    await client.checkManagementEndpoint('workspace', 'item');
    expect(http.fetch).toHaveBeenCalledWith(
      'https://api.fabric.example/v1/workspaces/workspace/appBackends/item/__private/publishable-key',
      expect.anything()
    );
  });

  it('reads optional Fabric facts through the shared transport', async () => {
    const http = {
      fetch: vi
        .fn()
        .mockResolvedValueOnce(
          new Response('{"id":"workspace","displayName":"My workspace"}')
        )
        .mockResolvedValueOnce(
          new Response('{"id":"item","displayName":"App","type":"AppBackend"}')
        )
        .mockResolvedValueOnce(
          new Response('{"value":[{"id":"db","displayName":"Database"}]}')
        ),
    };
    const client = createFabricStatusClient(
      http,
      'https://api.fabric.example/v1'
    );
    expect(await client.getWorkspace('workspace')).toMatchObject({
      id: 'workspace',
    });
    expect(await client.getItem('workspace', 'item')).toMatchObject({
      id: 'item',
    });
    expect(await client.listDatabases('workspace')).toEqual([
      { id: 'db', displayName: 'Database' },
    ]);
    expect(http.fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://api.fabric.example/v1/workspaces/workspace',
      'https://api.fabric.example/v1/workspaces/workspace/items/item',
      'https://api.fabric.example/v1/workspaces/workspace/sqlDatabases',
    ]);
  });

  it.each([
    ['JSON object', '{"publishableKey":"pk-test"}'],
    ['JSON string', '"pk-test"'],
    ['plain text', ' pk-test\n'],
  ])('accepts a %s key', async (_name, body) => {
    const http = { fetch: vi.fn().mockResolvedValue(new Response(body)) };
    const result = await checkManagementEndpoint(target, http);
    expect(result).toMatchObject({
      reachable: true,
      httpStatus: 200,
      authenticated: true,
      publishableKey: 'pk-test',
    });
    expect(result.error).toBeUndefined();
    expect(result.metadataError).toBeUndefined();
    expect(http.fetch).toHaveBeenCalledWith(
      `${target.itemEndpoint}__private/publishable-key`,
      expect.objectContaining({
        redirect: 'manual',
        headers: { Accept: 'application/json', [MONIKER_HEADER]: 'item' },
      })
    );
  });

  it.each([401, 403, 404, 500, 302])(
    'reports HTTP %s separately from reachability',
    async (status) => {
      const result = await checkManagementEndpoint(target, {
        fetch: vi.fn().mockResolvedValue(new Response('', { status })),
      });
      expect(result).toMatchObject({
        reachable: true,
        httpStatus: status,
        errorCode: 'http',
      });
      expect(result.authenticated).toBe(
        status === 401 || status === 403 ? false : undefined
      );
    }
  );

  it.each([
    '<html>app</html>',
    '{',
    '{"message":"ok"}',
    '',
    'null',
    '{"publishableKey":123}',
    '" "',
  ])(
    'separates unexpected metadata %j from management access',
    async (body) => {
      const result = await checkManagementEndpoint(target, {
        fetch: vi.fn().mockResolvedValue(new Response(body)),
      });
      expect(result).toMatchObject({
        reachable: true,
        authenticated: true,
        metadataError: 'unexpected-format',
      });
      expect(result.publishableKey).toBeUndefined();
      expect(result.error).toBeUndefined();
    }
  );

  it.each(['headers', 'body'])(
    'times out during %s and clears its timer',
    async (stage) => {
      vi.useFakeTimers();
      const pending = checkManagementEndpoint(target, {
        fetch: vi
          .fn()
          .mockImplementation(async (_url, options: RequestInit) => {
            const waitForAbort = () =>
              new Promise<string>((_resolve, reject) => {
                options.signal?.addEventListener('abort', () =>
                  reject(new globalThis.DOMException('Aborted', 'AbortError'))
                );
              });
            if (stage === 'headers') await waitForAbort();
            const response = new Response('');
            vi.spyOn(response, 'text').mockImplementation(waitForAbort);
            return response;
          }),
      });
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({
        reachable: stage === 'body',
        errorCode: 'timeout',
      });
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each([
    [new Error('fetch failed'), 'network'],
    [
      new Error('fetch failed', { cause: { code: 'ECONNREFUSED' } }),
      'connection-refused',
    ],
  ])(
    'reports network failure and clears its timer',
    async (error, errorCode) => {
      vi.useFakeTimers();
      const result = await checkManagementEndpoint(target, {
        fetch: vi.fn().mockRejectedValue(error),
      });
      expect(result).toMatchObject({ reachable: false, errorCode });
      expect(result.authenticated).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    }
  );
});
