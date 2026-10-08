import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { TYPE } from 'tedious/lib/data-type.js';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

interface MockTediousConnectionConfig {
  options: {
    encrypt?: boolean;
    useUTC?: boolean;
  };
}

interface MockTediousResultSet {
  columns: { colName: string; typeName: string }[];
  rows: unknown[][];
  createRows?: (config: MockTediousConnectionConfig) => unknown[][];
}

interface MockTediousScenario {
  resultSets: MockTediousResultSet[];
  completeAsync?: boolean;
}

const tediousMocks = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  const scenarios: MockTediousScenario[] = [];

  class MockRequest {
    private readonly listeners = new Map<string, Listener[]>();

    constructor(
      readonly sql: string,
      private readonly completeRequest: (
        error: Error | null | undefined
      ) => void
    ) {}

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emitEvent(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args);
      }
    }

    complete(error?: Error | null): void {
      this.completeRequest(error);
    }
  }

  class MockConnection {
    static readonly configs: MockTediousConnectionConfig[] = [];
    static readonly instances: MockConnection[] = [];

    private readonly listeners = new Map<string, Listener[]>();
    cancelCount = 0;
    private cancelled = false;

    constructor(readonly config: MockTediousConnectionConfig) {
      MockConnection.configs.push(config);
      MockConnection.instances.push(this);
    }

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    connect(): void {
      for (const listener of this.listeners.get('connect') ?? []) {
        listener(undefined);
      }
    }

    execSql(request: MockRequest): void {
      const scenario = scenarios.shift();
      if (!scenario) {
        request.complete(new Error('No Tedious mock scenario queued.'));
        return;
      }

      const run = () => {
        for (const resultSet of scenario.resultSets) {
          const metadata = resultSet.columns.map((column) => ({
            colName: column.colName,
            type: { name: column.typeName },
          }));
          request.emitEvent('columnMetadata', metadata);
          if (this.cancelled) {
            break;
          }
          const rows = resultSet.createRows?.(this.config) ?? resultSet.rows;
          for (const values of rows) {
            request.emitEvent(
              'row',
              metadata.map((column, index) => ({
                metadata: column,
                value: values[index],
              }))
            );
            if (this.cancelled) {
              break;
            }
          }
          if (this.cancelled) {
            break;
          }
        }
        request.complete(
          this.cancelled ? new Error('Request cancelled by connection.') : null
        );
      };
      if (scenario.completeAsync) {
        globalThis.queueMicrotask(run);
      } else {
        run();
      }
    }

    cancel(): void {
      this.cancelCount++;
      this.cancelled = true;
    }

    close(): void {}
  }

  return {
    Connection: MockConnection,
    Request: MockRequest,
    queueScenario: (scenario: MockTediousScenario) => {
      scenarios.push(scenario);
    },
    connectionConfigs: MockConnection.configs,
    connections: MockConnection.instances,
    reset: () => {
      scenarios.length = 0;
      MockConnection.configs.length = 0;
      MockConnection.instances.length = 0;
    },
  };
});

vi.mock('tedious', async (importOriginal) => {
  const actual = await importOriginal<typeof import('tedious')>();
  return {
    ...actual,
    Connection: tediousMocks.Connection,
    Request: tediousMocks.Request,
  };
});

import {
  MULTIPLE_SQL_RESULT_SETS_MESSAGE,
  MultipleSqlResultSetsError,
} from '../services/connectors/inspect/contract';
import { formatConnectorInspectValue } from '../services/connectors/inspect/format';
import {
  applyServerGeneration,
  columnRowToEntry,
  normalizeSqlColumnType,
  parseConnectionString,
  runSqlQueryPreview,
  writeMetadataFile,
} from '../services/schema-discovery';
import type {
  ColumnEntry,
  ColumnRow,
  SchemaMetadata,
  ServerGenRow,
} from '../services/schema-discovery';

describe('SQL query preview metadata', () => {
  beforeEach(() => {
    tediousMocks.reset();
  });

  it.each([
    ['TinyInt', 'integer'],
    ['SmallInt', 'integer'],
    ['Int', 'integer'],
    ['BigInt', 'integer'],
    ['IntN', 'integer'],
    ['Decimal', 'decimal'],
    ['Numeric', 'decimal'],
    ['SmallMoney', 'decimal'],
    ['Money', 'decimal'],
    ['DecimalN', 'decimal'],
    ['NumericN', 'decimal'],
    ['MoneyN', 'decimal'],
    ['Real', 'floating-point'],
    ['Float', 'floating-point'],
    ['FloatN', 'floating-point'],
    ['Char', 'text'],
    ['VarChar', 'text'],
    ['Text', 'text'],
    ['NChar', 'text'],
    ['NVarChar', 'text'],
    ['NText', 'text'],
    ['Xml', 'text'],
    ['Bit', 'boolean'],
    ['BitN', 'boolean'],
    ['Date', 'date'],
    ['Time', 'time'],
    ['SmallDateTime', 'datetime'],
    ['DateTime', 'datetime'],
    ['DateTimeN', 'datetime'],
    ['DateTime2', 'datetime'],
    ['DateTimeOffset', 'datetime'],
    ['UniqueIdentifier', 'uniqueidentifier'],
    ['Binary', 'binary'],
    ['VarBinary', 'binary'],
    ['Image', 'binary'],
    ['Null', 'unknown'],
    ['UDT', 'unknown'],
    ['TVP', 'unknown'],
    ['Variant', 'unknown'],
    ['CustomGeography', 'unknown'],
  ] as const)(
    'normalizes Tedious %s metadata to %s',
    (driverType, expected) => {
      expect(normalizeSqlColumnType(driverType)).toBe(expected);
    }
  );

  it('normalizes every current Tedious TYPE entry or uses an explicit unknown allowlist', () => {
    const explicitlyUnknown = new Set(['Null', 'Variant', 'UDT', 'TVP']);

    for (const type of Object.values(TYPE)) {
      const normalized = normalizeSqlColumnType(type.name);
      if (explicitlyUnknown.has(type.name)) {
        expect(normalized, type.name).toBe('unknown');
      } else {
        expect(normalized, type.name).not.toBe('unknown');
      }
    }
  });

  it('returns normalized columns and populated rows from Tedious metadata', async () => {
    const businessDate = new Date('2026-01-15T00:00:00.000Z');
    const createdAt = new Date('2026-01-15T12:34:56.789Z');
    tediousMocks.queueScenario({
      resultSets: [
        {
          columns: [
            { colName: 'Id', typeName: 'IntN' },
            { colName: 'Amount', typeName: 'DecimalN' },
            { colName: 'Name', typeName: 'NVarChar' },
            { colName: 'Enabled', typeName: 'BitN' },
            { colName: 'BusinessDate', typeName: 'Date' },
            { colName: 'CreatedAt', typeName: 'DateTime2' },
            { colName: 'ExternalId', typeName: 'UniqueIdentifier' },
            { colName: 'Payload', typeName: 'VarBinary' },
            { colName: 'Location', typeName: 'UDT' },
          ],
          rows: [
            [
              7,
              12.5,
              'Ada',
              true,
              businessDate,
              createdAt,
              '70f3f872-01b4-45cf-a558-e84d60d12f12',
              Buffer.from([1, 2]),
              Buffer.from([3, 4]),
            ],
          ],
        },
      ],
    });

    const result = await runSqlQueryPreview({
      host: 'test-host',
      port: 1433,
      database: 'test-db',
      token: 'test-token',
      query: 'SELECT * FROM dbo.Example',
    });

    expect(result.columns).toEqual([
      { name: 'Id', type: 'integer' },
      { name: 'Amount', type: 'decimal' },
      { name: 'Name', type: 'text' },
      { name: 'Enabled', type: 'boolean' },
      { name: 'BusinessDate', type: 'date' },
      { name: 'CreatedAt', type: 'datetime' },
      { name: 'ExternalId', type: 'uniqueidentifier' },
      { name: 'Payload', type: 'binary' },
      { name: 'Location', type: 'unknown' },
    ]);
    expect(result.rows).toEqual([
      {
        Id: 7,
        Amount: 12.5,
        Name: 'Ada',
        Enabled: true,
        BusinessDate: businessDate,
        CreatedAt: createdAt,
        ExternalId: '70f3f872-01b4-45cf-a558-e84d60d12f12',
        Payload: Buffer.from([1, 2]),
        Location: Buffer.from([3, 4]),
      },
    ]);
    expect(tediousMocks.connectionConfigs[0]?.options.useUTC).toBe(true);
    expect(tediousMocks.connectionConfigs[0]?.options.encrypt).toBe(true);
  });

  it('returns columns from Tedious metadata when the result has zero rows', async () => {
    tediousMocks.queueScenario({
      resultSets: [
        {
          columns: [
            { colName: 'Id', typeName: 'Int' },
            { colName: 'BusinessDate', typeName: 'Date' },
          ],
          rows: [],
        },
      ],
    });

    const result = await runSqlQueryPreview({
      host: 'test-host',
      port: 1433,
      database: 'test-db',
      token: 'test-token',
      query: 'SELECT Id, BusinessDate FROM dbo.Example WHERE 1 = 0',
    });

    expect(result).toEqual({
      columns: [
        { name: 'Id', type: 'integer' },
        { name: 'BusinessDate', type: 'date' },
      ],
      rows: [],
    });
  });

  it('retains columns when maxRows cancels further row emission', async () => {
    tediousMocks.queueScenario({
      resultSets: [
        {
          columns: [{ colName: 'Id', typeName: 'Int' }],
          rows: [[1], [2], [3]],
        },
      ],
    });

    const result = await runSqlQueryPreview({
      host: 'test-host',
      port: 1433,
      database: 'test-db',
      token: 'test-token',
      query: 'SELECT Id FROM dbo.Example',
      maxRows: 1,
    });

    expect(result).toEqual({
      columns: [{ name: 'Id', type: 'integer' }],
      rows: [{ Id: 1 }],
    });
    expect(tediousMocks.connections[0]?.cancelCount).toBe(1);
  });

  it('matches row-object semantics for duplicate column names', async () => {
    tediousMocks.queueScenario({
      resultSets: [
        {
          columns: [
            { colName: 'TicketId', typeName: 'Int' },
            { colName: 'Status', typeName: 'NVarChar' },
            { colName: 'TicketId', typeName: 'NVarChar' },
          ],
          rows: [[7, 'open', 'ticket-7']],
        },
      ],
    });

    const result = await runSqlQueryPreview({
      host: 'test-host',
      port: 1433,
      database: 'test-db',
      token: 'test-token',
      query: 'SELECT TicketId, Status, TicketId FROM dbo.Ticket',
    });

    expect(result).toEqual({
      columns: [
        { name: 'TicketId', type: 'text' },
        { name: 'Status', type: 'text' },
      ],
      rows: [{ TicketId: 'ticket-7', Status: 'open' }],
    });
  });

  it.each(['America/Los_Angeles', 'Pacific/Kiritimati'])(
    'decodes SQL temporal values with the configured UTC semantics in %s',
    async (timeZone) => {
      const originalTimeZone = process.env.TZ;
      process.env.TZ = timeZone;
      try {
        const decodeTemporal = (
          config: MockTediousConnectionConfig,
          year: number,
          monthIndex: number,
          day: number,
          hours = 0,
          minutes = 0
        ): Date =>
          config.options.useUTC
            ? new Date(Date.UTC(year, monthIndex, day, hours, minutes))
            : new Date(year, monthIndex, day, hours, minutes);

        tediousMocks.queueScenario({
          resultSets: [
            {
              columns: [
                { colName: 'BusinessDate', typeName: 'Date' },
                { colName: 'StartTime', typeName: 'Time' },
                { colName: 'CreatedAt', typeName: 'DateTime2' },
              ],
              rows: [],
              createRows: (config) => [
                [
                  decodeTemporal(config, 2026, 0, 15),
                  decodeTemporal(config, 1970, 0, 1, 9),
                  decodeTemporal(config, 2026, 0, 15, 0, 30),
                ],
              ],
            },
          ],
        });

        const result = await runSqlQueryPreview({
          host: 'test-host',
          port: 1433,
          database: 'test-db',
          token: 'test-token',
          query: 'SELECT BusinessDate, StartTime, CreatedAt FROM dbo.Example',
        });

        expect(tediousMocks.connectionConfigs[0]?.options.useUTC).toBe(true);
        expect(tediousMocks.connectionConfigs[0]?.options.encrypt).toBe(true);
        expect(
          formatConnectorInspectValue(result.rows[0]?.BusinessDate, 'date')
        ).toBe('2026-01-15');
        expect(
          formatConnectorInspectValue(result.rows[0]?.StartTime, 'time')
        ).toBe('09:00:00.000');
        expect(
          formatConnectorInspectValue(result.rows[0]?.CreatedAt, 'datetime')
        ).toBe('2026-01-15T00:30:00.000Z');
      } finally {
        if (originalTimeZone === undefined) {
          delete process.env.TZ;
        } else {
          process.env.TZ = originalTimeZone;
        }
      }
    }
  );

  it('rejects a newline-separated batch when a second empty result set starts', async () => {
    tediousMocks.queueScenario({
      resultSets: [
        {
          columns: [{ colName: 'FirstValue', typeName: 'Int' }],
          rows: [[1]],
        },
        {
          columns: [{ colName: 'SecondValue', typeName: 'Int' }],
          rows: [],
        },
      ],
      completeAsync: true,
    });

    await expect(
      runSqlQueryPreview({
        host: 'test-host',
        port: 1433,
        database: 'test-db',
        token: 'test-token',
        query: 'SELECT 1 AS FirstValue\nSELECT 2 AS SecondValue WHERE 1 = 0',
      })
    ).rejects.toMatchObject({
      name: MultipleSqlResultSetsError.name,
      message: MULTIPLE_SQL_RESULT_SETS_MESSAGE,
    });
    expect(tediousMocks.connections[0]?.cancelCount).toBe(1);
  });
});

describe('parseConnectionString', () => {
  it('parses host,port format', () => {
    const result = parseConnectionString('myhost.fabric.microsoft.com,1433');
    expect(result.host).toBe('myhost.fabric.microsoft.com');
    expect(result.port).toBe(1433);
  });

  it('defaults port to 1433 when not specified', () => {
    const result = parseConnectionString('myhost.fabric.microsoft.com');
    expect(result.host).toBe('myhost.fabric.microsoft.com');
    expect(result.port).toBe(1433);
  });

  it('strips tcp: prefix', () => {
    const result = parseConnectionString(
      'tcp:myhost.fabric.microsoft.com,1433'
    );
    expect(result.host).toBe('myhost.fabric.microsoft.com');
    expect(result.port).toBe(1433);
  });

  it('strips tcp: prefix without port', () => {
    const result = parseConnectionString('tcp:myhost.fabric.microsoft.com');
    expect(result.host).toBe('myhost.fabric.microsoft.com');
    expect(result.port).toBe(1433);
  });

  it('handles non-standard port', () => {
    const result = parseConnectionString('myhost.example.com,5432');
    expect(result.host).toBe('myhost.example.com');
    expect(result.port).toBe(5432);
  });
});

describe('writeMetadataFile', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'rayfin-schema-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('writes metadata.json to correct path', () => {
    const metadata: SchemaMetadata = {
      source: 'inventory',
      connector: 'fabric-sqlanalytics',
      connectionString: 'test-host',
      discoveredAt: '2026-01-01T00:00:00Z',
      schemas: [],
    };

    const path = writeMetadataFile(testDir, 'inventory', metadata);

    expect(path).toContain('rayfin');
    expect(path).toContain('inventory');
    expect(path).toContain('metadata.json');

    const written = JSON.parse(readFileSync(path, 'utf-8'));
    expect(written.source).toBe('inventory');
    expect(written.connector).toBe('fabric-sqlanalytics');
    expect(written.schemas).toEqual([]);
  });

  it('creates nested directories recursively', () => {
    const metadata: SchemaMetadata = {
      source: 'deep-source',
      connector: 'fabric-sqldatabase',
      connectionString: 'host',
      discoveredAt: '2026-01-01T00:00:00Z',
      schemas: [
        {
          schemaName: 'dbo',
          tables: [
            {
              tableName: 'Products',
              columns: [
                {
                  columnName: 'Id',
                  dataType: 'uniqueidentifier',
                  isNullable: false,
                },
              ],
              primaryKeyColumns: ['Id'],
              foreignKeys: [],
            },
          ],
        },
      ],
    };

    const path = writeMetadataFile(testDir, 'deep-source', metadata);
    const written = JSON.parse(readFileSync(path, 'utf-8'));

    expect(written.schemas).toHaveLength(1);
    expect(written.schemas[0].tables).toHaveLength(1);
    expect(written.schemas[0].tables[0].columns).toHaveLength(1);
    expect(written.schemas[0].tables[0].primaryKeyColumns).toEqual(['Id']);
  });
});

describe('columnRowToEntry', () => {
  const row = (over: Partial<ColumnRow>): ColumnRow => ({
    TABLE_SCHEMA: 'ServerGenerated',
    TABLE_NAME: 'T',
    COLUMN_NAME: 'X',
    DATA_TYPE: 'int',
    IS_NULLABLE: 'NO',
    CHARACTER_MAXIMUM_LENGTH: null,
    NUMERIC_PRECISION: null,
    NUMERIC_SCALE: null,
    DATETIME_PRECISION: null,
    ...over,
  });

  it('maps a plain nullable column to name, type, nullability and length only', () => {
    expect(
      columnRowToEntry(
        row({
          COLUMN_NAME: 'Name',
          DATA_TYPE: 'nvarchar',
          IS_NULLABLE: 'YES',
          CHARACTER_MAXIMUM_LENGTH: 50,
        })
      )
    ).toEqual({
      columnName: 'Name',
      dataType: 'nvarchar',
      isNullable: true,
      maxLength: 50,
    });
  });

  it('captures datetime2 fractional-seconds precision', () => {
    expect(
      columnRowToEntry(row({ DATA_TYPE: 'datetime2', DATETIME_PRECISION: 3 }))
        .datePrecision
    ).toBe(3);
  });

  it('captures numeric precision and scale', () => {
    const entry = columnRowToEntry(
      row({ DATA_TYPE: 'decimal', NUMERIC_PRECISION: 18, NUMERIC_SCALE: 2 })
    );
    expect(entry.precision).toBe(18);
    expect(entry.scale).toBe(2);
  });
});

describe('applyServerGeneration', () => {
  const base = (): ColumnEntry => ({
    columnName: 'X',
    dataType: 'int',
    isNullable: false,
  });
  const sgRow = (over: Partial<ServerGenRow>): ServerGenRow => ({
    TABLE_SCHEMA: 'ServerGenerated',
    TABLE_NAME: 'T',
    COLUMN_NAME: 'X',
    IS_IDENTITY: false,
    SEED_VALUE: null,
    INCREMENT_VALUE: null,
    DEFAULT_DEFINITION: null,
    COMPUTED_DEFINITION: null,
    GENERATED_ALWAYS_TYPE: 0,
    TYPE_NAME: 'int',
    ...over,
  });

  it('captures IDENTITY seed and increment', () => {
    const col = base();
    applyServerGeneration(
      col,
      sgRow({ IS_IDENTITY: true, SEED_VALUE: '5', INCREMENT_VALUE: '10' })
    );
    expect(col.identity).toEqual({ seed: '5', increment: '10' });
  });

  it('defaults IDENTITY seed and increment to 1 when the catalog returns null', () => {
    const col = base();
    applyServerGeneration(col, sgRow({ IS_IDENTITY: true }));
    expect(col.identity).toEqual({ seed: '1', increment: '1' });
  });

  it('preserves a BIGINT identity seed beyond MAX_SAFE_INTEGER', () => {
    const col = base();
    applyServerGeneration(
      col,
      sgRow({
        IS_IDENTITY: true,
        SEED_VALUE: '9007199254740993',
        INCREMENT_VALUE: '1',
      })
    );
    expect(col.identity).toEqual({ seed: '9007199254740993', increment: '1' });
  });

  it('captures a DEFAULT constraint definition verbatim', () => {
    const col = base();
    applyServerGeneration(col, sgRow({ DEFAULT_DEFINITION: '(newid())' }));
    expect(col.default).toBe('(newid())');
  });

  it('captures a computed column definition verbatim', () => {
    const col = base();
    applyServerGeneration(
      col,
      sgRow({ COMPUTED_DEFINITION: '([Quantity]*[UnitPrice])' })
    );
    expect(col.computed).toBe('([Quantity]*[UnitPrice])');
  });

  it('marks a rowversion column as server-managed', () => {
    const col = base();
    applyServerGeneration(col, sgRow({ TYPE_NAME: 'timestamp' }));
    expect(col.serverManaged).toBe('rowversion');
  });

  it('marks a temporal ROW START column as server-managed', () => {
    const col = base();
    applyServerGeneration(col, sgRow({ GENERATED_ALWAYS_TYPE: 1 }));
    expect(col.serverManaged).toBe('temporalRowStart');
  });

  it('marks a temporal ROW END column as server-managed', () => {
    const col = base();
    applyServerGeneration(col, sgRow({ GENERATED_ALWAYS_TYPE: 2 }));
    expect(col.serverManaged).toBe('temporalRowEnd');
  });

  it('leaves a plain column unmarked', () => {
    const col = base();
    applyServerGeneration(col, sgRow({}));
    expect(col.serverManaged).toBeUndefined();
    expect(col.identity).toBeUndefined();
    expect(col.default).toBeUndefined();
    expect(col.computed).toBeUndefined();
  });
});
