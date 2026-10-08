import type { ConnectorType } from '@microsoft/rayfin-tools-common/_internal/config';
import { CONNECTOR_CATALOG } from '@microsoft/rayfin-tools-common/_internal/config';

import { getPowerBiApiBaseUrl } from '../../../config/constants.js';
import { fabricFetch } from '../../../utils/http-client.js';
import { RayfinItemManager } from '../../fabric/rayfin-item.js';
import { SqlEndpointManager } from '../../fabric/sql-endpoint.js';
import { classifySqlAccessError } from '../../sql-error.js';

import {
  MultipleSqlResultSetsError,
  MULTIPLE_SQL_RESULT_SETS_RECOVERY,
} from './contract.js';
import type { ConnectorInspectColumn } from './types.js';

export type {
  ConnectorInspectColumn,
  ConnectorInspectColumnType,
} from './types.js';

// Known accepted gaps (PR #1679 review): bare (unbracketed) sp_/xp_ column
// names are rejected (fails closed, bracket to work around), and rare
// deprecated syntax like UPDATETEXT isn't in the denylist.
const SQL_WRITE_KEYWORD_PATTERN =
  /\b(?:insert|update|delete|merge|create|alter|drop|truncate|exec(?:ute)?|into|grant|deny|revoke|backup|restore|bulk|dbcc|kill|shutdown|waitfor)\b|\b(?:sp|xp)_[a-z0-9_]*\b/i;
const SQL_LEADING_TOKEN_PATTERN = /^\s*(select|with)\b/i;
const DAX_LEADING_TOKEN_PATTERN = /^\s*evaluate\b/i;
const SQL_SINGLE_QUOTED_LITERAL_PATTERN = /'(?:[^']|'')*'/g;
// T-SQL has no backslash-escape convention for double-quoted identifiers or
// strings — a literal `"` is escaped by doubling (`""`), matching the
// single-quote pattern above and the tokenizer in blankSqlNoise(). A
// backslash-based pattern here would fail to close on a value ending in an
// odd number of backslashes before the quote, leaving it unredacted in logs.
const SQL_DOUBLE_QUOTED_LITERAL_PATTERN = /"(?:[^"]|"")*"/g;

/**
 * Single left-to-right scan that blanks string literals, bracketed
 * identifiers, and comments together (quotes/brackets kept, content
 * blanked), so a delimiter opened in one context — e.g. an apostrophe
 * inside a `--` comment — can never close a different context, such as a
 * string literal spanning into real code on a later line. Sequential regex
 * passes over the same text can't guarantee that; this can, in one pass.
 */
function blankSqlNoise(query: string): string {
  let out = '';
  let i = 0;
  const n = query.length;
  while (i < n) {
    const ch = query[i]!;
    const next = query[i + 1];
    if (ch === "'") {
      out += "'";
      i++;
      while (i < n) {
        if (query[i] === "'" && query[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (query[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      out += "'";
      continue;
    }
    if (ch === '"') {
      out += '"';
      i++;
      while (i < n) {
        if (query[i] === '"' && query[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (query[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      out += '"';
      continue;
    }
    if (ch === '[') {
      out += '[';
      i++;
      while (i < n) {
        if (query[i] === ']' && query[i + 1] === ']') {
          i += 2;
          continue;
        }
        if (query[i] === ']') {
          i++;
          break;
        }
        i++;
      }
      out += ']';
      continue;
    }
    if (ch === '-' && next === '-') {
      i += 2;
      while (i < n && query[i] !== '\n' && query[i] !== '\r') i++;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (query[i] === '/' && query[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (query[i] === '*' && query[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      out += ' ';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const SQL_TYPES: ReadonlySet<ConnectorType> = new Set([
  'fabric-sqldatabase',
  'fabric-sqlanalytics',
  'fabric-warehouse',
]);

// fabric-sqlanalytics' SQL connection-string lookup expects 'SQLEndpoint',
// which is a different Fabric API vocabulary than CONNECTOR_CATALOG's
// fabricItemType ('Lakehouse', used for Items API lookups) — so it can't be
// reused from the catalog like the other SQL-family types below.
const SQL_ANALYTICS_CONNECTION_STRING_ITEM_TYPE = 'SQLEndpoint';

/**
 * Error surfaced from the inspect service, paired with a recovery hint
 * per the RFC's error-and-recovery model.
 */
export class ConnectorInspectError extends Error {
  override readonly name = 'ConnectorInspectError';

  constructor(
    message: string,
    readonly recovery: string
  ) {
    super(message);
  }
}

export interface ConnectorInspectInput {
  connectorType: ConnectorType;
  workspaceId: string;
  itemId: string;
  rows: number;
  /**
   * `entities` lists the connector's queryable entity names so callers have a
   * discovery step; `structured` samples one entity; `raw` runs a supplied
   * query file.
   */
  mode: 'structured' | 'raw' | 'entities';
  entity?: string;
  query?: string;
  token: string;
  dataToken?: string;
  /**
   * Verbose diagnostic sink, set only when `--verbose` is passed. Never
   * receives tokens, row values, or unredacted query literals.
   */
  log?: (message: string) => void;
}

export interface ConnectorInspectResult {
  connectorType: ConnectorType;
  queryMode: 'structured' | 'raw' | 'entities';
  entity?: string;
  columns: ConnectorInspectColumn[];
  rows: Record<string, unknown>[];
  truncated: boolean;
}

function validateSqlReadOnly(query: string): void {
  const blanked = blankSqlNoise(query.trim());
  const recovery =
    'Rewrite the query as a read-only SELECT/EVALUATE statement.';
  if (!SQL_LEADING_TOKEN_PATTERN.test(blanked)) {
    throw new ConnectorInspectError(
      'Only read-only SQL is supported. Query must start with SELECT or WITH.',
      recovery
    );
  }
  if (blanked.replace(/;\s*$/, '').includes(';')) {
    throw new ConnectorInspectError(
      'Only a single SQL statement is supported. Remove additional statements and retry.',
      recovery
    );
  }
  const blockedMatch = SQL_WRITE_KEYWORD_PATTERN.exec(blanked);
  if (blockedMatch) {
    throw new ConnectorInspectError(
      `Query contains blocked keyword: ${blockedMatch[0].toUpperCase()}`,
      recovery
    );
  }
}

function validateDaxReadOnly(query: string): void {
  if (!DAX_LEADING_TOKEN_PATTERN.test(query.trim())) {
    throw new ConnectorInspectError(
      'Only read-only DAX is supported. Query must start with EVALUATE.',
      'Rewrite the query as a read-only SELECT/EVALUATE statement.'
    );
  }
}

/**
 * Every builder below takes a *fetch* limit, not the user-requested cap. The
 * limit is deliberately one greater than the cap (see `probeLimit`) so the
 * server returns a single extra row when more data exists; `normalizeRows`
 * then trims it back and reports `truncated`. Capping in-query at exactly the
 * requested count would make truncation undetectable.
 */
function probeLimit(rows: number): number {
  return rows + 1;
}

function buildStructuredSql(entity: string, fetchRows: number): string {
  // Bracket each dot-separated part of a schema-qualified entity (e.g.
  // "SalesLT.Customer") individually, not the whole string as one identifier.
  const qualifiedName = entity
    .split('.')
    .map((part) => `[${part.replace(/\]/g, ']]')}]`)
    .join('.');
  return `SELECT TOP (${fetchRows}) * FROM ${qualifiedName}`;
}

function buildStructuredDax(entity: string, fetchRows: number): string {
  const quotedName = `'${entity.replace(/'/g, "''")}'`;
  return `EVALUATE TOPN(${fetchRows}, ${quotedName})`;
}

function buildEntityListSql(fetchRows: number): string {
  // INFORMATION_SCHEMA.TABLES is the same catalog view resolveSqlEntitySchema
  // already relies on, so entity discovery needs no new surface area.
  return (
    `SELECT TOP (${fetchRows}) TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE ` +
    'FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME'
  );
}

function buildEntityListDax(fetchRows: number): string {
  // INFO.TABLES() is the DAX equivalent of the catalog view. Hidden tables are
  // filtered out because they are not addressable as `--entity` values.
  return (
    `EVALUATE TOPN(${fetchRows}, SELECTCOLUMNS(FILTER(INFO.TABLES(), ` +
    'NOT [IsHidden]), "TABLE_NAME", [Name]), [TABLE_NAME], ASC) ' +
    'ORDER BY [TABLE_NAME]'
  );
}

/**
 * Redact quoted string literals from a query before it's written to a
 * verbose log, since raw `--query` files may carry customer data.
 */
function redactQueryLiterals(query: string): string {
  return query
    .replace(SQL_SINGLE_QUOTED_LITERAL_PATTERN, "'***'")
    .replace(SQL_DOUBLE_QUOTED_LITERAL_PATTERN, '"***"');
}

function normalizeRows(
  rows: Record<string, unknown>[],
  requestedRows: number
): { rows: Record<string, unknown>[]; truncated: boolean } {
  if (rows.length <= requestedRows) {
    return { rows, truncated: false };
  }
  return { rows: rows.slice(0, requestedRows), truncated: true };
}

async function resolveSqlItemType(
  token: string,
  workspaceId: string,
  itemId: string,
  connectorType: ConnectorType
): Promise<string> {
  const manager = new RayfinItemManager(token);
  const item = await manager.getFabricItemById(workspaceId, itemId);
  if (item?.type) {
    return item.type;
  }

  if (
    connectorType === 'fabric-sqldatabase' ||
    connectorType === 'fabric-warehouse'
  ) {
    return CONNECTOR_CATALOG[connectorType].fabricItemType;
  }
  return SQL_ANALYTICS_CONNECTION_STRING_ITEM_TYPE;
}

interface SqlConnectionInfo {
  host: string;
  port: number;
  database: string;
}

async function resolveSqlConnectionInfo(
  token: string,
  workspaceId: string,
  itemId: string,
  connectorType: ConnectorType
): Promise<SqlConnectionInfo> {
  const itemType = await resolveSqlItemType(
    token,
    workspaceId,
    itemId,
    connectorType
  );
  const sqlEndpoint = new SqlEndpointManager(token);
  const resolved = await sqlEndpoint.getConnectionStringByType(
    workspaceId,
    itemId,
    itemType
  );

  const { parseConnectionString } = await import('../../schema-discovery.js');
  const { host, port } = parseConnectionString(resolved.connectionString);
  return {
    host,
    port,
    database: resolved.databaseName ?? resolved.resolvedItemId,
  };
}

/**
 * Auto-qualify an unqualified `--entity` (e.g. "customer") with its schema
 * via `INFORMATION_SCHEMA.TABLES`; throws if it matches multiple schemas.
 */
async function resolveSqlEntitySchema(
  connectionInfo: SqlConnectionInfo,
  dbToken: string,
  entity: string,
  log?: (message: string) => void
): Promise<string> {
  const { runSqlQueryPreview } = await import('../../schema-discovery.js');
  const escaped = entity.replace(/'/g, "''");
  let result;
  try {
    result = await runSqlQueryPreview({
      ...connectionInfo,
      token: dbToken,
      query: `SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE LOWER(TABLE_NAME) = LOWER('${escaped}')`,
    });
  } catch (error) {
    log?.(
      `Schema lookup for '${entity}' failed, falling back to unqualified name: ${(error as Error).message}`
    );
    return entity;
  }

  const matches = [
    ...new Map(
      result.rows
        .map((row) => ({
          schema: String(row.TABLE_SCHEMA ?? ''),
          table: String(row.TABLE_NAME ?? ''),
        }))
        .filter((match) => match.schema && match.table)
        .map((match) => [`${match.schema}.${match.table}`, match] as const)
    ).values(),
  ];
  if (matches.length === 0) {
    return entity;
  }
  if (matches.length > 1) {
    throw new ConnectorInspectError(
      `Entity '${entity}' exists in multiple schemas: ${matches.map((m) => m.schema).join(', ')}.`,
      `Disambiguate with a schema-qualified name, e.g. --entity ${matches[0].schema}.${matches[0].table}`
    );
  }
  return `${matches[0].schema}.${matches[0].table}`;
}

/**
 * Map a `tedious` error to a category-specific message and recovery hint
 * per the RFC's error and recovery model.
 */
function categorizeSqlError(error: unknown): {
  message: string;
  recovery: string;
} {
  if (error instanceof MultipleSqlResultSetsError) {
    return {
      message: error.message,
      recovery: MULTIPLE_SQL_RESULT_SETS_RECOVERY,
    };
  }
  const { category, message } = classifySqlAccessError(error);
  if (category === 'permission') {
    return {
      message: `Permission denied: ${message}`,
      recovery: 'Request required source permissions for this workspace/item.',
    };
  }
  if (category === 'login') {
    return {
      message: `Login rejected: ${message}`,
      recovery:
        'Confirm you have read access to this workspace/item; if you do, run `rayfin login` to refresh your session.',
    };
  }
  if (category === 'auth') {
    return {
      message: `Authentication failed: ${message}`,
      recovery: 'Run `rayfin login` to refresh your session.',
    };
  }
  return {
    message,
    recovery:
      'Verify the entity/table name exists and that you have access, then retry.',
  };
}

async function executeSqlQuery(
  connectionInfo: SqlConnectionInfo,
  dbToken: string,
  query: string,
  rowsCap: number
): Promise<{
  columns: ConnectorInspectColumn[];
  rows: Record<string, unknown>[];
  truncated: boolean;
}> {
  const { runSqlQueryPreview } = await import('../../schema-discovery.js');
  let result;
  try {
    result = await runSqlQueryPreview({
      ...connectionInfo,
      token: dbToken,
      query,
      // Mirror the in-query probe limit so the driver never clips the extra
      // row that normalizeRows uses to detect truncation.
      maxRows: probeLimit(rowsCap),
    });
  } catch (error) {
    const { message, recovery } = categorizeSqlError(error);
    throw new ConnectorInspectError(message, recovery);
  }

  const normalized = normalizeRows(result.rows, rowsCap);
  return {
    columns: result.columns,
    rows: normalized.rows,
    truncated: normalized.truncated,
  };
}

type SemanticExecuteResponse = {
  results?: Array<{
    tables?: Array<{
      rows?: Record<string, unknown>[];
    }>;
  }>;
  error?: {
    code?: string;
    message?: string;
  };
};

async function executeSemanticModelQuery(
  token: string,
  workspaceId: string,
  itemId: string,
  query: string,
  rowsCap: number,
  log?: (message: string) => void
): Promise<{
  columns: ConnectorInspectColumn[];
  rows: Record<string, unknown>[];
  truncated: boolean;
}> {
  const baseUrl = getPowerBiApiBaseUrl();
  log?.(`Resolved semantic model endpoint: ${baseUrl}`);
  const response = await fabricFetch(
    `${baseUrl}/v1.0/myorg/groups/${workspaceId}/datasets/${itemId}/executeQueries`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        queries: [{ query }],
        serializerSettings: { includeNulls: true },
      }),
    }
  );
  // Read as text first: error responses (401/403/400) from this API
  const rawBody = await response.text();
  let body: SemanticExecuteResponse | undefined;
  if (rawBody.length > 0) {
    try {
      body = JSON.parse(rawBody) as SemanticExecuteResponse;
    } catch {
      body = undefined;
    }
  }

  if (!response.ok) {
    const errorInfo = response.headers.get('x-powerbi-error-info');
    const remote =
      body?.error?.message ??
      (rawBody.trim() || errorInfo || response.statusText);
    const recovery =
      response.status === 401
        ? 'Run `rayfin login` to refresh your session.'
        : response.status === 403
          ? 'Request required source permissions for this workspace/item.'
          : 'Verify the entity/table name exists and that you have access, then retry.';
    throw new ConnectorInspectError(
      `Semantic model query failed (${response.status}): ${remote}`,
      recovery
    );
  }

  if (!body) {
    throw new ConnectorInspectError(
      'Semantic model query returned an empty or unreadable response.',
      'Retry the request; if it persists, verify the workspace/item IDs and your permissions.'
    );
  }

  const table = body.results?.[0]?.tables?.[0];
  const rows = table?.rows ?? [];
  const columns: ConnectorInspectColumn[] =
    rows.length > 0
      ? Object.keys(rows[0]!).map((name) => ({ name, type: 'unknown' }))
      : [];

  const normalized = normalizeRows(rows, rowsCap);
  return {
    columns,
    rows: normalized.rows,
    truncated: normalized.truncated,
  };
}

function resolveQuery(input: ConnectorInspectInput): {
  query: string;
  entity?: string;
} {
  const fetchRows = probeLimit(input.rows);

  if (input.mode === 'entities') {
    // Discovery mode carries no entity: the result rows *are* the entity list.
    if (SQL_TYPES.has(input.connectorType)) {
      return { query: buildEntityListSql(fetchRows), entity: undefined };
    }
    if (input.connectorType === 'fabric-semanticmodel') {
      return { query: buildEntityListDax(fetchRows), entity: undefined };
    }
    throw new Error(
      `Unsupported connector type for entity listing: ${input.connectorType}`
    );
  }

  if (input.mode === 'structured') {
    if (!input.entity) {
      throw new Error('Structured mode requires --entity <name>.');
    }
    if (SQL_TYPES.has(input.connectorType)) {
      return {
        query: buildStructuredSql(input.entity, fetchRows),
        entity: input.entity,
      };
    }
    if (input.connectorType === 'fabric-semanticmodel') {
      return {
        query: buildStructuredDax(input.entity, fetchRows),
        entity: input.entity,
      };
    }
    throw new Error(
      `Unsupported connector type for structured mode: ${input.connectorType}`
    );
  }

  if (!input.query || input.query.trim().length === 0) {
    throw new Error('Raw mode requires a non-empty query.');
  }

  return { query: input.query, entity: undefined };
}

/**
 * Provider abstraction (RFC's Provider architecture table): each provider
 * owns query building, validation, and execution for one connector family.
 */
interface InspectProvider {
  inspect(input: ConnectorInspectInput): Promise<ConnectorInspectResult>;
}

/** SQL-family execution and normalization (`fabric-sqldatabase`, `fabric-sqlanalytics`, `fabric-warehouse`). */
class SqlFamilyInspectProvider implements InspectProvider {
  async inspect(input: ConnectorInspectInput): Promise<ConnectorInspectResult> {
    const connectionInfo = await resolveSqlConnectionInfo(
      input.token,
      input.workspaceId,
      input.itemId,
      input.connectorType
    );
    input.log?.(
      `Resolved SQL connection: host=${connectionInfo.host} database=${connectionInfo.database}`
    );
    const dbToken = input.dataToken ?? input.token;

    // Auto-qualify a bare "--entity Customer" with its schema; left
    // untouched if already schema-qualified.
    let resolvedInput = input;
    if (
      input.mode === 'structured' &&
      input.entity &&
      !input.entity.includes('.')
    ) {
      const resolvedEntity = await resolveSqlEntitySchema(
        connectionInfo,
        dbToken,
        input.entity,
        input.log
      );
      input.log?.(`Resolved entity '${input.entity}' -> '${resolvedEntity}'`);
      resolvedInput = { ...input, entity: resolvedEntity };
    }

    const { query, entity } = resolveQuery(resolvedInput);
    validateSqlReadOnly(query);
    input.log?.(`Executing query: ${redactQueryLiterals(query)}`);
    const sql = await executeSqlQuery(
      connectionInfo,
      dbToken,
      query,
      input.rows
    );
    input.log?.(
      `Query returned ${sql.rows.length} row(s)${sql.truncated ? ' (truncated to cap)' : ''}`
    );

    return {
      connectorType: input.connectorType,
      queryMode: input.mode,
      entity,
      columns: sql.columns,
      rows: sql.rows,
      truncated: sql.truncated,
    };
  }
}

/** DAX execution and normalization (`fabric-semanticmodel`). */
class SemanticModelInspectProvider implements InspectProvider {
  async inspect(input: ConnectorInspectInput): Promise<ConnectorInspectResult> {
    const { query, entity } = resolveQuery(input);
    validateDaxReadOnly(query);
    input.log?.(`Executing query: ${redactQueryLiterals(query)}`);
    const semantic = await executeSemanticModelQuery(
      input.dataToken ?? input.token,
      input.workspaceId,
      input.itemId,
      query,
      input.rows,
      input.log
    );
    input.log?.(
      `Query returned ${semantic.rows.length} row(s)${semantic.truncated ? ' (truncated to cap)' : ''}`
    );

    return {
      connectorType: input.connectorType,
      queryMode: input.mode,
      entity,
      columns: semantic.columns,
      rows: semantic.rows,
      truncated: semantic.truncated,
    };
  }
}

export async function runConnectorInspect(
  input: ConnectorInspectInput
): Promise<ConnectorInspectResult> {
  if (SQL_TYPES.has(input.connectorType)) {
    return new SqlFamilyInspectProvider().inspect(input);
  }

  if (input.connectorType === 'fabric-semanticmodel') {
    return new SemanticModelInspectProvider().inspect(input);
  }

  throw new Error(`Unsupported connector type: ${input.connectorType}`);
}
