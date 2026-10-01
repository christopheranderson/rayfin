import { describe, expect, it } from 'vitest';

import { toQueryResult } from './queryResult';
import type { FabricSemanticModelTabularResponse } from './types';

function envelope(
  output: Partial<FabricSemanticModelTabularResponse['output']>,
  overrides: Partial<FabricSemanticModelTabularResponse> = {}
): FabricSemanticModelTabularResponse {
  return {
    status: 'Succeeded',
    errors: [],
    output: { tables: [], ...output },
    ...overrides,
  };
}

describe('toQueryResult', () => {
  it('produces a success result with inferred columns and column-aligned rows', () => {
    const response = envelope({
      requestId: 'req-1',
      tables: [
        {
          rows: [
            { 'credit_score[Age]': 37, 'credit_score[Balance]': 0 },
            { 'credit_score[Age]': 42, 'credit_score[Balance]': 1500.5 },
          ],
        },
      ],
    });

    const result = toQueryResult(response);

    expect(result).toEqual({
      status: 'success',
      requestId: 'req-1',
      table: {
        columns: [
          { name: 'credit_score[Age]', dataType: 'unknown' },
          { name: 'credit_score[Balance]', dataType: 'unknown' },
        ],
        rows: [
          [37, 0],
          [42, 1500.5],
        ],
      },
    });
  });

  it('returns success with empty columns and rows when the table has no rows', () => {
    const response = envelope({
      requestId: 'req-empty',
      tables: [{ rows: [] }],
    });

    const result = toQueryResult(response);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.table).toEqual({ columns: [], rows: [] });
    }
  });

  it('returns success with empty columns and rows when output has no tables', () => {
    const response = envelope({ requestId: 'req-none' });

    const result = toQueryResult(response);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.table).toEqual({ columns: [], rows: [] });
    }
  });

  it('treats null queryError and null responseError as absent', () => {
    const response = envelope({
      requestId: 'req-2',
      queryError: null,
      responseError: null,
      tables: [{ rows: [{ 'T[A]': 1 }] }],
    });

    expect(toQueryResult(response).status).toBe('success');
  });

  it('uses wire-provided column metadata when present', () => {
    const response = envelope({
      requestId: 'req-cols',
      tables: [
        {
          columns: [
            { name: 'Sales[Year]', dataType: 'Int64' },
            { name: 'Sales[Amount]', dataType: 'Double' },
          ],
          rows: [{ 'Sales[Year]': 2026, 'Sales[Amount]': 12.5 }],
        },
      ],
    });

    const result = toQueryResult(response);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.table.columns).toEqual([
        { name: 'Sales[Year]', dataType: 'Int64' },
        { name: 'Sales[Amount]', dataType: 'Double' },
      ]);
      expect(result.table.rows).toEqual([[2026, 12.5]]);
    }
  });

  it('defaults dataType to "unknown" when wire column omits it', () => {
    const response = envelope({
      tables: [{ columns: [{ name: 'T[A]' }], rows: [{ 'T[A]': 1 }] }],
    });

    const result = toQueryResult(response);

    if (result.status === 'success') {
      expect(result.table.columns[0]?.dataType).toBe('unknown');
    }
  });

  it('fills missing cells with null to keep rows column-aligned', () => {
    const response = envelope({
      tables: [
        {
          rows: [
            { 'T[A]': 1, 'T[B]': 2 },
            { 'T[A]': 3 }, // missing T[B]
          ],
        },
      ],
    });

    const result = toQueryResult(response);

    if (result.status === 'success') {
      expect(result.table.rows).toEqual([
        [1, 2],
        [3, null],
      ]);
    }
  });

  it('categorises responseError as "api"', () => {
    const response = envelope({
      requestId: 'req-resp',
      responseError: { code: 'AuthFailed', message: 'Not authorised' },
    });

    expect(toQueryResult(response)).toEqual({
      status: 'error',
      requestId: 'req-resp',
      error: { category: 'api', code: 'AuthFailed', message: 'Not authorised' },
    });
  });

  it('categorises queryError as "query"', () => {
    const response = envelope({
      requestId: 'req-q',
      queryError: { code: 'DAX', message: 'Syntax error' },
    });

    expect(toQueryResult(response)).toEqual({
      status: 'error',
      requestId: 'req-q',
      error: { category: 'query', code: 'DAX', message: 'Syntax error' },
    });
  });

  it('categorises a per-table error as "overflow"', () => {
    const response = envelope({
      requestId: 'req-of',
      tables: [
        {
          rows: [{ 'T[A]': 1 }],
          error: { message: 'More than 1000000 rows in a query result' },
        },
      ],
    });

    expect(toQueryResult(response)).toEqual({
      status: 'error',
      requestId: 'req-of',
      error: {
        category: 'overflow',
        message: 'More than 1000000 rows in a query result',
      },
    });
  });

  it('prefers FuncSet errors[] over output-level errors', () => {
    const response = envelope(
      {
        queryError: { message: 'this should be ignored' },
      },
      { errors: [{ message: 'transport down' }] }
    );

    const result = toQueryResult(response);

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error).toEqual({
        category: 'api',
        message: 'transport down',
      });
    }
  });

  it('parses JSON-encoded RuntimeError messages from the UDF', () => {
    const response = envelope(
      {},
      {
        errors: [
          {
            message: JSON.stringify({
              httpStatus: 400,
              code: 'PowerBINotAuthorizedException',
              message: 'The user does not have access to the dataset.',
              requestId: 'pbi-req-7',
            }),
          },
        ],
      }
    );

    const result = toQueryResult(response);

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error).toEqual({
        category: 'api',
        code: 'PowerBINotAuthorizedException',
        message: 'The user does not have access to the dataset.',
      });
    }
  });

  it('falls back to httpStatus as the code when the parsed payload has no code', () => {
    const response = envelope(
      {},
      {
        errors: [
          {
            message: JSON.stringify({ httpStatus: 503, message: 'Throttled' }),
          },
        ],
      }
    );

    const result = toQueryResult(response);

    if (result.status === 'error') {
      expect(result.error).toEqual({
        category: 'api',
        code: '503',
        message: 'Throttled',
      });
    }
  });

  it('handles a plain string FuncSet error entry', () => {
    const response = envelope({}, { errors: ['Boom'] });

    const result = toQueryResult(response);

    if (result.status === 'error') {
      expect(result.error).toEqual({ category: 'api', message: 'Boom' });
    }
  });

  it('handles a FuncSet error entry without a message field', () => {
    const response = envelope({}, { errors: [{ unrelated: true }] });

    const result = toQueryResult(response);

    if (result.status === 'error') {
      expect(result.error).toEqual({
        category: 'api',
        message: 'Connector returned an error.',
      });
    }
  });

  it('defaults requestId to empty string when the adapter omits it', () => {
    const response = envelope({
      tables: [{ rows: [{ 'T[A]': 1 }] }],
    });

    expect(toQueryResult(response).requestId).toBe('');
  });

  it('omits the code field on errors when none was provided', () => {
    const response = envelope({
      queryError: { message: 'Bad DAX' },
    });

    const result = toQueryResult(response);

    if (result.status === 'error') {
      expect(result.error).not.toHaveProperty('code');
      expect(result.error.message).toBe('Bad DAX');
    }
  });
});

describe('engine highlight markup', () => {
  it('strips <ccon> markers from a query error message', () => {
    const response = envelope({
      queryError: {
        message:
          "Query (1, 10) Failed to resolve name '<ccon>NoSuchTableHere</ccon>'. It is not a valid table, variable or function name.",
      },
    });

    const result = toQueryResult(response);

    if (result.status === 'error') {
      expect(result.error.message).toBe(
        "Query (1, 10) Failed to resolve name 'NoSuchTableHere'. It is not a valid table, variable or function name."
      );
    }
  });

  it('strips markers from the details field', () => {
    const response = envelope({
      queryError: {
        message: 'Bad DAX',
        details: 'Table <ccon>Sales</ccon> was not found.',
      },
    });

    const result = toQueryResult(response);

    if (result.status === 'error') {
      expect(result.error.details).toBe('Table Sales was not found.');
    }
  });

  it('strips the wider marker family case-insensitively', () => {
    const response = envelope({
      queryError: {
        message:
          '<PII>alice@contoso.com</PII> hit <oii>Model</oii><crlf><ii>x</ii>',
      },
    });

    const result = toQueryResult(response);

    if (result.status === 'error') {
      expect(result.error.message).toBe('alice@contoso.com hit Model\nx');
    }
  });

  it('turns line-break markers into newlines rather than dropping them', () => {
    const response = envelope({
      queryError: {
        message: 'Query (1, 8) failed.<crlf>Table <ccon>Sales</ccon> missing.',
      },
    });

    const result = toQueryResult(response);

    if (result.status === 'error') {
      expect(result.error.message).toBe(
        'Query (1, 8) failed.\nTable Sales missing.'
      );
    }
  });

  it('collapses a paired line-break marker into a single newline', () => {
    const response = envelope({
      queryError: { message: 'first<crlf></crlf>second' },
    });

    const result = toQueryResult(response);

    if (result.status === 'error') {
      expect(result.error.message).toBe('first\nsecond');
    }
  });

  it('strips markers from top-level errors entries', () => {
    const response = envelope(
      {},
      { errors: [{ message: 'Transport <ccon>down</ccon>' }] }
    );

    const result = toQueryResult(response);

    if (result.status === 'error') {
      expect(result.error.message).toBe('Transport down');
    }
  });

  it('leaves ordinary angle brackets untouched', () => {
    const response = envelope({
      queryError: { message: 'Expected value < 10 and > 2 for <column>' },
    });

    const result = toQueryResult(response);

    if (result.status === 'error') {
      expect(result.error.message).toBe(
        'Expected value < 10 and > 2 for <column>'
      );
    }
  });
});
