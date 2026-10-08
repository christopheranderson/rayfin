/**
 * Runtime companion for the `kusto` connector marker.
 *
 * Connector markers are type-only, so the invoke-time behaviour for the
 * `executeQuery` and `executeCommand` operations is supplied here as a
 * {@link ConnectorRuntime}. Pass the result of {@link kusto} to
 * `ConnectorsRayfinClient` (or `createConnectorsApi`) under the same connector
 * name used in the typed schema so the connectors proxy injects the resolved
 * cluster routing into every outbound query or command.
 */

import type {
  ConnectorRuntime,
  InvokeContext,
  InvokeNext,
} from '@microsoft/rayfin-connectors';

import type { KustoConnectorConfig } from './types';

/**
 * Build the runtime hooks for a `kusto` connector instance.
 *
 * Registers an `invoke` middleware for `executeQuery` and `executeCommand` that
 * merges the connector's resolved `queryServiceUri` + `databaseName` (carried on
 * `InvokeContext.connectorConfig` as a {@link KustoConnectorConfig}) into
 * the outbound payload. The routing values are applied *after* the caller's
 * input, so a caller that tries to pass its own `queryServiceUri` /
 * `databaseName` cannot override the connector's resolved endpoint — those
 * fields are connector-owned, not caller-supplied. The caller's `query` /
 * `command` text is preserved. Query and management commands share one cluster
 * URI and database; only the endpoint (`/v1/rest/query` vs `/v1/rest/mgmt`) is
 * selected downstream (in the function bridge) from the operation name, so the
 * same routing injection serves both.
 *
 * @example
 * ```ts
 * import { ConnectorsRayfinClient } from '@microsoft/rayfin-client/experimental';
 * import { kusto, type Kusto } from '@microsoft/rayfin-connector-kusto';
 *
 * type AppConnectorsSchema = {
 *   telemetry: Kusto<'executeQuery'>;
 *   admin: Kusto<'executeQuery' | 'executeCommand'>;
 * };
 *
 * const client = new ConnectorsRayfinClient<
 *   DataSchema,
 *   FunctionsSchema,
 *   AppConnectorsSchema
 * >(config, { telemetry: kusto(), admin: kusto() });
 * ```
 *
 * @returns The connector runtime hooks for the Kusto connector.
 */
export function kusto(): ConnectorRuntime {
  // Both operations route to the same resolved cluster + database; the caller
  // only ever supplies the `query` / `command` text. Injecting the connector's
  // routing *after* the caller's input discards any caller-supplied
  // `queryServiceUri` / `databaseName` so the endpoint stays connector-owned.
  const injectRouting = (
    ctx: InvokeContext,
    next: InvokeNext
  ): Promise<unknown> => {
    const config = ctx.connectorConfig as KustoConnectorConfig | undefined;

    const input: Record<string, unknown> = {
      ...(ctx.input as Record<string, unknown> | undefined),
    };
    if (config?.queryServiceUri !== undefined) {
      input.queryServiceUri = config.queryServiceUri;
    }
    if (config?.databaseName !== undefined) {
      input.databaseName = config.databaseName;
    }

    // Generate a correlation id when the caller didn't supply one and
    // pass it in the payload. The connector function forwards it as the
    // `x-ms-client-request-id` header, so the id correlates the query
    // across services without ever appearing in the streamed response
    // body (the function is a pure byte pump). When no CSPRNG is
    // available the id is omitted rather than generated from a weak PRNG,
    // so the query still runs with empty (out-of-band) correlation.
    if (typeof input.clientRequestId !== 'string') {
      const generated = newClientRequestId();
      if (generated !== undefined) {
        input.clientRequestId = generated;
      }
    }

    return next({ ...ctx, input });
  };

  return {
    operations: {
      executeQuery: { invoke: injectRouting },
      executeCommand: { invoke: injectRouting },
    },
  };
}

/**
 * Build a Kusto client request id in the `KPC.rayfin_kusto_v1;<uuid>` shape the
 * connector function used to generate. Returns `undefined` when no CSPRNG is
 * available, so the caller can omit correlation rather than fall back to weak
 * randomness.
 */
function newClientRequestId(): string | undefined {
  const uuid = randomUuid();
  return uuid === undefined ? undefined : `KPC.rayfin_kusto_v1;${uuid}`;
}

/**
 * Generate a random UUID. Prefers `crypto.randomUUID` (browsers in a secure
 * context and modern Node); otherwise derives an RFC 4122 version 4 UUID from
 * `crypto.getRandomValues`. Both draw from the Web Crypto CSPRNG, so the id is
 * never produced by a weak, predictable PRNG (js/insecure-randomness). Returns
 * `undefined` when Web Crypto is entirely unavailable, so callers degrade to
 * empty correlation instead of throwing.
 */
function randomUuid(): string | undefined {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }
  if (typeof webCrypto?.getRandomValues !== 'function') {
    return undefined;
  }
  // `getRandomValues` is part of Web Crypto in every browser and in Node's
  // webcrypto, so the fallback stays cryptographically secure.
  const bytes = new Uint8Array(16);
  webCrypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
