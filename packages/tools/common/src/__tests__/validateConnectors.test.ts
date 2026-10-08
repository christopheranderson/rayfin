import { describe, expect, it } from 'vitest';

import type { ConnectorEntry } from '../config/types.js';
import {
  KNOWN_CONNECTOR_TYPES,
  parseConnectorOperations,
  validateConnectors,
} from '../config/validateConnectors.js';

describe('validateConnectors', () => {
  it('returns no errors for undefined connectors', () => {
    expect(validateConnectors(undefined)).toEqual([]);
  });

  it('returns no errors for empty connectors array', () => {
    expect(validateConnectors([])).toEqual([]);
  });

  it('returns no errors for valid Fabric connector', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'inventory',
        type: 'fabric-sqlanalytics',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
        auth: { type: 'delegated' },
      },
    ];
    expect(validateConnectors(connectors)).toEqual([]);
  });

  it('rejects connector name with invalid characters', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'my source!',
        type: 'fabric-sqlanalytics',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
        auth: { type: 'delegated' },
      },
    ];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('invalid characters');
  });

  it('rejects connector name exceeding max length', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'a'.repeat(257),
        type: 'fabric-sqlanalytics',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
        auth: { type: 'delegated' },
      },
    ];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('exceeds maximum length');
  });

  it('accepts connector names with hyphens and underscores', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'my-source_01',
        type: 'fabric-sqlanalytics',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
        auth: { type: 'delegated' },
      },
    ];
    expect(validateConnectors(connectors)).toEqual([]);
  });

  it('rejects missing name field', () => {
    const connectors = [
      { type: 'fabric-sqlanalytics' } as unknown as ConnectorEntry,
    ];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('missing required field "name"');
  });

  it('rejects duplicate connector names', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'inventory',
        type: 'fabric-sqlanalytics',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
        auth: { type: 'delegated' },
      },
      {
        name: 'inventory',
        type: 'fabric-warehouse',
        config: { workspaceId: 'ws-2', itemId: 'item-2' },
        auth: { type: 'delegated' },
      },
    ];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Duplicate connector name "inventory"');
  });

  it('rejects missing type field', () => {
    const connectors = [{ name: 'test' } as unknown as ConnectorEntry];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('missing required field "type"');
  });

  it('rejects unsupported connector type', () => {
    const connectors = [
      { name: 'test', type: 'unknown-db' } as unknown as ConnectorEntry,
    ];
    const errors = validateConnectors(connectors);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('unsupported type');
  });

  it('rejects missing auth.type', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'inventory',
        type: 'fabric-sqlanalytics',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
      },
    ];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('missing required field "auth.type"');
  });

  it('rejects unsupported auth.type', () => {
    const connectors = [
      {
        name: 'inventory',
        type: 'fabric-sqlanalytics',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
        auth: { type: 'api-key' },
      },
    ] as unknown as ConnectorEntry[];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('unsupported "auth.type"');
  });

  it('rejects Fabric connector missing config.workspaceId', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'wh',
        type: 'fabric-warehouse',
        config: { itemId: 'item-1' },
        auth: { type: 'delegated' },
      },
    ];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('requires "config.workspaceId"');
  });

  it('rejects Fabric connector missing config.itemId', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'wh',
        type: 'fabric-warehouse',
        config: { workspaceId: 'ws-1' },
        auth: { type: 'delegated' },
      },
    ];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('requires "config.itemId"');
  });

  it('rejects Fabric connector missing config entirely', () => {
    const connectors: ConnectorEntry[] = [
      { name: 'wh', type: 'fabric-warehouse', auth: { type: 'delegated' } },
    ];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(2);
    expect(errors[0].message).toContain('requires "config.workspaceId"');
    expect(errors[1].message).toContain('requires "config.itemId"');
  });

  it('validates multiple connectors independently', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'valid',
        type: 'fabric-sqlanalytics',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
        auth: { type: 'delegated' },
      },
      {
        name: 'invalid',
        type: 'fabric-sqldatabase',
        config: { workspaceId: 'ws-2' },
        auth: { type: 'delegated' },
      },
    ];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(1);
    expect(errors[0].sourceName).toBe('invalid');
  });
});

describe('KNOWN_CONNECTOR_TYPES', () => {
  it('contains all ConnectorType values', () => {
    expect(KNOWN_CONNECTOR_TYPES).toContain('fabric-sqlanalytics');
    expect(KNOWN_CONNECTOR_TYPES).toContain('fabric-warehouse');
    expect(KNOWN_CONNECTOR_TYPES).toContain('fabric-sqldatabase');
    expect(KNOWN_CONNECTOR_TYPES).toContain('fabric-semanticmodel');
    expect(KNOWN_CONNECTOR_TYPES).toContain('kusto');
    expect(KNOWN_CONNECTOR_TYPES).toHaveLength(5);
  });
});

describe('validateConnectors auth', () => {
  it('accepts delegated auth', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'a',
        type: 'fabric-sqlanalytics',
        auth: { type: 'delegated' },
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
      },
    ];
    expect(validateConnectors(connectors)).toEqual([]);
  });

  it('accepts application auth', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'a',
        type: 'fabric-sqlanalytics',
        auth: { type: 'application' },
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
      },
    ];
    expect(validateConnectors(connectors)).toEqual([]);
  });

  it('rejects application auth for kusto', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'telemetry',
        type: 'kusto',
        version: '1',
        auth: { type: 'application' },
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
        operations: [{ name: 'executeQuery' }],
      },
    ];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(
      'kusto) does not support auth type "application"'
    );
  });

  it('rejects unknown auth type', () => {
    const connectors = [
      {
        name: 'a',
        type: 'fabric-sqlanalytics',
        auth: { type: 'api-key' },
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
      },
    ] as unknown as ConnectorEntry[];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('unsupported "auth.type" "api-key"');
  });
});

describe('validateConnectors operations', () => {
  it('accepts fabric-semanticmodel with executeQuery operation', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'dataset',
        type: 'fabric-semanticmodel',
        version: '1',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
        operations: [{ name: 'executeQuery' }],
        auth: { type: 'delegated' },
      },
    ];
    expect(validateConnectors(connectors)).toEqual([]);
  });

  it('accepts kusto with executeQuery operation', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'telemetry',
        type: 'kusto',
        version: '1',
        config: { workspaceId: 'ws-1', itemId: 'kql-database-item-1' },
        operations: [{ name: 'executeQuery' }],
        auth: { type: 'delegated' },
      },
    ];
    expect(validateConnectors(connectors)).toEqual([]);
  });

  it('rejects kusto missing itemId', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'telemetry',
        type: 'kusto',
        version: '1',
        config: { workspaceId: 'ws-1' },
        operations: [{ name: 'executeQuery' }],
        auth: { type: 'delegated' },
      },
    ];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('requires "config.itemId"');
  });

  it('rejects CRUD operations on kusto', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'telemetry',
        type: 'kusto',
        version: '1',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
        operations: [{ name: 'read' }],
        auth: { type: 'delegated' },
      },
    ];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(
      'kusto) does not support operation "read"'
    );
  });

  it('rejects fabric-semanticmodel missing workspaceId', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'dataset',
        type: 'fabric-semanticmodel',
        version: '1',
        config: { itemId: 'item-1' },
        operations: [{ name: 'executeQuery' }],
        auth: { type: 'delegated' },
      },
    ];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('requires "config.workspaceId"');
  });

  it('rejects CRUD operation on fabric-semanticmodel', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'dataset',
        type: 'fabric-semanticmodel',
        version: '1',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
        operations: [{ name: 'read' }],
        auth: { type: 'delegated' },
      },
    ];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('does not support operation "read"');
    expect(errors[0].message).toContain('fabric-semanticmodel');
  });

  it('rejects executeQuery on fabric-sqlanalytics (Lakehouse, read-only)', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'lakehouse',
        type: 'fabric-sqlanalytics',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
        operations: [{ name: 'executeQuery' }],
        auth: { type: 'delegated' },
      },
    ];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(
      'does not support operation "executeQuery"'
    );
    expect(errors[0].message).toContain('fabric-sqlanalytics');
  });

  it('rejects write operations on fabric-sqlanalytics (Lakehouse, read-only)', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'lakehouse',
        type: 'fabric-sqlanalytics',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
        operations: [
          { name: 'create' },
          { name: 'update' },
          { name: 'delete' },
        ],
        auth: { type: 'delegated' },
      },
    ];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(3);
    expect(errors.map((e) => e.message).join('\n')).toContain(
      'does not support operation "create"'
    );
  });

  it('accepts CRUD operations on fabric-sqldatabase (writable)', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'salesdb',
        type: 'fabric-sqldatabase',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
        operations: [
          { name: 'read' },
          { name: 'create' },
          { name: 'update' },
          { name: 'delete' },
        ],
        auth: { type: 'delegated' },
      },
    ];
    expect(validateConnectors(connectors)).toEqual([]);
  });

  it('rejects duplicate operations', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'inventory',
        type: 'fabric-sqldatabase',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
        operations: [{ name: 'read' }, { name: 'read' }],
        auth: { type: 'delegated' },
      },
    ];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('duplicate operation "read"');
  });

  it('rejects operation entry missing required "name"', () => {
    const connectors = [
      {
        name: 'inventory',
        type: 'fabric-sqlanalytics',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
        operations: [{}],
        auth: { type: 'delegated' },
      },
    ] as unknown as ConnectorEntry[];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('missing required field "name"');
  });

  it('accepts undefined or empty operations list', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'a',
        type: 'fabric-sqlanalytics',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
        auth: { type: 'delegated' },
      },
      {
        name: 'b',
        type: 'fabric-sqlanalytics',
        config: { workspaceId: 'ws-2', itemId: 'item-2' },
        operations: [],
        auth: { type: 'delegated' },
      },
    ];
    expect(validateConnectors(connectors)).toEqual([]);
  });
});

describe('validateConnectors version', () => {
  it('rejects kusto missing version', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'telemetry',
        type: 'kusto',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
        operations: [{ name: 'executeQuery' }],
        auth: { type: 'delegated' },
      },
    ];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('requires "version"');
  });

  it('rejects fabric-semanticmodel missing version', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'dataset',
        type: 'fabric-semanticmodel',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
        operations: [{ name: 'executeQuery' }],
        auth: { type: 'delegated' },
      },
    ];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('requires "version"');
  });

  it('rejects fabric-semanticmodel with whitespace-only version', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'dataset',
        type: 'fabric-semanticmodel',
        version: '   ',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
        operations: [{ name: 'executeQuery' }],
        auth: { type: 'delegated' },
      },
    ];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('requires "version"');
  });

  // Workload parses `version` as an int and routes to `rayfin_<type>_v<n>`,
  // so decimal, signed, leading-zero, or non-numeric values are rejected at
  // `rayfin up` time. The trimmed value is what gets pattern-matched, so
  // surrounding whitespace around an otherwise-valid integer is tolerated.
  it.each(['1.0', '1.5', '0', '01', '-1', '+1', 'abc', '1e2'])(
    'rejects fabric-semanticmodel with non-positive-integer version %p',
    (badVersion) => {
      const connectors: ConnectorEntry[] = [
        {
          name: 'dataset',
          type: 'fabric-semanticmodel',
          version: badVersion,
          config: { workspaceId: 'ws-1', itemId: 'item-1' },
          operations: [{ name: 'executeQuery' }],
          auth: { type: 'delegated' },
        },
      ];
      const errors = validateConnectors(connectors);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('must be a positive integer');
      expect(errors[0].message).toContain(`"${badVersion}"`);
    }
  );

  it('accepts multi-digit positive integer version', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'dataset',
        type: 'fabric-semanticmodel',
        version: '42',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
        operations: [{ name: 'executeQuery' }],
        auth: { type: 'delegated' },
      },
    ];
    expect(validateConnectors(connectors)).toEqual([]);
  });

  it('accepts integer version with surrounding whitespace', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'dataset',
        type: 'fabric-semanticmodel',
        version: '  2  ',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
        operations: [{ name: 'executeQuery' }],
        auth: { type: 'delegated' },
      },
    ];
    expect(validateConnectors(connectors)).toEqual([]);
  });

  it('accepts Cat A Fabric connector without version', () => {
    const connectors: ConnectorEntry[] = [
      {
        name: 'lakehouse',
        type: 'fabric-sqlanalytics',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
        auth: { type: 'delegated' },
      },
    ];
    expect(validateConnectors(connectors)).toEqual([]);
  });
});

describe('validateConnectors unknown-operation hint', () => {
  it('appends a "Did you mean" hint when the operation is a near-miss', () => {
    const connectors = [
      {
        name: 'dataset',
        type: 'fabric-semanticmodel',
        version: '1',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
        operations: [{ name: 'executeQuery2' }],
        auth: { type: 'delegated' },
      },
    ] as unknown as ConnectorEntry[];
    const errors = validateConnectors(connectors);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(
      'does not support operation "executeQuery2"'
    );
    expect(errors[0].message).toContain('Did you mean "executeQuery"?');
  });
});

describe('parseConnectorOperations', () => {
  it('parses a comma-separated list and preserves input order', () => {
    const result = parseConnectorOperations('read,create', 'fabric-warehouse');
    expect(result).toEqual({ ok: true, operations: ['read', 'create'] });
  });

  it('trims whitespace and skips empty entries', () => {
    const result = parseConnectorOperations(
      '  read , , create  ',
      'fabric-warehouse'
    );
    expect(result).toEqual({ ok: true, operations: ['read', 'create'] });
  });

  it('deduplicates while preserving first occurrence', () => {
    const result = parseConnectorOperations(
      'read,create,read',
      'fabric-warehouse'
    );
    expect(result).toEqual({ ok: true, operations: ['read', 'create'] });
  });

  it('rejects unknown operation with a "Did you mean" hint', () => {
    const result = parseConnectorOperations(
      'executeQuery2',
      'fabric-semanticmodel'
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain(
        'does not support operation "executeQuery2"'
      );
      expect(result.message).toContain('Did you mean "executeQuery"?');
      expect(result.message).toContain('Allowed: executeQuery');
    }
  });

  it('rejects when the input is empty or only whitespace', () => {
    const result = parseConnectorOperations('  ,  ,', 'fabric-warehouse');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('No operations were provided');
    }
  });
});
