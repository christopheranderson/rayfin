/**
 * Human-readable rendering for `--output plain`.
 *
 * `plain` exists so a run can be read in a terminal (or piped into `grep`)
 * without the caller having to parse JSON. Rendering a pretty-printed JSON
 * blob would make `plain` indistinguishable from `--output json`, so this
 * module recognises the payload shapes connectors actually return and lays
 * them out as text, falling back to JSON only when the shape is unknown.
 */

import { formatTable } from './table.js';

/** Placeholder for a value the payload did not carry. */
const EMPTY_CELL = '—';

/** The normalised semantic-model result shape, as far as rendering cares. */
interface TabularPayload {
  columns: Array<{ name: string }>;
  rows: unknown[][];
}

/**
 * Render a single value as a table cell.
 *
 * `null` and `undefined` become the empty-cell placeholder so a sparse row
 * still lines up with its header. Objects are compacted onto one line
 * because a cell cannot span lines without breaking the column layout.
 */
function renderCell(value: unknown): string {
  if (value === null || value === undefined) {
    return EMPTY_CELL;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  return JSON.stringify(value) ?? String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Detect the normalised query-result table produced by the semantic-model
 * connector: `{ columns: [{ name, dataType }], rows: unknown[][] }`.
 */
function asTabularPayload(value: unknown): TabularPayload | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const { columns, rows } = value;
  if (!Array.isArray(columns) || !Array.isArray(rows)) {
    return undefined;
  }
  if (!columns.every((c) => isRecord(c) && typeof c.name === 'string')) {
    return undefined;
  }
  if (!rows.every((row) => Array.isArray(row))) {
    return undefined;
  }

  return {
    columns: columns as Array<{ name: string }>,
    rows: rows as unknown[][],
  };
}

/**
 * Detect an array of flat records with consistent-enough keys to tabulate,
 * e.g. the row shape a GraphQL connector returns.
 */
function asRecordRows(
  value: unknown
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  if (!value.every(isRecord)) {
    return undefined;
  }
  // Nested objects would have to be JSON-compacted into a cell, which reads
  // worse than the JSON fallback, so leave those to the fallback.
  const flat = value.every((row) =>
    Object.values(row).every(
      (v) => v === null || v === undefined || typeof v !== 'object'
    )
  );
  return flat ? (value as Array<Record<string, unknown>>) : undefined;
}

/** Render `{ columns, rows }` as an aligned table. */
function renderTabular(payload: TabularPayload): string {
  const headers = payload.columns.map((column) => column.name);
  const rows = payload.rows.map((row) => row.map(renderCell));
  const lines = formatTable(headers, rows);

  const rowCount = payload.rows.length;
  lines.push('');
  lines.push(`(${rowCount} ${rowCount === 1 ? 'row' : 'rows'})`);

  return lines.join('\n');
}

/** Render an array of flat records as an aligned table. */
function renderRecordRows(rows: Array<Record<string, unknown>>): string {
  // Union the keys in first-seen order so a row missing a key still aligns.
  const headers: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!headers.includes(key)) {
        headers.push(key);
      }
    }
  }

  const body = rows.map((row) => headers.map((key) => renderCell(row[key])));
  const lines = formatTable(headers, body);

  lines.push('');
  lines.push(`(${rows.length} ${rows.length === 1 ? 'row' : 'rows'})`);

  return lines.join('\n');
}

/** Render a flat object as `key: value` lines. */
function renderRecord(record: Record<string, unknown>): string {
  const keys = Object.keys(record);
  const width = Math.max(...keys.map((key) => key.length));
  return keys
    .map((key) => `${key.padEnd(width)} : ${renderCell(record[key])}`)
    .join('\n');
}

/**
 * Render a connector payload for `--output plain`.
 *
 * Recognised shapes, in order:
 * 1. A normalised query result (`{ status, table }` or a bare
 *    `{ columns, rows }`) renders as an aligned table with a row count.
 * 2. An array of flat records renders as an aligned table.
 * 3. A flat object renders as `key: value` lines.
 * 4. Anything else falls back to pretty-printed JSON, which is still more
 *    useful than nothing and keeps this function total.
 */
export function renderPlainOutput(output: unknown): string {
  if (output === null || output === undefined) {
    return '';
  }

  if (typeof output === 'string') {
    return output;
  }

  if (
    typeof output === 'number' ||
    typeof output === 'boolean' ||
    typeof output === 'bigint'
  ) {
    return String(output);
  }

  if (isRecord(output)) {
    // The semantic-model connector nests the table under `table`, alongside
    // `status` and `requestId`.
    const nested = asTabularPayload(output.table);
    if (nested) {
      return renderTabular(nested);
    }

    const direct = asTabularPayload(output);
    if (direct) {
      return renderTabular(direct);
    }

    const nestedRows = asRecordRows(output.rows) ?? asRecordRows(output.data);
    if (nestedRows) {
      return renderRecordRows(nestedRows);
    }

    const flat = Object.values(output).every(
      (v) => v === null || v === undefined || typeof v !== 'object'
    );
    if (flat && Object.keys(output).length > 0) {
      return renderRecord(output);
    }
  }

  const rows = asRecordRows(output);
  if (rows) {
    return renderRecordRows(rows);
  }

  return JSON.stringify(output, null, 2);
}
