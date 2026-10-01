/**
 * Smoke tests for the experimental `ConnectorsRayfinClient`.
 *
 * The connectors API is purely a Proxy facade on top of `apiClient` — these
 * tests just verify the subclass instantiates, exposes `connectors`, and
 * still forwards through `RayfinClient` (auth + functions remain available).
 */

import { describe, expect, it } from 'vitest';

import RayfinClient from '../../client';
import {
  ConnectorsRayfinClient,
  type ConnectorsRayfinClientConfig,
} from '../../experimental/ConnectorsRayfinClient';

const baseConfig = {
  baseUrl: 'https://example.invalid',
  publishableKey: 'pk-test-1234567890',
};

describe('ConnectorsRayfinClient', () => {
  it('exposes a `connectors` proxy alongside the inherited surface', () => {
    const client = new ConnectorsRayfinClient({
      ...baseConfig,
      connectors: {},
    });

    expect(client).toBeInstanceOf(ConnectorsRayfinClient);
    expect(client).toBeInstanceOf(RayfinClient);
    expect(client.connectors).toBeDefined();
    expect(typeof client.connectors).toBe('object');
    // Inherited from RayfinClient
    expect(client.auth).toBeDefined();
    expect(client.functions).toBeDefined();
    expect(client.data).toBeDefined();
  });

  it('returns a callable per-operation accessor for a configured Cat B connector', () => {
    const client = new ConnectorsRayfinClient({
      ...baseConfig,
      connectors: {
        salesModel: { connector: 'fabric-semanticmodel' },
      },
    });

    const connector = (
      client.connectors as unknown as Record<
        string,
        Record<string, (input: unknown) => Promise<unknown>>
      >
    ).salesModel;

    expect(connector).toBeDefined();
    expect(typeof connector.executeQuery).toBe('function');
  });

  it('operation proxy is not thenable — then/catch/finally return undefined', () => {
    const client = new ConnectorsRayfinClient({
      ...baseConfig,
      connectors: {
        salesModel: { connector: 'fabric-semanticmodel' },
      },
    });

    const connector = (
      client.connectors as unknown as Record<string, Record<string, unknown>>
    ).salesModel;

    // Ensures `await client.connectors.salesModel` does not fire a POST
    // with operation: 'then' (false thenable trap).
    expect((connector as any).then).toBeUndefined();
    expect((connector as any).catch).toBeUndefined();
    expect((connector as any).finally).toBeUndefined();
  });

  it('accepts the new `connectors?` config field without runtime error', () => {
    const config: ConnectorsRayfinClientConfig = {
      ...baseConfig,
      connectors: {
        salesModel: { connector: 'fabric-semanticmodel' },
        salesDb: { connector: 'fabric-sqldatabase' },
      },
    };
    const client = new ConnectorsRayfinClient(config);
    expect(client.connectors).toBeDefined();
  });
});

describe('Stable RayfinClient backward compatibility', () => {
  it('constructs without any connectors-related config', () => {
    const client = new RayfinClient(baseConfig);
    expect(client).toBeInstanceOf(RayfinClient);
    expect(client.data).toBeDefined();
    expect(client.functions).toBeDefined();
    expect(client.auth).toBeDefined();
  });

  it('does not expose a `connectors` property', () => {
    const client = new RayfinClient(baseConfig) as unknown as Record<
      string,
      unknown
    >;
    expect(client.connectors).toBeUndefined();
  });
});
