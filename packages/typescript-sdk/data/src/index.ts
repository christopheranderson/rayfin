// Main exports
export { createDataApi, DataApi } from './client/DataApi';
export type { TypedDataClients } from './client/DataApi';

export { GraphQLClient } from './graphql/GraphQLClient';
export { GraphQLEntityClient } from './graphql/GraphQLEntityClient';
export { GraphQLQueryBuilder } from './graphql/GraphQLQueryBuilder';
export type {
  GroupedAggregationStage,
  RowQueryBuilder,
} from './graphql/GraphQLQueryBuilder';
export { GraphQLAggregationBuilder } from './graphql/GraphQLAggregationBuilder';
export { AggregationNotSupportedError } from './graphql/errors';

// DAB utilities
export { ResponseHandler } from './graphql/ResponseHandler';
// Low-level DAB wire helpers, re-exported so the connector-path entity client
// in `@microsoft/rayfin-connectors` can format `_by_pk` argument values and
// parse mutation responses with the exact same formatting as the data-path
// client, without reaching into internal module paths.
export { formatGraphQLValue } from './graphql/formatValue';
export { deserializeDabResponse } from './utils/serialization';

// Types and interfaces
export type { GraphQLRequest, GraphQLResponse } from './graphql/GraphQLClient';

export type {
  EntitySchema,
  CleanEntityKeys,
  NestedFieldPath,
  IsRelationship,
  RelationshipInput,
  PrimaryKeyOnly,
  MutationInput,
  CreateInput,
  UpdateInput,
  WhereUniqueInput,
  // DAB-compliant types
  FilterInput,
  FilterValue,
  RelationshipIsNullFilter,
  FieldFilterInput,
  FieldSelection,
  OrderByInput,
  PaginationConfig,
  PagedResult,
  StringFilterInput,
  NumberFilterInput,
  BooleanFilterInput,
  DateFilterInput,
  GenericFilterInput,
} from './graphql/types';

export type {
  ScalarKeys,
  NumericKeys,
  AggregationFieldOptions,
  AggregationOpValue,
  AggregationOps,
  AggregationOpName,
  AggregationEntry,
  AggregationSpec,
  AggregationResult,
  GroupedAggregationRow,
  ExactlyOne,
} from './graphql/aggregation-types';
