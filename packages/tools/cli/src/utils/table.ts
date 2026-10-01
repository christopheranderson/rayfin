/**
 * Fixed-width table rendering for CLI list output.
 *
 * Columns are sized to their widest cell rather than to a hardcoded width,
 * so a value that overflows some assumed maximum — a connector named
 * `adventure-works-dw-2020`, say — no longer pushes every column to its
 * right out of alignment.
 */

/** Appended to a cell that had to be shortened to fit `maxColumnWidth`. */
const ELLIPSIS = '…';

/** Box-drawing character used to rule off the header row. */
const RULE = '─';

/**
 * Ceiling on a single column's width. Sizing purely to content means one
 * pathologically long value stretches the table past any usable terminal,
 * so cells wider than this are truncated instead.
 */
const DEFAULT_MAX_COLUMN_WIDTH = 60;

export interface FormatTableOptions {
  /** Spaces between adjacent columns. Defaults to `1`. */
  gap?: number;
  /** Per-column width ceiling before truncation. Defaults to `60`. */
  maxColumnWidth?: number;
  /** Draw a `─` rule beneath the header row. Defaults to `true`. */
  rule?: boolean;
}

/**
 * Shorten `value` to at most `maxWidth` characters, marking the cut with an
 * ellipsis when there is room for one.
 */
export function truncateCell(value: string, maxWidth: number): string {
  if (value.length <= maxWidth) return value;
  if (maxWidth <= 1) return value.slice(0, Math.max(maxWidth, 0));
  return `${value.slice(0, maxWidth - 1)}${ELLIPSIS}`;
}

/**
 * Render `headers` and `rows` as an aligned plain-text table.
 *
 * Returns one string per line (header, optional rule, then one line per row)
 * so callers can route them through whatever mode-aware logger they use.
 * Trailing padding is trimmed, keeping the output diff- and pipe-friendly.
 */
export function formatTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  options: FormatTableOptions = {}
): string[] {
  const gap = options.gap ?? 1;
  const maxColumnWidth = options.maxColumnWidth ?? DEFAULT_MAX_COLUMN_WIDTH;
  const showRule = options.rule ?? true;

  // Folded rather than spread into `Math.max` — a result set large enough to
  // exceed the engine's argument limit would otherwise blow the stack.
  const columnCount = rows.reduce(
    (widest, row) => Math.max(widest, row.length),
    headers.length
  );
  if (columnCount === 0) return [];

  const indices = Array.from({ length: columnCount }, (_, index) => index);
  const clamp = (value: string | undefined): string =>
    truncateCell(value ?? '', maxColumnWidth);

  const headerCells = indices.map((index) => clamp(headers[index]));
  const bodyRows = rows.map((row) => indices.map((index) => clamp(row[index])));

  const widths = indices.map((index) =>
    bodyRows.reduce(
      (widest, row) => Math.max(widest, row[index].length),
      headerCells[index].length
    )
  );

  const separator = ' '.repeat(gap);
  const renderRow = (cells: string[]): string =>
    cells
      // The final column never needs padding; trimming keeps lines clean for
      // anything downstream that is whitespace-sensitive.
      .map((cell, index) =>
        index === columnCount - 1 ? cell : cell.padEnd(widths[index])
      )
      .join(separator)
      .trimEnd();

  const lines = [renderRow(headerCells)];
  if (showRule) {
    lines.push(widths.map((width) => RULE.repeat(width)).join(separator));
  }
  for (const row of bodyRows) lines.push(renderRow(row));
  return lines;
}
