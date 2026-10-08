import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ensureAuthenticated = vi.fn();
const getConnectionStringByType = vi.fn();
const discoverSchema = vi.fn();
const writeMetadataFile = vi.fn();

vi.mock('../auth/index.js', () => ({
  ensureAuthenticated: (...args: unknown[]) => ensureAuthenticated(...args),
}));

vi.mock('../services/fabric/sql-endpoint.js', () => ({
  SqlEndpointManager: class {
    getConnectionStringByType = getConnectionStringByType;
  },
}));

vi.mock('../services/schema-discovery.js', () => ({
  discoverSchema: (...args: unknown[]) => discoverSchema(...args),
  writeMetadataFile: (...args: unknown[]) => writeMetadataFile(...args),
}));

const { runConnectorSchemaDiscovery } =
  await import('../services/connector-schema-discovery.js');

/** Build a JWT whose payload carries `aud`. Signature is never validated. */
function tokenForAudience(audience: string): string {
  const payload = Buffer.from(JSON.stringify({ aud: audience })).toString(
    'base64url'
  );
  return `header.${payload}.signature`;
}

const POWERBI_AUDIENCE = 'https://analysis.windows.net/powerbi/api';
const FABRIC_AUDIENCE = 'https://api.fabric.microsoft.com';

function runDiscovery(): ReturnType<typeof runConnectorSchemaDiscovery> {
  return runConnectorSchemaDiscovery({
    projectRoot: '/tmp/project',
    rayfinYmlPath: '/tmp/project/rayfin.yml',
    config: {},
    entries: [
      {
        name: 'sales',
        type: 'fabric-sqldatabase',
        config: { workspaceId: 'ws-1', itemId: 'item-1' },
      },
    ] as never,
    entryIndex: 0,
    itemType: 'SQLDatabase',
    fabricToken: 'fabric-control-plane-token',
    mode: 'text' as never,
    verbose: false,
    yes: true,
    retryHintOnFailure: 'Connector was added to rayfin.yml.',
  });
}

describe('runConnectorSchemaDiscovery — ambient token audience guard', () => {
  const originalToken = process.env['RAYFIN_TOKEN'];

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['RAYFIN_TOKEN'];

    getConnectionStringByType.mockResolvedValue({
      connectionString: 'Server=tcp:example;Database=db',
      databaseName: 'db',
      resolvedItemId: 'item-1',
    });
    discoverSchema.mockResolvedValue({ schemas: [] });
    writeMetadataFile.mockReturnValue('/tmp/project/metadata.json');
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env['RAYFIN_TOKEN'];
    else process.env['RAYFIN_TOKEN'] = originalToken;
  });

  it('rejects an ambient token minted for the Fabric audience', async () => {
    const wrongToken = tokenForAudience(FABRIC_AUDIENCE);
    process.env['RAYFIN_TOKEN'] = wrongToken;
    ensureAuthenticated.mockResolvedValue({ token: wrongToken });

    const result = await runDiscovery();

    expect(result.succeeded).toBe(false);
    expect(result.reason).toBe('audience');
    expect(result.error).toContain(FABRIC_AUDIENCE);
    expect(result.error).toContain(POWERBI_AUDIENCE);

    // The whole point: never reach the data plane, so the driver's login
    // rejection can't be reported as a permissions problem.
    expect(discoverSchema).not.toHaveBeenCalled();
  });

  it('does not offer `rayfin login`, which cannot replace an ambient token', async () => {
    const wrongToken = tokenForAudience(FABRIC_AUDIENCE);
    process.env['RAYFIN_TOKEN'] = wrongToken;
    ensureAuthenticated.mockResolvedValue({ token: wrongToken });

    const result = await runDiscovery();

    expect(result.recovery).not.toMatch(/rayfin login/u);
    expect(result.recovery).toMatch(/RAYFIN_TOKEN/u);
  });

  it('rejects an opaque ambient token whose audience cannot be read', async () => {
    process.env['RAYFIN_TOKEN'] = 'opaque-not-a-jwt';
    ensureAuthenticated.mockResolvedValue({ token: 'opaque-not-a-jwt' });

    const result = await runDiscovery();

    expect(result.succeeded).toBe(false);
    expect(result.reason).toBe('audience');
    expect(discoverSchema).not.toHaveBeenCalled();
  });

  it('allows an ambient token minted for the database audience', async () => {
    const rightToken = tokenForAudience(POWERBI_AUDIENCE);
    process.env['RAYFIN_TOKEN'] = rightToken;
    ensureAuthenticated.mockResolvedValue({ token: rightToken });

    const result = await runDiscovery();

    expect(result.succeeded).toBe(true);
    expect(discoverSchema).toHaveBeenCalledTimes(1);
  });

  it('leaves the MSAL path alone, including an opaque token', async () => {
    // No RAYFIN_TOKEN: the token was acquired *for* these scopes, so its
    // audience is correct by construction and must not be second-guessed.
    ensureAuthenticated.mockResolvedValue({ token: 'opaque-msal-token' });

    const result = await runDiscovery();

    expect(result.succeeded).toBe(true);
    expect(discoverSchema).toHaveBeenCalledTimes(1);
  });

  it('honours RAYFIN_DB_TOKEN_SCOPE when deriving the expected audience', async () => {
    const ring = 'https://analysis.windows-int.net/powerbi/api';
    const originalScope = process.env['RAYFIN_DB_TOKEN_SCOPE'];
    process.env['RAYFIN_DB_TOKEN_SCOPE'] = `${ring}/.default`;

    const ringToken = tokenForAudience(ring);
    process.env['RAYFIN_TOKEN'] = ringToken;
    ensureAuthenticated.mockResolvedValue({ token: ringToken });

    try {
      const result = await runDiscovery();

      // A production-audience token would be wrong in this ring, and the
      // previously hard-coded scope would have accepted it.
      expect(result.succeeded).toBe(true);
      expect(ensureAuthenticated).toHaveBeenCalledWith([`${ring}/.default`]);
    } finally {
      if (originalScope === undefined)
        delete process.env['RAYFIN_DB_TOKEN_SCOPE'];
      else process.env['RAYFIN_DB_TOKEN_SCOPE'] = originalScope;
    }
  });

  it('ignores RAYFIN_FABRIC_SCOPE, which names the Fabric resource', async () => {
    // Honouring it here would request a Fabric-audience token for a Power BI
    // operation and then verify it against that same wrong audience, leaving
    // the guard inert in exactly the ring it is meant to protect.
    const originalScope = process.env['RAYFIN_FABRIC_SCOPE'];
    process.env['RAYFIN_FABRIC_SCOPE'] =
      'https://api.fabric.microsoft.com/.default';

    const fabricToken = tokenForAudience(FABRIC_AUDIENCE);
    process.env['RAYFIN_TOKEN'] = fabricToken;
    ensureAuthenticated.mockResolvedValue({ token: fabricToken });

    try {
      const result = await runDiscovery();

      expect(result.succeeded).toBe(false);
      expect(result.reason).toBe('audience');
      expect(result.error).toContain(POWERBI_AUDIENCE);
    } finally {
      if (originalScope === undefined)
        delete process.env['RAYFIN_FABRIC_SCOPE'];
      else process.env['RAYFIN_FABRIC_SCOPE'] = originalScope;
    }
  });

  it('never puts token material in the failure it reports', async () => {
    const marker = 'SUPERSECRETTOKENMATERIAL';
    const wrongToken = `header.${Buffer.from(
      JSON.stringify({ aud: FABRIC_AUDIENCE, secret: marker })
    ).toString('base64url')}.${marker}`;
    process.env['RAYFIN_TOKEN'] = wrongToken;
    ensureAuthenticated.mockResolvedValue({ token: wrongToken });

    const result = await runDiscovery();

    expect(result.succeeded).toBe(false);
    expect(JSON.stringify(result)).not.toContain(marker);
  });
});
