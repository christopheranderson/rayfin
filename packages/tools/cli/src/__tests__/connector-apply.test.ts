import { existsSync, readFileSync } from 'node:fs';

import { CONNECTOR_CONFIG_SKIP_REASON } from '@microsoft/rayfin-tools-common/_internal/services/connectors';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Make the apply step deterministic and observable: we don't want the real
// fetch / file-IO heavy `applyConfigToServer` running in unit tests.
vi.mock('../utils/dab-apply', () => ({
  applyConfigToServer: vi.fn(),
}));
vi.mock('../services/connector-generator.js', () => ({
  generateConnectorDabConfigs: vi.fn(),
}));

// Run the real retry loop so `shouldRetry` is genuinely exercised, but with
// zero backoff so the deterministic-vs-transient behavior is validated without
// timer delays.
vi.mock('../utils/retry-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/retry-utils')>();
  return {
    ...actual,
    withRetry: (
      fn: Parameters<typeof actual.withRetry>[0],
      opts: Parameters<typeof actual.withRetry>[1]
    ) => actual.withRetry(fn, { ...opts, baseDelay: 0 }),
  };
});

import { MONIKER_HEADER } from '../config/constants';
import { createCliConnectorService } from '../rayfin-services/connectors.js';
import { generateConnectorDabConfigs } from '../services/connector-generator.js';
import {
  GRAPHQL_CONNECTOR_TYPES,
  applyConnectorConfigs,
  detectConnectorEntityCollisions,
  detectReservedConnectorEntityNames,
  formatConnectorEntityCollisionError,
  formatReservedConnectorEntityNameError,
  selectConnectorsToApply,
} from '../utils/connector-apply';
import { applyConfigToServer } from '../utils/dab-apply';
import type { OutputMode } from '../utils/output-mode';
import { HttpError } from '../utils/retry-utils';

const baseOptions = {
  itemEndpoint: 'https://api.example/workspaces/ws-1/appBackends/item-1',
  rayfinItemId: 'item-1',
  authorizationHeader: 'Bearer test',
  projectRoot: '/proj',
  // 'interactive' so modeLog/modeWarn route through console.* (spied below)
  // rather than stderr writes used by 'plain'.
  mode: 'interactive' as OutputMode,
  verbose: () => {},
};

describe('applyConnectorConfigs', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateConnectorDabConfigs).mockResolvedValue({
      results: [],
      generated: ['sales'],
    });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('returns empty outcome when no connectors are declared', async () => {
    const { results, steps } = await applyConnectorConfigs({
      ...baseOptions,
      connectors: undefined,
      context: 'inline',
    });
    expect(results).toEqual([]);
    expect(steps).toEqual({});
    expect(applyConfigToServer).not.toHaveBeenCalled();
  });

  it('skips non-GraphQL connectors without calling the server', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const { results } = await applyConnectorConfigs({
      ...baseOptions,
      connectors: [
        {
          name: 'analytics',
          type: 'fabric-semanticmodel',
          config: { workspaceId: 'ws', itemId: 'it' },
        },
      ],
      context: 'inline',
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      name: 'analytics',
      status: 'skipped',
      skipReason: CONNECTOR_CONFIG_SKIP_REASON.NonGraphQlConnector,
    });
    expect(applyConfigToServer).not.toHaveBeenCalled();
  });

  it('skips connectors whose generated DAB config is missing', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const { results } = await applyConnectorConfigs({
      ...baseOptions,
      connectors: [
        {
          name: 'sales',
          type: 'fabric-sqldatabase',
          config: { workspaceId: 'ws', itemId: 'it' },
        },
      ],
      context: 'inline',
    });

    expect(results[0]).toMatchObject({
      name: 'sales',
      status: 'skipped',
      skipReason: CONNECTOR_CONFIG_SKIP_REASON.MissingGeneratedConfig,
    });
    expect(applyConfigToServer).not.toHaveBeenCalled();
  });

  it('POSTs each GraphQL connector to its scoped applyconfig endpoint', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(applyConfigToServer).mockResolvedValue(undefined);

    const { results, steps } = await applyConnectorConfigs({
      ...baseOptions,
      connectors: [
        {
          name: 'sales',
          type: 'fabric-sqldatabase',
          config: { workspaceId: 'ws', itemId: 'it' },
        },
        {
          name: 'reporting',
          type: 'fabric-warehouse',
          config: { workspaceId: 'ws', itemId: 'it2' },
        },
      ],
      context: 'inline',
    });

    expect(results.map((r) => r.status)).toEqual(['success', 'success']);
    expect(steps['connector:sales']?.status).toBe('success');
    expect(steps['connector:reporting']?.status).toBe('success');

    expect(applyConfigToServer).toHaveBeenCalledTimes(2);
    expect(applyConfigToServer).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('dab-config.json'),
      `${baseOptions.itemEndpoint}/__private/connectors/sales/applyconfig`,
      false,
      true,
      'Bearer test',
      expect.objectContaining({ [MONIKER_HEADER]: 'item-1' }),
      'interactive',
      { diagnostics: undefined }
    );
  });

  it('routes the v2 connector service through the scoped applyconfig endpoint', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(applyConfigToServer).mockResolvedValue(undefined);

    const result = await createCliConnectorService().applyConfigs({
      projectRoot: '/proj',
      connectors: [
        {
          name: 'sales',
          type: 'fabric-sqldatabase',
          config: { workspaceId: 'ws', itemId: 'it' },
        },
      ],
      itemEndpoint: baseOptions.itemEndpoint,
      itemId: baseOptions.rayfinItemId,
      authorizationHeader: baseOptions.authorizationHeader,
    });

    expect(result.results).toEqual([
      expect.objectContaining({ name: 'sales', status: 'success' }),
    ]);
    expect(applyConfigToServer).toHaveBeenCalledWith(
      expect.stringContaining('dab-config.json'),
      `${baseOptions.itemEndpoint}/__private/connectors/sales/applyconfig`,
      false,
      true,
      'Bearer test',
      expect.objectContaining({ [MONIKER_HEADER]: 'item-1' }),
      'silent',
      { diagnostics: undefined }
    );
  });

  it('emits the "run rayfin up first" hint on UNKNOWN_CONNECTOR in standalone context', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(applyConfigToServer).mockRejectedValue(
      new Error('UNKNOWN_CONNECTOR: not declared')
    );

    const { results } = await applyConnectorConfigs({
      ...baseOptions,
      connectors: [
        {
          name: 'sales',
          type: 'fabric-sqldatabase',
          config: { workspaceId: 'ws', itemId: 'it' },
        },
      ],
      context: 'standalone',
    });

    expect(results[0].status).toBe('error');
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Run 'rayfin up' first")
    );
  });

  it('does NOT emit the hint on UNKNOWN_CONNECTOR in inline context', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(applyConfigToServer).mockRejectedValue(
      new Error('UNKNOWN_CONNECTOR: not declared')
    );

    const { results } = await applyConnectorConfigs({
      ...baseOptions,
      connectors: [
        {
          name: 'sales',
          type: 'fabric-sqldatabase',
          config: { workspaceId: 'ws', itemId: 'it' },
        },
      ],
      context: 'inline',
    });

    expect(results[0].status).toBe('error');
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Run 'rayfin up' first")
    );
  });

  it('respects connectorFilter to limit the apply set', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(applyConfigToServer).mockResolvedValue(undefined);

    const { results } = await applyConnectorConfigs({
      ...baseOptions,
      connectors: [
        {
          name: 'sales',
          type: 'fabric-sqldatabase',
          config: { workspaceId: 'ws', itemId: 'it1' },
        },
        {
          name: 'reporting',
          type: 'fabric-warehouse',
          config: { workspaceId: 'ws', itemId: 'it2' },
        },
      ],
      connectorFilter: 'sales',
      context: 'standalone',
    });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('sales');
    expect(applyConfigToServer).toHaveBeenCalledTimes(1);
  });

  it('fails fast on a deterministic HTTP 400 apply error without retrying', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(applyConfigToServer).mockRejectedValue(
      new HttpError('DAB server responded with error: 400 Bad Request', 400)
    );

    const { results } = await applyConnectorConfigs({
      ...baseOptions,
      connectors: [
        {
          name: 'sales',
          type: 'fabric-sqldatabase',
          config: { workspaceId: 'ws', itemId: 'it' },
        },
      ],
      context: 'inline',
    });

    expect(results[0].status).toBe('error');
    // Deterministic 4xx must not be retried — exactly one attempt.
    expect(applyConfigToServer).toHaveBeenCalledTimes(1);
  });

  it('retries transient HTTP 503 apply errors before succeeding', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(applyConfigToServer)
      .mockRejectedValueOnce(
        new HttpError('DAB server responded with error: 503', 503)
      )
      .mockRejectedValueOnce(
        new HttpError('DAB server responded with error: 503', 503)
      )
      .mockResolvedValueOnce(undefined);

    const { results } = await applyConnectorConfigs({
      ...baseOptions,
      connectors: [
        {
          name: 'sales',
          type: 'fabric-sqldatabase',
          config: { workspaceId: 'ws', itemId: 'it' },
        },
      ],
      context: 'inline',
    });

    expect(results[0].status).toBe('success');
    // Transient 5xx is retried: two failures then success.
    expect(applyConfigToServer).toHaveBeenCalledTimes(3);
  });

  it('retries transient HTTP 429 apply errors', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(applyConfigToServer)
      .mockRejectedValueOnce(
        new HttpError('DAB server responded with error: 429', 429)
      )
      .mockResolvedValueOnce(undefined);

    const { results } = await applyConnectorConfigs({
      ...baseOptions,
      connectors: [
        {
          name: 'sales',
          type: 'fabric-sqldatabase',
          config: { workspaceId: 'ws', itemId: 'it' },
        },
      ],
      context: 'inline',
    });

    expect(results[0].status).toBe('success');
    // 408, 425, and 429 are the transient 4xx — they are retried, not failed fast.
    expect(applyConfigToServer).toHaveBeenCalledTimes(2);
  });

  it('exposes a GraphQL connector allow-list derived from the catalog', () => {
    // Catalog-driven: every connector with a non-null dialect is treated as
    // GraphQL-capable. The current catalog has fabric-sqldatabase, fabric-sqlanalytics
    // and fabric-warehouse with dialects; fabric-semanticmodel is null.
    expect([...GRAPHQL_CONNECTOR_TYPES].sort()).toEqual(
      ['fabric-sqldatabase', 'fabric-sqlanalytics', 'fabric-warehouse'].sort()
    );
    expect(GRAPHQL_CONNECTOR_TYPES).not.toContain('fabric-semanticmodel');
  });
});

describe('detectConnectorEntityCollisions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const configFor = (entityNames: string[]) =>
    JSON.stringify({
      entities: Object.fromEntries(entityNames.map((n) => [n, {}])),
    });

  it('ignores stale configs outside the current apply set', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation((path) => {
      const configPath = String(path);
      return configPath.includes('current')
        ? configFor(['CurrentEntity'])
        : configFor(['StaleCollision']);
    });
    const connectors = ['stale-a', 'stale-b', 'current'].map((name) => ({
      name,
      type: 'fabric-sqldatabase' as const,
      config: { workspaceId: 'ws', itemId: name },
    }));
    const connectorsToApply = selectConnectorsToApply(connectors, ['current']);

    const collisions = detectConnectorEntityCollisions(
      '/proj',
      connectorsToApply.map((entry) => entry.name)
    );

    expect(collisions).toEqual([]);
    expect(readFileSync).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(readFileSync).mock.calls[0][0])).toContain(
      'current'
    );
  });

  it('returns no collisions when every entity name is unique', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation((path) =>
      String(path).includes('sales')
        ? configFor(['Order', 'Customer'])
        : configFor(['Product'])
    );

    const collisions = detectConnectorEntityCollisions('/proj', [
      'sales',
      'catalog',
    ]);

    expect(collisions).toEqual([]);
  });

  it('reports an entity name declared by two connectors', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation((path) =>
      String(path).includes('sales')
        ? configFor(['Product', 'Order'])
        : configFor(['Product'])
    );

    const collisions = detectConnectorEntityCollisions('/proj', [
      'sales',
      'catalog',
    ]);

    expect(collisions).toEqual([
      { entityName: 'Product', connectors: ['catalog', 'sales'] },
    ]);
  });

  it('skips connectors without a generated config on disk', () => {
    vi.mocked(existsSync).mockImplementation((path) =>
      String(path).includes('sales')
    );
    vi.mocked(readFileSync).mockReturnValue(configFor(['Product']));

    const collisions = detectConnectorEntityCollisions('/proj', [
      'sales',
      'catalog',
    ]);

    expect(collisions).toEqual([]);
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });

  it('ignores malformed config files', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation((path) =>
      String(path).includes('sales') ? '{ not json' : configFor(['Product'])
    );

    const collisions = detectConnectorEntityCollisions('/proj', [
      'sales',
      'catalog',
    ]);

    expect(collisions).toEqual([]);
  });

  it('formats a readable, multi-line collision error message', () => {
    const message = formatConnectorEntityCollisionError([
      { entityName: 'Product', connectors: ['catalog', 'sales'] },
    ]);

    expect(message).toContain('Duplicate GraphQL type names');
    expect(message).toContain(
      '• "Product" is declared by connectors: catalog, sales'
    );
    expect(message).toContain('Rename the entity');
  });
});

describe('detectReservedConnectorEntityNames', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const configFor = (entityNames: string[]) =>
    JSON.stringify({
      entities: Object.fromEntries(entityNames.map((n) => [n, {}])),
    });

  it('returns nothing when no entity uses a reserved name', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      configFor(['Order', 'TaskDate', 'DateRange'])
    );

    expect(detectReservedConnectorEntityNames('/proj', ['sales'])).toEqual([]);
  });

  it('reports built-in scalar, root type, and introspection names', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation((path) =>
      String(path).includes('sales')
        ? configFor(['Date', 'Order'])
        : configFor(['Date', 'Query', '__Meta'])
    );

    expect(
      detectReservedConnectorEntityNames('/proj', ['sales', 'catalog'])
    ).toEqual([
      { entityName: '__Meta', connectors: ['catalog'] },
      { entityName: 'Date', connectors: ['catalog', 'sales'] },
      { entityName: 'Query', connectors: ['catalog'] },
    ]);
  });

  it('skips connectors without a generated config on disk', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    expect(detectReservedConnectorEntityNames('/proj', ['sales'])).toEqual([]);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('formats a readable, multi-line reserved-name error message', () => {
    const message = formatReservedConnectorEntityNameError([
      { entityName: 'Date', connectors: ['catalog', 'sales'] },
    ]);

    expect(message).toContain('Reserved GraphQL type names');
    expect(message).toContain(
      "Entity name 'Date' is a built-in GraphQL scalar"
    );
    expect(message).toContain('declared by: catalog, sales');
    expect(message).toContain('Reserved names:');
  });

  it('indents every line below the header by three spaces (CLI UX R3)', () => {
    const message = formatReservedConnectorEntityNameError([
      { entityName: 'Date', connectors: ['catalog'] },
    ]);
    const [header, ...rest] = message.split('\n');

    expect(header).toBe(
      'Reserved GraphQL type names detected in connector entities:'
    );
    for (const line of rest.filter((l) => l.length > 0)) {
      expect(line.startsWith('   ')).toBe(true);
    }
  });
});
