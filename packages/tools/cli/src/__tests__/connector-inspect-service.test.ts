import { InvocationContext } from '@microsoft/rayfin-tools-common/_internal/telemetry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `service.ts` executes queries via dynamically imported functions in
// `schema-discovery.js`; mock only at that boundary.
const mocks = vi.hoisted(() => ({
  getFabricItemById: vi.fn().mockResolvedValue({ type: 'SQLDatabase' }),
  getConnectionStringByType: vi.fn().mockResolvedValue({
    connectionString: 'test-host.fabric.microsoft.com,1433',
    resolvedItemId: 'item-1',
  }),
  parseConnectionString: vi
    .fn()
    .mockReturnValue({ host: 'test-host.fabric.microsoft.com', port: 1433 }),
  runSqlQueryPreview: vi.fn(),
}));

vi.mock('../services/fabric/rayfin-item.js', () => ({
  RayfinItemManager: vi.fn().mockImplementation(() => ({
    getFabricItemById: mocks.getFabricItemById,
  })),
}));

vi.mock('../services/fabric/sql-endpoint.js', () => ({
  SqlEndpointManager: vi.fn().mockImplementation(() => ({
    getConnectionStringByType: mocks.getConnectionStringByType,
  })),
}));

vi.mock('../services/schema-discovery.js', () => ({
  parseConnectionString: mocks.parseConnectionString,
  runSqlQueryPreview: mocks.runSqlQueryPreview,
}));

import {
  MULTIPLE_SQL_RESULT_SETS_MESSAGE,
  MULTIPLE_SQL_RESULT_SETS_RECOVERY,
  MultipleSqlResultSetsError,
} from '../services/connectors/inspect/contract';
import {
  ConnectorInspectError,
  runConnectorInspect,
  type ConnectorInspectInput,
} from '../services/connectors/inspect/service';
import { setCurrentContext } from '../telemetry/context-store.js';

function sqlInput(
  overrides: Partial<ConnectorInspectInput> = {}
): ConnectorInspectInput {
  return {
    connectorType: 'fabric-sqldatabase',
    workspaceId: 'ws-1',
    itemId: 'item-1',
    rows: 10,
    mode: 'structured',
    token: 'user-token',
    ...overrides,
  };
}

describe('runConnectorInspect — SQL family', () => {
  beforeEach(() => {
    mocks.runSqlQueryPreview.mockReset();
  });

  it('auto-resolves a bare entity to its schema and returns the JSON contract shape', async () => {
    mocks.runSqlQueryPreview
      .mockResolvedValueOnce({
        columns: [],
        rows: [{ TABLE_SCHEMA: 'SalesLT', TABLE_NAME: 'Customer' }],
      })
      .mockResolvedValueOnce({
        columns: [{ name: 'Id', type: 'unknown' }],
        rows: [{ Id: 1 }, { Id: 2 }],
      });

    const result = await runConnectorInspect(sqlInput({ entity: 'Customer' }));

    expect(result.connectorType).toBe('fabric-sqldatabase');
    expect(result.queryMode).toBe('structured');
    expect(result.entity).toBe('SalesLT.Customer');
    expect(result.rows).toEqual([{ Id: 1 }, { Id: 2 }]);
    expect(result.truncated).toBe(false);

    // Structured mode translation table: schema-qualified TOP query. The cap
    // is rows + 1 so a probe row is available for truncation detection.
    expect(mocks.runSqlQueryPreview.mock.calls[1]![0].query).toBe(
      'SELECT TOP (11) * FROM [SalesLT].[Customer]'
    );
  });

  it("corrects entity casing to the database's actual casing regardless of collation (Warehouse/Lakehouse are case-sensitive, unlike SQL Database)", async () => {
    mocks.runSqlQueryPreview
      .mockResolvedValueOnce({
        columns: [],
        rows: [{ TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Geography' }],
      })
      .mockResolvedValueOnce({
        columns: [{ name: 'Id', type: 'unknown' }],
        rows: [{ Id: 1 }],
      });

    const result = await runConnectorInspect(
      sqlInput({ connectorType: 'fabric-warehouse', entity: 'geography' })
    );

    expect(result.entity).toBe('dbo.Geography');
    // Uses the database's real casing in the final query, not the
    // user's lowercase input.
    expect(mocks.runSqlQueryPreview.mock.calls[1]![0].query).toBe(
      'SELECT TOP (11) * FROM [dbo].[Geography]'
    );
    // The lookup itself is case-insensitive so it matches on
    // case-sensitive-collation connectors too.
    expect(mocks.runSqlQueryPreview.mock.calls[0]![0].query).toBe(
      "SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE LOWER(TABLE_NAME) = LOWER('geography')"
    );
  });

  it('rejects an ambiguous bare entity that exists in more than one schema', async () => {
    mocks.runSqlQueryPreview.mockResolvedValueOnce({
      columns: [],
      rows: [
        { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Customer' },
        { TABLE_SCHEMA: 'SalesLT', TABLE_NAME: 'Customer' },
      ],
    });

    await expect(
      runConnectorInspect(sqlInput({ entity: 'Customer' }))
    ).rejects.toMatchObject({
      message: "Entity 'Customer' exists in multiple schemas: dbo, SalesLT.",
      recovery:
        'Disambiguate with a schema-qualified name, e.g. --entity dbo.Customer',
    });
  });

  it('caps and truncates rows beyond the requested sample size', async () => {
    mocks.runSqlQueryPreview
      .mockResolvedValueOnce({
        columns: [],
        rows: [{ TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Customer' }],
      })
      .mockResolvedValueOnce({
        columns: [{ name: 'Id', type: 'unknown' }],
        rows: [{ Id: 1 }, { Id: 2 }, { Id: 3 }],
      });

    const result = await runConnectorInspect(
      sqlInput({ entity: 'Customer', rows: 2 })
    );

    expect(result.rows).toEqual([{ Id: 1 }, { Id: 2 }]);
    expect(result.truncated).toBe(true);
  });

  // The in-query cap is deliberately one greater than the requested sample
  // size. Capping at exactly `rows` would return a full page with no way to
  // tell whether more data existed, so `truncated` could never be true.
  it('fetches one row beyond the requested cap so truncation stays detectable', async () => {
    mocks.runSqlQueryPreview
      .mockResolvedValueOnce({
        columns: [],
        rows: [{ TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Customer' }],
      })
      .mockResolvedValueOnce({
        columns: [{ name: 'Id', type: 'unknown' }],
        rows: [{ Id: 1 }],
      });

    await runConnectorInspect(sqlInput({ entity: 'Customer', rows: 5 }));

    expect(mocks.runSqlQueryPreview.mock.calls[1]![0].query).toBe(
      'SELECT TOP (6) * FROM [dbo].[Customer]'
    );
    expect(mocks.runSqlQueryPreview.mock.calls[1]![0].maxRows).toBe(6);
  });

  it('applies the same probe limit to the entity listing query', async () => {
    mocks.runSqlQueryPreview.mockResolvedValueOnce({
      columns: [{ name: 'TABLE_NAME', type: 'unknown' }],
      rows: [{ TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Customer' }],
    });

    await runConnectorInspect(sqlInput({ mode: 'entities', rows: 5 }));

    expect(mocks.runSqlQueryPreview.mock.calls[0]![0].query).toContain(
      'SELECT TOP (6)'
    );
  });

  it('rejects raw queries that do not start with SELECT or WITH', async () => {
    await expect(
      runConnectorInspect(
        sqlInput({ mode: 'raw', query: 'DELETE FROM Customer' })
      )
    ).rejects.toMatchObject({
      message:
        'Only read-only SQL is supported. Query must start with SELECT or WITH.',
    });
    expect(mocks.runSqlQueryPreview).not.toHaveBeenCalled();
  });

  it.each([
    '-- P0 aggregation coverage: table-wide\r\nSELECT COUNT(*) AS OrderCount, SUM(Amount) AS TotalAmount FROM dbo.SalesOrder;',
    '-- aggregation\rSELECT COUNT(*) FROM dbo.SalesOrder;',
    ' \n/* aggregation */\nSELECT COUNT(*) FROM dbo.SalesOrder;',
    '/* outer /* nested */ still a comment */ SELECT COUNT(*) FROM dbo.SalesOrder;',
    '/* outer /* nested /* DELETE */ UPDATE */ DROP */ WITH Orders AS (SELECT * FROM dbo.SalesOrder) SELECT COUNT(*) FROM Orders;',
    '-- first comment\n/* second comment */\nWITH Orders AS (SELECT * FROM dbo.SalesOrder) SELECT COUNT(*) FROM Orders;',
  ])('allows read-only SQL with leading comments: %s', async (query) => {
    mocks.runSqlQueryPreview.mockResolvedValueOnce({ columns: [], rows: [] });

    await runConnectorInspect(sqlInput({ mode: 'raw', query }));

    expect(mocks.runSqlQueryPreview).toHaveBeenCalledWith(
      expect.objectContaining({ query })
    );
  });

  it('preserves SQL column metadata when a raw query returns zero rows', async () => {
    mocks.runSqlQueryPreview.mockResolvedValueOnce({
      columns: [
        { name: 'Id', type: 'integer' },
        { name: 'BusinessDate', type: 'date' },
      ],
      rows: [],
    });

    const result = await runConnectorInspect(
      sqlInput({
        mode: 'raw',
        query: 'SELECT Id, BusinessDate FROM dbo.Customer WHERE 1 = 0',
      })
    );

    expect(result.columns).toEqual([
      { name: 'Id', type: 'integer' },
      { name: 'BusinessDate', type: 'date' },
    ]);
    expect(result.rows).toEqual([]);
  });

  it('surfaces driver rejection for newline-separated multiple result sets', async () => {
    mocks.runSqlQueryPreview.mockRejectedValueOnce(
      new MultipleSqlResultSetsError()
    );

    await expect(
      runConnectorInspect(
        sqlInput({
          mode: 'raw',
          query: 'SELECT 1 AS FirstValue\nSELECT 2 AS SecondValue',
        })
      )
    ).rejects.toMatchObject({
      message: MULTIPLE_SQL_RESULT_SETS_MESSAGE,
      recovery: MULTIPLE_SQL_RESULT_SETS_RECOVERY,
    });
  });

  it.each([
    '-- SELECT is only a comment\nDELETE FROM Customer',
    "/* SELECT */ UPDATE Customer SET Name = 'changed'",
    '-- SELECT 1',
    '/* SELECT 1 */',
    '/* outer /* SELECT 1 */ still a comment */ DELETE FROM Customer',
    '/* outer /* nested */ SELECT 1',
  ])('rejects non-read-only SQL after leading comments: %s', async (query) => {
    await expect(
      runConnectorInspect(sqlInput({ mode: 'raw', query }))
    ).rejects.toMatchObject({
      message:
        'Only read-only SQL is supported. Query must start with SELECT or WITH.',
    });
    expect(mocks.runSqlQueryPreview).not.toHaveBeenCalled();
  });

  it.each(['\r', '\n', '\r\n'])(
    'validates statements after line comments terminated by %j',
    async (lineEnding) => {
      await expect(
        runConnectorInspect(
          sqlInput({
            mode: 'raw',
            query: `SELECT 1 -- comment${lineEnding}; DELETE FROM Customer`,
          })
        )
      ).rejects.toMatchObject({
        message:
          'Only a single SQL statement is supported. Remove additional statements and retry.',
      });
      await expect(
        runConnectorInspect(
          sqlInput({
            mode: 'raw',
            query: `SELECT 1 -- comment${lineEnding}DELETE FROM Customer`,
          })
        )
      ).rejects.toMatchObject({
        message: 'Query contains blocked keyword: DELETE',
      });
      expect(mocks.runSqlQueryPreview).not.toHaveBeenCalled();
    }
  );

  it('rejects raw queries containing a blocked write/DDL keyword', async () => {
    await expect(
      runConnectorInspect(
        sqlInput({
          mode: 'raw',
          query: 'SELECT * FROM Customer DROP INDEX ix1',
        })
      )
    ).rejects.toMatchObject({
      message: 'Query contains blocked keyword: DROP',
      recovery: 'Rewrite the query as a read-only SELECT/EVALUATE statement.',
    });
    expect(mocks.runSqlQueryPreview).not.toHaveBeenCalled();
  });

  it('does not block a keyword that only appears inside a string literal', async () => {
    mocks.runSqlQueryPreview.mockResolvedValueOnce({
      columns: [{ name: 'Status', type: 'unknown' }],
      rows: [{ Status: 'DROP' }],
    });

    const result = await runConnectorInspect(
      sqlInput({
        mode: 'raw',
        query: "SELECT * FROM Customer WHERE Status = 'DROP'",
      })
    );

    expect(result.rows).toEqual([{ Status: 'DROP' }]);
  });

  it('rejects SELECT ... INTO queries that would create a table', async () => {
    await expect(
      runConnectorInspect(
        sqlInput({
          mode: 'raw',
          query: 'SELECT * INTO NewTable FROM Customer',
        })
      )
    ).rejects.toMatchObject({
      message: 'Query contains blocked keyword: INTO',
      recovery: 'Rewrite the query as a read-only SELECT/EVALUATE statement.',
    });
    expect(mocks.runSqlQueryPreview).not.toHaveBeenCalled();
  });

  it('rejects multiple statements separated by a semicolon', async () => {
    await expect(
      runConnectorInspect(
        sqlInput({
          mode: 'raw',
          query: 'SELECT * FROM Customer; SELECT * FROM Orders',
        })
      )
    ).rejects.toMatchObject({
      message:
        'Only a single SQL statement is supported. Remove additional statements and retry.',
    });
    expect(mocks.runSqlQueryPreview).not.toHaveBeenCalled();
  });

  it('rejects newline-separated multi-statement batches that bypass semicolon check', async () => {
    await expect(
      runConnectorInspect(
        sqlInput({
          mode: 'raw',
          query: 'SELECT 1\nGRANT SELECT ON schema::dbo TO [someone]',
        })
      )
    ).rejects.toMatchObject({
      message: 'Query contains blocked keyword: GRANT',
    });
    expect(mocks.runSqlQueryPreview).not.toHaveBeenCalled();
  });

  it('allows multiline CTE and UNION queries', async () => {
    mocks.runSqlQueryPreview.mockResolvedValue({ columns: [], rows: [] });

    await runConnectorInspect(
      sqlInput({
        mode: 'raw',
        query:
          'WITH CustomerIds AS (\n  SELECT Id FROM Customer\n)\nSELECT Id FROM CustomerIds',
      })
    );
    await runConnectorInspect(
      sqlInput({
        mode: 'raw',
        query:
          'SELECT Id FROM Customer\nUNION ALL\nSELECT Id FROM ArchivedCustomer',
      })
    );

    expect(mocks.runSqlQueryPreview).toHaveBeenCalledTimes(2);
  });

  it('rejects dangerous permission-alteration keywords without semicolon separators', async () => {
    await expect(
      runConnectorInspect(
        sqlInput({
          mode: 'raw',
          query: 'SELECT 1\nBACKUP DATABASE [db] TO DISK',
        })
      )
    ).rejects.toMatchObject({
      message: 'Query contains blocked keyword: BACKUP',
    });
    expect(mocks.runSqlQueryPreview).not.toHaveBeenCalled();
  });

  it('does not block a keyword that only appears inside a bracketed identifier', async () => {
    mocks.runSqlQueryPreview.mockResolvedValueOnce({
      columns: [{ name: 'Grant', type: 'unknown' }],
      rows: [{ Grant: 100 }],
    });

    const result = await runConnectorInspect(
      sqlInput({ mode: 'raw', query: 'SELECT [Grant] FROM Funding' })
    );

    expect(result.rows).toEqual([{ Grant: 100 }]);
  });

  it('correctly closes a bracketed identifier containing an escaped `]]`, not exposing text after it', async () => {
    mocks.runSqlQueryPreview.mockResolvedValueOnce({ columns: [], rows: [] });

    await runConnectorInspect(
      sqlInput({ mode: 'raw', query: 'SELECT [a]]grant] FROM t' })
    );

    expect(mocks.runSqlQueryPreview).toHaveBeenCalledTimes(1);
  });

  it('does not block a keyword that only appears inside a double-quoted identifier', async () => {
    mocks.runSqlQueryPreview.mockResolvedValueOnce({
      columns: [{ name: 'Grant', type: 'unknown' }],
      rows: [{ Grant: 100 }],
    });

    const result = await runConnectorInspect(
      sqlInput({ mode: 'raw', query: 'SELECT "Grant" FROM Funding' })
    );

    expect(result.rows).toEqual([{ Grant: 100 }]);
  });

  it('correctly closes a double-quoted identifier containing a doubled `""` escape, not exposing text after it', async () => {
    mocks.runSqlQueryPreview.mockResolvedValueOnce({ columns: [], rows: [] });

    await runConnectorInspect(
      sqlInput({ mode: 'raw', query: 'SELECT "a""b" FROM t' })
    );

    expect(mocks.runSqlQueryPreview).toHaveBeenCalledTimes(1);
  });

  it('rejects a write batch hidden by a backslash inside a double-quoted identifier (previously a working bypass)', async () => {
    await expect(
      runConnectorInspect(
        sqlInput({
          mode: 'raw',
          query: 'SELECT 1 AS "x\\"; GRANT CONTROL TO evil; --"',
        })
      )
    ).rejects.toMatchObject({
      message:
        'Only a single SQL statement is supported. Remove additional statements and retry.',
    });
    expect(mocks.runSqlQueryPreview).not.toHaveBeenCalled();
  });

  it('does not block a keyword that only appears inside a line comment', async () => {
    mocks.runSqlQueryPreview.mockResolvedValueOnce({
      columns: [{ name: 'Id', type: 'unknown' }],
      rows: [{ Id: 1 }],
    });

    const result = await runConnectorInspect(
      sqlInput({
        mode: 'raw',
        query: 'SELECT Id FROM Customer -- update the totals later',
      })
    );

    expect(result.rows).toEqual([{ Id: 1 }]);
  });

  it('rejects a DROP statement hidden between two comments whose apostrophes could be paired as a string', async () => {
    await expect(
      runConnectorInspect(
        sqlInput({
          mode: 'raw',
          query: "SELECT 1 -- '\nDROP TABLE dbo.Target\n-- '",
        })
      )
    ).rejects.toMatchObject({
      message: 'Query contains blocked keyword: DROP',
    });
    expect(mocks.runSqlQueryPreview).not.toHaveBeenCalled();
  });

  it('does not treat a semicolon inside a line comment as a second statement', async () => {
    mocks.runSqlQueryPreview.mockResolvedValueOnce({ columns: [], rows: [] });

    await runConnectorInspect(
      sqlInput({
        mode: 'raw',
        query: 'SELECT 1 -- note; and more',
      })
    );

    expect(mocks.runSqlQueryPreview).toHaveBeenCalledTimes(1);
  });

  it('does not treat a semicolon inside a bracketed identifier as a second statement', async () => {
    mocks.runSqlQueryPreview.mockResolvedValueOnce({ columns: [], rows: [] });

    await runConnectorInspect(
      sqlInput({ mode: 'raw', query: 'SELECT [a;b] FROM t' })
    );

    expect(mocks.runSqlQueryPreview).toHaveBeenCalledTimes(1);
  });

  it('does not treat a semicolon inside a block comment as a second statement', async () => {
    mocks.runSqlQueryPreview.mockResolvedValueOnce({ columns: [], rows: [] });

    await runConnectorInspect(
      sqlInput({ mode: 'raw', query: 'SELECT 1 /* a; b */ FROM t' })
    );

    expect(mocks.runSqlQueryPreview).toHaveBeenCalledTimes(1);
  });

  it('rejects stored procedure invocations that were previously not in the denylist', async () => {
    await expect(
      runConnectorInspect(
        sqlInput({
          mode: 'raw',
          query: 'SELECT * FROM Customer sp_executesql',
        })
      )
    ).rejects.toMatchObject({
      message: 'Query contains blocked keyword: SP_EXECUTESQL',
    });
    expect(mocks.runSqlQueryPreview).not.toHaveBeenCalled();
  });

  it('rejects extended stored procedure invocations', async () => {
    await expect(
      runConnectorInspect(
        sqlInput({
          mode: 'raw',
          query: 'SELECT * FROM Customer xp_cmdshell',
        })
      )
    ).rejects.toMatchObject({
      message: 'Query contains blocked keyword: XP_CMDSHELL',
    });
    expect(mocks.runSqlQueryPreview).not.toHaveBeenCalled();
  });

  it('does not treat a semicolon inside a string literal as a second statement', async () => {
    mocks.runSqlQueryPreview.mockResolvedValueOnce({
      columns: [{ name: 'Id', type: 'unknown' }],
      rows: [{ Id: 1 }],
    });

    const result = await runConnectorInspect(
      sqlInput({
        mode: 'raw',
        query: "SELECT * FROM Customer WHERE Name = 'foo;bar'",
      })
    );

    expect(result.rows).toEqual([{ Id: 1 }]);
  });

  it('categorizes a SQL permission-denied error per the RFC error model', async () => {
    mocks.runSqlQueryPreview.mockRejectedValueOnce(
      Object.assign(new Error('SELECT permission was denied on the object'), {
        number: 229,
      })
    );

    await expect(
      runConnectorInspect(
        sqlInput({ mode: 'raw', query: 'SELECT * FROM Customer' })
      )
    ).rejects.toMatchObject({
      message: 'Permission denied: SELECT permission was denied on the object',
      recovery: 'Request required source permissions for this workspace/item.',
    });
  });

  it('falls back to a generic recovery hint for uncategorized SQL errors', async () => {
    mocks.runSqlQueryPreview.mockRejectedValueOnce(
      new Error('Invalid object name')
    );

    await expect(
      runConnectorInspect(
        sqlInput({ mode: 'raw', query: 'SELECT * FROM Customer' })
      )
    ).rejects.toMatchObject({
      message: 'Invalid object name',
      recovery:
        'Verify the entity/table name exists and that you have access, then retry.',
    });
  });

  it('reports connection, query, and row-count details to `log` when provided', async () => {
    mocks.runSqlQueryPreview.mockResolvedValueOnce({
      columns: [{ name: 'Id', type: 'unknown' }],
      rows: [{ Id: 1 }],
    });
    const log = vi.fn();

    await runConnectorInspect(
      sqlInput({
        mode: 'raw',
        query: "SELECT * FROM Customer WHERE Name = 'Alice'",
        log,
      })
    );

    const messages = log.mock.calls.map((call) => call[0] as string);
    expect(messages).toEqual([
      expect.stringContaining(
        'Resolved SQL connection: host=test-host.fabric.microsoft.com'
      ),
      expect.stringContaining(
        "Executing query: SELECT * FROM Customer WHERE Name = '***'"
      ),
      expect.stringContaining('Query returned 1 row(s)'),
    ]);
    // Sensitive literal must never reach the log, only the redacted form.
    expect(messages.join('\n')).not.toContain('Alice');
  });

  it('logs the schema-lookup failure before falling back to the unqualified entity', async () => {
    mocks.runSqlQueryPreview
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockResolvedValueOnce({
        columns: [{ name: 'Id', type: 'unknown' }],
        rows: [{ Id: 1 }],
      });
    const log = vi.fn();

    const result = await runConnectorInspect(
      sqlInput({ entity: 'Customer', log })
    );

    expect(result.entity).toBe('Customer');
    const messages = log.mock.calls.map((call) => call[0] as string);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "Schema lookup for 'Customer' failed, falling back to unqualified name: permission denied"
        ),
      ])
    );
  });

  it('does not invoke query execution logging when `log` is omitted', async () => {
    mocks.runSqlQueryPreview.mockResolvedValueOnce({ columns: [], rows: [] });

    await expect(
      runConnectorInspect(
        sqlInput({ mode: 'raw', query: 'SELECT * FROM Customer' })
      )
    ).resolves.toBeDefined();
  });
});

function jsonResponse(status: number, body: unknown, activityId?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'status',
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'x-ms-root-activity-id'
          ? (activityId ?? null)
          : null,
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe('runConnectorInspect — semantic model', () => {
  const fetchMock = vi.fn();
  let context: InvocationContext;

  beforeEach(() => {
    fetchMock.mockReset();
    context = new InvocationContext('rayfin-cli', '1.0.0');
    setCurrentContext(context);
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    setCurrentContext(undefined);
    vi.restoreAllMocks();
  });

  it('builds an EVALUATE TOPN query and returns the JSON contract shape', async () => {
    const response = jsonResponse(
      200,
      {
        results: [{ tables: [{ rows: [{ StudentId: 1, Name: 'A' }] }] }],
      },
      'inspect-activity-1'
    );
    fetchMock.mockResolvedValueOnce(response);

    const result = await runConnectorInspect({
      connectorType: 'fabric-semanticmodel',
      workspaceId: 'ws-1',
      itemId: 'item-1',
      rows: 10,
      mode: 'structured',
      entity: 'Students',
      token: 'user-token',
    });

    expect(result.rows).toEqual([{ StudentId: 1, Name: 'A' }]);
    expect(result.truncated).toBe(false);
    expect(result.columns).toEqual([
      { name: 'StudentId', type: 'unknown' },
      { name: 'Name', type: 'unknown' },
    ]);

    const [, requestInit] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((requestInit as RequestInit).body as string);
    expect(body.queries[0].query).toBe("EVALUATE TOPN(11, 'Students')");
    expect(
      context.finalize({
        osType: 'linux',
        osVersion: 'test',
        nodeVersion: 'test',
      }).properties?.fabric_activity_ids
    ).toBe('["inspect-activity-1"]');
  });

  it('rejects raw DAX queries that do not start with EVALUATE', async () => {
    await expect(
      runConnectorInspect({
        connectorType: 'fabric-semanticmodel',
        workspaceId: 'ws-1',
        itemId: 'item-1',
        rows: 10,
        mode: 'raw',
        query: 'DEFINE MEASURE Foo = 1',
        token: 'user-token',
      })
    ).rejects.toMatchObject({
      message:
        'Only read-only DAX is supported. Query must start with EVALUATE.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a 401 response to a login recovery hint', async () => {
    const response = jsonResponse(
      401,
      { error: { message: 'token expired' } },
      'inspect-activity-2'
    );
    fetchMock.mockResolvedValueOnce(response);

    await expect(
      runConnectorInspect({
        connectorType: 'fabric-semanticmodel',
        workspaceId: 'ws-1',
        itemId: 'item-1',
        rows: 10,
        mode: 'structured',
        entity: 'Students',
        token: 'user-token',
      })
    ).rejects.toMatchObject({
      message: 'Semantic model query failed (401): token expired',
      recovery: 'Run `rayfin login` to refresh your session.',
    });
    expect(
      context.finalize({
        osType: 'linux',
        osVersion: 'test',
        nodeVersion: 'test',
      }).properties?.fabric_activity_ids
    ).toBe('["inspect-activity-2"]');
  });

  it('maps a 403 response to a permission recovery hint', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { error: { message: 'insufficient permissions' } })
    );

    await expect(
      runConnectorInspect({
        connectorType: 'fabric-semanticmodel',
        workspaceId: 'ws-1',
        itemId: 'item-1',
        rows: 10,
        mode: 'structured',
        entity: 'Students',
        token: 'user-token',
      })
    ).rejects.toMatchObject({
      recovery: 'Request required source permissions for this workspace/item.',
    });
  });

  it('truncates rows beyond the requested sample size', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        results: [
          {
            tables: [
              {
                rows: [{ StudentId: 1 }, { StudentId: 2 }, { StudentId: 3 }],
              },
            ],
          },
        ],
      })
    );

    const result = await runConnectorInspect({
      connectorType: 'fabric-semanticmodel',
      workspaceId: 'ws-1',
      itemId: 'item-1',
      rows: 2,
      mode: 'structured',
      entity: 'Students',
      token: 'user-token',
    });

    expect(result.rows).toEqual([{ StudentId: 1 }, { StudentId: 2 }]);
    expect(result.truncated).toBe(true);
  });
});

describe('runConnectorInspect — unsupported connector type', () => {
  it('rejects a connector type with no registered provider', async () => {
    await expect(
      runConnectorInspect({
        connectorType:
          'fabric-lakehouse' as ConnectorInspectInput['connectorType'],
        workspaceId: 'ws-1',
        itemId: 'item-1',
        rows: 10,
        mode: 'structured',
        entity: 'Students',
        token: 'user-token',
      })
    ).rejects.toThrow('Unsupported connector type: fabric-lakehouse');
  });
});

// Sanity check that the error class carries the recovery hint used by the
// command layer to render the `❌ <message>` + indented hint pair.
describe('ConnectorInspectError', () => {
  it('exposes both message and recovery', () => {
    const error = new ConnectorInspectError('boom', 'try again');
    expect(error.message).toBe('boom');
    expect(error.recovery).toBe('try again');
    expect(error.name).toBe('ConnectorInspectError');
  });
});
