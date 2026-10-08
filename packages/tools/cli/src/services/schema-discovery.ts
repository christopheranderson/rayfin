import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import type { Connection } from 'tedious';

import { MultipleSqlResultSetsError } from './connectors/inspect/contract.js';
import type {
  ConnectorInspectColumn,
  ConnectorInspectColumnType,
} from './connectors/inspect/types.js';

// ── Schema metadata interfaces ──────────────────────────────────────

export interface ColumnEntry {
  columnName: string;
  dataType: string;
  isNullable: boolean;
  maxLength?: number;
  precision?: number;
  scale?: number;
  datePrecision?: number;
  identity?: { seed: string; increment: string };
  computed?: string;
  default?: string;
  /** Server-maintained column with no user-facing expression. */
  serverManaged?: 'rowversion' | 'temporalRowStart' | 'temporalRowEnd';
}

export interface ForeignKeyEntry {
  constraintName: string;
  columnName: string;
  referencedTableSchema: string;
  referencedTableName: string;
  referencedColumnName: string;
}

export interface TableEntry {
  tableName: string;
  columns: ColumnEntry[];
  foreignKeys?: ForeignKeyEntry[];
  primaryKeyColumns?: string[];
}

export interface SchemaEntry {
  schemaName: string;
  tables: TableEntry[];
}

export interface SchemaMetadata {
  source: string;
  connector: string;
  connectionString: string;
  discoveredAt: string;
  schemas: SchemaEntry[];
}

// ── SQL query types ─────────────────────────────────────────────────

interface TableRow {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  [key: string]: unknown;
}

export interface ColumnRow {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  COLUMN_NAME: string;
  DATA_TYPE: string;
  IS_NULLABLE: string;
  CHARACTER_MAXIMUM_LENGTH: number | null;
  NUMERIC_PRECISION: number | null;
  NUMERIC_SCALE: number | null;
  DATETIME_PRECISION: number | null;
  [key: string]: unknown;
}

export interface ServerGenRow {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  COLUMN_NAME: string;
  IS_IDENTITY: boolean;
  SEED_VALUE: string | null;
  INCREMENT_VALUE: string | null;
  DEFAULT_DEFINITION: string | null;
  COMPUTED_DEFINITION: string | null;
  GENERATED_ALWAYS_TYPE: number;
  TYPE_NAME: string;
  [key: string]: unknown;
}

/**
 * Map a raw column query row (portable INFORMATION_SCHEMA fields, present on
 * every engine) to a {@link ColumnEntry}.
 */
export function columnRowToEntry(row: ColumnRow): ColumnEntry {
  const col: ColumnEntry = {
    columnName: row.COLUMN_NAME,
    dataType: row.DATA_TYPE,
    isNullable: row.IS_NULLABLE === 'YES',
  };
  if (row.CHARACTER_MAXIMUM_LENGTH != null) {
    col.maxLength = row.CHARACTER_MAXIMUM_LENGTH;
  }
  if (row.NUMERIC_PRECISION != null) {
    col.precision = row.NUMERIC_PRECISION;
  }
  if (row.NUMERIC_SCALE != null) {
    col.scale = row.NUMERIC_SCALE;
  }
  if (row.DATETIME_PRECISION != null) {
    col.datePrecision = row.DATETIME_PRECISION;
  }
  return col;
}

/**
 * Apply server-generation metadata (IDENTITY seed/increment, DEFAULT, computed
 * definition, and server-managed rowversion / temporal period columns) from a
 * catalog row onto its column entry. Only SQL Database has these; on Warehouse /
 * Lakehouse the probe returns nothing, so this is never called and the column
 * stays plain.
 */
export function applyServerGeneration(
  col: ColumnEntry,
  row: ServerGenRow
): void {
  if (row.IS_IDENTITY) {
    col.identity = {
      seed: row.SEED_VALUE ?? '1',
      increment: row.INCREMENT_VALUE ?? '1',
    };
  }
  if (row.DEFAULT_DEFINITION != null) {
    col.default = row.DEFAULT_DEFINITION;
  }
  if (row.COMPUTED_DEFINITION != null) {
    col.computed = row.COMPUTED_DEFINITION;
  }
  // Server-maintained columns with no user-facing expression: rowversion
  // (surfaces as the legacy `timestamp` type) and temporal period columns
  // (GENERATED ALWAYS AS ROW START/END).
  if (row.TYPE_NAME === 'timestamp' || row.TYPE_NAME === 'rowversion') {
    col.serverManaged = 'rowversion';
  } else if (row.GENERATED_ALWAYS_TYPE === 1) {
    col.serverManaged = 'temporalRowStart';
  } else if (row.GENERATED_ALWAYS_TYPE === 2) {
    col.serverManaged = 'temporalRowEnd';
  }
}

interface PkRow {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  COLUMN_NAME: string;
  [key: string]: unknown;
}

interface FkRow {
  CONSTRAINT_NAME: string;
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  COLUMN_NAME: string;
  REFERENCED_TABLE_SCHEMA: string;
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
  [key: string]: unknown;
}

// ── TDS connection helpers ──────────────────────────────────────────

interface ConnectionOptions {
  host: string;
  port: number;
  database: string;
  token: string;
}

export interface SqlQueryPreviewResult {
  columns: ConnectorInspectColumn[];
  rows: Record<string, unknown>[];
}

export interface SqlDriverColumnMetadata {
  colName: string;
  type: {
    name: string;
  };
}

/**
 * Normalize Tedious' protocol-level type names into a stable inspect result
 * vocabulary without inferring from row values.
 */
export function normalizeSqlColumnType(
  driverTypeName: string
): ConnectorInspectColumnType {
  switch (driverTypeName) {
    case 'TinyInt':
    case 'SmallInt':
    case 'Int':
    case 'BigInt':
    case 'IntN':
      return 'integer';
    case 'Decimal':
    case 'Numeric':
    case 'SmallMoney':
    case 'Money':
    case 'DecimalN':
    case 'NumericN':
    case 'MoneyN':
      return 'decimal';
    case 'Real':
    case 'Float':
    case 'FloatN':
      return 'floating-point';
    case 'Char':
    case 'VarChar':
    case 'Text':
    case 'NChar':
    case 'NVarChar':
    case 'NText':
    case 'Xml':
      return 'text';
    case 'Bit':
    case 'BitN':
      return 'boolean';
    case 'Date':
      return 'date';
    case 'Time':
      return 'time';
    case 'SmallDateTime':
    case 'DateTime':
    case 'DateTimeN':
    case 'DateTime2':
    case 'DateTimeOffset':
      return 'datetime';
    case 'UniqueIdentifier':
      return 'uniqueidentifier';
    case 'Binary':
    case 'VarBinary':
    case 'Image':
      return 'binary';
    default:
      return 'unknown';
  }
}

/** Convert Tedious result metadata into the connector inspection column shape. */
export function normalizeSqlPreviewColumns(
  metadata: readonly SqlDriverColumnMetadata[]
): ConnectorInspectColumn[] {
  const columnsByName = new Map<string, ConnectorInspectColumn>();
  for (const column of metadata) {
    columnsByName.set(column.colName, {
      name: column.colName,
      type: normalizeSqlColumnType(column.type.name),
    });
  }
  return [...columnsByName.values()];
}

/**
 * Parse a connection string in `host,port` format.
 * Strips `tcp:` prefix if present.
 */
export function parseConnectionString(connStr: string): {
  host: string;
  port: number;
} {
  let cleaned = connStr;
  if (cleaned.startsWith('tcp:')) {
    cleaned = cleaned.substring(4);
  }
  const parts = cleaned.split(',');
  return {
    host: parts[0],
    port: parts.length > 1 ? parseInt(parts[1], 10) : 1433,
  };
}

/**
 * Create a TDS connection using `tedious` with Entra token auth.
 */
async function createConnection(
  options: ConnectionOptions
): Promise<Connection> {
  const { Connection: TdsConnection } = await import('tedious');

  return new Promise((resolve, reject) => {
    const config = {
      server: options.host,
      authentication: {
        type: 'azure-active-directory-access-token' as const,
        options: { token: options.token },
      },
      options: {
        database: options.database,
        port: options.port,
        encrypt: true,
        useUTC: true,
        connectTimeout: 30000,
        requestTimeout: 30000,
      },
    };

    const connection = new TdsConnection(config);

    connection.on('connect', (err: Error | undefined) => {
      if (err) {
        reject(err);
      } else {
        resolve(connection);
      }
    });

    connection.connect();
  });
}

/** Execute a SQL query and return rows as typed objects; cancels the request early once `maxRows` rows arrive. */
async function executeQuery<T extends Record<string, unknown>>(
  connection: Connection,
  sql: string,
  maxRows?: number,
  onColumns?: (columns: ConnectorInspectColumn[]) => void
): Promise<T[]> {
  const { Request } = await import('tedious');

  return new Promise((resolve, reject) => {
    const rows: T[] = [];
    let cancelledForRowLimit = false;
    let resultSetCount = 0;
    let terminalError: Error | undefined;
    const request = new Request(sql, (err: Error | null | undefined) => {
      if (terminalError) {
        reject(terminalError);
      } else if (err && !cancelledForRowLimit) {
        reject(err);
      } else {
        resolve(rows);
      }
    });

    request.on(
      'row',
      (columns: Array<{ metadata: { colName: string }; value: unknown }>) => {
        if (terminalError) {
          return;
        }
        const row: Record<string, unknown> = {};
        for (const col of columns) {
          row[col.metadata.colName] = col.value;
        }
        rows.push(row as T);
        if (
          maxRows !== undefined &&
          rows.length >= maxRows &&
          !cancelledForRowLimit
        ) {
          cancelledForRowLimit = true;
          connection.cancel();
        }
      }
    );

    request.on('columnMetadata', (metadata) => {
      resultSetCount++;
      if (resultSetCount > 1) {
        terminalError = new MultipleSqlResultSetsError();
        connection.cancel();
        return;
      }
      if (!onColumns) {
        return;
      }
      const columns = Array.isArray(metadata)
        ? metadata
        : Object.values(metadata);
      onColumns?.(normalizeSqlPreviewColumns(columns));
    });

    connection.execSql(request);
  });
}

/** Execute an arbitrary read query against a SQL endpoint and return column metadata plus row objects. */
export async function runSqlQueryPreview(options: {
  host: string;
  port: number;
  database: string;
  token: string;
  query: string;
  maxRows?: number;
}): Promise<SqlQueryPreviewResult> {
  const connection = await createConnection({
    host: options.host,
    port: options.port,
    database: options.database,
    token: options.token,
  });

  try {
    let columns: ConnectorInspectColumn[] = [];
    const rows = await executeQuery<Record<string, unknown>>(
      connection,
      options.query,
      options.maxRows,
      (resultColumns) => {
        columns = resultColumns;
      }
    );

    return { columns, rows };
  } finally {
    connection.close();
  }
}

// ── SQL queries ─────────────────────────────────────────────────────

const TABLES_QUERY = `
SELECT TABLE_SCHEMA, TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_TYPE = 'BASE TABLE'
ORDER BY TABLE_SCHEMA, TABLE_NAME
`;

const COLUMNS_QUERY = `
SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE,
       IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH,
       NUMERIC_PRECISION, NUMERIC_SCALE, DATETIME_PRECISION
FROM INFORMATION_SCHEMA.COLUMNS
ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
`;

const PK_QUERY = `
SELECT
  tc.TABLE_SCHEMA,
  tc.TABLE_NAME,
  kcu.COLUMN_NAME
FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
  ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
  AND tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
ORDER BY tc.TABLE_SCHEMA, tc.TABLE_NAME, kcu.ORDINAL_POSITION
`;

const FK_QUERY = `
SELECT
  kcu.CONSTRAINT_NAME,
  kcu.TABLE_SCHEMA,
  kcu.TABLE_NAME,
  kcu.COLUMN_NAME,
  kcu2.TABLE_SCHEMA AS REFERENCED_TABLE_SCHEMA,
  kcu2.TABLE_NAME   AS REFERENCED_TABLE_NAME,
  kcu2.COLUMN_NAME  AS REFERENCED_COLUMN_NAME
FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
  ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
  AND kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu2
  ON kcu2.CONSTRAINT_NAME = rc.UNIQUE_CONSTRAINT_NAME
  AND kcu2.CONSTRAINT_SCHEMA = rc.UNIQUE_CONSTRAINT_SCHEMA
  AND kcu2.ORDINAL_POSITION = kcu.ORDINAL_POSITION
ORDER BY kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
`;

// Server-generated columns: IDENTITY (seed/increment), DEFAULT constraints,
// computed definitions, and server-managed rowversion / temporal period
// columns. SQL Database only; Warehouse/Lakehouse return nothing (or reject
// sys.* — handled non-fatally by the caller).
const SERVER_GEN_QUERY = `
SELECT
  s.name AS TABLE_SCHEMA,
  t.name AS TABLE_NAME,
  c.name AS COLUMN_NAME,
  c.is_identity      AS IS_IDENTITY,
  CAST(ic.seed_value      AS nvarchar(64)) AS SEED_VALUE,
  CAST(ic.increment_value AS nvarchar(64)) AS INCREMENT_VALUE,
  dc.definition      AS DEFAULT_DEFINITION,
  cc.definition      AS COMPUTED_DEFINITION,
  c.generated_always_type AS GENERATED_ALWAYS_TYPE,
  ty.name            AS TYPE_NAME
FROM sys.columns c
JOIN sys.tables t  ON t.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.types ty  ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
WHERE c.is_identity = 1
   OR dc.definition IS NOT NULL
   OR cc.definition IS NOT NULL
   OR c.generated_always_type <> 0
   OR ty.name IN ('timestamp', 'rowversion')
ORDER BY s.name, t.name, c.column_id
`;

// ── Schema discovery orchestrator ───────────────────────────────────

export interface DiscoverSchemaOptions {
  sourceName: string;
  connector: string;
  connectionString: string;
  database: string;
  token: string;
  verbose?: boolean;
  log?: (message: string) => void;
}

/**
 * Discover the SQL schema of a Fabric data source.
 *
 * Connects via TDS, queries INFORMATION_SCHEMA for tables, columns,
 * primary keys, and foreign keys, then returns structured metadata.
 */
export async function discoverSchema(
  options: DiscoverSchemaOptions
): Promise<SchemaMetadata> {
  const { sourceName, connector, connectionString, database, token, verbose } =
    options;
  const log = options.log ?? (() => {});

  const { host, port } = parseConnectionString(connectionString);

  if (verbose) {
    log(
      `[schema-discovery] Connecting to ${host}:${port} database=${database}`
    );
  }

  const connection = await createConnection({ host, port, database, token });

  try {
    // 1. Discover tables
    const tableRows = await executeQuery<TableRow>(connection, TABLES_QUERY);
    if (verbose) {
      log(`[schema-discovery] Found ${tableRows.length} tables`);
    }

    // 2. Discover columns
    const columnRows = await executeQuery<ColumnRow>(connection, COLUMNS_QUERY);
    if (verbose) {
      log(`[schema-discovery] Found ${columnRows.length} columns`);
    }

    // 3. Discover primary keys (non-fatal)
    let pkRows: PkRow[] = [];
    try {
      pkRows = await executeQuery<PkRow>(connection, PK_QUERY);
      if (verbose) {
        log(`[schema-discovery] Found ${pkRows.length} PK columns`);
      }
    } catch (err) {
      log(
        `[schema-discovery] Warning: PK discovery failed, continuing without PK data`
      );
    }

    // 4. Discover foreign keys (non-fatal)
    let fkRows: FkRow[] = [];
    try {
      fkRows = await executeQuery<FkRow>(connection, FK_QUERY);
      if (verbose) {
        log(`[schema-discovery] Found ${fkRows.length} FK relationships`);
      }
    } catch (err) {
      log(
        `[schema-discovery] Warning: FK discovery failed, continuing without FK data`
      );
    }

    // 5. Discover server-generated columns — IDENTITY / DEFAULT / computed
    //    (non-fatal; only SQL Database has these).
    let serverGenRows: ServerGenRow[] = [];
    try {
      serverGenRows = await executeQuery<ServerGenRow>(
        connection,
        SERVER_GEN_QUERY
      );
      if (verbose) {
        log(
          `[schema-discovery] Found ${serverGenRows.length} server-generated columns`
        );
      }
    } catch (err) {
      log(
        `[schema-discovery] Warning: server-generation discovery failed, continuing without identity/default/computed data`
      );
    }

    // Build structured metadata
    const schemaMap = new Map<string, Map<string, TableEntry>>();

    // Initialize tables
    for (const row of tableRows) {
      if (!schemaMap.has(row.TABLE_SCHEMA)) {
        schemaMap.set(row.TABLE_SCHEMA, new Map());
      }
      schemaMap.get(row.TABLE_SCHEMA)!.set(row.TABLE_NAME, {
        tableName: row.TABLE_NAME,
        columns: [],
      });
    }

    // Add columns
    for (const row of columnRows) {
      const table = schemaMap.get(row.TABLE_SCHEMA)?.get(row.TABLE_NAME);
      if (!table) continue;
      table.columns.push(columnRowToEntry(row));
    }

    // Add PK columns
    for (const row of pkRows) {
      const table = schemaMap.get(row.TABLE_SCHEMA)?.get(row.TABLE_NAME);
      if (!table) continue;
      if (!table.primaryKeyColumns) {
        table.primaryKeyColumns = [];
      }
      table.primaryKeyColumns.push(row.COLUMN_NAME);
    }

    // Add FK entries
    for (const row of fkRows) {
      const table = schemaMap.get(row.TABLE_SCHEMA)?.get(row.TABLE_NAME);
      if (!table) continue;
      if (!table.foreignKeys) {
        table.foreignKeys = [];
      }
      table.foreignKeys.push({
        constraintName: row.CONSTRAINT_NAME,
        columnName: row.COLUMN_NAME,
        referencedTableSchema: row.REFERENCED_TABLE_SCHEMA,
        referencedTableName: row.REFERENCED_TABLE_NAME,
        referencedColumnName: row.REFERENCED_COLUMN_NAME,
      });
    }

    // Apply server-generation metadata onto the matching columns.
    for (const row of serverGenRows) {
      const table = schemaMap.get(row.TABLE_SCHEMA)?.get(row.TABLE_NAME);
      const col = table?.columns.find((c) => c.columnName === row.COLUMN_NAME);
      if (col) applyServerGeneration(col, row);
    }

    // Convert to array structure
    const schemas: SchemaEntry[] = [];
    for (const [schemaName, tables] of schemaMap) {
      schemas.push({
        schemaName,
        tables: Array.from(tables.values()),
      });
    }

    return {
      source: sourceName,
      connector,
      connectionString: host, // Don't persist full connection string
      discoveredAt: new Date().toISOString(),
      schemas,
    };
  } finally {
    connection.close();
  }
}

// ── Metadata file writer ────────────────────────────────────────────

/**
 * Write schema metadata to `rayfin/connectors/<name>/metadata.json`.
 *
 * Co-locates the discovered schema artifact with the connector's
 * generated entity files and scaffold so every per-connector output
 * lives under a single directory the Builder can grep, diff, or delete
 * as one unit.
 */
export function writeMetadataFile(
  projectRoot: string,
  sourceName: string,
  metadata: SchemaMetadata
): string {
  const metadataPath = join(
    projectRoot,
    'rayfin',
    'connectors',
    sourceName,
    'metadata.json'
  );
  mkdirSync(dirname(metadataPath), { recursive: true });
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  return metadataPath;
}
