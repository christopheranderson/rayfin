/**
 * Dialect configuration for static analysis.
 *
 * - `DatabaseDialect`: legal values for `services.data.dialect` (data path).
 * - `ConnectorDialect`: analyzer-only flavors for connector schema validation;
 *   never written to `services.data.dialect`.
 */

import { isMinorFixesOn } from './feature-gate.js';

/** Data-path dialects. Mirrors DatabaseDialects in Microsoft.Rayfin.Common.
 * Supported database dialects for Rayfin Data API.
 */
/** @internal */
export const DatabaseDialect = {
  MsSql: 'mssql',
  PostgreSql: 'postgresql',
} as const;

/** @internal */
export type Dialect = (typeof DatabaseDialect)[keyof typeof DatabaseDialect];

/**
 * Connector-only analyzer dialects. Kept separate from `DatabaseDialect` so
 * the data path stays narrowly typed. Both entries share Fabric Warehouse
 * engine semantics today; separate values leave room for future divergence.
 */
/** @internal */
export const ConnectorDialect = {
  FabricWarehouse: 'fabric-warehouse',
  FabricSqlAnalytics: 'fabric-sqlanalytics',
} as const;

/** @internal */
export type ConnectorDialectType =
  (typeof ConnectorDialect)[keyof typeof ConnectorDialect];

/** Union accepted by the analyzer (data + connector dialects). */
/** @internal */
export type AnalyzerDialect = Dialect | ConnectorDialectType;

/** @internal */
export interface DialectConfig {
  /** Default primary key type (usually UUID/GUID) */
  defaultIdType: string;

  /** Default string type with optional length */
  defaultStringType: (length?: number) => string;

  /** Default integer type */
  defaultIntegerType: string;

  /** Default boolean type */
  defaultBooleanType: string;

  /** Default date/datetime type */
  defaultDateType: string;

  /** Default decimal type with optional precision and scale.
   *  When called without arguments, returns the dialect's default decimal type
   *  (e.g., DECIMAL(18,2) for MSSQL, NUMERIC(18,2) for PostgreSQL).
   */
  defaultDecimalType: (precision?: number, scale?: number) => string;

  /** Default text type for large content */
  defaultTextType: string;

  /** Default schema name (null means no default schema) */
  defaultSchema: string | null;

  /** Check constraint syntax template */
  checkConstraintTemplate: (columnName: string, values: string[]) => string;

  /** Minimum length check constraint syntax template */
  minLengthConstraintTemplate: (
    columnName: string,
    minLength: number
  ) => string;

  /** Numeric range check constraint syntax template (min and/or max). */
  numericRangeConstraintTemplate: (
    columnName: string,
    min: number | undefined,
    max: number | undefined
  ) => string;

  /** Email format check constraint syntax template */
  emailConstraintTemplate: (columnName: string) => string;

  /** Maximum allowed precision for DECIMAL/NUMERIC types.
   *  Capped at 28 to match the .NET decimal type used by Data API Builder at runtime.
   */
  maxDecimalPrecision: number;

  /** Maximum allowed length for sized string types (e.g., NVARCHAR(n)).
   *  `null` means no limit (e.g., PostgreSQL VARCHAR(n) has no practical cap).
   *  MSSQL NVARCHAR(n) is capped at 4000; values above that are rejected with an error.
   */
  maxStringLength: number | null;
}

// Numeric literals are emitted unquoted (SQL Server / PostgreSQL both accept them).
function buildBracketedNumericRange(
  columnName: string,
  min: number | undefined,
  max: number | undefined
): string {
  const parts: string[] = [];
  if (min !== undefined) parts.push(`${bracketId(columnName)} >= ${min}`);
  if (max !== undefined) parts.push(`${bracketId(columnName)} <= ${max}`);
  return parts.join(' AND ');
}

function buildQuotedNumericRange(
  columnName: string,
  min: number | undefined,
  max: number | undefined
): string {
  const parts: string[] = [];
  if (min !== undefined) parts.push(`${quoteId(columnName)} >= ${min}`);
  if (max !== undefined) parts.push(`${quoteId(columnName)} <= ${max}`);
  return parts.join(' AND ');
}

/**
 * Quote a SQL identifier for bracket-delimited dialects (MSSQL / Fabric),
 * doubling any embedded `]` so a mapped column name is always a valid
 * delimited identifier inside generated CHECK expressions.
 */
const bracketId = (name: string): string => `[${name.replace(/]/g, ']]')}]`;

/**
 * Quote a SQL identifier for double-quote-delimited dialects (PostgreSQL),
 * doubling any embedded `"` for the same reason as {@link bracketId}.
 */
const quoteId = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * Quote a SQL string literal, doubling any embedded single quote so enum
 * values containing an apostrophe (e.g. `O'Brien`) produce valid DDL inside
 * generated CHECK expressions across all dialects.
 */
const sqlLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * Multi-dialect configurations
 * MSSQL and PostgreSQL are both implemented
 */
/** @internal */
export const DIALECT_CONFIGS: Record<Dialect, DialectConfig> = {
  // ✅ MSSQL - Fully implemented
  [DatabaseDialect.MsSql]: {
    defaultIdType: 'UNIQUEIDENTIFIER',
    defaultStringType: (length = 255) => `NVARCHAR(${length})`,
    defaultIntegerType: 'INT',
    defaultBooleanType: 'BIT',
    defaultDateType: 'DATETIME2',
    defaultDecimalType: (precision?, scale?) =>
      precision !== undefined && scale !== undefined
        ? `DECIMAL(${precision},${scale})`
        : 'DECIMAL(18,2)',
    defaultTextType: 'NVARCHAR(MAX)',
    defaultSchema: 'dbo',
    checkConstraintTemplate: (columnName, values) => {
      // Case-sensitive CHECK on MSSQL requires the binary collation. Gated
      // behind `cli-minor-fixes` for GA rollout — off falls back to the
      // dialect's default (case-insensitive) collation.
      const minorFixesOn = isMinorFixesOn();
      const idExpr = minorFixesOn
        ? `${bracketId(columnName)} COLLATE Latin1_General_100_BIN2`
        : bracketId(columnName);
      return `${idExpr} IN (${values.map(sqlLiteral).join(', ')})`;
    },
    minLengthConstraintTemplate: (columnName, minLength) =>
      `LEN(${bracketId(columnName)}) >= ${minLength}`,
    numericRangeConstraintTemplate: (columnName, min, max) =>
      buildBracketedNumericRange(columnName, min, max),
    emailConstraintTemplate: (columnName) =>
      `${bracketId(columnName)} LIKE '_%@_%._%' AND CHARINDEX(' ', ${bracketId(columnName)}) = 0`,
    maxDecimalPrecision: 28,
    maxStringLength: 4000,
  },

  // ✅ PostgreSQL - Fully implemented
  [DatabaseDialect.PostgreSql]: {
    defaultIdType: 'UUID',
    defaultStringType: (length = 255) => `VARCHAR(${length})`,
    defaultIntegerType: 'INTEGER',
    defaultBooleanType: 'BOOLEAN',
    defaultDateType: 'TIMESTAMP WITH TIME ZONE',
    defaultDecimalType: (precision?, scale?) =>
      precision !== undefined && scale !== undefined
        ? `NUMERIC(${precision},${scale})`
        : 'NUMERIC(18,2)',
    defaultTextType: 'TEXT',
    defaultSchema: 'public',
    checkConstraintTemplate: (columnName, values) =>
      `${quoteId(columnName)} IN (${values.map(sqlLiteral).join(', ')})`,
    minLengthConstraintTemplate: (columnName, minLength) =>
      `LENGTH(${quoteId(columnName)}) >= ${minLength}`,
    numericRangeConstraintTemplate: (columnName, min, max) =>
      buildQuotedNumericRange(columnName, min, max),
    emailConstraintTemplate: (columnName) =>
      `${quoteId(columnName)} LIKE '_%@_%._%' AND POSITION(' ' IN ${quoteId(columnName)}) = 0`,
    maxDecimalPrecision: 28,
    maxStringLength: null,
  },
};

/** Shared Fabric engine base: VARCHAR(n)/VARCHAR(MAX), BIT, DATETIME2, no NVARCHAR. */
const FABRIC_WAREHOUSE_BASE_CONFIG: DialectConfig = {
  defaultIdType: 'UNIQUEIDENTIFIER',
  defaultStringType: (length = 255) => `VARCHAR(${length})`,
  defaultIntegerType: 'INT',
  defaultBooleanType: 'BIT',
  defaultDateType: 'DATETIME2',
  defaultDecimalType: (precision?, scale?) =>
    precision !== undefined && scale !== undefined
      ? `DECIMAL(${precision},${scale})`
      : 'DECIMAL(18,2)',
  defaultTextType: 'VARCHAR(MAX)',
  defaultSchema: 'dbo',
  checkConstraintTemplate: (columnName, values) =>
    `${bracketId(columnName)} IN (${values.map(sqlLiteral).join(', ')})`,
  minLengthConstraintTemplate: (columnName, minLength) =>
    `LEN(${bracketId(columnName)}) >= ${minLength}`,
  numericRangeConstraintTemplate: (columnName, min, max) =>
    buildBracketedNumericRange(columnName, min, max),
  emailConstraintTemplate: (columnName) =>
    `${bracketId(columnName)} LIKE '_%@_%._%' AND CHARINDEX(' ', ${bracketId(columnName)}) = 0`,
  maxDecimalPrecision: 28,
  maxStringLength: 8000,
};

/** @internal */
export const CONNECTOR_DIALECT_CONFIGS: Record<
  ConnectorDialectType,
  DialectConfig
> = {
  [ConnectorDialect.FabricWarehouse]: { ...FABRIC_WAREHOUSE_BASE_CONFIG },
  [ConnectorDialect.FabricSqlAnalytics]: { ...FABRIC_WAREHOUSE_BASE_CONFIG },
};

/** Resolve config for any analyzer dialect (data or connector). */
/** @internal */
export function getDialectConfig(dialect: AnalyzerDialect): DialectConfig {
  const connectorConfig = (
    CONNECTOR_DIALECT_CONFIGS as Partial<Record<string, DialectConfig>>
  )[dialect];
  if (connectorConfig) return connectorConfig;

  const config = (DIALECT_CONFIGS as Partial<Record<string, DialectConfig>>)[
    dialect
  ];
  if (!config) {
    throw new Error(`Unknown SQL dialect: ${dialect}`);
  }
  return config;
}

/** Data-path dialect check. Connector-only dialects are intentionally excluded. */
/** @internal */
export function isDialectSupported(dialect: string): dialect is Dialect {
  return (
    dialect === DatabaseDialect.MsSql || dialect === DatabaseDialect.PostgreSql
  );
}

/**
 * Get list of supported dialects for CLI help text
 */
/** @internal */
export function getSupportedDialects(): Dialect[] {
  return [DatabaseDialect.MsSql, DatabaseDialect.PostgreSql];
}
