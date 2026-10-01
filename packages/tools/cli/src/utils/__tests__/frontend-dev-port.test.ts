import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { PortRangeExhaustedError } from '../docker-utils.js';
import { readEnvMap, upsertEnvVariables } from '../env-file-utils.js';
import {
  appendLocalDevRedirectUris,
  DEFAULT_FRONTEND_DEV_PORT,
  ensureFrontendDevPort,
  ensureLocalDevRedirectUris,
  FRONTEND_DEV_PORT_ENV_VAR,
  localDevRedirectUrisForPort,
  resolveFrontendDevPort,
  RETAINED_FRONTEND_DEV_PORTS_ENV_VAR,
} from '../frontend-dev-port.js';

const findAvailablePort =
  vi.fn<
    (
      start: number,
      reservedPorts?: Set<number>,
      maxAttempts?: number
    ) => Promise<number>
  >();
const checkPortAvailability = vi.fn<(port: number) => Promise<boolean>>();
const findAvailableEphemeralPort =
  vi.fn<(reservedPorts?: Set<number>) => Promise<number>>();

vi.mock('../docker-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../docker-utils.js')>()),
  checkPortAvailability: (port: number) => checkPortAvailability(port),
  findAvailableEphemeralPort: (reservedPorts?: Set<number>) =>
    findAvailableEphemeralPort(reservedPorts),
  findAvailablePort: (
    ...args: [start: number, reservedPorts?: Set<number>, maxAttempts?: number]
  ) => findAvailablePort(...args),
}));

describe('localDevRedirectUrisForPort', () => {
  it('returns localhost and 127.0.0.1 origins for the port', () => {
    expect(localDevRedirectUrisForPort(5176)).toEqual([
      'http://localhost:5176',
      'http://127.0.0.1:5176',
    ]);
  });
});

describe('ensureFrontendDevPort', () => {
  let testDir: string;
  let rayfinDir: string;

  beforeEach(async () => {
    findAvailablePort.mockReset();
    findAvailablePort.mockImplementation(async (start) => start);
    checkPortAvailability.mockReset();
    checkPortAvailability.mockResolvedValue(false);
    findAvailableEphemeralPort.mockReset();
    findAvailableEphemeralPort.mockResolvedValue(55000);
    testDir = join(tmpdir(), `rayfin-frontend-port-${randomUUID()}`);
    rayfinDir = join(testDir, 'rayfin');
    await mkdir(rayfinDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('allocates and persists a port on first use', async () => {
    findAvailablePort.mockResolvedValue(5177);

    const port = await ensureFrontendDevPort(rayfinDir);

    expect(port).toBe(5177);
    expect(findAvailablePort).toHaveBeenCalledWith(
      DEFAULT_FRONTEND_DEV_PORT,
      undefined,
      100
    );
    const env = await readEnvMap(rayfinDir);
    expect(env.get(FRONTEND_DEV_PORT_ENV_VAR)).toBe('5177');
  });

  it('reuses an already-assigned port when it remains available', async () => {
    await upsertEnvVariables(rayfinDir, [
      { key: FRONTEND_DEV_PORT_ENV_VAR, value: '5179' },
    ]);

    const port = await ensureFrontendDevPort(rayfinDir);

    expect(port).toBe(5179);
    expect(findAvailablePort).toHaveBeenCalledWith(5179, undefined, 100);
  });

  it('replaces an occupied persisted port with the next available port', async () => {
    await upsertEnvVariables(rayfinDir, [
      { key: FRONTEND_DEV_PORT_ENV_VAR, value: '5179' },
    ]);
    findAvailablePort.mockResolvedValue(5180);

    const port = await ensureFrontendDevPort(rayfinDir);

    expect(port).toBe(5180);
    expect(findAvailablePort).toHaveBeenCalledWith(5179, undefined, 100);
    const env = await readEnvMap(rayfinDir);
    expect(env.get(FRONTEND_DEV_PORT_ENV_VAR)).toBe('5180');
  });

  it.each([5168, 5432, 7071, 9229])(
    'skips sibling runtime port %i without retaining it as a redirect alias',
    async (persistedPort) => {
      await upsertEnvVariables(rayfinDir, [
        {
          key: FRONTEND_DEV_PORT_ENV_VAR,
          value: String(persistedPort),
        },
      ]);
      const reservedPorts = new Set([persistedPort]);
      findAvailablePort.mockImplementationOnce(async (_start, reserved) => {
        const replacement = persistedPort + 1;
        reserved?.add(replacement);
        return replacement;
      });

      const resolution = await resolveFrontendDevPort(rayfinDir, reservedPorts);

      expect(resolution).toEqual({
        port: persistedPort + 1,
        redirectPorts: [persistedPort + 1],
      });
      expect(findAvailablePort).toHaveBeenCalledWith(
        persistedPort,
        reservedPorts,
        100
      );
      expect(reservedPorts).toEqual(
        new Set([persistedPort, persistedPort + 1])
      );
      const env = await readEnvMap(rayfinDir);
      expect(env.get(RETAINED_FRONTEND_DEV_PORTS_ENV_VAR)).toBeUndefined();
    }
  );

  it('retains an occupied prior port for redirects until it becomes available', async () => {
    await upsertEnvVariables(rayfinDir, [
      { key: FRONTEND_DEV_PORT_ENV_VAR, value: '5179' },
    ]);
    findAvailablePort.mockResolvedValueOnce(5180);

    const replaced = await resolveFrontendDevPort(rayfinDir);

    expect(replaced).toEqual({ port: 5180, redirectPorts: [5180, 5179] });
    let env = await readEnvMap(rayfinDir);
    expect(env.get(RETAINED_FRONTEND_DEV_PORTS_ENV_VAR)).toBe('5179');

    findAvailablePort.mockImplementation(async (start) => start);
    const retained = await resolveFrontendDevPort(rayfinDir);

    expect(retained).toEqual({ port: 5180, redirectPorts: [5180, 5179] });

    checkPortAvailability.mockResolvedValue(true);
    const pruned = await resolveFrontendDevPort(rayfinDir);

    expect(pruned).toEqual({ port: 5180, redirectPorts: [5180] });
    env = await readEnvMap(rayfinDir);
    expect(env.get(RETAINED_FRONTEND_DEV_PORTS_ENV_VAR)).toBe('');
  });

  it('re-allocates when the persisted value is not a valid port', async () => {
    await upsertEnvVariables(rayfinDir, [
      { key: FRONTEND_DEV_PORT_ENV_VAR, value: 'not-a-port' },
    ]);
    findAvailablePort.mockResolvedValue(5180);

    const port = await ensureFrontendDevPort(rayfinDir);

    expect(port).toBe(5180);
    expect(findAvailablePort).toHaveBeenCalledOnce();
  });

  it.each(['0x1000', '1e4', '5173abc', ' 5173 '])(
    'rejects non-decimal persisted port format %s',
    async (persistedPort) => {
      await upsertEnvVariables(rayfinDir, [
        { key: FRONTEND_DEV_PORT_ENV_VAR, value: persistedPort },
      ]);
      findAvailablePort.mockResolvedValue(5180);

      await ensureFrontendDevPort(rayfinDir);

      expect(findAvailablePort).toHaveBeenCalledWith(
        DEFAULT_FRONTEND_DEV_PORT,
        undefined,
        100
      );
    }
  );

  it('wraps to the default range when no higher valid port is available', async () => {
    await upsertEnvVariables(rayfinDir, [
      { key: FRONTEND_DEV_PORT_ENV_VAR, value: '65535' },
    ]);
    findAvailablePort
      .mockRejectedValueOnce(new PortRangeExhaustedError(65535, 1))
      .mockResolvedValueOnce(DEFAULT_FRONTEND_DEV_PORT);

    const port = await ensureFrontendDevPort(rayfinDir);

    expect(port).toBe(DEFAULT_FRONTEND_DEV_PORT);
    expect(findAvailablePort).toHaveBeenNthCalledWith(1, 65535, undefined, 1);
    expect(findAvailablePort).toHaveBeenNthCalledWith(
      2,
      DEFAULT_FRONTEND_DEV_PORT,
      undefined,
      100
    );
  });

  it('uses an OS-assigned port when both deterministic ranges are full', async () => {
    await upsertEnvVariables(rayfinDir, [
      { key: FRONTEND_DEV_PORT_ENV_VAR, value: '6000' },
    ]);
    findAvailablePort.mockImplementation(
      (start, _reserved, maxAttempts = 100) =>
        Promise.reject(new PortRangeExhaustedError(start, maxAttempts))
    );

    const port = await ensureFrontendDevPort(rayfinDir);

    expect(port).toBe(55000);
    expect(findAvailableEphemeralPort).toHaveBeenCalledWith(undefined);
  });

  it('does not replace or retain a persisted port after an indeterminate probe failure', async () => {
    await upsertEnvVariables(rayfinDir, [
      { key: FRONTEND_DEV_PORT_ENV_VAR, value: '5179' },
    ]);
    const probeError = new Error('socket resources exhausted');
    findAvailablePort.mockRejectedValueOnce(probeError);

    await expect(resolveFrontendDevPort(rayfinDir)).rejects.toBe(probeError);

    expect(findAvailablePort).toHaveBeenCalledOnce();
    expect(findAvailableEphemeralPort).not.toHaveBeenCalled();
    const env = await readEnvMap(rayfinDir);
    expect(env.get(FRONTEND_DEV_PORT_ENV_VAR)).toBe('5179');
    expect(env.get(RETAINED_FRONTEND_DEV_PORTS_ENV_VAR)).toBeUndefined();
  });
});

describe('appendLocalDevRedirectUris', () => {
  let testDir: string;
  let rayfinDir: string;

  beforeEach(async () => {
    findAvailablePort.mockReset();
    findAvailablePort.mockImplementation(async (start) => start);
    testDir = join(tmpdir(), `rayfin-frontend-append-${randomUUID()}`);
    rayfinDir = join(testDir, 'rayfin');
    await mkdir(rayfinDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  const servicesWithAuth = (
    allowedRedirectUris?: string[]
  ): RayfinConfig['services'] =>
    ({
      auth: {
        enabled: true,
        ...(allowedRedirectUris && { allowedRedirectUris }),
      },
      data: { enabled: true },
    }) as unknown as RayfinConfig['services'];

  it('appends both loopback origins for a replacement port', async () => {
    await upsertEnvVariables(rayfinDir, [
      { key: FRONTEND_DEV_PORT_ENV_VAR, value: '5181' },
    ]);
    findAvailablePort.mockResolvedValue(5182);

    const result = await appendLocalDevRedirectUris(
      servicesWithAuth(),
      rayfinDir
    );

    expect(result.auth?.allowedRedirectUris).toEqual([
      'http://localhost:5182',
      'http://127.0.0.1:5182',
      'http://localhost:5181',
      'http://127.0.0.1:5181',
    ]);
    expect(findAvailablePort).toHaveBeenCalledWith(5181, undefined, 100);
    const env = await readEnvMap(rayfinDir);
    expect(env.get(FRONTEND_DEV_PORT_ENV_VAR)).toBe('5182');
  });

  it('preserves existing redirect URIs and does not mutate the input', async () => {
    await upsertEnvVariables(rayfinDir, [
      { key: FRONTEND_DEV_PORT_ENV_VAR, value: '5182' },
    ]);
    const services = servicesWithAuth(['http://localhost:5173']);

    const result = await appendLocalDevRedirectUris(services, rayfinDir);

    expect(result.auth?.allowedRedirectUris).toEqual([
      'http://localhost:5173',
      'http://localhost:5182',
      'http://127.0.0.1:5182',
    ]);
    // Input is left untouched (non-mutating, matching addAllowedRedirectUri).
    expect(services.auth?.allowedRedirectUris).toEqual([
      'http://localhost:5173',
    ]);
  });

  it('allocates a port when none is persisted yet', async () => {
    findAvailablePort.mockResolvedValue(5183);

    const result = await appendLocalDevRedirectUris(
      servicesWithAuth(),
      rayfinDir
    );

    expect(findAvailablePort).toHaveBeenCalledWith(
      DEFAULT_FRONTEND_DEV_PORT,
      undefined,
      100
    );
    expect(result.auth?.allowedRedirectUris).toEqual([
      'http://localhost:5183',
      'http://127.0.0.1:5183',
    ]);
    const env = await readEnvMap(rayfinDir);
    expect(env.get(FRONTEND_DEV_PORT_ENV_VAR)).toBe('5183');
  });
});

describe('ensureLocalDevRedirectUris', () => {
  let testDir: string;
  let rayfinDir: string;

  beforeEach(async () => {
    findAvailablePort.mockReset();
    findAvailablePort.mockImplementation(async (start) => start);
    testDir = join(tmpdir(), `rayfin-frontend-gate-${randomUUID()}`);
    rayfinDir = join(testDir, 'rayfin');
    await mkdir(rayfinDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  const servicesWith = (
    auth: { enabled: boolean; allowedRedirectUris?: string[] } | undefined
  ): RayfinConfig['services'] =>
    ({
      ...(auth && { auth }),
      data: { enabled: true },
    }) as unknown as RayfinConfig['services'];

  it('appends local dev origins when auth is enabled', async () => {
    await upsertEnvVariables(rayfinDir, [
      { key: FRONTEND_DEV_PORT_ENV_VAR, value: '5184' },
    ]);

    const result = await ensureLocalDevRedirectUris(
      servicesWith({ enabled: true }),
      rayfinDir
    );

    expect(result.auth?.allowedRedirectUris).toEqual([
      'http://localhost:5184',
      'http://127.0.0.1:5184',
    ]);
  });

  it('resolves the port but returns services unchanged when auth is disabled', async () => {
    const services = servicesWith({ enabled: false });
    await upsertEnvVariables(rayfinDir, [
      { key: FRONTEND_DEV_PORT_ENV_VAR, value: '5185' },
    ]);
    findAvailablePort.mockResolvedValue(5186);

    const result = await ensureLocalDevRedirectUris(services, rayfinDir);

    expect(result).toBe(services);
    expect(result.auth?.allowedRedirectUris).toBeUndefined();
    expect(findAvailablePort).toHaveBeenCalledWith(5185, undefined, 100);
    const env = await readEnvMap(rayfinDir);
    expect(env.get(FRONTEND_DEV_PORT_ENV_VAR)).toBe('5186');
  });

  it('resolves the port but returns services unchanged without an auth block', async () => {
    const services = servicesWith(undefined);

    const result = await ensureLocalDevRedirectUris(services, rayfinDir);

    expect(result).toBe(services);
    expect(findAvailablePort).toHaveBeenCalledWith(
      DEFAULT_FRONTEND_DEV_PORT,
      undefined,
      100
    );
  });

  it('is non-fatal: reports the error and returns the original services on failure', async () => {
    // No persisted port, and allocation fails — the gate must swallow the
    // error so deployment can proceed.
    findAvailablePort.mockImplementation(
      (start, _reserved, maxAttempts = 100) =>
        Promise.reject(new PortRangeExhaustedError(start, maxAttempts))
    );
    findAvailableEphemeralPort.mockRejectedValue(
      new Error('no ephemeral port')
    );
    const services = servicesWith({ enabled: true });
    const onError = vi.fn();

    const result = await ensureLocalDevRedirectUris(
      services,
      rayfinDir,
      onError
    );

    expect(result).toBe(services);
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining(FRONTEND_DEV_PORT_ENV_VAR)
    );
  });
});
