import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { RayfinClient, RayfinServerClient } from '../client';
import { resolveRayfinConfig } from '../config';

/**
 * `resolveRayfinConfig()` calls `loadRayfinConfig()` in the same module —
 * mocking `loadRayfinConfig` at the module boundary wouldn't affect that
 * internal call, so these tests stub `fetch` instead, the same way
 * `config.test.ts` does.
 */
const DEFAULT_CONFIG_PATH = '/rayfin.config.json';

function mockFetchSuccess(body: unknown) {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => 'application/json' },
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function mockFetchAbsent() {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: false,
    status: 404,
    statusText: 'Not Found',
  });
}

/**
 * The resolved `baseUrl` / `publishableKey` land on the private `ApiClient`.
 * TypeScript's `private` is compile-time only, so we read them through a cast
 * (the same seam the existing integration tests use for `apiClient.baseUrl`).
 */
type ApiClientPeek = { apiClient: { baseUrl: string; publishableKey: string } };
const peek = (client: unknown) =>
  (client as unknown as ApiClientPeek).apiClient;

const DEFAULTS = {
  apiUrl: 'https://options.example',
  publishableKey: 'pk-options',
};

/**
 * `resolveRayfinConfig()`'s return type has `baseUrl`/`publishableKey` as
 * optional (neither remote nor defaults are guaranteed to supply them), but
 * every test here always supplies both as defaults, so the resolve step can
 * only overlay on top of them. Assert that here once instead of at every
 * call site.
 */
function assertResolved<
  T extends { baseUrl?: string; publishableKey?: string },
>(resolved: T): T & { baseUrl: string; publishableKey: string } {
  return resolved as T & { baseUrl: string; publishableKey: string };
}

describe('resolveRayfinConfig + new RayfinClient — runtime config precedence', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('overlays baseUrl and publishableKey from the remote config, overriding defaults', async () => {
    mockFetchSuccess({
      apiUrl: 'https://remote.example/backend',
      publishableKey: 'pk-remote',
    });

    const resolved = await resolveRayfinConfig(DEFAULTS);
    const client = new RayfinClient({
      ...assertResolved(resolved),
      authStorage: false,
    });

    expect(peek(client).baseUrl).toBe('https://remote.example/backend/');
    expect(peek(client).publishableKey).toBe('pk-remote');
  });

  it('falls back to defaults when no remote config is present (null)', async () => {
    mockFetchAbsent();

    const resolved = await resolveRayfinConfig(DEFAULTS);
    const client = new RayfinClient({
      ...assertResolved(resolved),
      authStorage: false,
    });

    expect(peek(client).baseUrl).toBe('https://options.example');
    expect(peek(client).publishableKey).toBe('pk-options');
  });

  it('overlays apiUrl but keeps the defaults publishableKey when the remote omits it', async () => {
    mockFetchSuccess({
      apiUrl: 'https://remote.example/backend',
    });

    const resolved = await resolveRayfinConfig(DEFAULTS);
    const client = new RayfinClient({
      ...assertResolved(resolved),
      authStorage: false,
    });

    expect(peek(client).baseUrl).toBe('https://remote.example/backend/');
    expect(peek(client).publishableKey).toBe('pk-options');
  });

  it('throws MISSING_PUBLISHABLE_KEY when neither remote nor defaults supply a key', async () => {
    mockFetchSuccess({
      apiUrl: 'https://remote.example/backend',
    });

    const resolved = await resolveRayfinConfig({
      apiUrl: 'https://options.example',
    });

    expect(
      () =>
        new RayfinClient({ ...assertResolved(resolved), authStorage: false })
    ).toThrow('requires a publishableKey');
  });

  it('resolves runtimeConfig from the remote config, overriding the defaults per-field', async () => {
    mockFetchSuccess({
      apiUrl: 'https://remote.example/backend',
      publishableKey: 'pk-remote',
      workspaceId: 'remote-workspace',
      portalUrl: 'https://remote.fabric.example',
      tenantId: 'remote-tenant',
    });

    const resolved = await resolveRayfinConfig({
      ...DEFAULTS,
      workspaceId: 'fallback-workspace',
      itemId: 'fallback-item',
      portalUrl: 'https://fallback.fabric.example',
      tenantId: 'fallback-tenant',
    });
    const client = new RayfinClient({
      ...assertResolved(resolved),
      authStorage: false,
    });

    expect(client.runtimeConfig).toEqual({
      apiUrl: 'https://remote.example/backend/',
      publishableKey: 'pk-remote',
      workspaceId: 'remote-workspace',
      itemId: 'fallback-item',
      portalUrl: 'https://remote.fabric.example',
      tenantId: 'remote-tenant',
    });
  });

  it('leaves Fabric fields undefined when no defaults are given and the remote omits them', async () => {
    mockFetchSuccess({
      apiUrl: 'https://remote.example/backend',
      publishableKey: 'pk-remote',
    });

    const resolved = await resolveRayfinConfig(DEFAULTS);
    const client = new RayfinClient({
      ...assertResolved(resolved),
      authStorage: false,
    });

    expect(client.runtimeConfig).toEqual({
      apiUrl: 'https://remote.example/backend/',
      publishableKey: 'pk-remote',
      workspaceId: undefined,
      itemId: undefined,
      portalUrl: undefined,
      tenantId: undefined,
    });
  });

  it('falls back to the defaults when no remote config is present (null)', async () => {
    mockFetchAbsent();

    const resolved = await resolveRayfinConfig({
      ...DEFAULTS,
      workspaceId: 'fallback-workspace',
    });
    const client = new RayfinClient({
      ...assertResolved(resolved),
      authStorage: false,
    });

    expect(client.runtimeConfig).toEqual({
      apiUrl: 'https://options.example',
      publishableKey: 'pk-options',
      workspaceId: 'fallback-workspace',
      itemId: undefined,
      portalUrl: undefined,
      tenantId: undefined,
    });
  });

  it('skips remote loading entirely by not calling resolveRayfinConfig', () => {
    const client = new RayfinClient({
      baseUrl: DEFAULTS.apiUrl,
      publishableKey: DEFAULTS.publishableKey,
      runtimeConfig: { workspaceId: 'fallback-workspace' },
      authStorage: false,
    });

    expect(client.runtimeConfig).toEqual({ workspaceId: 'fallback-workspace' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('carries the tenantId default through even though no remote config supplies it', async () => {
    mockFetchSuccess({
      apiUrl: 'https://remote.example/backend',
      publishableKey: 'pk-remote',
    });

    const resolved = await resolveRayfinConfig({
      ...DEFAULTS,
      tenantId: 'fallback-tenant',
    });
    const client = new RayfinClient({
      ...assertResolved(resolved),
      authStorage: false,
    });

    expect(client.runtimeConfig?.tenantId).toBe('fallback-tenant');
  });
});

describe('resolveRayfinConfig + new RayfinServerClient — runtime config precedence', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('overlays baseUrl and publishableKey from the remote config, overriding defaults', async () => {
    mockFetchSuccess({
      apiUrl: 'https://remote.example/backend',
      publishableKey: 'pk-remote',
    });

    const resolved = await resolveRayfinConfig(DEFAULTS);
    const client = new RayfinServerClient({ ...assertResolved(resolved) });

    expect(peek(client).baseUrl).toBe('https://remote.example/backend/');
    expect(peek(client).publishableKey).toBe('pk-remote');
  });

  it('falls back to defaults when no remote config is present (null)', async () => {
    mockFetchAbsent();

    const resolved = await resolveRayfinConfig(DEFAULTS);
    const client = new RayfinServerClient({ ...assertResolved(resolved) });

    expect(peek(client).baseUrl).toBe('https://options.example');
    expect(peek(client).publishableKey).toBe('pk-options');
  });

  it('passes an absolute configUrl through to loadRayfinConfig for non-browser runtimes', async () => {
    mockFetchAbsent();
    const configUrl = 'https://api.example/rayfin.config.json';

    await resolveRayfinConfig(DEFAULTS, { configUrl });

    expect(globalThis.fetch).toHaveBeenCalledWith(configUrl);
  });

  it('calls loadRayfinConfig with no URL (default relative path) when configUrl is omitted', async () => {
    mockFetchAbsent();

    await resolveRayfinConfig(DEFAULTS);

    expect(globalThis.fetch).toHaveBeenCalledWith(DEFAULT_CONFIG_PATH);
  });

  it('resolves runtimeConfig from the remote config, overriding the defaults per-field', async () => {
    mockFetchSuccess({
      apiUrl: 'https://remote.example/backend',
      publishableKey: 'pk-remote',
      workspaceId: 'remote-workspace',
      portalUrl: 'https://remote.fabric.example',
      tenantId: 'remote-tenant',
    });

    const resolved = await resolveRayfinConfig({
      ...DEFAULTS,
      workspaceId: 'fallback-workspace',
      itemId: 'fallback-item',
      portalUrl: 'https://fallback.fabric.example',
      tenantId: 'fallback-tenant',
    });
    const client = new RayfinServerClient({ ...assertResolved(resolved) });

    expect(client.runtimeConfig).toEqual({
      apiUrl: 'https://remote.example/backend/',
      publishableKey: 'pk-remote',
      workspaceId: 'remote-workspace',
      itemId: 'fallback-item',
      portalUrl: 'https://remote.fabric.example',
      tenantId: 'remote-tenant',
    });
  });

  it('carries the defaults through when no remote config is present', async () => {
    mockFetchAbsent();

    const resolved = await resolveRayfinConfig({
      ...DEFAULTS,
      tenantId: 'fallback-tenant',
    });
    const client = new RayfinServerClient({ ...assertResolved(resolved) });

    expect(client.runtimeConfig?.tenantId).toBe('fallback-tenant');
  });
});
