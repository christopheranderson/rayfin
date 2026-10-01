import { describe, expect, it } from 'vitest';

import {
  formatConnectorInspectColumns,
  formatConnectorInspectValue,
} from '../services/connectors/inspect/format';

describe('formatConnectorInspectColumns', () => {
  it('formats a typed zero-row column contract', () => {
    expect(
      formatConnectorInspectColumns([
        { name: 'Id', type: 'integer' },
        { name: 'BusinessDate', type: 'date' },
      ])
    ).toEqual(['Columns: Id (integer), BusinessDate (date)']);
  });

  it('folds a wide column contract between entries', () => {
    expect(
      formatConnectorInspectColumns(
        [
          { name: 'Id', type: 'integer' },
          { name: 'BusinessDate', type: 'date' },
        ],
        24
      )
    ).toEqual(['Columns: Id (integer)', '         BusinessDate (date)']);
  });
});

describe('formatConnectorInspectValue', () => {
  it('formats SQL date, time, and datetime values by their metadata type', () => {
    expect(
      formatConnectorInspectValue(new Date('2026-01-15T00:00:00.000Z'), 'date')
    ).toBe('2026-01-15');
    expect(
      formatConnectorInspectValue(new Date('1970-01-01T09:00:00.000Z'), 'time')
    ).toBe('09:00:00.000');
    expect(
      formatConnectorInspectValue(new Date('1970-01-01T00:00:00.000Z'), 'time')
    ).toBe('00:00:00.000');
    expect(
      formatConnectorInspectValue(new Date('1970-01-01T23:59:59.999Z'), 'time')
    ).toBe('23:59:59.999');
    expect(
      formatConnectorInspectValue(
        new Date('2026-01-15T00:30:00.000Z'),
        'datetime'
      )
    ).toBe('2026-01-15T00:30:00.000Z');
  });

  it('renders binary and unknown buffers as terminal-safe hexadecimal', () => {
    const binary = formatConnectorInspectValue(
      Buffer.from([0x00, 0x07, 0xff]),
      'binary'
    );
    const unknown = formatConnectorInspectValue(
      Buffer.from([0x00, 0x07, 0xff]),
      'unknown'
    );

    expect(binary).toBe('0x0007ff');
    expect(unknown).toBe('0x0007ff');
    expect(
      [...binary].some((character) => character.charCodeAt(0) < 0x20)
    ).toBe(false);
    expect(
      [...unknown].some((character) => character.charCodeAt(0) < 0x20)
    ).toBe(false);
  });

  it('preserves an invalid Date as printable text', () => {
    expect(formatConnectorInspectValue(new Date('invalid'), 'datetime')).toBe(
      'Invalid Date'
    );
  });
});
