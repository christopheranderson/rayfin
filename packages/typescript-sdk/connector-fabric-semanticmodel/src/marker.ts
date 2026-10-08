/**
 * Typed marker for the `fabric-semanticmodel` connector
 * category. Contributes the operation catalog that the typed
 * `client.connectors.<name>` proxy uses to type its operations.
 */

import type {
  ConnectorMarker,
  OperationDef,
  TypedConnectorClient,
} from '@microsoft/rayfin-connectors';

import type { SemanticModelQueryResult } from './queryResult';
import type { ExecuteQueryInput } from './types';

/**
 * Union of all operation names this connector category supports.
 */
export type FabricSemanticModelOperation = 'executeQuery';

/**
 * The full catalog of typed operations for `fabric-semanticmodel`.
 *
 * `executeQuery` is typed as the normalised {@link SemanticModelQueryResult}
 * because the runtime's `invoke` middleware folds the wire envelope down before
 * returning. The declared output therefore describes what a caller actually
 * receives, on every transport.
 *
 * This holds for a client the runtime is registered on, which is how the
 * connector is meant to be mounted. A client constructed without it bypasses
 * the middleware entirely and yields the raw payload, in the same way it
 * already bypassed the decoding hook.
 */
export interface FabricSemanticModelOperationCatalog {
  executeQuery: OperationDef<ExecuteQueryInput, SemanticModelQueryResult>;
}

/**
 * Type marker for a `fabric-semanticmodel` connector instance.
 *
 * Pick which operations you want to expose via the union type parameter
 * (defaults to all of them).
 *
 * @example
 * ```ts
 * type AppConnectorsSchema = {
 *   salesModel: FabricSemanticModel<'executeQuery'>;
 * };
 * ```
 */
export type FabricSemanticModel<
  TOps extends FabricSemanticModelOperation = FabricSemanticModelOperation,
> = ConnectorMarker<
  TypedConnectorClient<Pick<FabricSemanticModelOperationCatalog, TOps>>
> & {
  /**
   * Diagnostic phantom — carries the operation catalog at the type level
   * so tools (e.g. typedoc, IDE hovers) can surface the connector's
   * operation surface without inferring through the resolved client type.
   * Not used by `TypedConnectorsApi`, which reads `__client` only.
   */
  readonly __operations?: Pick<FabricSemanticModelOperationCatalog, TOps>;
};
