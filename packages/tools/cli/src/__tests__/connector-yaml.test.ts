import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Command } from 'commander';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parse } from 'yaml';

import { connectorCommand } from '../commands/connector/connector';
import { sanitizeSourceName } from '../commands/connector/connector-add';
import { discoverSchema } from '../services/schema-discovery';

// Mock project-utils to return our temp dir as the project root
let testProjectDir: string;

const interactiveState = vi.hoisted(() => ({ value: false }));

// Spy for Inquirer's default `prompt` so tests can assert it is (never) called.
const inquirerPrompt = vi.hoisted(() => vi.fn());

vi.mock('inquirer', () => ({
  default: { prompt: inquirerPrompt },
}));

vi.mock('../utils/project-utils.js', () => ({
  findRayfinProjectRoot: () => testProjectDir,
}));

vi.mock('../auth/index.js', () => ({
  ensureAuthenticated: vi.fn().mockResolvedValue({ token: 'mock-token' }),
  isAuthenticated: vi.fn().mockResolvedValue(true),
}));

vi.mock('../services/fabric/rayfin-item.js', () => ({
  RayfinItemManager: vi.fn().mockImplementation(() => ({
    getFabricItemById: vi.fn().mockResolvedValue({
      displayName: 'Test Item',
      type: 'SQLEndpoint',
    }),
  })),
}));

vi.mock('../services/fabric/sql-endpoint.js', () => ({
  SqlEndpointManager: vi.fn().mockImplementation(() => ({
    getConnectionStringByType: vi
      .fn()
      .mockImplementation((_wsId: string, itemId: string) =>
        Promise.resolve({
          connectionString: 'test-host.fabric.microsoft.com,1433',
          resolvedItemId: itemId, // Return the same ID (no Lakehouse resolution)
        })
      ),
  })),
}));

vi.mock('../services/connector-kusto-resolution.js', () => ({
  resolveKustoEndpoint: vi.fn().mockResolvedValue({
    queryServiceUri: 'https://cluster.kusto.fabric.microsoft.com',
    databaseName: 'TelemetryDb',
    resolvedItemId: 'kql-database-item-1',
  }),
}));

vi.mock('../services/schema-discovery.js', () => ({
  discoverSchema: vi.fn().mockResolvedValue({
    source: 'test',
    connector: 'fabric-sqlanalytics',
    connectionString: 'test-host',
    discoveredAt: '2026-01-01T00:00:00Z',
    schemas: [{ schemaName: 'dbo', tables: [] }],
  }),
  writeMetadataFile: vi.fn().mockReturnValue('/tmp/metadata.json'),
}));

vi.mock('../utils/output-mode.js', async () => {
  const actual = await vi.importActual<
    typeof import('../utils/output-mode.js')
  >('../utils/output-mode.js');

  // I/O sinks routed to console.log so tests capture output without touching
  // process.stdout. `emitJsonError` throws a plain Error whose message the
  // `.rejects.toThrow(...)` assertions match (the real one throws
  // CliHandledError and writes to process.stdout, which these tests do not
  // capture).
  const emitJson = (data: unknown) => console.log(JSON.stringify(data));
  const emitJsonError = (
    mode: string,
    error: string,
    extra?: Record<string, unknown>
  ) => {
    if (mode === 'json') {
      console.log(JSON.stringify({ status: 'error', error, ...extra }));
    }
    throw new Error(error);
  };

  return {
    ...actual,
    // Keep the REAL flag resolvers so the placement-independent regression
    // tests exercise production logic rather than a copy. `resolveCommandFlags`
    // is recomposed from the real leaf resolvers only so its R6 rejection can
    // route through the console.log-based `emitJsonError` above.
    resolveCommandFlags: (command: any) => {
      const json = actual.resolveInheritedBooleanFlag(command, 'json');
      const verbose = actual.resolveInheritedBooleanFlag(command, 'verbose');
      const yes = actual.resolveInheritedBooleanFlag(command, 'yes');
      const { output } = actual.resolveRootOutputFlags(command);
      const mode = actual.resolveOutputMode({ json, output });
      if (mode === 'json' && verbose) {
        emitJsonError(mode, '`--verbose` cannot be combined with `--json`.');
      }
      return { mode, verbose, json, yes };
    },
    isInteractive: () => interactiveState.value,
    modeLog: (mode: string, ...args: any[]) => {
      if (mode !== 'json' && mode !== 'silent') {
        console.log(...args);
      }
    },
    modeWarn: () => {},
    modeError: () => {},
    emitJson,
    emitJsonError,
  };
});

/**
 * Helper: write a minimal rayfin.yml to the temp project.
 */
function writeRayfinYml(extra: Record<string, unknown> = {}) {
  const config = {
    id: 'test-project',
    name: 'Test Project',
    version: '1.0.0',
    services: {
      auth: { enabled: true },
      data: { enabled: true },
      storage: { enabled: false },
    },
    ...extra,
  };
  writeFileSync(
    join(testProjectDir, 'rayfin', 'rayfin.yml'),

    require('yaml').stringify(config, { lineWidth: 0 })
  );
}

/**
 * Helper: read and parse the current rayfin.yml.
 */
function readRayfinYml(): Record<string, unknown> {
  return parse(
    readFileSync(join(testProjectDir, 'rayfin', 'rayfin.yml'), 'utf-8')
  ) as Record<string, unknown>;
}

/**
 * Helper: run a source subcommand via Commander.
 *
 * Commander caches parsed option values on the `Command` instance, so if
 * we reuse the imported `connectorCommand` singleton across tests, options
 * set by one test (e.g. `--name`) leak into the next test that omits them.
 * Reset the `add` subcommand's option state before each parse to keep tests
 * independent.
 */
async function runconnectorCommand(args: string[]): Promise<void> {
  const addCmd = connectorCommand.commands.find((c) => c.name() === 'add');
  if (addCmd) {
    // Reapply defaults; clears any leftover values from a prior parseAsync.
    (
      addCmd as unknown as { _optionValues: Record<string, unknown> }
    )._optionValues = {};
    (
      addCmd as unknown as { _optionValueSources: Record<string, unknown> }
    )._optionValueSources = {};
  }
  const parent = new Command('rayfin');
  parent.addCommand(connectorCommand);
  parent.exitOverride();
  await parent.parseAsync(['node', 'rayfin', 'connector', ...args]);
}

describe('source add — rayfin.yml integration', () => {
  beforeEach(() => {
    testProjectDir = mkdtempSync(join(tmpdir(), 'rayfin-source-test-'));
    mkdirSync(join(testProjectDir, 'rayfin'), { recursive: true });
    writeRayfinYml();
  });

  afterEach(() => {
    rmSync(testProjectDir, { recursive: true, force: true });
  });

  it('adds a source entry to rayfin.yml', async () => {
    await runconnectorCommand([
      'add',
      '--type',
      'fabric-sqlanalytics',
      '--name',
      'inventory',
      '--workspace-id',
      'ws-123',
      '--item-id',
      'item-456',
    ]);

    const config = readRayfinYml();
    const connectors = config.connectors as Array<Record<string, unknown>>;
    expect(connectors).toBeDefined();
    expect(Array.isArray(connectors)).toBe(true);
    const inventory = connectors.find((e) => e.name === 'inventory');
    expect(inventory).toBeDefined();
    expect(inventory!.type).toBe('fabric-sqlanalytics');

    const cfg = inventory!.config as Record<string, string>;
    expect(cfg.workspaceId).toBe('ws-123');
    expect(cfg.itemId).toBe('item-456');

    // By default, the CLI emits all operations the catalog allows for the
    // connector type, in object-entry form (matches the host wire shape).
    // `fabric-sqlanalytics` is read-only per LAKEHOUSE_CONNECTOR_OPERATIONS.
    expect(inventory!.operations).toEqual([{ name: 'read' }]);
  });

  it('lowercases an explicit --name so it is not stored verbatim', async () => {
    // An explicit --name must be case-normalized, not stored verbatim.
    await runconnectorCommand([
      'add',
      '--type',
      'fabric-sqlanalytics',
      '--name',
      'InventoryLakehouse',
      '--workspace-id',
      'ws-123',
      '--item-id',
      'item-456',
    ]);

    const config = readRayfinYml();
    const connectors = config.connectors as Array<Record<string, unknown>>;
    // The entry and scaffold dir use the normalized name, not the raw --name.
    expect(connectors.map((e) => e.name)).toEqual(['inventorylakehouse']);
    expect(
      existsSync(
        join(testProjectDir, 'rayfin', 'connectors', 'inventorylakehouse')
      )
    ).toBe(true);
  });

  it.each(['fabric-sqlanalytics', 'fabric-warehouse', 'fabric-sqldatabase'])(
    'adds %s with application auth without changing existing auth',
    async (type) => {
      const existing = {
        name: 'existing',
        type,
        config: { workspaceId: 'ws-123', itemId: 'existing-item' },
        auth: { type: 'delegated' },
      };
      writeRayfinYml({ connectors: [existing] });

      await runconnectorCommand([
        'add',
        '--type',
        type,
        '--name',
        'inventory',
        '--workspace-id',
        'ws-123',
        '--item-id',
        'item-456',
      ]);

      const config = readRayfinYml();
      expect(config.connectors).toEqual([
        existing,
        expect.objectContaining({
          name: 'inventory',
          type,
          auth: { type: 'application' },
        }),
      ]);
    }
  );

  it('treats a case-only --name variant as the same connector (no duplicate)', async () => {
    // A case-only variant should overwrite, not create a second entry.
    await runconnectorCommand([
      'add',
      '--type',
      'fabric-sqlanalytics',
      '--name',
      'inventory',
      '--workspace-id',
      'ws-123',
      '--item-id',
      'item-456',
    ]);
    await runconnectorCommand([
      'add',
      '--type',
      'fabric-sqlanalytics',
      '--name',
      'INVENTORY',
      '--workspace-id',
      'ws-789',
      '--item-id',
      'item-999',
      '--yes',
    ]);

    const config = readRayfinYml();
    const connectors = config.connectors as Array<Record<string, unknown>>;
    // Exactly one entry, normalized, overwritten with the second add's config.
    expect(connectors.map((e) => e.name)).toEqual(['inventory']);
    const cfg = connectors[0].config as Record<string, string>;
    expect(cfg.workspaceId).toBe('ws-789');
    expect(cfg.itemId).toBe('item-999');
  });

  it('emits executeQuery operation for fabric-semanticmodel', async () => {
    await runconnectorCommand([
      'add',
      '--type',
      'fabric-semanticmodel',
      '--name',
      'salesmodel',
      '--workspace-id',
      'ws-1',
      '--item-id',
      'item-1',
    ]);

    const config = readRayfinYml();
    const connectors = config.connectors as Array<Record<string, unknown>>;
    const salesmodel = connectors.find((e) => e.name === 'salesmodel');
    expect(salesmodel).toBeDefined();
    expect(salesmodel!.type).toBe('fabric-semanticmodel');
    expect(salesmodel!.operations).toEqual([{ name: 'executeQuery' }]);
    // Function-bridge connectors must pin a version.
    expect(salesmodel!.version).toBeDefined();
    // The host requires `auth.type`; the CLI emits the catalog default.
    expect(salesmodel!.auth).toEqual({ type: 'delegated' });
  });

  it('refuses to scaffold a connector type held out of this release', async () => {
    // Was a kusto scaffold test. Kusto is now `authoring: 'held'`, so `add`
    // refuses it - and the guarantee worth pinning at this level is that the
    // refusal happens *before* anything is written: no rayfin.yml entry and no
    // schema directory. A half-scaffolded held type would be worse than none.
    await expect(
      runconnectorCommand([
        'add',
        '--type',
        'kusto',
        '--name',
        'telemetry',
        '--workspace-id',
        'ws-1',
        '--item-id',
        'kql-database-item-1',
      ])
    ).rejects.toThrow(/not available in this release/);

    const config = readRayfinYml();
    const connectors = (config.connectors ?? []) as Array<
      Record<string, unknown>
    >;
    expect(
      connectors.find((entry) => entry.name === 'telemetry')
    ).toBeUndefined();
    expect(
      existsSync(join(testProjectDir, 'rayfin', 'connectors', 'telemetry'))
    ).toBe(false);
  });

  it('scaffolds a function-bridge schema.ts that exports the typed surface', async () => {
    await runconnectorCommand([
      'add',
      '--type',
      'fabric-semanticmodel',
      '--name',
      'salesmodel',
      '--workspace-id',
      'ws-1',
      '--item-id',
      'item-1',
    ]);

    const schemaPath = join(
      testProjectDir,
      'rayfin',
      'connectors',
      'salesmodel',
      'schema.ts'
    );
    const contents = readFileSync(schemaPath, 'utf-8');

    // The new scaffold must not lie about schema discovery (that step is
    // explicitly skipped for function-bridge connectors).
    expect(contents).not.toMatch(/schema discovery/i);
    expect(contents).not.toMatch(/export const schema = \[\]/);

    // Should export a ready-to-import marker-based schema type plus the
    // runtime `connectorConfig` const consumed by `RayfinClient`.
    expect(contents).toMatch(/Connector: salesmodel \(fabric-semanticmodel\)/);
    expect(contents).toMatch(
      /import type \{ ConnectorConfig \} from '@microsoft\/rayfin-connectors'/
    );
    expect(contents).toMatch(
      /import type \{ FabricSemanticModel \} from '@microsoft\/rayfin-connector-fabric-semanticmodel'/
    );
    expect(contents).toMatch(
      /export type SalesmodelSchema = FabricSemanticModel<'executeQuery'>/
    );
    expect(contents).toMatch(
      /export const connectorConfig = \{[\s\S]*connector: 'fabric-semanticmodel'[\s\S]*\} as const satisfies ConnectorConfig/
    );
    expect(contents).not.toMatch(/export \{\};/);
  });

  it('still scaffolds the SQL-style stub for SQL connectors', async () => {
    await runconnectorCommand([
      'add',
      '--type',
      'fabric-warehouse',
      '--name',
      'warehouse1',
      '--workspace-id',
      'ws-1',
      '--item-id',
      'item-1',
    ]);

    const config = readRayfinYml();
    // Existing fields should be preserved
    expect(config.id).toBe('test-project');
    expect(config.name).toBe('Test Project');
    expect(config.services as Record<string, unknown>).toBeDefined();
  });

  it('adds multiple connectors to rayfin.yml', async () => {
    await runconnectorCommand([
      'add',
      '--type',
      'fabric-sqlanalytics',
      '--name',
      'source1',
      '--workspace-id',
      'ws-1',
      '--item-id',
      'item-1',
    ]);

    await runconnectorCommand([
      'add',
      '--type',
      'fabric-warehouse',
      '--name',
      'source2',
      '--workspace-id',
      'ws-2',
      '--item-id',
      'item-2',
    ]);

    const config = readRayfinYml();
    const connectors = config.connectors as Array<Record<string, unknown>>;
    expect(connectors).toHaveLength(2);
    expect(connectors.find((e) => e.name === 'source1')?.type).toBe(
      'fabric-sqlanalytics'
    );
    expect(connectors.find((e) => e.name === 'source2')?.type).toBe(
      'fabric-warehouse'
    );
  });

  it('overwrites duplicate source with --yes flag', async () => {
    // First add
    await runconnectorCommand([
      'add',
      '--type',
      'fabric-sqlanalytics',
      '--name',
      'inventory',
      '--workspace-id',
      'ws-old',
      '--item-id',
      'item-old',
    ]);

    // Overwrite with --yes
    await runconnectorCommand([
      'add',
      '--type',
      'fabric-warehouse',
      '--name',
      'inventory',
      '--workspace-id',
      'ws-new',
      '--item-id',
      'item-new',
      '--yes',
    ]);

    const config = readRayfinYml();
    const connectors = config.connectors as Array<Record<string, unknown>>;
    const inventory = connectors.find((e) => e.name === 'inventory');
    expect(inventory!.type).toBe('fabric-warehouse');
    const cfg = inventory!.config as Record<string, string>;
    expect(cfg.workspaceId).toBe('ws-new');
  });

  it('keeps generated entity files when overwriting an existing connector', async () => {
    await runconnectorCommand([
      'add',
      '--type',
      'fabric-sqlanalytics',
      '--name',
      'inventory',
      '--workspace-id',
      'ws-old',
      '--item-id',
      'item-old',
    ]);

    // Stand in for the entity files the agent/Builder generates from
    // metadata.json after the first add.
    const entityDir = join(
      testProjectDir,
      'rayfin',
      'connectors',
      'inventory',
      'entities'
    );
    mkdirSync(entityDir, { recursive: true });
    writeFileSync(join(entityDir, 'Product.ts'), 'export class Product {}');

    await runconnectorCommand([
      'add',
      '--type',
      'fabric-sqlanalytics',
      '--name',
      'inventory',
      '--workspace-id',
      'ws-new',
      '--item-id',
      'item-new',
      '--yes',
    ]);

    expect(existsSync(join(entityDir, 'Product.ts'))).toBe(true);
    expect(readFileSync(join(entityDir, 'Product.ts'), 'utf-8')).toBe(
      'export class Product {}'
    );
  });

  it('reports a permission-denied schema discovery failure in JSON output', async () => {
    vi.mocked(discoverSchema).mockRejectedValueOnce(
      Object.assign(new Error('SELECT permission was denied on the object'), {
        number: 229,
      })
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runconnectorCommand([
      'add',
      '--type',
      'fabric-sqlanalytics',
      '--name',
      'inventory',
      '--workspace-id',
      'ws-123',
      '--item-id',
      'item-456',
      '--json',
    ]);

    const payload = logSpy.mock.calls
      .map((call) => String(call[0]))
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .find((value) => value?.action === 'connector.add');
    logSpy.mockRestore();

    expect(payload?.schemaDiscovery).toMatchObject({
      status: 'failed',
      reason: 'permission',
      recovery: expect.stringContaining('read access'),
    });
  });

  it('offers item access before a session refresh for an ambiguous login rejection', async () => {
    vi.mocked(discoverSchema).mockRejectedValueOnce(
      Object.assign(
        new Error("Login failed for user '<token-identified principal>'."),
        { number: 18456 }
      )
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runconnectorCommand([
      'add',
      '--type',
      'fabric-sqlanalytics',
      '--name',
      'inventory',
      '--workspace-id',
      'ws-123',
      '--item-id',
      'item-456',
      '--json',
    ]);

    const payload = logSpy.mock.calls
      .map((call) => String(call[0]))
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .find((value) => value?.action === 'connector.add');
    logSpy.mockRestore();

    const discovery = payload?.schemaDiscovery as Record<string, string>;
    expect(discovery).toMatchObject({ status: 'failed', reason: 'login' });
    // The whole point of the `login` category: 18456 is ambiguous, so neither
    // diagnosis may be asserted and the likelier one comes first.
    expect(discovery.recovery).toContain('read access');
    expect(discovery.recovery).toContain('rayfin login');
    expect(discovery.recovery.indexOf('read access')).toBeLessThan(
      discovery.recovery.indexOf('rayfin login')
    );
    expect(discovery.error).not.toContain('Could not authenticate');
  });

  it('overwrites duplicate source when --yes is passed at the root program', async () => {
    // First add establishes the connector.
    await runconnectorCommand([
      'add',
      '--type',
      'fabric-sqlanalytics',
      '--name',
      'inventory',
      '--workspace-id',
      'ws-old',
      '--item-id',
      'item-old',
    ]);

    // Re-add with `--yes` declared globally on the root program and supplied
    // *before* the subcommand. Commander binds the flag to the root option,
    // so the leaf `add` command must merge globals to see it. Regression test
    // for the bug where root-level `--yes` was ignored and overwrite exited 1.
    const addCmd = connectorCommand.commands.find((c) => c.name() === 'add');
    if (addCmd) {
      (
        addCmd as unknown as { _optionValues: Record<string, unknown> }
      )._optionValues = {};
      (
        addCmd as unknown as { _optionValueSources: Record<string, unknown> }
      )._optionValueSources = {};
    }
    const parent = new Command('rayfin');
    parent.option('-y, --yes', 'Auto-accept all confirmation prompts', false);
    parent.addCommand(connectorCommand);
    parent.exitOverride();
    await parent.parseAsync([
      'node',
      'rayfin',
      '--yes',
      'connector',
      'add',
      '--type',
      'fabric-warehouse',
      '--name',
      'inventory',
      '--workspace-id',
      'ws-new',
      '--item-id',
      'item-new',
    ]);

    const config = readRayfinYml();
    const connectors = config.connectors as Array<Record<string, unknown>>;
    const inventory = connectors.find((e) => e.name === 'inventory');
    expect(inventory!.type).toBe('fabric-warehouse');
    const cfg = inventory!.config as Record<string, string>;
    expect(cfg.workspaceId).toBe('ws-new');
  });

  it('rejects unknown connector type', async () => {
    await expect(
      runconnectorCommand([
        'add',
        '--type',
        'unknown-db',
        '--name',
        'test',
        '--workspace-id',
        'ws-1',
        '--item-id',
        'item-1',
      ])
    ).rejects.toThrow(/Unknown connector type/);
  });

  it('suggests closest connector type for typos', async () => {
    await expect(
      runconnectorCommand([
        'add',
        '--type',
        'fabric-sqlanalitics',
        '--name',
        'test',
        '--workspace-id',
        'ws-1',
        '--item-id',
        'item-1',
      ])
    ).rejects.toThrow(/Did you mean "fabric-sqlanalytics"/);
  });

  it('stores workspaceId and itemId under config in YAML', async () => {
    await runconnectorCommand([
      'add',
      '--type',
      'fabric-sqldatabase',
      '--name',
      'mydb',
      '--workspace-id',
      'ws-abc-123',
      '--item-id',
      'item-xyz-789',
    ]);

    const config = readRayfinYml();
    const connectors = config.connectors as Array<Record<string, unknown>>;
    const mydb = connectors.find((e) => e.name === 'mydb');
    const cfg = mydb!.config as Record<string, string>;
    expect(cfg.workspaceId).toBe('ws-abc-123');
    expect(cfg.itemId).toBe('item-xyz-789');
    // Verify they are NOT at the top level of the entry
    expect((mydb as Record<string, unknown>).workspaceId).toBeUndefined();
    expect((mydb as Record<string, unknown>).itemId).toBeUndefined();
  });

  it('rejects invalid source name with special characters', async () => {
    await expect(
      runconnectorCommand([
        'add',
        '--type',
        'fabric-sqlanalytics',
        '--name',
        'invalid!name',
        '--workspace-id',
        'ws-1',
        '--item-id',
        'item-1',
      ])
    ).rejects.toThrow(/invalid characters/);
  });
});

describe('source remove — rayfin.yml integration', () => {
  beforeEach(() => {
    testProjectDir = mkdtempSync(join(tmpdir(), 'rayfin-source-test-'));
    mkdirSync(join(testProjectDir, 'rayfin'), { recursive: true });
    writeRayfinYml({
      connectors: [
        {
          name: 'inventory',
          type: 'fabric-sqlanalytics',
          config: { workspaceId: 'ws-1', itemId: 'item-1' },
        },
        {
          name: 'warehouse',
          type: 'fabric-warehouse',
          config: { workspaceId: 'ws-2', itemId: 'item-2' },
        },
      ],
    });
  });

  afterEach(() => {
    rmSync(testProjectDir, { recursive: true, force: true });
  });

  it('removes a source from rayfin.yml', async () => {
    await runconnectorCommand(['remove', 'inventory', '--yes']);

    const config = readRayfinYml();
    const connectors = config.connectors as Array<Record<string, unknown>>;
    expect(connectors).toBeDefined();
    expect(connectors.find((e) => e.name === 'inventory')).toBeUndefined();
    expect(connectors.find((e) => e.name === 'warehouse')).toBeDefined();
  });

  it('removes connectors key when last source is removed', async () => {
    await runconnectorCommand(['remove', 'inventory', '--yes']);
    await runconnectorCommand(['remove', 'warehouse', '--yes']);

    const config = readRayfinYml();
    expect(config.connectors).toBeUndefined();
  });

  it('no-ops with a friendly message when removing a non-existent connector', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runconnectorCommand(['remove', 'nonexistent', '--yes']);
      // Did not throw — exits cleanly with a Builder-facing message.
      const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toMatch(/"nonexistent" is not declared/);
      expect(printed).toMatch(/nothing to remove/);
      // Existing entries are untouched.
      const config = readRayfinYml();
      const connectors = config.connectors as Array<Record<string, unknown>>;
      expect(connectors.find((e) => e.name === 'inventory')).toBeDefined();
      expect(connectors.find((e) => e.name === 'warehouse')).toBeDefined();
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('connector add/remove — JSON output contract (R6)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testProjectDir = mkdtempSync(join(tmpdir(), 'rayfin-source-json-'));
    mkdirSync(join(testProjectDir, 'rayfin'), { recursive: true });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    interactiveState.value = false;
    inquirerPrompt.mockReset().mockResolvedValue({});
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(testProjectDir, { recursive: true, force: true });
  });

  /** Collect every parseable JSON object printed to stdout. */
  function jsonOutputs(): Array<Record<string, unknown>> {
    return logSpy.mock.calls
      .map((c) => String(c[0]))
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  }

  /** Reset Commander option state so the singleton subcommands are reusable. */
  function resetSubcommandState(): void {
    for (const sub of connectorCommand.commands) {
      (
        sub as unknown as { _optionValues: Record<string, unknown> }
      )._optionValues = {};
      (
        sub as unknown as { _optionValueSources: Record<string, unknown> }
      )._optionValueSources = {};
    }
  }

  /** Run `connector <args>` under a root program that declares global flags. */
  async function runWithRoot(
    rootArgs: string[],
    connectorArgs: string[]
  ): Promise<void> {
    resetSubcommandState();
    const parent = new Command('rayfin');
    parent.option('--json', 'Emit machine-readable JSON output', false);
    parent.option('--verbose', 'Enable verbose output', false);
    parent.addCommand(connectorCommand);
    parent.exitOverride();
    await parent.parseAsync([
      'node',
      'rayfin',
      ...rootArgs,
      'connector',
      ...connectorArgs,
    ]);
  }

  it('emits one success JSON object for connector add (subcommand-level --json)', async () => {
    writeRayfinYml();
    await runWithRoot(
      [],
      [
        'add',
        '--type',
        'fabric-sqlanalytics',
        '--name',
        'inventory',
        '--workspace-id',
        'ws-1',
        '--item-id',
        'item-1',
        '--json',
      ]
    );
    const outs = jsonOutputs();
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({
      status: 'success',
      action: 'connector.add',
      name: 'inventory',
      type: 'fabric-sqlanalytics',
      overwritten: false,
    });
  });

  it('emits one success JSON object for connector add (root-level --json)', async () => {
    writeRayfinYml();
    await runWithRoot(
      ['--json'],
      [
        'add',
        '--type',
        'fabric-sqlanalytics',
        '--name',
        'inventory',
        '--workspace-id',
        'ws-1',
        '--item-id',
        'item-1',
      ]
    );
    const outs = jsonOutputs();
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({
      status: 'success',
      action: 'connector.add',
    });
  });

  it('emits a JSON error and rejects for unknown type in JSON mode', async () => {
    writeRayfinYml();
    await expect(
      runWithRoot(
        [],
        [
          'add',
          '--type',
          'nope',
          '--name',
          'x',
          '--workspace-id',
          'ws',
          '--item-id',
          'it',
          '--json',
        ]
      )
    ).rejects.toThrow(/Unknown connector type/);
    const outs = jsonOutputs();
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({ status: 'error' });
    expect(String(outs[0].error)).toMatch(/Unknown connector type/);
  });

  it('rejects --verbose combined with --json before doing work', async () => {
    writeRayfinYml();
    await expect(
      runWithRoot(
        [],
        [
          'add',
          '--type',
          'fabric-sqlanalytics',
          '--name',
          'x',
          '--workspace-id',
          'ws',
          '--item-id',
          'it',
          '--json',
          '--verbose',
        ]
      )
    ).rejects.toThrow(/`--verbose` cannot be combined with `--json`/);
    const outs = jsonOutputs();
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({ status: 'error' });
  });

  it('emits one success JSON object for connector remove (subcommand-level --json)', async () => {
    writeRayfinYml({
      connectors: [
        {
          name: 'inventory',
          type: 'fabric-sqlanalytics',
          config: { workspaceId: 'ws-1', itemId: 'item-1' },
        },
      ],
    });
    await runWithRoot([], ['remove', 'inventory', '--yes', '--json']);
    const outs = jsonOutputs();
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({
      status: 'success',
      action: 'connector.remove',
      name: 'inventory',
      removed: true,
    });
  });

  it('emits structured JSON (not plain text) when removing a non-declared connector (root-level --json)', async () => {
    writeRayfinYml({
      connectors: [
        {
          name: 'inventory',
          type: 'fabric-sqlanalytics',
          config: { workspaceId: 'ws-1', itemId: 'item-1' },
        },
      ],
    });
    await runWithRoot(['--json'], ['remove', 'nonexistent', '--yes']);
    const outs = jsonOutputs();
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({
      status: 'success',
      action: 'connector.remove',
      name: 'nonexistent',
      removed: false,
      reason: 'not-declared',
    });
    expect(outs[0].declaredConnectors).toEqual(['inventory']);
  });

  it('emits a JSON error when rayfin.yml is missing (remove)', async () => {
    // No writeRayfinYml() — rayfin.yml is absent.
    await expect(
      runWithRoot([], ['remove', 'inventory', '--yes', '--json'])
    ).rejects.toThrow(/No rayfin\.yml found/);
    const outs = jsonOutputs();
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({ status: 'error' });
  });

  it('rejects overwrite of an existing connector without --yes when non-interactive', async () => {
    writeRayfinYml({
      connectors: [
        {
          name: 'inventory',
          type: 'fabric-sqlanalytics',
          config: { workspaceId: 'ws-1', itemId: 'item-1' },
        },
      ],
    });
    await expect(
      runWithRoot(
        [],
        [
          'add',
          '--type',
          'fabric-sqlanalytics',
          '--name',
          'inventory',
          '--workspace-id',
          'ws-1',
          '--item-id',
          'item-1',
          '--json',
        ]
      )
    ).rejects.toThrow(/already exists/);
    const outs = jsonOutputs();
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({ status: 'error' });
    expect(String(outs[0].error)).toMatch(/--yes to overwrite/);
  });

  it('never prompts in JSON mode even in a TTY when overwriting without --yes', async () => {
    interactiveState.value = true;
    writeRayfinYml({
      connectors: [
        {
          name: 'inventory',
          type: 'fabric-sqlanalytics',
          config: { workspaceId: 'ws-1', itemId: 'item-1' },
        },
      ],
    });
    await expect(
      runWithRoot(
        [],
        [
          'add',
          '--type',
          'fabric-sqlanalytics',
          '--name',
          'inventory',
          '--workspace-id',
          'ws-1',
          '--item-id',
          'item-1',
          '--json',
        ]
      )
    ).rejects.toThrow(/already exists/);
    expect(inquirerPrompt).not.toHaveBeenCalled();
    const outs = jsonOutputs();
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({ status: 'error' });
    expect(String(outs[0].error)).toMatch(/--yes to overwrite/);
  });

  it('includes an agentFiles summary in the connector add success envelope', async () => {
    writeRayfinYml();
    await runWithRoot(
      [],
      [
        'add',
        '--type',
        'fabric-sqlanalytics',
        '--name',
        'inventory',
        '--workspace-id',
        'ws-1',
        '--item-id',
        'item-1',
        '--json',
      ]
    );
    const outs = jsonOutputs();
    expect(outs).toHaveLength(1);
    expect(outs[0]).toHaveProperty('agentFiles');
    const agentFiles = outs[0].agentFiles as Record<string, unknown>;
    expect(Array.isArray(agentFiles.installed)).toBe(true);
    expect(Array.isArray(agentFiles.updated)).toBe(true);
    expect(Array.isArray(agentFiles.warnings)).toBe(true);
  });

  it('refuses to remove a declared connector without --yes when non-interactive', async () => {
    writeRayfinYml({
      connectors: [
        {
          name: 'inventory',
          type: 'fabric-sqlanalytics',
          config: { workspaceId: 'ws-1', itemId: 'item-1' },
        },
      ],
    });
    await expect(
      runWithRoot([], ['remove', 'inventory', '--json'])
    ).rejects.toThrow(/without confirmation/);
    const outs = jsonOutputs();
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({ status: 'error' });
    // The connector must remain declared — nothing was removed.
    expect(readRayfinYml().connectors).toBeDefined();
  });

  it('never prompts in JSON mode even in a TTY when removing without --yes', async () => {
    interactiveState.value = true;
    writeRayfinYml({
      connectors: [
        {
          name: 'inventory',
          type: 'fabric-sqlanalytics',
          config: { workspaceId: 'ws-1', itemId: 'item-1' },
        },
      ],
    });
    await expect(
      runWithRoot([], ['remove', 'inventory', '--json'])
    ).rejects.toThrow(/without confirmation/);
    expect(inquirerPrompt).not.toHaveBeenCalled();
    const outs = jsonOutputs();
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({ status: 'error' });
    expect(readRayfinYml().connectors).toBeDefined();
  });

  // always reported false).
  it('reports directoryDeleted: true when the connector directory existed', async () => {
    writeRayfinYml({
      connectors: [
        {
          name: 'inventory',
          type: 'fabric-sqlanalytics',
          config: { workspaceId: 'ws-1', itemId: 'item-1' },
        },
      ],
    });
    mkdirSync(join(testProjectDir, 'rayfin', 'connectors', 'inventory'), {
      recursive: true,
    });
    writeFileSync(
      join(testProjectDir, 'rayfin', 'connectors', 'inventory', 'schema.ts'),
      'export const schema = [];\n'
    );
    await runWithRoot([], ['remove', 'inventory', '--yes', '--json']);
    const outs = jsonOutputs();
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({
      status: 'success',
      action: 'connector.remove',
      removed: true,
      directoryDeleted: true,
    });
  });

  it('reports directoryDeleted: false when no connector directory existed', async () => {
    writeRayfinYml({
      connectors: [
        {
          name: 'inventory',
          type: 'fabric-sqlanalytics',
          config: { workspaceId: 'ws-1', itemId: 'item-1' },
        },
      ],
    });
    await runWithRoot([], ['remove', 'inventory', '--yes', '--json']);
    const outs = jsonOutputs();
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({
      status: 'success',
      removed: true,
      directoryDeleted: false,
    });
  });
});

describe('connector commands — flag parity across add/remove/list', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testProjectDir = mkdtempSync(join(tmpdir(), 'rayfin-source-parity-'));
    mkdirSync(join(testProjectDir, 'rayfin'), { recursive: true });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(testProjectDir, { recursive: true, force: true });
  });

  function resetSubcommandState(): void {
    for (const sub of connectorCommand.commands) {
      (
        sub as unknown as { _optionValues: Record<string, unknown> }
      )._optionValues = {};
      (
        sub as unknown as { _optionValueSources: Record<string, unknown> }
      )._optionValueSources = {};
    }
  }

  async function runWithRoot(
    rootArgs: string[],
    connectorArgs: string[]
  ): Promise<void> {
    resetSubcommandState();
    const parent = new Command('rayfin');
    parent.option('--json', 'Emit machine-readable JSON output', false);
    parent.option('--verbose', 'Enable verbose output', false);
    parent.addCommand(connectorCommand);
    parent.exitOverride();
    await parent.parseAsync([
      'node',
      'rayfin',
      ...rootArgs,
      'connector',
      ...connectorArgs,
    ]);
  }

  function seedConnector(): void {
    writeRayfinYml({
      connectors: [
        {
          name: 'inventory',
          type: 'fabric-sqlanalytics',
          config: { workspaceId: 'ws-1', itemId: 'item-1' },
        },
      ],
    });
  }

  // Regression: `connector remove` previously did not declare `--verbose`, so
  // `rayfin connector remove <name> --verbose` failed to parse with an
  // "unknown option" error. All three commands must now accept it.
  it.each([
    [
      'subcommand-level',
      [] as string[],
      ['remove', 'inventory', '--yes', '--verbose'],
    ],
    ['root-level', ['--verbose'], ['remove', 'inventory', '--yes']],
  ])(
    'remove honors --verbose (%s) and completes',
    async (_where, rootArgs, connectorArgs) => {
      seedConnector();
      await expect(runWithRoot(rootArgs, connectorArgs)).resolves.not.toThrow();
      const config = readRayfinYml();
      expect(config.connectors).toBeUndefined();
    }
  );

  it('list honors --verbose and renders the catalog-driven detail block', async () => {
    seedConnector();
    await runWithRoot([], ['list', '--verbose']);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toMatch(/Allowed operations:/);
  });

  it('list honors root-level --json (placement independence)', async () => {
    seedConnector();
    await runWithRoot(['--json'], ['list']);
    const jsonLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.trim().startsWith('['));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!) as Array<Record<string, unknown>>;
    expect(parsed.find((e) => e.name === 'inventory')).toBeDefined();
  });

  // R6 is enforced uniformly by the single `resolveCommandFlags` resolver, so
  // every connector command rejects `--verbose --json` before doing any work.
  it.each([
    ['remove', ['remove', 'inventory', '--yes', '--json', '--verbose']],
    ['list', ['list', '--json', '--verbose']],
  ])('%s rejects --verbose combined with --json (R6)', async (_cmd, args) => {
    seedConnector();
    await expect(runWithRoot([], args)).rejects.toThrow(
      /`--verbose` cannot be combined with `--json`/
    );
    const errorOutputs = logSpy.mock.calls
      .map((c) => String(c[0]))
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      })
      .filter((o) => o.status === 'error');
    expect(errorOutputs).toHaveLength(1);
  });
});

describe('source list — rayfin.yml integration', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testProjectDir = mkdtempSync(join(tmpdir(), 'rayfin-source-test-'));
    mkdirSync(join(testProjectDir, 'rayfin'), { recursive: true });
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(testProjectDir, { recursive: true, force: true });
    consoleSpy.mockRestore();
  });

  it('outputs JSON for configured connectors', async () => {
    writeRayfinYml({
      connectors: [
        {
          name: 'inventory',
          type: 'fabric-sqlanalytics',
          config: { workspaceId: 'ws-1', itemId: 'item-1' },
        },
      ],
    });

    await runconnectorCommand(['list', '--json']);

    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output) as Array<Record<string, unknown>>;
    expect(Array.isArray(parsed)).toBe(true);
    const inventory = parsed.find((e) => e.name === 'inventory');
    expect(inventory).toBeDefined();
    expect(inventory!.type).toBe('fabric-sqlanalytics');
  });

  it('outputs empty JSON when no connectors configured', async () => {
    writeRayfinYml();

    await runconnectorCommand(['list', '--json']);

    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output) as unknown[];
    expect(parsed).toEqual([]);
  });
});

describe('sanitizeSourceName', () => {
  it('converts display name to lowercase with hyphens', () => {
    expect(sanitizeSourceName('Sales Lakehouse')).toBe('sales-lakehouse');
  });

  it('handles special characters', () => {
    expect(sanitizeSourceName('My Data Source!')).toBe('my-data-source');
  });

  it('collapses consecutive hyphens', () => {
    expect(sanitizeSourceName('Sales  --  Data')).toBe('sales-data');
  });

  it('trims leading and trailing hyphens', () => {
    expect(sanitizeSourceName('  Sales  ')).toBe('sales');
  });

  it('preserves underscores', () => {
    expect(sanitizeSourceName('sales_data_v2')).toBe('sales_data_v2');
  });

  it('handles already valid names', () => {
    expect(sanitizeSourceName('inventory')).toBe('inventory');
  });

  it('handles mixed case and numbers', () => {
    expect(sanitizeSourceName('MyDB2 Warehouse')).toBe('mydb2-warehouse');
  });
});
