import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveConfig,
  type ConfigEnv,
  type Plugin,
  type ProxyOptions,
  type UserConfig,
} from 'vite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAuthenticatedTokenMock, fetchMock } = vi.hoisted(() => ({
  getAuthenticatedTokenMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('@microsoft/rayfin-cli/auth', () => ({
  getAuthenticatedToken: getAuthenticatedTokenMock,
}));

import {
  getRayfinLocalStaticAccess,
  isRayfinLocalAutoLoginEnabled,
  resolveRayfinFunctionsBaseUrl,
} from '../index.js';
import { readStaticAccess } from '../posture.js';
import { rayfinLocalDev } from '../vite.js';

const tempDirs: string[] = [];

beforeEach(() => {
  // Default success stub for the delegated Entra token acquisition
  // (`acquireEntraToken()` in `vite.ts`, which delegates to the Rayfin
  // CLI's own auth module); individual tests override this to exercise
  // sign-in failures.
  getAuthenticatedTokenMock.mockResolvedValue({
    token: 'entra-token',
    expiresOnTimestamp: Date.now() + 3600_000,
    tenantId: undefined,
    identityType: 'user',
  });
  // Default success stub for the Node-side brokered-token exchange
  // (`exchangeBrokeredToken()` in `vite.ts`); individual tests override this
  // to exercise exchange failures.
  fetchMock.mockResolvedValue(
    Response.json({
      accessToken: 'rayfin-access-token',
      tokenType: 'Bearer',
      expiresIn: 3600,
    })
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  vi.restoreAllMocks();
  getAuthenticatedTokenMock.mockReset();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true }))
  );
});

describe('resolveRayfinFunctionsBaseUrl', () => {
  it('returns an absolute same-origin URL only when the proxy registered', () => {
    vi.stubGlobal('__RAYFIN_LOCAL_FUNCTIONS_PROXY__', true);
    vi.stubGlobal('location', { origin: 'http://localhost:5173' });

    expect(resolveRayfinFunctionsBaseUrl()).toBe(
      'http://localhost:5173/.rayfin'
    );

    vi.stubGlobal('__RAYFIN_LOCAL_FUNCTIONS_PROXY__', false);
    expect(resolveRayfinFunctionsBaseUrl()).toBeUndefined();
  });
});

describe('local auth helpers', () => {
  it('reads the development posture and automatic sign-in defines', () => {
    vi.stubGlobal('__RAYFIN_LOCAL_STATIC_ACCESS__', 'protected');
    vi.stubGlobal('__RAYFIN_LOCAL_AUTO_LOGIN__', true);

    expect(getRayfinLocalStaticAccess()).toBe('protected');
    expect(isRayfinLocalAutoLoginEnabled()).toBe(true);

    vi.stubGlobal('__RAYFIN_LOCAL_STATIC_ACCESS__', undefined);
    vi.stubGlobal('__RAYFIN_LOCAL_AUTO_LOGIN__', false);
    expect(getRayfinLocalStaticAccess()).toBeUndefined();
    expect(isRayfinLocalAutoLoginEnabled()).toBe(false);
  });
});

describe('readStaticAccess', () => {
  it('walks up to read the project static-hosting posture', async () => {
    const root = await createProject(
      'services:\n  staticHosting:\n    assetAccess: protected\n'
    );
    const frontend = join(root, 'packages', 'frontend');
    await mkdir(frontend, { recursive: true });

    expect(readStaticAccess(frontend)).toBe('protected');
  });

  it('fails soft for missing and malformed project configuration', async () => {
    const missingRoot = await mkdtemp(join(tmpdir(), 'rayfin-local-dev-'));
    const malformedRoot = await createProject('services: [\n');
    tempDirs.push(missingRoot);

    expect(readStaticAccess(missingRoot)).toBeUndefined();
    expect(readStaticAccess(malformedRoot)).toBeUndefined();
  });
});

describe('rayfinLocalDev', () => {
  it('reads the runtime URL selected by rayfin dev', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rayfin-local-dev-'));
    tempDirs.push(root);
    await writeFile(
      join(root, '.env.local'),
      'VITE_RAYFIN_FUNCTIONS_URL=http://localhost:7314\n'
    );

    const config = await runConfig(rayfinLocalDev(), { root });

    expect(config?.define?.__RAYFIN_LOCAL_FUNCTIONS_PROXY__).toBe('true');
    const [context] = Object.keys(config?.server?.proxy ?? {});
    expect(context).toBe('^/\\.rayfin/api(?:/|$)');
    const contextPattern = new RegExp(context);
    expect(contextPattern.test('/.rayfin/api')).toBe(true);
    expect(contextPattern.test('/.rayfin/api/hello')).toBe(true);
    expect(contextPattern.test('/.rayfin/admin/host/status')).toBe(false);
    expect(contextPattern.test('/.rayfin/runtime/webhooks')).toBe(false);
    expect(contextPattern.test('/.rayfinanything/api/hello')).toBe(false);
    expect(proxyFrom(config).target).toBe('http://localhost:7314');
  });

  it('keeps the active dev session URL when the framework env is rewritten', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rayfin-local-dev-'));
    tempDirs.push(root);
    await writeFile(
      join(root, '.env.local'),
      'VITE_RAYFIN_API_URL=https://fabric.example.com/api\n'
    );
    vi.stubEnv('RAYFIN_PUBLIC_FUNCTIONS_URL', 'http://localhost:7314');

    const config = await runConfig(rayfinLocalDev(), { root });

    expect(proxyFrom(config).target).toBe('http://localhost:7314');
  });

  it('prefers an explicit runtime URL over the active dev session URL', async () => {
    vi.stubEnv('RAYFIN_PUBLIC_FUNCTIONS_URL', 'http://localhost:7314');

    const config = await runConfig(
      rayfinLocalDev({ functionsUrl: 'http://localhost:7420' })
    );

    expect(proxyFrom(config).target).toBe('http://localhost:7420');
  });

  it('preserves a runtime base path, request path, and query string', async () => {
    const config = await runConfig(
      rayfinLocalDev({ functionsUrl: 'https://localhost:7314/worker/root/' })
    );
    const proxy = proxyFrom(config);

    expect(proxy.target).toBe('https://localhost:7314');
    expect(proxy.rewrite?.('/.rayfin/api/hello?name=Ada')).toBe(
      '/worker/root/api/hello?name=Ada'
    );
  });

  it('defines auth posture even when local Functions are not configured', async () => {
    const root = await createProject(
      'services:\n  staticHosting:\n    assetAccess: protected\n'
    );

    const config = await runConfig(
      rayfinLocalDev({ apiUrl: 'http://localhost:5168' }),
      { root }
    );

    expect(config?.define?.__RAYFIN_LOCAL_FUNCTIONS_PROXY__).toBe('false');
    expect(config?.define?.__RAYFIN_LOCAL_STATIC_ACCESS__).toBe('"protected"');
    expect(config?.define?.__RAYFIN_LOCAL_AUTO_LOGIN__).toBe('true');
    expect(Object.keys(config?.server?.proxy ?? {})).toEqual([
      BACKEND_PROXY_CONTEXT_PATTERN,
    ]);
  });

  it('always enables automatic sign-in for protected sites', async () => {
    const root = await createProject(
      'services:\n  staticHosting:\n    assetAccess: protected\n'
    );

    const config = await runConfig(
      rayfinLocalDev({ apiUrl: 'http://localhost:5168' }),
      { root }
    );

    expect(config?.define?.__RAYFIN_LOCAL_AUTO_LOGIN__).toBe('true');
  });

  it('does not enable automatic sign-in for a protected site without a resolved backend URL', async () => {
    const root = await createProject(
      'services:\n  staticHosting:\n    assetAccess: protected\n'
    );

    const config = await runConfig(rayfinLocalDev(), { root });

    expect(config?.define?.__RAYFIN_LOCAL_AUTO_LOGIN__).toBe('false');
  });

  it('requires an explicit opt-in for public-site automatic sign-in', async () => {
    const root = await createProject(
      'services:\n  staticHosting:\n    assetAccess: public\n'
    );

    const defaultConfig = await runConfig(
      rayfinLocalDev({ apiUrl: 'http://localhost:5168' }),
      { root }
    );
    const optedInConfig = await runConfig(
      rayfinLocalDev({ autoLogin: true, apiUrl: 'http://localhost:5168' }),
      { root }
    );

    expect(defaultConfig?.define?.__RAYFIN_LOCAL_AUTO_LOGIN__).toBe('false');
    expect(optedInConfig?.define?.__RAYFIN_LOCAL_AUTO_LOGIN__).toBe('true');
  });

  it('keeps missing and malformed posture configuration inert', async () => {
    const missingRoot = await mkdtemp(join(tmpdir(), 'rayfin-local-dev-'));
    const malformedRoot = await createProject('services: [\n');
    tempDirs.push(missingRoot);

    for (const root of [missingRoot, malformedRoot]) {
      const config = await runConfig(rayfinLocalDev(), { root });
      expect(config?.define?.__RAYFIN_LOCAL_STATIC_ACCESS__).toBe('undefined');
      expect(config?.define?.__RAYFIN_LOCAL_AUTO_LOGIN__).toBe('false');
    }
  });

  it('does not define client routing for a development-mode build', async () => {
    const config = await resolveConfig(
      {
        configFile: false,
        plugins: [rayfinLocalDev({ functionsUrl: 'http://localhost:7314' })],
      },
      'build',
      'development'
    );

    expect(config.define?.__RAYFIN_LOCAL_FUNCTIONS_PROXY__).toBeUndefined();
  });

  it('rejects invalid runtime URLs during Vite configuration', async () => {
    await expect(
      runConfig(rayfinLocalDev({ functionsUrl: 'file:///tmp/functions' }))
    ).rejects.toThrow('Invalid local Rayfin Functions URL');
  });

  it('returns a closed local error when the runtime proxy fails', async () => {
    const config = await runConfig(
      rayfinLocalDev({ functionsUrl: 'http://localhost:7314' })
    );
    const proxy = proxyFrom(config);
    let errorHandler:
      | ((error: Error, request: object, response: TestResponse) => void)
      | undefined;
    const proxyServer = {
      on: vi.fn((event, handler) => {
        if (event === 'error') errorHandler = handler;
      }),
    };
    proxy.configure?.(proxyServer as never, proxy);
    const response: TestResponse = {
      statusCode: 0,
      headersSent: false,
      writableEnded: false,
      setHeader: vi.fn(),
      writeHead: vi.fn(),
      end: vi.fn(),
    };

    errorHandler?.(new Error('connection refused'), {}, response);

    expect(response.writeHead).toHaveBeenCalledWith(502, {
      'content-type': 'application/json',
    });
    expect(response.end).toHaveBeenCalledWith(
      JSON.stringify({
        error: 'The local Rayfin Functions host is unavailable.',
      })
    );
  });

  it('rejects cross-origin token requests', async () => {
    const handler = await tokenMiddleware(
      rayfinLocalDev({ autoLogin: true, apiUrl: 'http://localhost:5168' })
    );
    const response = createResponse();

    await handler(
      createRequest('127.0.0.1', {
        host: 'localhost:5173',
        origin: 'https://attacker.example',
      }),
      response
    );

    expect(response.statusCode).toBe(403);
    expect(response.end).toHaveBeenCalledWith(
      JSON.stringify({
        error: 'Cross-origin local sign-in requests are not allowed.',
      })
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-loopback token requests', async () => {
    const handler = await tokenMiddleware(
      rayfinLocalDev({ autoLogin: true, apiUrl: 'http://localhost:5168' })
    );
    const response = createResponse();

    await handler(
      createRequest('192.168.1.50', {
        host: 'localhost:5173',
        origin: 'http://localhost:5173',
      }),
      response
    );

    expect(response.statusCode).toBe(403);
    expect(response.end).toHaveBeenCalledWith(
      JSON.stringify({
        error: 'Local sign-in is only available from the Vite host.',
      })
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('acquires a delegated Entra token via the Rayfin CLI auth module and exchanges it for a Rayfin session', async () => {
    const handler = await tokenMiddleware(
      rayfinLocalDev({ autoLogin: true, apiUrl: 'http://localhost:5168' })
    );
    const response = createResponse();

    await handler(
      createRequest('127.0.0.1', {
        host: 'localhost:5173',
        origin: 'http://localhost:5173',
      }),
      response
    );

    expect(getAuthenticatedTokenMock).toHaveBeenCalledWith(
      ['https://analysis.windows.net/powerbi/api/Item.Execute.All'],
      { tenantId: undefined }
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:5168/api/auth/v1/brokered/token',
      expect.objectContaining({
        method: 'POST',
        headers: { authorization: `Bearer entra-token` },
      })
    );
    expect(response.statusCode).toBe(200);
    const [body] = response.end.mock.calls.at(-1) as [string];
    expect(JSON.parse(body)).toEqual({
      accessToken: 'rayfin-access-token',
      tokenType: 'Bearer',
      expiresIn: 3600,
    });
  });

  it('passes the configured tenant ID to the Rayfin CLI auth module', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rayfin-local-dev-'));
    tempDirs.push(root);
    await writeFile(
      join(root, '.env.local'),
      [
        'VITE_RAYFIN_API_URL=http://localhost:5168',
        'VITE_FABRIC_TENANT_ID=11111111-1111-1111-1111-111111111111',
      ].join('\n')
    );
    const handler = await tokenMiddleware(rayfinLocalDev({ autoLogin: true }), {
      root,
    });
    const response = createResponse();

    await handler(
      createRequest('127.0.0.1', {
        host: 'localhost:5173',
        origin: 'http://localhost:5173',
      }),
      response
    );

    expect(getAuthenticatedTokenMock).toHaveBeenCalledWith(
      ['https://analysis.windows.net/powerbi/api/Item.Execute.All'],
      { tenantId: '11111111-1111-1111-1111-111111111111' }
    );
  });

  it('includes the publishable key and workload moniker headers in the brokered exchange', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rayfin-local-dev-'));
    tempDirs.push(root);
    await writeFile(
      join(root, '.env.local'),
      [
        'VITE_RAYFIN_API_URL=http://localhost:5168',
        'VITE_RAYFIN_PUBLISHABLE_KEY=pk-test',
        'VITE_FABRIC_ITEM_ID=item-1',
      ].join('\n')
    );
    const handler = await tokenMiddleware(rayfinLocalDev({ autoLogin: true }), {
      root,
    });
    const response = createResponse();

    await handler(
      createRequest('127.0.0.1', {
        host: 'localhost:5173',
        origin: 'http://localhost:5173',
      }),
      response
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:5168/api/auth/v1/brokered/token',
      expect.objectContaining({
        headers: {
          authorization: `Bearer entra-token`,
          'X-Publishable-Key': 'pk-test',
          'x-ms-workload-resource-moniker': 'item-1',
        },
      })
    );
    expect(response.statusCode).toBe(200);
  });

  it('falls back to extracting a moniker from the API URL when no item ID is configured', async () => {
    const handler = await tokenMiddleware(
      rayfinLocalDev({
        autoLogin: true,
        apiUrl: 'https://fabric.example/12345678-90ab-cdef-1234-567890abcdef/',
      })
    );
    const response = createResponse();

    await handler(
      createRequest('127.0.0.1', {
        host: 'localhost:5173',
        origin: 'http://localhost:5173',
      }),
      response
    );

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-ms-workload-resource-moniker':
            '12345678-90ab-cdef-1234-567890abcdef',
        }),
      })
    );
    expect(response.statusCode).toBe(200);
  });

  it('reports an actionable error when the Rayfin CLI could not provide a token', async () => {
    getAuthenticatedTokenMock.mockRejectedValue(
      new Error('user declined the device code prompt')
    );
    const handler = await tokenMiddleware(
      rayfinLocalDev({ autoLogin: true, apiUrl: 'http://localhost:5168' })
    );
    const response = createResponse();

    await handler(
      createRequest('127.0.0.1', {
        host: 'localhost:5173',
        origin: 'http://localhost:5173',
      }),
      response
    );

    expect(response.statusCode).toBe(503);
    const [body] = response.end.mock.calls.at(-1) as [string];
    const parsed = JSON.parse(body);
    expect(parsed.error).toBe(
      'Could not sign you in automatically for local development.'
    );
    expect(parsed.hint).toContain('rayfin login');
    expect(parsed.hint).toContain('user declined the device code prompt');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('joins the brokered-token path onto a backend URL with an existing path', async () => {
    const handler = await tokenMiddleware(
      rayfinLocalDev({
        autoLogin: true,
        apiUrl: 'https://fabric.example/workload-root/',
      })
    );
    const response = createResponse();

    await handler(
      createRequest('127.0.0.1', {
        host: 'localhost:5173',
        origin: 'http://localhost:5173',
      }),
      response
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://fabric.example/workload-root/api/auth/v1/brokered/token',
      expect.anything()
    );
    expect(response.statusCode).toBe(200);
  });

  it('reports an actionable error when the backend rejects the brokered exchange', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 400 }));
    const handler = await tokenMiddleware(
      rayfinLocalDev({ autoLogin: true, apiUrl: 'http://localhost:5168' })
    );
    const response = createResponse();

    await handler(
      createRequest('127.0.0.1', {
        host: 'localhost:5173',
        origin: 'http://localhost:5173',
      }),
      response
    );

    expect(response.statusCode).toBe(502);
    const [body] = response.end.mock.calls.at(-1) as [string];
    const parsed = JSON.parse(body);
    expect(parsed.error).toBe('External Entra exchange is not enabled.');
    expect(parsed.hint).toContain('externalEntraExchange: true');
  });

  it('reports an actionable error when the backend exchange is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));
    const handler = await tokenMiddleware(
      rayfinLocalDev({ autoLogin: true, apiUrl: 'http://localhost:5168' })
    );
    const response = createResponse();

    await handler(
      createRequest('127.0.0.1', {
        host: 'localhost:5173',
        origin: 'http://localhost:5173',
      }),
      response
    );

    expect(response.statusCode).toBe(502);
    const [body] = response.end.mock.calls.at(-1) as [string];
    const parsed = JSON.parse(body);
    expect(parsed.error).toBe('Entra token exchange failed.');
  });

  it('proxies well-known backend routes when a local HTTP API URL resolves', async () => {
    const config = await runConfig(
      rayfinLocalDev({ apiUrl: 'http://localhost:5168/rayfin-root/' })
    );
    const proxy = proxyAt(config, BACKEND_PROXY_CONTEXT_PATTERN);
    const contextPattern = new RegExp(BACKEND_PROXY_CONTEXT_PATTERN);

    expect(proxy.target).toBe('http://localhost:5168');
    expect(contextPattern.test('/api/auth/v1/session')).toBe(true);
    expect(contextPattern.test('/graphql')).toBe(true);
    expect(contextPattern.test('/connector-invoke/foo')).toBe(true);
    expect(contextPattern.test('/connectors')).toBe(true);
    expect(contextPattern.test('/dashboard')).toBe(false);
    expect(proxy.rewrite?.('/api/auth/v1/session')).toBe(
      '/rayfin-root/api/auth/v1/session'
    );
  });

  it('proxies backend routes to an already-HTTPS local API URL', async () => {
    const config = await runConfig(
      rayfinLocalDev({ apiUrl: 'https://localhost:5168/rayfin-root/' })
    );
    const proxy = proxyAt(config, BACKEND_PROXY_CONTEXT_PATTERN);

    expect(proxy.target).toBe('https://localhost:5168');
  });

  it('proxies the default Functions invocation route when a Functions URL resolves', async () => {
    const config = await runConfig(
      rayfinLocalDev({
        functionsUrl: 'http://localhost:7314/worker/root/',
      })
    );
    const proxy = proxyAt(config, DEFAULT_FUNCTIONS_PROXY_CONTEXT_PATTERN);
    const contextPattern = new RegExp(DEFAULT_FUNCTIONS_PROXY_CONTEXT_PATTERN);

    expect(contextPattern.test('/functions/hello/invoke')).toBe(true);
    expect(contextPattern.test('/functions')).toBe(true);
    expect(contextPattern.test('/functionsomething')).toBe(false);
    expect(proxy.target).toBe('http://localhost:7314');
    expect(proxy.rewrite?.('/functions/hello/invoke')).toBe(
      '/worker/root/api/hello'
    );
  });

  it('does not proxy backend routes without a local API URL', async () => {
    const config = await runConfig(
      rayfinLocalDev({ functionsUrl: 'http://localhost:7314' })
    );

    expect(
      config?.server?.proxy?.[BACKEND_PROXY_CONTEXT_PATTERN]
    ).toBeUndefined();
    expect(
      config?.server?.proxy?.[DEFAULT_FUNCTIONS_PROXY_CONTEXT_PATTERN]
    ).toBeDefined();
  });

  it('serves a real rayfin.config.json computed from the request origin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rayfin-local-dev-'));
    tempDirs.push(root);
    await writeFile(
      join(root, '.env.local'),
      [
        'VITE_RAYFIN_API_URL=http://localhost:5168',
        'VITE_RAYFIN_PUBLISHABLE_KEY=pk-test',
        'VITE_FABRIC_WORKSPACE_ID=workspace-1',
        'VITE_FABRIC_ITEM_ID=item-1',
      ].join('\n')
    );
    const handler = await configJsonMiddleware(rayfinLocalDev(), { root });
    const response = createResponse();
    const next = vi.fn();

    handler(
      createRequest('127.0.0.1', { host: 'localhost:5173' }),
      response,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(response.setHeader).toHaveBeenCalledWith(
      'content-type',
      'application/json'
    );
    const [body] = response.end.mock.calls.at(-1) as [string];
    expect(JSON.parse(body)).toEqual({
      apiUrl: 'http://localhost:5173',
      publishableKey: 'pk-test',
      workspaceId: 'workspace-1',
      itemId: 'item-1',
    });
  });

  it('serves the dev-server origin as the API URL even when the real backend is HTTPS', async () => {
    const handler = await configJsonMiddleware(
      rayfinLocalDev({
        apiUrl: 'https://fabric-dev.example.com/workload-root',
      })
    );
    const response = createResponse();
    const next = vi.fn();

    handler(
      createRequest('127.0.0.1', { host: 'localhost:5173' }),
      response,
      next
    );

    expect(next).not.toHaveBeenCalled();
    const [body] = response.end.mock.calls.at(-1) as [string];
    expect(JSON.parse(body)).toEqual({
      apiUrl: 'http://localhost:5173',
    });
  });

  it('enables automatic local sign-in for a protected site regardless of the local API URL protocol', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rayfin-local-dev-'));
    tempDirs.push(root);
    await mkdir(join(root, 'rayfin'), { recursive: true });
    await writeFile(
      join(root, 'rayfin', 'rayfin.yml'),
      'services:\n  staticHosting:\n    assetAccess: protected\n'
    );

    const config = await runConfig(
      rayfinLocalDev({ apiUrl: 'http://localhost:5168' }),
      { root }
    );

    expect(config?.define?.['__RAYFIN_LOCAL_AUTO_LOGIN__']).toBe('true');
  });

  it('falls through to the SPA fallback when no local API URL resolves', async () => {
    const handler = await configJsonMiddleware(
      rayfinLocalDev({ functionsUrl: 'http://localhost:7314' })
    );
    const response = createResponse();
    const next = vi.fn();

    handler(
      createRequest('127.0.0.1', { host: 'localhost:5173' }),
      response,
      next
    );

    expect(next).toHaveBeenCalled();
    expect(response.end).not.toHaveBeenCalled();
  });
});

interface TestResponse {
  statusCode: number;
  headersSent: boolean;
  writableEnded: boolean;
  setHeader: ReturnType<typeof vi.fn>;
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

async function runConfig(
  plugin: Plugin,
  config: UserConfig = {}
): Promise<UserConfig | undefined> {
  const hook = plugin.config;
  if (typeof hook !== 'function') throw new Error('Missing Vite config hook');
  const env: ConfigEnv = {
    command: 'serve',
    mode: 'development',
    isSsrBuild: false,
    isPreview: false,
  };
  return (await hook.call({} as never, config, env)) ?? undefined;
}

function proxyFrom(config: UserConfig | undefined): ProxyOptions {
  const proxy = Object.values(config?.server?.proxy ?? {})[0];
  if (!proxy || typeof proxy === 'string') throw new Error('Missing proxy');
  return proxy;
}

const BACKEND_PROXY_CONTEXT_PATTERN =
  '^/(?:api|graphql|connector-invoke|connectors)(?:/|$)';
const DEFAULT_FUNCTIONS_PROXY_CONTEXT_PATTERN = '^/functions(?:/|$)';

function proxyAt(
  config: UserConfig | undefined,
  context: string
): ProxyOptions {
  const proxy = config?.server?.proxy?.[context];
  if (!proxy || typeof proxy === 'string') {
    throw new Error(`Missing proxy for ${context}`);
  }
  return proxy;
}

async function configJsonMiddleware(
  plugin: Plugin,
  config: UserConfig = {}
): Promise<(request: never, response: TestResponse, next: () => void) => void> {
  await runConfig(plugin, config);
  const hook = plugin.configureServer;
  if (typeof hook !== 'function') {
    throw new Error('Missing Vite configureServer hook');
  }

  let handler:
    | ((request: never, response: TestResponse, next: () => void) => void)
    | undefined;
  hook.call(
    {} as never,
    {
      middlewares: {
        use: vi.fn((path: string, middleware: never) => {
          if (path === '/rayfin.config.json' && !handler) {
            handler = middleware as never;
          }
        }),
      },
      config: { logger: { info: vi.fn() } },
    } as never
  );
  if (!handler) throw new Error('Missing rayfin.config.json middleware');
  return handler;
}

async function createProject(yaml: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rayfin-local-dev-'));
  tempDirs.push(root);
  const configDir = join(root, 'rayfin');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'rayfin.yml'), yaml);
  return root;
}

async function tokenMiddleware(
  plugin: Plugin,
  config: UserConfig = {}
): Promise<(request: never, response: TestResponse) => Promise<void>> {
  await runConfig(plugin, config);
  const hook = plugin.configureServer;
  if (typeof hook !== 'function') {
    throw new Error('Missing Vite configureServer hook');
  }

  let handler:
    | ((request: never, response: TestResponse) => Promise<void>)
    | undefined;
  hook.call(
    {} as never,
    {
      middlewares: {
        use: vi.fn((_path, middleware) => {
          handler = middleware;
        }),
      },
      config: { logger: { info: vi.fn() } },
    } as never
  );
  if (!handler) throw new Error('Missing token middleware');
  return handler;
}

function createRequest(
  remoteAddress: string,
  headers: Record<string, string>
): never {
  return {
    method: 'GET',
    headers,
    socket: { remoteAddress },
  } as never;
}

function createResponse(): TestResponse {
  return {
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    setHeader: vi.fn(),
    writeHead: vi.fn(),
    end: vi.fn(),
  };
}
