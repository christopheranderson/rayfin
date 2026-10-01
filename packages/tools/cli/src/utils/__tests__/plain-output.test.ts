import { describe, expect, it } from 'vitest';

import { renderPlainOutput } from '../plain-output.js';

describe('renderPlainOutput', () => {
  it('renders a semantic-model query result as an aligned table', () => {
    const rendered = renderPlainOutput({
      status: 'success',
      requestId: 'req-1',
      table: {
        columns: [
          { name: 'Product[Category]', dataType: 'String' },
          { name: '[Total Sales]', dataType: 'Double' },
        ],
        rows: [
          ['Bikes', 28318144.65],
          ['Components', 11799076.66],
        ],
      },
    });

    const lines = rendered.split('\n');
    expect(lines[0]).toBe('Product[Category] [Total Sales]');
    expect(lines[1]).toBe('───────────────── ─────────────');
    expect(lines[2]).toBe('Bikes             28318144.65');
    expect(lines[3]).toBe('Components        11799076.66');
    expect(rendered).toContain('(2 rows)');
  });

  it('renders a bare columns/rows payload', () => {
    const rendered = renderPlainOutput({
      columns: [{ name: 'Name' }, { name: 'Id' }],
      rows: [['alpha', 1]],
    });

    expect(rendered.split('\n')[0]).toBe('Name  Id');
    expect(rendered).toContain('(1 row)');
  });

  it('fills missing cells so sparse rows still align', () => {
    const rendered = renderPlainOutput({
      columns: [{ name: 'A' }, { name: 'B' }],
      rows: [
        ['x', null],
        ['y', undefined],
      ],
    });

    expect(rendered).toContain('x —');
    expect(rendered).toContain('y —');
  });

  it('renders an array of flat records as a table', () => {
    const rendered = renderPlainOutput([
      { name: 'adventure-works-dw-2020', type: 'fabric-semanticmodel' },
      { name: 'sales', type: 'kusto' },
    ]);

    const lines = rendered.split('\n');
    expect(lines[0]).toBe('name                    type');
    expect(lines[2]).toBe('adventure-works-dw-2020 fabric-semanticmodel');
    expect(rendered).toContain('(2 rows)');
  });

  it('unions record keys in first-seen order', () => {
    const rendered = renderPlainOutput([{ a: 1 }, { b: 2 }]);

    expect(rendered.split('\n')[0]).toBe('a b');
    expect(rendered).toContain('1 —');
    expect(rendered).toContain('— 2');
  });

  it('renders a flat object as key/value lines', () => {
    const rendered = renderPlainOutput({ status: 'ok', requestId: 'req-2' });

    expect(rendered).toBe('status    : ok\nrequestId : req-2');
  });

  it('passes strings through untouched', () => {
    expect(renderPlainOutput('already rendered')).toBe('already rendered');
  });

  it('renders scalars without quoting', () => {
    expect(renderPlainOutput(42)).toBe('42');
    expect(renderPlainOutput(true)).toBe('true');
  });

  it('returns an empty string for nullish payloads', () => {
    expect(renderPlainOutput(null)).toBe('');
    expect(renderPlainOutput(undefined)).toBe('');
  });

  it('falls back to pretty JSON for nested shapes it cannot tabulate', () => {
    const payload = { result: { nested: { deep: true } } };

    expect(renderPlainOutput(payload)).toBe(JSON.stringify(payload, null, 2));
  });
});
