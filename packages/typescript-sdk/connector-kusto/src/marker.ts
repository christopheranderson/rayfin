import type {
  ConnectorMarker,
  OperationDef,
  TypedConnectorClient,
} from '@microsoft/rayfin-connectors';

import type {
  ExecuteCommandInput,
  ExecuteQueryInput,
  KustoCommandResponse,
  KustoQueryResponse,
} from './types';

/**
 * Operation names supported by the `kusto` connector.
 *
 * - `executeQuery` — run a KQL query against `/v1/rest/query`.
 * - `executeCommand` — run a Kusto management command against `/v1/rest/mgmt`.
 */
export type KustoOperation = 'executeQuery' | 'executeCommand';

/**
 * Typed operation catalog for the `kusto` connector.
 */
export interface KustoOperationCatalog {
  executeQuery: OperationDef<ExecuteQueryInput, KustoQueryResponse>;
  executeCommand: OperationDef<ExecuteCommandInput, KustoCommandResponse>;
}

/**
 * Type marker for a Fabric Eventhouse (KQL Database) connector.
 *
 * @example
 * ```ts
 * type AppConnectorsSchema = {
 *   telemetry: Kusto<'executeQuery'>;
 *   admin: Kusto<'executeQuery' | 'executeCommand'>;
 * };
 * ```
 */
export type Kusto<TOps extends KustoOperation = KustoOperation> =
  ConnectorMarker<TypedConnectorClient<Pick<KustoOperationCatalog, TOps>>> & {
    /**
     * Carries the selected operation catalog at the type level.
     *
     * @internal
     */
    readonly __operations?: Pick<KustoOperationCatalog, TOps>;
  };
