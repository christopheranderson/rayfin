import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fabricApiBaseUrl = vi.fn<() => string>();

vi.mock('../../config/constants.js', () => ({
  getFabricSettings: () => ({ fabricApiBaseUrl: fabricApiBaseUrl() }),
}));

const {
  resolveDbTokenTarget,
  inspectDbTokenAudience,
  POWER_BI_AUDIENCE_PROD,
  POWER_BI_AUDIENCE_INT,
} = await import('../db-token.js');

function tokenForAudience(audience: string): string {
  const payload = Buffer.from(JSON.stringify({ aud: audience })).toString(
    'base64url'
  );
  return `header.${payload}.signature`;
}

describe('resolveDbTokenTarget', () => {
  const originalDbScope = process.env['RAYFIN_DB_TOKEN_SCOPE'];
  const originalFabricScope = process.env['RAYFIN_FABRIC_SCOPE'];

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['RAYFIN_DB_TOKEN_SCOPE'];
    delete process.env['RAYFIN_FABRIC_SCOPE'];
    fabricApiBaseUrl.mockReturnValue('https://api.fabric.microsoft.com');
  });

  afterEach(() => {
    for (const [key, value] of [
      ['RAYFIN_DB_TOKEN_SCOPE', originalDbScope],
      ['RAYFIN_FABRIC_SCOPE', originalFabricScope],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each([
    ['https://api.fabric.microsoft.com', 'production'],
    ['https://dailyapi.fabric.microsoft.com', 'daily'],
    ['https://dxtapi.fabric.microsoft.com', 'dxt'],
    ['https://msitapi.fabric.microsoft.com', 'msit'],
  ])('pairs %s (%s) with the production Power BI resource', (url) => {
    fabricApiBaseUrl.mockReturnValue(url);
    expect(resolveDbTokenTarget().audience).toBe(POWER_BI_AUDIENCE_PROD);
  });

  it.each([
    ['https://analysis-df.windows.net', 'EDOG/PPE/DF'],
    ['https://some-proxy.example.com', 'an unrecognized proxy'],
    ['not-a-url', 'a malformed origin'],
    ['', 'an empty origin'],
  ])('keeps %s (%s) on the INT resource', (url) => {
    fabricApiBaseUrl.mockReturnValue(url);
    expect(resolveDbTokenTarget().audience).toBe(POWER_BI_AUDIENCE_INT);
  });

  it('never hands an unrecognized host a production-scoped token', () => {
    fabricApiBaseUrl.mockReturnValue('https://attacker.example.com');
    expect(resolveDbTokenTarget().scopes).toEqual([
      `${POWER_BI_AUDIENCE_INT}/.default`,
    ]);
  });

  it('builds the scope from the audience it resolved', () => {
    expect(resolveDbTokenTarget().scopes).toEqual([
      `${POWER_BI_AUDIENCE_PROD}/.default`,
    ]);
  });

  it('lets RAYFIN_DB_TOKEN_SCOPE override the host inference', () => {
    const custom = 'https://custom.example.com/resource';
    process.env['RAYFIN_DB_TOKEN_SCOPE'] = `${custom}/.default`;
    fabricApiBaseUrl.mockReturnValue('https://api.fabric.microsoft.com');

    expect(resolveDbTokenTarget()).toEqual({
      scopes: [`${custom}/.default`],
      audience: custom,
    });
  });

  it('ignores RAYFIN_FABRIC_SCOPE, which names the Fabric resource', () => {
    // Honouring it would request a Fabric-audience token for a Power BI
    // operation, which is the mismatch this module exists to prevent.
    process.env['RAYFIN_FABRIC_SCOPE'] =
      'https://api.fabric.microsoft.com/.default';

    expect(resolveDbTokenTarget().audience).toBe(POWER_BI_AUDIENCE_PROD);
  });

  it('accepts an explicit base URL over the ambient settings', () => {
    fabricApiBaseUrl.mockReturnValue('https://api.fabric.microsoft.com');

    expect(
      resolveDbTokenTarget('https://some-proxy.example.com').audience
    ).toBe(POWER_BI_AUDIENCE_INT);
  });
});

describe('inspectDbTokenAudience', () => {
  const target = {
    scopes: [`${POWER_BI_AUDIENCE_PROD}/.default`],
    audience: POWER_BI_AUDIENCE_PROD,
  };

  it('accepts a token for the expected audience', () => {
    const token = tokenForAudience(POWER_BI_AUDIENCE_PROD);
    expect(inspectDbTokenAudience(token, target)).toEqual({ status: 'ok' });
  });

  it('reports a token minted for another resource', () => {
    const token = tokenForAudience('https://api.fabric.microsoft.com');
    expect(inspectDbTokenAudience(token, target)).toEqual({
      status: 'mismatch',
      actual: 'https://api.fabric.microsoft.com',
    });
  });

  it('reports a token whose audience cannot be read', () => {
    expect(inspectDbTokenAudience('opaque', target)).toEqual({
      status: 'unreadable',
    });
  });

  it('accepts an Authorization header, not just a raw token', () => {
    const token = tokenForAudience(POWER_BI_AUDIENCE_PROD);
    expect(inspectDbTokenAudience(`Bearer ${token}`, target)).toEqual({
      status: 'ok',
    });
  });

  it('treats a trailing slash as insignificant', () => {
    const token = tokenForAudience(`${POWER_BI_AUDIENCE_PROD}/`);
    expect(inspectDbTokenAudience(token, target)).toEqual({ status: 'ok' });
  });

  it('rejects the INT audience against a production target', () => {
    const token = tokenForAudience(POWER_BI_AUDIENCE_INT);
    expect(inspectDbTokenAudience(token, target).status).toBe('mismatch');
  });
});
