import type {
  ConnectorConfig,
  InvokeContext,
  InvokeNext,
} from '@microsoft/rayfin-connectors';
import { describe, expect, it, vi } from 'vitest';

import { kusto } from './runtime';
import type { KustoConnectorConfig } from './types';

/** The resolved connector config the CLI bakes into the generated schema.ts. */
const CONFIG: KustoConnectorConfig = {
  connector: 'kusto',
  queryServiceUri: 'https://resolved.kusto.fabric.microsoft.com',
  databaseName: 'ResolvedDb',
};

/**
 * Build an `InvokeContext` for the `executeQuery` operation with the given
 * caller `input` and (optionally) a bound connector config.
 */
function ctxFor(
  input: unknown,
  connectorConfig: ConnectorConfig | undefined = CONFIG
): InvokeContext {
  return {
    connectorName: 'telemetry',
    operation: 'executeQuery',
    input,
    host: { type: 'standalone' },
    connectorConfig,
  };
}

/**
 * Build an `InvokeContext` for the `executeCommand` (management) operation with
 * the given caller `input` and (optionally) a bound connector config.
 */
function commandCtxFor(
  input: unknown,
  connectorConfig: ConnectorConfig | undefined = CONFIG
): InvokeContext {
  return {
    connectorName: 'telemetry',
    operation: 'executeCommand',
    input,
    host: { type: 'standalone' },
    connectorConfig,
  };
}

describe('kusto() runtime middleware', () => {
  it('injects the resolved queryServiceUri + databaseName into the payload', async () => {
    const invoke = kusto().operations!.executeQuery!.invoke!;
    const next = vi.fn<InvokeNext>().mockResolvedValue('ok');

    await invoke(ctxFor({ query: 'StormEvents | count' }), next);

    expect(next).toHaveBeenCalledTimes(1);
    const forwarded = next.mock.calls[0]![0]!.input as Record<string, unknown>;
    expect(forwarded.query).toBe('StormEvents | count');
    expect(forwarded.queryServiceUri).toBe(
      'https://resolved.kusto.fabric.microsoft.com'
    );
    expect(forwarded.databaseName).toBe('ResolvedDb');
    // A correlation id is generated and forwarded so the connector function can
    // relay it as the x-ms-client-request-id header.
    expect(typeof forwarded.clientRequestId).toBe('string');
    expect(forwarded.clientRequestId as string).toMatch(
      /^KPC\.rayfin_kusto_v1;/
    );
  });

  it('preserves a caller-supplied clientRequestId', async () => {
    const invoke = kusto().operations!.executeQuery!.invoke!;
    const next = vi.fn<InvokeNext>().mockResolvedValue('ok');

    await invoke(
      ctxFor({ query: 'print 1', clientRequestId: 'caller-supplied-id' }),
      next
    );

    const forwarded = next.mock.calls[0]![0]!.input as Record<string, unknown>;
    expect(forwarded.clientRequestId).toBe('caller-supplied-id');
  });

  it('discards a caller-supplied queryServiceUri / databaseName (routing is connector-owned)', async () => {
    const invoke = kusto().operations!.executeQuery!.invoke!;
    const next = vi.fn<InvokeNext>().mockResolvedValue('ok');

    await invoke(
      ctxFor({
        query: 'StormEvents | count',
        queryServiceUri: 'https://evil.attacker.example.com',
        databaseName: 'EvilDb',
      }),
      next
    );

    const forwarded = next.mock.calls[0]![0]!.input as Record<string, unknown>;
    // The caller's spoofed endpoint must not survive into what BaaS receives.
    expect(forwarded.queryServiceUri).toBe(
      'https://resolved.kusto.fabric.microsoft.com'
    );
    expect(forwarded.databaseName).toBe('ResolvedDb');
    // The caller's actual query is preserved.
    expect(forwarded.query).toBe('StormEvents | count');
  });

  it('delegates the (rewritten) context to next and returns its result', async () => {
    const invoke = kusto().operations!.executeQuery!.invoke!;
    const next = vi.fn<InvokeNext>().mockResolvedValue({ status: 'Succeeded' });

    const result = await invoke(ctxFor({ query: 'print 1' }), next);

    expect(result).toEqual({ status: 'Succeeded' });
    // The connector name / operation pass through untouched; only input changes.
    expect(next.mock.calls[0]![0]!.operation).toBe('executeQuery');
    expect(next.mock.calls[0]![0]!.connectorName).toBe('telemetry');
  });

  it('degrades to no clientRequestId (never a weak PRNG) when Web Crypto is unavailable', async () => {
    const original = globalThis.crypto;
    // Simulate a runtime without Web Crypto (very old Node).
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
    });
    try {
      const invoke = kusto().operations!.executeQuery!.invoke!;
      const next = vi.fn<InvokeNext>().mockResolvedValue('ok');

      // Must not throw, and must not inject a (weak) generated id.
      await expect(invoke(ctxFor({ query: 'print 1' }), next)).resolves.toBe(
        'ok'
      );
      const forwarded = next.mock.calls[0]![0]!.input as Record<
        string,
        unknown
      >;
      expect('clientRequestId' in forwarded).toBe(false);
      // Routing is still applied.
      expect(forwarded.query).toBe('print 1');
      expect(forwarded.databaseName).toBe('ResolvedDb');
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: original,
        configurable: true,
      });
    }
  });

  it('injects the resolved routing into an executeCommand (management) payload', async () => {
    const invoke = kusto().operations!.executeCommand!.invoke!;
    const next = vi.fn<InvokeNext>().mockResolvedValue('ok');

    await invoke(commandCtxFor({ command: '.show databases' }), next);

    expect(next).toHaveBeenCalledTimes(1);
    const forwarded = next.mock.calls[0]![0]!.input as Record<string, unknown>;
    // Same connector-owned routing as executeQuery; only the caller field differs.
    expect(forwarded.command).toBe('.show databases');
    expect(forwarded.queryServiceUri).toBe(
      'https://resolved.kusto.fabric.microsoft.com'
    );
    expect(forwarded.databaseName).toBe('ResolvedDb');
    // A correlation id is generated for commands too, exactly as for queries.
    expect(typeof forwarded.clientRequestId).toBe('string');
    expect(forwarded.clientRequestId as string).toMatch(
      /^KPC\.rayfin_kusto_v1;/
    );
    expect(next.mock.calls[0]![0]!.operation).toBe('executeCommand');
  });

  it('discards a caller-supplied routing on executeCommand too', async () => {
    const invoke = kusto().operations!.executeCommand!.invoke!;
    const next = vi.fn<InvokeNext>().mockResolvedValue('ok');

    await invoke(
      commandCtxFor({
        command: '.drop table Foo',
        queryServiceUri: 'https://evil.attacker.example.com',
        databaseName: 'EvilDb',
      }),
      next
    );

    const forwarded = next.mock.calls[0]![0]!.input as Record<string, unknown>;
    expect(forwarded.queryServiceUri).toBe(
      'https://resolved.kusto.fabric.microsoft.com'
    );
    expect(forwarded.databaseName).toBe('ResolvedDb');
    expect(forwarded.command).toBe('.drop table Foo');
  });
});
