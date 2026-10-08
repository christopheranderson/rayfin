import { describe, it, expect } from 'vitest';

import { formatTable, truncateCell } from '../table.js';

describe('truncateCell', () => {
  it('returns values within the width unchanged', () => {
    expect(truncateCell('value', 5)).toBe('value');
  });

  it('uses an ellipsis when there is room', () => {
    expect(truncateCell('abcdef', 4)).toBe('abc…');
  });

  it('handles zero- and one-character widths without an ellipsis', () => {
    expect(truncateCell('abcdef', 1)).toBe('a');
    expect(truncateCell('abcdef', 0)).toBe('');
  });
});

describe('formatTable', () => {
  it('sizes columns to the widest value, not a fixed width', () => {
    // `adventure-works-dw-2020` is 23 chars — it overflowed the old
    // hardcoded padEnd(20) and shifted every following column left.
    const lines = formatTable(
      ['Name', 'Type'],
      [
        ['adventure-works-dw-2020', 'fabric-semanticmodel'],
        ['sales', 'kusto'],
      ]
    );

    const [header, rule, first, second] = lines;
    expect(header).toBe('Name                    Type');
    expect(rule).toBe(`${'─'.repeat(23)} ${'─'.repeat(20)}`);
    expect(first).toBe('adventure-works-dw-2020 fabric-semanticmodel');
    expect(second).toBe('sales                   kusto');

    // Every row starts its second column at the same offset.
    expect(header.indexOf('Type')).toBe(24);
    expect(first.indexOf('fabric-semanticmodel')).toBe(24);
    expect(second.indexOf('kusto')).toBe(24);
  });

  it('widens a column when the header is longer than every value', () => {
    const lines = formatTable(['Workspace ID'], [['—']]);
    expect(lines[0]).toBe('Workspace ID');
    expect(lines[1]).toBe('─'.repeat(12));
    expect(lines[2]).toBe('—');
  });

  it('does not pad the final column', () => {
    const lines = formatTable(['A', 'B'], [['loooong', 'x']]);
    expect(lines.every((line) => line === line.trimEnd())).toBe(true);
  });

  it('truncates cells past the width ceiling with an ellipsis', () => {
    const lines = formatTable(['Name', 'Type'], [['x'.repeat(30), 'kusto']], {
      maxColumnWidth: 10,
    });
    expect(lines[2]).toBe(`${'x'.repeat(9)}… kusto`);
  });

  it('pads short rows so ragged input still aligns', () => {
    const lines = formatTable(['A', 'B', 'C'], [['one'], ['two', 'three']]);
    expect(lines[2]).toBe('one');
    expect(lines[3]).toBe('two three');
  });

  it('honours a custom gap and an omitted rule', () => {
    const lines = formatTable(['A', 'B'], [['1', '2']], {
      gap: 3,
      rule: false,
    });
    expect(lines).toEqual(['A   B', '1   2']);
  });

  it('returns nothing when there are no columns', () => {
    expect(formatTable([], [])).toEqual([]);
  });
});
