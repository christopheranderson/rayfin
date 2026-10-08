import type {
  ConnectorInspectColumn,
  ConnectorInspectColumnType,
} from './types.js';

export function formatConnectorInspectColumns(
  columns: readonly ConnectorInspectColumn[],
  maxWidth = Number.POSITIVE_INFINITY
): string[] {
  if (columns.length === 0) {
    return [];
  }

  const prefix = 'Columns: ';
  const continuation = ' '.repeat(prefix.length);
  const lines: string[] = [];
  let line = prefix;

  for (const column of columns) {
    const entry = `${column.name} (${column.type})`;
    const separator = line === prefix ? '' : ', ';
    if (
      line !== prefix &&
      line.length + separator.length + entry.length > maxWidth
    ) {
      lines.push(line);
      line = `${continuation}${entry}`;
    } else {
      line += `${separator}${entry}`;
    }
  }

  lines.push(line);
  return lines;
}

export function formatConnectorInspectValue(
  value: unknown,
  columnType: ConnectorInspectColumnType
): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (Buffer.isBuffer(value)) {
    return `0x${value.toString('hex')}`;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return String(value);
    }
    const timestamp = value.toISOString();
    if (columnType === 'date') {
      return timestamp.slice(0, 10);
    }
    if (columnType === 'time') {
      return timestamp.slice(11, 23);
    }
    return timestamp;
  }
  return String(value);
}
