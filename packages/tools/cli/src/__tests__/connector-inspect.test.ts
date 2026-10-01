import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

// Command-layer tests for `rayfin connector inspect`: everything a user
// can get wrong on the command line, before the service layer ever runs.

let testProjectDir: string;

vi.mock('../utils/project-utils.js', () => ({
  findRayfinProjectRoot: () => testProjectDir,
}));

const mocks = vi.hoisted(() => ({
  ensureAuthenticated: vi.fn().mockResolvedValue({ token: 'user-token' }),
  hydrateRayfinEnv: vi.fn().mockResolvedValue(undefined),
  runConnectorInspect: vi.fn(),
  resolveWorkspaceIdByNameFuzzy: vi.fn(),
  resolveItemIdByName: vi.fn(),
}));

vi.mock('../auth/index.js', () => ({
  ensureAuthenticated: mocks.ensureAuthenticated,
}));

vi.mock('../services/connector-schema-discovery.js', () => ({
  hydrateRayfinEnv: mocks.hydrateRayfinEnv,
}));

vi.mock('../services/connectors/inspect/service.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../services/connectors/inspect/service')
    >();
  return {
    ...actual,
    runConnectorInspect: mocks.runConnectorInspect,
  };
});

vi.mock('../utils/resolve-workspace-name.js', () => ({
  resolveWorkspaceIdByNameFuzzy: mocks.resolveWorkspaceIdByNameFuzzy,
}));

vi.mock('../utils/resolve-item-name.js', () => ({
  resolveItemIdByName: mocks.resolveItemIdByName,
}));

import { connectorInspectCommand } from '../commands/connector/connector-inspect';

/**
 * Run `rayfin connector inspect <args>` via Commander, resetting cached
 * option state first (avoids leaking option values between tests).
 */
async function runInspect(args: string[]): Promise<void> {
  (
    connectorInspectCommand as unknown as {
      _optionValues: Record<string, unknown>;
    }
  )._optionValues = {};
  (
    connectorInspectCommand as unknown as {
      _optionValueSources: Record<string, unknown>;
    }
  )._optionValueSources = {};

  const parent = new Command('rayfin');
  parent.addCommand(connectorInspectCommand);
  parent.exitOverride();
  await parent.parseAsync(['node', 'rayfin', 'inspect', ...args]);
}

describe('connector inspect — command-line validation', () => {
  // Overloaded `write` signature doesn't fit MockInstance's generic shape;
  // matches the `let promptSpy: any` pattern used elsewhere in this package.
  let stderrSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureAuthenticated.mockResolvedValue({ token: 'user-token' });
    testProjectDir = mkdtempSync(join(tmpdir(), 'rayfin-inspect-test-'));
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    rmSync(testProjectDir, { recursive: true, force: true });
  });

  const directArgs = [
    '--workspace-id',
    'ws-1',
    '--item-id',
    'item-1',
    '--type',
    'fabric-sqldatabase',
  ];

  it('rejects a non-numeric --rows', async () => {
    await expect(
      runInspect([...directArgs, '--entity', 'Customer', '--rows', 'abc'])
    ).rejects.toThrow('--rows must be a positive integer.');
  });

  it('rejects a zero or negative --rows', async () => {
    await expect(
      runInspect([...directArgs, '--entity', 'Customer', '--rows', '0'])
    ).rejects.toThrow('--rows must be a positive integer.');
  });

  it('rejects --rows above the max of 100', async () => {
    await expect(
      runInspect([...directArgs, '--entity', 'Customer', '--rows', '101'])
    ).rejects.toThrow('--rows cannot exceed 100.');
  });

  it('rejects an unknown --type with a suggestion', async () => {
    await expect(
      runInspect([
        '--workspace-id',
        'ws-1',
        '--item-id',
        'item-1',
        '--type',
        'fabric-sqldatabse', // typo
        '--entity',
        'Customer',
      ])
    ).rejects.toThrow(/Unknown connector type "fabric-sqldatabse"/);
  });

  it('rejects a known but uninspectable --type (kusto) before doing any auth/resolution work', async () => {
    await expect(
      runInspect([
        '--workspace-id',
        'ws-1',
        '--item-id',
        'item-1',
        '--type',
        'kusto',
        '--entity',
        'Customer',
      ])
    ).rejects.toThrow('Unsupported connector type: kusto');
    expect(mocks.ensureAuthenticated).not.toHaveBeenCalled();
    expect(mocks.runConnectorInspect).not.toHaveBeenCalled();
  });

  it('rejects --workspace and --workspace-id together', async () => {
    await expect(
      runInspect([
        '--workspace',
        'My Workspace',
        '--workspace-id',
        'ws-1',
        '--item-id',
        'item-1',
        '--type',
        'fabric-sqldatabase',
        '--entity',
        'Customer',
      ])
    ).rejects.toThrow(
      'Specify either --workspace <name> or --workspace-id <id>, not both.'
    );
  });

  it('rejects --item and --item-id together', async () => {
    await expect(
      runInspect([
        '--workspace-id',
        'ws-1',
        '--item',
        'My Item',
        '--item-id',
        'item-1',
        '--type',
        'fabric-sqldatabase',
        '--entity',
        'Customer',
      ])
    ).rejects.toThrow(
      'Specify either --item <name> or --item-id <id>, not both.'
    );
  });

  it('rejects when neither --name nor a direct selector is given', async () => {
    await expect(runInspect(['--entity', 'Customer'])).rejects.toThrow(
      'Specify either --name <connector>, or --workspace/--workspace-id, --item/--item-id, and --type for direct mode.'
    );
  });

  it('rejects mixing --name with a direct selector', async () => {
    await expect(
      runInspect([
        '--name',
        'sales',
        '--workspace-id',
        'ws-1',
        '--entity',
        'Customer',
      ])
    ).rejects.toThrow(
      'Specify either --name <connector>, or --workspace/--workspace-id, --item/--item-id, and --type for direct mode.'
    );
  });

  it('lists entities when neither --entity nor --query is given', async () => {
    mocks.runConnectorInspect.mockResolvedValue({
      connectorType: 'fabric-sqldatabase',
      queryMode: 'entities',
      entity: undefined,
      columns: [
        { name: 'TABLE_SCHEMA', type: 'text' },
        { name: 'TABLE_NAME', type: 'text' },
        { name: 'TABLE_TYPE', type: 'text' },
      ],
      rows: [
        {
          TABLE_SCHEMA: 'SalesLT',
          TABLE_NAME: 'Customer',
          TABLE_TYPE: 'BASE TABLE',
        },
      ],
      truncated: false,
    });

    await runInspect(directArgs);

    expect(mocks.runConnectorInspect).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'entities', entity: undefined })
    );
  });

  it('rejects when both --entity and --query are given', async () => {
    await expect(
      runInspect([
        ...directArgs,
        '--entity',
        'Customer',
        '--query',
        './inspection/students.sql',
      ])
    ).rejects.toThrow(
      'Specify at most one query mode: --entity <name> or --query <path>.'
    );
  });

  it('rejects direct mode missing --type', async () => {
    await expect(
      runInspect([
        '--workspace-id',
        'ws-1',
        '--item-id',
        'item-1',
        '--entity',
        'Customer',
      ])
    ).rejects.toThrow(
      'Direct inspect mode requires --workspace (or --workspace-id), --item (or --item-id), and --type <connector-type>.'
    );
  });

  it('rejects direct mode missing --item/--item-id', async () => {
    await expect(
      runInspect([
        '--workspace-id',
        'ws-1',
        '--type',
        'fabric-sqldatabase',
        '--entity',
        'Customer',
      ])
    ).rejects.toThrow(
      'Direct inspect mode requires --workspace (or --workspace-id), --item (or --item-id), and --type <connector-type>.'
    );
  });
});

describe('connector inspect — query file validation', () => {
  let stderrSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureAuthenticated.mockResolvedValue({ token: 'user-token' });
    testProjectDir = mkdtempSync(join(tmpdir(), 'rayfin-inspect-test-'));
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    rmSync(testProjectDir, { recursive: true, force: true });
  });

  const directArgs = [
    '--workspace-id',
    'ws-1',
    '--item-id',
    'item-1',
    '--type',
    'fabric-sqldatabase',
  ];

  it('rejects a --query path that escapes the project root', async () => {
    await expect(
      runInspect([...directArgs, '--query', '../outside.sql'])
    ).rejects.toThrow('Query file must be inside the project: ../outside.sql');
  });

  it('rejects a --query file with an unsupported extension', async () => {
    writeFileSync(join(testProjectDir, 'query.txt'), 'SELECT 1');
    await expect(
      runInspect([...directArgs, '--query', 'query.txt'])
    ).rejects.toThrow(
      'Query file must have a .sql or .dax extension: query.txt'
    );
  });

  it('rejects a --query file that does not exist', async () => {
    await expect(
      runInspect([...directArgs, '--query', 'missing.sql'])
    ).rejects.toThrow('Query file not found: missing.sql');
  });
});

describe('connector inspect — --name (rayfin.yml) mode validation', () => {
  let stderrSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureAuthenticated.mockResolvedValue({ token: 'user-token' });
    testProjectDir = mkdtempSync(join(tmpdir(), 'rayfin-inspect-test-'));
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    rmSync(testProjectDir, { recursive: true, force: true });
  });

  function writeRayfinYml(config: Record<string, unknown>) {
    mkdirSync(join(testProjectDir, 'rayfin'), { recursive: true });
    writeFileSync(
      join(testProjectDir, 'rayfin', 'rayfin.yml'),
      stringify(config, { lineWidth: 0 })
    );
  }

  it('rejects --name when no rayfin.yml exists', async () => {
    await expect(
      runInspect(['--name', 'sales', '--entity', 'Customer'])
    ).rejects.toThrow('No rayfin.yml found.');
  });

  it('rejects --name for a connector not declared in rayfin.yml', async () => {
    writeRayfinYml({
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      connectors: [],
    });
    await expect(
      runInspect(['--name', 'sales', '--entity', 'Customer'])
    ).rejects.toThrow('Connector "sales" is not declared in rayfin.yml.');
  });

  it('rejects --name for a connector missing workspaceId/itemId', async () => {
    writeRayfinYml({
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      connectors: [{ name: 'sales', type: 'fabric-sqldatabase', config: {} }],
    });
    await expect(
      runInspect(['--name', 'sales', '--entity', 'Customer'])
    ).rejects.toThrow(
      'Connector "sales" is missing required config.workspaceId/config.itemId.'
    );
  });

  it('rejects --name for a semantic model connector that disallows executeQuery', async () => {
    writeRayfinYml({
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      connectors: [
        {
          name: 'analytics',
          type: 'fabric-semanticmodel',
          config: { workspaceId: 'ws-1', itemId: 'item-1' },
          operations: [{ name: 'refresh' }],
        },
      ],
    });
    await expect(
      runInspect(['--name', 'analytics', '--entity', 'Students'])
    ).rejects.toThrow('Connector "analytics" does not allow executeQuery.');
  });

  it('rejects --name for a known but uninspectable connector type (kusto) before doing any auth/resolution work', async () => {
    writeRayfinYml({
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      connectors: [
        {
          name: 'events',
          type: 'kusto',
          config: { workspaceId: 'ws-1', itemId: 'item-1' },
        },
      ],
    });
    await expect(
      runInspect(['--name', 'events', '--entity', 'Customer'])
    ).rejects.toThrow('Unsupported connector type: kusto');
    expect(mocks.ensureAuthenticated).not.toHaveBeenCalled();
    expect(mocks.runConnectorInspect).not.toHaveBeenCalled();
  });
});

describe('connector inspect — entity schema resolution from metadata.json', () => {
  let stderrSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureAuthenticated.mockResolvedValue({ token: 'user-token' });
    mocks.runConnectorInspect.mockResolvedValue({
      connectorType: 'fabric-sqldatabase',
      queryMode: 'structured',
      entity: 'SalesLT.Customer',
      columns: [],
      rows: [],
      truncated: false,
    });
    testProjectDir = mkdtempSync(join(tmpdir(), 'rayfin-inspect-test-'));
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    rmSync(testProjectDir, { recursive: true, force: true });
  });

  function writeRayfinYml(config: Record<string, unknown>) {
    mkdirSync(join(testProjectDir, 'rayfin'), { recursive: true });
    writeFileSync(
      join(testProjectDir, 'rayfin', 'rayfin.yml'),
      stringify(config, { lineWidth: 0 })
    );
  }

  function writeMetadata(connectorName: string, metadata: unknown) {
    const dir = join(testProjectDir, 'rayfin', 'connectors', connectorName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'metadata.json'), JSON.stringify(metadata));
  }

  const sqlConnectorConfig = {
    id: 'test',
    name: 'Test',
    version: '1.0.0',
    connectors: [
      {
        name: 'sales',
        type: 'fabric-sqldatabase',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
      },
    ],
  };

  it('qualifies a bare --entity using a uniquely matching table in metadata.json', async () => {
    writeRayfinYml(sqlConnectorConfig);
    writeMetadata('sales', {
      schemas: [{ schemaName: 'SalesLT', tables: [{ tableName: 'Customer' }] }],
    });

    await runInspect(['--name', 'sales', '--entity', 'Customer']);

    expect(mocks.runConnectorInspect).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'SalesLT.Customer' })
    );
  });

  it('matches table names case-insensitively but resolves to the canonical casing', async () => {
    writeRayfinYml(sqlConnectorConfig);
    writeMetadata('sales', {
      schemas: [{ schemaName: 'SalesLT', tables: [{ tableName: 'Customer' }] }],
    });

    await runInspect(['--name', 'sales', '--entity', 'customer']);

    expect(mocks.runConnectorInspect).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'SalesLT.Customer' })
    );
  });

  it('leaves an already schema-qualified --entity untouched', async () => {
    writeRayfinYml(sqlConnectorConfig);
    writeMetadata('sales', {
      schemas: [{ schemaName: 'SalesLT', tables: [{ tableName: 'Customer' }] }],
    });

    await runInspect(['--name', 'sales', '--entity', 'dbo.Customer']);

    expect(mocks.runConnectorInspect).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'dbo.Customer' })
    );
  });

  it('falls back to the unqualified entity when metadata.json is missing', async () => {
    writeRayfinYml(sqlConnectorConfig);

    await runInspect(['--name', 'sales', '--entity', 'Customer']);

    expect(mocks.runConnectorInspect).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'Customer' })
    );
  });

  it('falls back to the unqualified entity when the table is not in metadata.json', async () => {
    writeRayfinYml(sqlConnectorConfig);
    writeMetadata('sales', {
      schemas: [{ schemaName: 'SalesLT', tables: [{ tableName: 'Product' }] }],
    });

    await runInspect(['--name', 'sales', '--entity', 'Customer']);

    expect(mocks.runConnectorInspect).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'Customer' })
    );
  });

  it('falls back to the unqualified entity when metadata.json is not valid JSON', async () => {
    writeRayfinYml(sqlConnectorConfig);
    const dir = join(testProjectDir, 'rayfin', 'connectors', 'sales');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'metadata.json'), '{ not valid json');

    await runInspect(['--name', 'sales', '--entity', 'Customer']);

    expect(mocks.runConnectorInspect).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'Customer' })
    );
  });

  it('rejects an entity that matches tables in multiple schemas', async () => {
    writeRayfinYml(sqlConnectorConfig);
    writeMetadata('sales', {
      schemas: [
        { schemaName: 'dbo', tables: [{ tableName: 'Customer' }] },
        { schemaName: 'SalesLT', tables: [{ tableName: 'Customer' }] },
      ],
    });

    await expect(
      runInspect(['--name', 'sales', '--entity', 'Customer'])
    ).rejects.toThrow(
      "Entity 'Customer' exists in multiple schemas: dbo, SalesLT."
    );
    expect(mocks.runConnectorInspect).not.toHaveBeenCalled();
  });

  it('does not consult metadata.json for a non-SQL connector type', async () => {
    writeRayfinYml({
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      connectors: [
        {
          name: 'analytics',
          type: 'fabric-semanticmodel',
          config: { workspaceId: 'ws-1', itemId: 'item-1' },
          operations: [{ name: 'executeQuery' }],
        },
      ],
    });
    writeMetadata('analytics', {
      schemas: [{ schemaName: 'SalesLT', tables: [{ tableName: 'Students' }] }],
    });

    await runInspect(['--name', 'analytics', '--entity', 'Students']);

    expect(mocks.runConnectorInspect).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'Students' })
    );
  });
});

describe('connector inspect — auth and name-resolution failures', () => {
  let stderrSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    testProjectDir = mkdtempSync(join(tmpdir(), 'rayfin-inspect-test-'));
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    rmSync(testProjectDir, { recursive: true, force: true });
  });

  const directArgs = [
    '--workspace-id',
    'ws-1',
    '--item-id',
    'item-1',
    '--type',
    'fabric-sqldatabase',
  ];

  it('reports a clear error when the user is not authenticated', async () => {
    mocks.ensureAuthenticated.mockRejectedValue(new Error('no session'));

    await expect(
      runInspect([...directArgs, '--entity', 'Customer'])
    ).rejects.toThrow('Authentication is required.');
  });

  it('surfaces a workspace-name resolution failure with a --workspace-id hint', async () => {
    mocks.ensureAuthenticated.mockResolvedValue({ token: 'user-token' });
    mocks.resolveWorkspaceIdByNameFuzzy.mockRejectedValue(
      new Error(
        'Workspace "Nonexistent" not found. Please retry with a valid workspace name.'
      )
    );

    await expect(
      runInspect([
        '--workspace',
        'Nonexistent',
        '--item-id',
        'item-1',
        '--type',
        'fabric-sqldatabase',
        '--entity',
        'Customer',
      ])
    ).rejects.toThrow(
      'Workspace "Nonexistent" not found. Please retry with a valid workspace name.'
    );
  });

  it('surfaces an item-name resolution failure with a --item-id hint', async () => {
    mocks.ensureAuthenticated.mockResolvedValue({ token: 'user-token' });
    mocks.resolveItemIdByName.mockRejectedValue(
      new Error('Item "Nonexistent" not found in this workspace.')
    );

    await expect(
      runInspect([
        '--workspace-id',
        'ws-1',
        '--item',
        'Nonexistent',
        '--type',
        'fabric-sqldatabase',
        '--entity',
        'Customer',
      ])
    ).rejects.toThrow('Item "Nonexistent" not found in this workspace.');
  });

  it('reports a clear error when the database-scoped token cannot be acquired', async () => {
    // First ensureAuthenticated call (user token) succeeds; the second,
    // DB-scoped call (SQL-family types only) fails.
    mocks.ensureAuthenticated
      .mockResolvedValueOnce({ token: 'user-token' })
      .mockRejectedValueOnce(new Error('no db scope'));

    await expect(
      runInspect([...directArgs, '--entity', 'Customer'])
    ).rejects.toThrow(
      'Database-scoped authentication is required for SQL inspect.'
    );
  });
});

/**
 * `ensureAuthenticated` hands back an ambient `RAYFIN_TOKEN` verbatim without
 * consulting the scopes the caller asked for — there is no exchange to perform
 * on a supplied token. So a launcher that exports one Fabric-audience token
 * satisfies this command's *request* for a database scope while failing its
 * *requirement*, and the mismatch used to surface as a 401 from the data plane
 * that read like a workspace or model permission problem.
 */
describe('connector inspect — ambient token audience guard', () => {
  let stderrSpy: any;
  let savedToken: string | undefined;

  const POWER_BI = 'https://analysis.windows.net/powerbi/api';
  const FABRIC = 'https://api.fabric.microsoft.com';

  /** Builds an unsigned JWT with the given audience. */
  function jwt(aud?: unknown): string {
    const segment = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${segment({ alg: 'none' })}.${segment(
      aud === undefined ? { sub: 'u' } : { aud }
    )}.signature`;
  }

  const directArgs = [
    '--workspace-id',
    'ws-1',
    '--item-id',
    'item-1',
    '--type',
    'fabric-sqldatabase',
    '--entity',
    'Customer',
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    savedToken = process.env['RAYFIN_TOKEN'];
    testProjectDir = mkdtempSync(join(tmpdir(), 'rayfin-inspect-aud-'));
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mocks.runConnectorInspect.mockResolvedValue({
      connectorType: 'fabric-sqldatabase',
      queryMode: 'structured',
      entity: 'SalesLT.Customer',
      columns: [],
      rows: [],
      truncated: false,
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    rmSync(testProjectDir, { recursive: true, force: true });
    if (savedToken === undefined) {
      delete process.env['RAYFIN_TOKEN'];
    } else {
      process.env['RAYFIN_TOKEN'] = savedToken;
    }
  });

  it('rejects a token minted for another resource', async () => {
    const token = jwt(FABRIC);
    process.env['RAYFIN_TOKEN'] = token;
    mocks.ensureAuthenticated.mockResolvedValue({ token });

    await expect(runInspect(directArgs)).rejects.toThrow(
      `Access token has the wrong audience for SQL inspect (got ${FABRIC}, expected ${POWER_BI}).`
    );
    // Rejected before spending a round trip.
    expect(mocks.runConnectorInspect).not.toHaveBeenCalled();
  });

  it('rejects a token whose audience cannot be read', async () => {
    for (const token of ['opaque-token', jwt(undefined), jwt(['a', 'b'])]) {
      vi.clearAllMocks();
      process.env['RAYFIN_TOKEN'] = token;
      mocks.ensureAuthenticated.mockResolvedValue({ token });

      await expect(runInspect(directArgs)).rejects.toThrow(
        'RAYFIN_TOKEN could not be decoded as a JWT, so its audience cannot be verified.'
      );
      expect(mocks.runConnectorInspect).not.toHaveBeenCalled();
    }
  });

  it('allows a token minted for the database resource', async () => {
    const token = jwt(POWER_BI);
    process.env['RAYFIN_TOKEN'] = token;
    mocks.ensureAuthenticated.mockResolvedValue({ token });

    await runInspect(directArgs);

    expect(mocks.runConnectorInspect).toHaveBeenCalledTimes(1);
  });

  it('ignores a trailing slash on the audience', async () => {
    const token = jwt(`${POWER_BI}/`);
    process.env['RAYFIN_TOKEN'] = token;
    mocks.ensureAuthenticated.mockResolvedValue({ token });

    await runInspect(directArgs);

    expect(mocks.runConnectorInspect).toHaveBeenCalledTimes(1);
  });

  it('leaves the normal desktop path alone', async () => {
    // No ambient token: MSAL acquired the token *for* these scopes, so its
    // audience is correct by construction and the guard must not run.
    delete process.env['RAYFIN_TOKEN'];
    mocks.ensureAuthenticated.mockResolvedValue({ token: 'user-token' });

    await runInspect(directArgs);

    expect(mocks.runConnectorInspect).toHaveBeenCalledTimes(1);
  });

  it('never puts token material in the error', async () => {
    const signature = 'SUPER-SECRET-SIGNATURE';
    const token = `${Buffer.from('{"alg":"none"}').toString(
      'base64url'
    )}.${Buffer.from(`{"aud":"${FABRIC}"}`).toString(
      'base64url'
    )}.${signature}`;
    process.env['RAYFIN_TOKEN'] = token;
    mocks.ensureAuthenticated.mockResolvedValue({ token });

    const error = await runInspect(directArgs).then(
      () => undefined,
      (caught: unknown) => caught as Error
    );

    const surfaced = [
      error?.message ?? '',
      error?.stack ?? '',
      stderrSpy.mock.calls.flat().map(String).join('\n'),
    ].join('\n');
    expect(surfaced).not.toContain(signature);
    expect(surfaced).not.toContain(token);
    // The audience names a resource, not a credential, so it may appear.
    expect(error?.message).toContain(FABRIC);
  });

  describe('RAYFIN_FABRIC_SCOPE does not steer the database audience', () => {
    // `RAYFIN_FABRIC_SCOPE` is documented as the scope for acquiring *Fabric*
    // tokens. Database-scoped commands need the *Power BI* resource, so
    // reading that variable here asked Entra for a Fabric-audience token and
    // presented it to Power BI.
    //
    // The guard derived its expectation from the same variable, so it compared
    // the token against the wrong audience, passed, and let the request fail
    // downstream with the error the guard exists to replace — leaving the check
    // inert in exactly the non-production ring it was meant to protect.
    let savedScope: string | undefined;

    beforeEach(() => {
      savedScope = process.env['RAYFIN_FABRIC_SCOPE'];
      process.env['RAYFIN_FABRIC_SCOPE'] = `${FABRIC}/.default`;
    });

    afterEach(() => {
      if (savedScope === undefined) delete process.env['RAYFIN_FABRIC_SCOPE'];
      else process.env['RAYFIN_FABRIC_SCOPE'] = savedScope;
    });

    it('still rejects a Fabric-audience token', async () => {
      const token = jwt(FABRIC);
      process.env['RAYFIN_TOKEN'] = token;
      mocks.ensureAuthenticated.mockResolvedValue({ token });

      await expect(runInspect(directArgs)).rejects.toThrow(
        `Access token has the wrong audience for SQL inspect (got ${FABRIC}, expected ${POWER_BI}).`
      );
      expect(mocks.runConnectorInspect).not.toHaveBeenCalled();
    });

    it('still requests the Power BI scope, not the Fabric one', async () => {
      const token = jwt(POWER_BI);
      process.env['RAYFIN_TOKEN'] = token;
      mocks.ensureAuthenticated.mockResolvedValue({ token });

      await runInspect(directArgs);

      expect(mocks.ensureAuthenticated).toHaveBeenCalledWith(
        [`${POWER_BI}/.default`],
        expect.anything()
      );
    });
  });
});

describe('connector inspect — service error rendering', () => {
  let stderrSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureAuthenticated.mockResolvedValue({ token: 'user-token' });
    testProjectDir = mkdtempSync(join(tmpdir(), 'rayfin-inspect-test-'));
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    rmSync(testProjectDir, { recursive: true, force: true });
  });

  const directArgs = [
    '--workspace-id',
    'ws-1',
    '--item-id',
    'item-1',
    '--type',
    'fabric-sqldatabase',
  ];

  it('renders a ConnectorInspectError message and recovery hint from the service', async () => {
    const { ConnectorInspectError } =
      await import('../services/connectors/inspect/service');
    mocks.runConnectorInspect.mockRejectedValue(
      new ConnectorInspectError(
        "Entity 'Customer' exists in multiple schemas: dbo, SalesLT.",
        'Disambiguate with a schema-qualified name, e.g. --entity dbo.Customer'
      )
    );

    await expect(
      runInspect([...directArgs, '--entity', 'Customer'])
    ).rejects.toThrow(
      "Entity 'Customer' exists in multiple schemas: dbo, SalesLT."
    );
  });

  it('renders a generic recovery hint for an unexpected service error', async () => {
    mocks.runConnectorInspect.mockRejectedValue(new Error('boom'));

    await expect(
      runInspect([...directArgs, '--entity', 'Customer'])
    ).rejects.toThrow('Inspect failed: boom');
  });
});

describe('connector inspect — --json mode is silent on stderr', () => {
  let stderrSpy: any;
  let stdoutSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureAuthenticated.mockResolvedValue({ token: 'user-token' });
    testProjectDir = mkdtempSync(join(tmpdir(), 'rayfin-inspect-test-'));
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    rmSync(testProjectDir, { recursive: true, force: true });
  });

  const directArgs = [
    '--workspace-id',
    'ws-1',
    '--item-id',
    'item-1',
    '--type',
    'fabric-sqldatabase',
  ];

  it('emits no stderr progress output on success, only the JSON envelope on stdout', async () => {
    const businessDate = new Date('2026-01-15T00:00:00.000Z');
    const createdAt = new Date('2026-01-15T00:30:00.000Z');
    mocks.runConnectorInspect.mockResolvedValue({
      connectorType: 'fabric-sqldatabase',
      queryMode: 'structured',
      entity: 'SalesLT.Customer',
      columns: [
        { name: 'BusinessDate', type: 'date' },
        { name: 'CreatedAt', type: 'datetime' },
      ],
      rows: [{ BusinessDate: businessDate, CreatedAt: createdAt }],
      truncated: false,
    });

    await runInspect([...directArgs, '--entity', 'Customer', '--json']);

    expect(mocks.ensureAuthenticated).toHaveBeenCalledTimes(2);
    for (const call of mocks.ensureAuthenticated.mock.calls) {
      expect(call[1]).toEqual({ silent: true });
    }
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const emitted = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(emitted).toMatchObject({
      status: 'ok',
      entity: 'SalesLT.Customer',
      columns: [
        { name: 'BusinessDate', type: 'date' },
        { name: 'CreatedAt', type: 'datetime' },
      ],
      rows: [
        {
          BusinessDate: '2026-01-15T00:00:00.000Z',
          CreatedAt: '2026-01-15T00:30:00.000Z',
        },
      ],
    });
  });

  it('includes metadata columns when a SQL query returns zero rows', async () => {
    mocks.runConnectorInspect.mockResolvedValue({
      connectorType: 'fabric-sqldatabase',
      queryMode: 'structured',
      entity: 'SalesLT.Customer',
      columns: [
        { name: 'Id', type: 'integer' },
        { name: 'BusinessDate', type: 'date' },
      ],
      rows: [],
      truncated: false,
    });

    await runInspect([...directArgs, '--entity', 'Customer', '--json']);

    expect(stderrSpy).not.toHaveBeenCalled();
    const emitted = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(emitted).toMatchObject({
      status: 'ok',
      rowsReturned: 0,
      columns: [
        { name: 'Id', type: 'integer' },
        { name: 'BusinessDate', type: 'date' },
      ],
      rows: [],
    });
  });

  it('emits no stderr progress output on service failure, only the JSON error on stdout', async () => {
    mocks.runConnectorInspect.mockRejectedValue(new Error('boom'));

    await expect(
      runInspect([...directArgs, '--entity', 'Customer', '--json'])
    ).rejects.toThrow();

    expect(stderrSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const emitted = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(emitted).toMatchObject({ status: 'error' });
  });
});

describe('connector inspect — SQL date display', () => {
  let stderrSpy: any;
  const originalTimeZone = process.env.TZ;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureAuthenticated.mockResolvedValue({ token: 'user-token' });
    testProjectDir = mkdtempSync(join(tmpdir(), 'rayfin-inspect-date-test-'));
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    rmSync(testProjectDir, { recursive: true, force: true });
    if (originalTimeZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTimeZone;
    }
  });

  const directArgs = [
    '--workspace-id',
    'ws-1',
    '--item-id',
    'item-1',
    '--type',
    'fabric-sqldatabase',
    '--entity',
    'Customer',
    '--output',
    'plain',
  ];

  it('prints the typed column contract when SQL returns zero rows', async () => {
    mocks.runConnectorInspect.mockResolvedValue({
      connectorType: 'fabric-sqldatabase',
      queryMode: 'structured',
      entity: 'SalesLT.Customer',
      columns: [
        { name: 'Id', type: 'integer' },
        { name: 'BusinessDate', type: 'date' },
      ],
      rows: [],
      truncated: false,
    });

    await runInspect(directArgs);

    const stderr = stderrSpy.mock.calls.map((call: any[]) => call[0]).join('');
    expect(stderr).toContain('Columns: Id (integer), BusinessDate (date)');
    expect(stderr).toContain('No rows returned.');
  });

  it('keeps the no-column-metadata message distinct for populated results', async () => {
    mocks.runConnectorInspect.mockResolvedValue({
      connectorType: 'fabric-sqldatabase',
      queryMode: 'structured',
      entity: 'SalesLT.Customer',
      columns: [],
      rows: [{ Id: 1 }],
      truncated: false,
    });

    await runInspect(directArgs);

    const stderr = stderrSpy.mock.calls.map((call: any[]) => call[0]).join('');
    expect(stderr).toContain('Result has rows but no column metadata.');
  });

  it.each(['America/Los_Angeles', 'Pacific/Kiritimati'])(
    'renders SQL date as the same calendar value in %s while keeping datetime timestamp-like',
    async (timeZone) => {
      process.env.TZ = timeZone;
      mocks.runConnectorInspect.mockResolvedValue({
        connectorType: 'fabric-sqldatabase',
        queryMode: 'structured',
        entity: 'SalesLT.Customer',
        columns: [
          { name: 'BusinessDate', type: 'date' },
          { name: 'StartTime', type: 'time' },
          { name: 'CreatedAt', type: 'datetime' },
        ],
        rows: [
          {
            BusinessDate: new Date('2026-01-15T00:00:00.000Z'),
            StartTime: new Date('1970-01-01T09:00:00.000Z'),
            CreatedAt: new Date('2026-01-15T00:30:00.000Z'),
          },
        ],
        truncated: false,
      });

      await runInspect([...directArgs, '--rows', '1']);

      const stderr = stderrSpy.mock.calls
        .map((call: any[]) => call[0])
        .join('');
      expect(stderr).toContain(
        'Columns: BusinessDate (date), StartTime (time), CreatedAt (datetime)'
      );
      expect(stderr).toContain('2026-01-15');
      expect(stderr).toContain('09:00:00.000');
      expect(stderr).toContain('2026-01-15T00:30:00.000Z');
      expect(stderr).not.toContain('1970-01-01T09:00:00.000Z');
      expect(stderr).not.toContain('Wed Jan');
      expect(stderr).not.toContain('Thu Jan');
    }
  );

  it('prints the typed column contract before vertical populated output', async () => {
    const columnsDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      'columns'
    );
    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      value: 20,
    });
    mocks.runConnectorInspect.mockResolvedValue({
      connectorType: 'fabric-sqldatabase',
      queryMode: 'structured',
      entity: 'SalesLT.Customer',
      columns: [
        { name: 'Id', type: 'integer' },
        { name: 'Name', type: 'text' },
      ],
      rows: [{ Id: 1, Name: 'A long customer display name' }],
      truncated: false,
    });

    try {
      await runInspect([...directArgs, '--rows', '1']);
    } finally {
      if (columnsDescriptor) {
        Object.defineProperty(process.stdout, 'columns', columnsDescriptor);
      } else {
        delete (process.stdout as { columns?: number }).columns;
      }
    }

    const stderr = stderrSpy.mock.calls.map((call: any[]) => call[0]).join('');
    expect(stderr).toContain('Columns: Id (integer)');
    expect(stderr).toContain('         Name (text)');
    expect(stderr).toContain('-- Row 1/1 --');
  });

  it('renders binary and unknown buffers as width-safe terminal text', async () => {
    const payload = Buffer.alloc(64, 0xab);
    mocks.runConnectorInspect.mockResolvedValue({
      connectorType: 'fabric-sqldatabase',
      queryMode: 'structured',
      entity: 'SalesLT.Customer',
      columns: [
        { name: 'Payload', type: 'binary' },
        { name: 'Location', type: 'unknown' },
      ],
      rows: [{ Payload: payload, Location: payload }],
      truncated: false,
    });

    await runInspect([...directArgs, '--rows', '1']);

    const stderr = stderrSpy.mock.calls.map((call: any[]) => call[0]).join('');
    expect(stderr).toContain('0xabababab');
    expect(stderr).toContain('…');
    expect(stderr).not.toContain(`0x${payload.toString('hex')}`);
    expect(
      [...stderr].some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 && character !== '\n' && character !== '\r';
      })
    ).toBe(false);
  });
});

describe('connector inspect — entity listing mode', () => {
  let stderrSpy: any;
  let stdoutSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureAuthenticated.mockResolvedValue({ token: 'user-token' });
    testProjectDir = mkdtempSync(join(tmpdir(), 'rayfin-inspect-entities-'));
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    rmSync(testProjectDir, { recursive: true, force: true });
  });

  const sqlArgs = [
    '--workspace-id',
    'ws-1',
    '--item-id',
    'item-1',
    '--type',
    'fabric-sqldatabase',
  ];

  const semanticModelArgs = [
    '--workspace-id',
    'ws-1',
    '--item-id',
    'item-1',
    '--type',
    'fabric-semanticmodel',
  ];

  function armEntityListing(connectorType: string): void {
    mocks.runConnectorInspect.mockResolvedValue({
      connectorType,
      queryMode: 'entities',
      entity: undefined,
      columns: [{ name: 'TABLE_NAME', type: 'text' }],
      rows: [{ TABLE_NAME: 'Customer' }],
      truncated: false,
    });
  }

  it('defaults to the max row cap so a listing does not silently truncate', async () => {
    armEntityListing('fabric-sqldatabase');

    await runInspect(sqlArgs);

    expect(mocks.runConnectorInspect).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'entities', rows: 100 })
    );
    const stderr = stderrSpy.mock.calls.map((call: any[]) => call[0]).join('');
    expect(stderr).toContain('Customer');
  });

  it('honours an explicit --rows in entity listing mode', async () => {
    armEntityListing('fabric-sqldatabase');

    await runInspect([...sqlArgs, '--rows', '5']);

    expect(mocks.runConnectorInspect).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'entities', rows: 5 })
    );
  });

  it('keeps the sampling row default when --entity is given', async () => {
    mocks.runConnectorInspect.mockResolvedValue({
      connectorType: 'fabric-sqldatabase',
      queryMode: 'structured',
      entity: 'SalesLT.Customer',
      columns: [{ name: 'Id', type: 'integer' }],
      rows: [{ Id: 1 }],
      truncated: false,
    });

    await runInspect([...sqlArgs, '--entity', 'Customer']);

    expect(mocks.runConnectorInspect).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'structured', rows: 10 })
    );
  });

  it('lists entities for a semantic model connector', async () => {
    armEntityListing('fabric-semanticmodel');

    await runInspect(semanticModelArgs);

    expect(mocks.runConnectorInspect).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'entities',
        connectorType: 'fabric-semanticmodel',
      })
    );
    const stderr = stderrSpy.mock.calls.map((call: any[]) => call[0]).join('');
    expect(stderr).toContain('Customer');
  });

  it('reports the entity query mode in the JSON envelope', async () => {
    armEntityListing('fabric-sqldatabase');

    await runInspect([...sqlArgs, '--json']);

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const emitted = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(emitted).toMatchObject({ status: 'ok', queryMode: 'entities' });
  });

  it('echoes the direct selector back in the sample-entity hint', async () => {
    armEntityListing('fabric-sqldatabase');

    await runInspect(sqlArgs);

    const stderr = stderrSpy.mock.calls.map((c: any[]) => c[0]).join('');
    expect(stderr).toContain(
      "rayfin connector inspect --workspace-id 'ws-1' --item-id 'item-1' --type 'fabric-sqldatabase' --entity <name>"
    );
  });

  it('shell-escapes selector values containing metacharacters', async () => {
    armEntityListing('fabric-sqldatabase');

    await runInspect([
      '--workspace-id',
      'ws 1&foo=$bar',
      '--item-id',
      'item`1;rm',
      '--type',
      'fabric-sqldatabase',
    ]);

    const stderr = stderrSpy.mock.calls.map((c: any[]) => c[0]).join('');
    expect(stderr).toContain(
      "rayfin connector inspect --workspace-id 'ws 1&foo=$bar' --item-id 'item`1;rm' --type 'fabric-sqldatabase' --entity <name>"
    );
  });
});
