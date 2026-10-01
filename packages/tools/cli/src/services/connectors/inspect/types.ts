/**
 * Normalized SQL-family vocabulary emitted by `connector inspect`.
 *
 * Semantic-model `connector invoke` results use a separate Power BI/Arrow
 * `dataType` vocabulary from `resolveDataType` in
 * `packages/typescript-sdk/connector-fabric-semanticmodel/src/arrow.ts`.
 * The two output contracts are deliberately not unified yet.
 */
export type ConnectorInspectColumnType =
  | 'integer'
  | 'decimal'
  | 'floating-point'
  | 'text'
  | 'boolean'
  | 'date'
  | 'time'
  | 'datetime'
  | 'uniqueidentifier'
  | 'binary'
  | 'unknown';

export interface ConnectorInspectColumn {
  name: string;
  type: ConnectorInspectColumnType;
}
