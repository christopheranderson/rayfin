/**
 * Formats a value for inline use in a GraphQL query string.
 * Applies proper escaping for strings (backslash, quote, newline, carriage return, tab).
 */
export function formatGraphQLValue(value: any): string {
  if (typeof value === 'string') {
    return `"${value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')}"`;
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (value instanceof Date) {
    return `"${value.toISOString()}"`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => formatGraphQLValue(v)).join(', ')}]`;
  }
  if (value === null || value === undefined) {
    return 'null';
  }

  return `"${String(value)}"`;
}
