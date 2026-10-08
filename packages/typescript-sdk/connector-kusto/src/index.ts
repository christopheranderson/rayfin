export type {
  ExecuteCommandInput,
  ExecuteQueryInput,
  KustoColumn,
  KustoCommandResponse,
  KustoConnectorConfig,
  KustoQueryResponse,
  KustoTable,
  KustoV1Column,
  KustoV1Table,
} from './types';

export type { Kusto, KustoOperation, KustoOperationCatalog } from './marker';

export { kusto } from './runtime';

export { toQueryResult } from './queryResult';
export type {
  KustoCorrelation,
  KustoQueryError,
  KustoQueryResult,
} from './queryResult';
