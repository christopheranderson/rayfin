import { describe, expect, it } from 'vitest';

import {
  applyBaseApiUrlOverride,
  applyWorkspaceUriOverrides,
  getFabricSettings,
  parseWorkspaceUri,
} from '../fabric.js';

const WS = '767f94fa-1106-4377-8fb4-bb931907444a';

describe('parseWorkspaceUri', () => {
  it('constructs URLs from the subdomain via templating', () => {
    const result = parseWorkspaceUri(
      `https://env1.fabric.microsoft.com/groups/${WS}/list?experience=power-bi`
    );
    expect(result).toEqual({
      workspaceId: WS,
      isMyWorkspace: false,
      environment: 'env1',
      fabricApiBaseUrl: 'https://env1api.fabric.microsoft.com/v1',
      fabricPortalUrl: 'https://env1.fabric.microsoft.com/',
    });
  });

  it('templates a different subdomain identically', () => {
    const result = parseWorkspaceUri(
      `https://env2.fabric.microsoft.com/groups/${WS}`
    );
    expect(result.environment).toBe('env2');
    expect(result.fabricApiBaseUrl).toBe(
      'https://env2api.fabric.microsoft.com/v1'
    );
    expect(result.fabricPortalUrl).toBe('https://env2.fabric.microsoft.com/');
    expect(result.workspaceId).toBe(WS);
  });

  it('ignores extra path segments after /groups/<guid>', () => {
    const result = parseWorkspaceUri(
      `https://env3.fabric.microsoft.com/groups/${WS}/list`
    );
    expect(result.environment).toBe('env3');
    expect(result.workspaceId).toBe(WS);
  });

  it('uses only the leftmost subdomain label', () => {
    const result = parseWorkspaceUri(
      `https://foo.bar.fabric.microsoft.com/groups/${WS}/list`
    );
    expect(result.environment).toBe('foo');
    expect(result.fabricApiBaseUrl).toBe(
      'https://fooapi.fabric.microsoft.com/v1'
    );
    expect(result.fabricPortalUrl).toBe('https://foo.fabric.microsoft.com/');
  });

  it('is case-insensitive for the host', () => {
    const result = parseWorkspaceUri(
      `https://ENV1.Fabric.Microsoft.COM/groups/${WS}/list`
    );
    expect(result.environment).toBe('env1');
  });

  it('maps the production "app" subdomain to "api" (not "appapi")', () => {
    const result = parseWorkspaceUri(
      `https://app.fabric.microsoft.com/groups/${WS}/list`
    );
    expect(result).toEqual({
      workspaceId: WS,
      isMyWorkspace: false,
      environment: 'app',
      fabricApiBaseUrl: 'https://api.fabric.microsoft.com/v1',
      fabricPortalUrl: 'https://app.fabric.microsoft.com/',
    });
  });

  it('accepts GUIDs in uppercase', () => {
    const upper = WS.toUpperCase();
    const result = parseWorkspaceUri(
      `https://env1.fabric.microsoft.com/groups/${upper}`
    );
    expect(result.workspaceId).toBe(upper);
    expect(result.isMyWorkspace).toBe(false);
  });

  it('treats the literal /groups/me segment as "My workspace"', () => {
    const result = parseWorkspaceUri(
      'https://env1.fabric.microsoft.com/groups/me/list?experience=power-bi'
    );
    expect(result.isMyWorkspace).toBe(true);
    expect(result.workspaceId).toBeUndefined();
    expect(result.environment).toBe('env1');
    expect(result.fabricApiBaseUrl).toBe(
      'https://env1api.fabric.microsoft.com/v1'
    );
    expect(result.fabricPortalUrl).toBe('https://env1.fabric.microsoft.com/');
  });

  it('is case-insensitive for the "me" path segment', () => {
    const result = parseWorkspaceUri(
      'https://app.fabric.microsoft.com/groups/ME/list'
    );
    expect(result.isMyWorkspace).toBe(true);
    expect(result.workspaceId).toBeUndefined();
  });

  it('throws on non-fabric hosts', () => {
    expect(() =>
      parseWorkspaceUri(`https://contoso.example.com/groups/${WS}/list`)
    ).toThrow(/\*\.fabric\.microsoft\.com/);
  });

  it('accepts a Power BI portal host and maps it onto Fabric', () => {
    // The Fabric portal address bar (and our onboarding docs) hand the
    // user a *.powerbi.com URL; it names the same environment as its
    // *.fabric.microsoft.com counterpart.
    const result = parseWorkspaceUri(
      `https://dxt.powerbi.com/groups/${WS}/list`
    );
    expect(result.workspaceId).toBe(WS);
    expect(result.environment).toBe('dxt');
    expect(result.fabricApiBaseUrl).toBe(
      'https://dxtapi.fabric.microsoft.com/v1'
    );
    expect(result.fabricPortalUrl).toBe('https://dxt.fabric.microsoft.com/');
  });

  it('maps the production Power BI host to the production Fabric API', () => {
    const result = parseWorkspaceUri(
      `https://app.powerbi.com/groups/${WS}/list`
    );
    expect(result.environment).toBe('app');
    expect(result.fabricApiBaseUrl).toBe('https://api.fabric.microsoft.com/v1');
    expect(result.fabricPortalUrl).toBe('https://app.fabric.microsoft.com/');
  });

  it.each(['msit.powerbi.com', 'msit.fabric.microsoft.com'])(
    'maps the %s workspace URI to the MSIT Power BI portal',
    (host) => {
      const result = parseWorkspaceUri(`https://${host}/groups/${WS}/list`);
      expect(result.environment).toBe('msit');
      expect(result.fabricApiBaseUrl).toBe(
        'https://msitapi.fabric.microsoft.com/v1'
      );
      expect(result.fabricPortalUrl).toBe('https://msit.powerbi.com/');
    }
  );

  it('resolves a Power BI host identically to its Fabric counterpart', () => {
    const viaPowerBi = parseWorkspaceUri(
      `https://dxt.powerbi.com/groups/${WS}/list`
    );
    const viaFabric = parseWorkspaceUri(
      `https://dxt.fabric.microsoft.com/groups/${WS}/list`
    );
    expect(viaPowerBi).toEqual(viaFabric);
  });

  it('requires the leading dot on the powerbi.com suffix', () => {
    // "notpowerbi.com" must not be mistaken for a Power BI portal host.
    expect(() =>
      parseWorkspaceUri(`https://env1.notpowerbi.com/groups/${WS}/list`)
    ).toThrow(/\*\.powerbi\.com/);
  });

  it('handles a root-anchored Power BI FQDN', () => {
    // A trailing dot must be stripped before the suffix slice, or the
    // environment label would come back mangled.
    const result = parseWorkspaceUri(
      `https://dxt.powerbi.com./groups/${WS}/list`
    );
    expect(result.environment).toBe('dxt');
  });

  it('throws when /groups/<guid> segment is missing', () => {
    expect(() =>
      parseWorkspaceUri('https://env1.fabric.microsoft.com/list')
    ).toThrow(/\/groups\/<workspaceId>/);
  });

  it('throws when workspace ID is not a valid GUID', () => {
    expect(() =>
      parseWorkspaceUri(
        'https://env1.fabric.microsoft.com/groups/not-a-guid/list'
      )
    ).toThrow(/invalid workspace ID/);
  });

  it('throws on malformed URLs', () => {
    expect(() => parseWorkspaceUri('not a url')).toThrow(/Invalid workspace/);
  });

  it('throws on empty input', () => {
    expect(() => parseWorkspaceUri('')).toThrow(/non-empty/);
  });

  it('throws on non-http protocols', () => {
    expect(() =>
      parseWorkspaceUri(`ftp://env1.fabric.microsoft.com/groups/${WS}`)
    ).toThrow(/protocol/);
  });
});

describe('applyWorkspaceUriOverrides', () => {
  it('writes RAYFIN_FABRIC_* into the provided env record', () => {
    const env: Record<string, string | undefined> = {};
    const parsed = applyWorkspaceUriOverrides(
      `https://env1.fabric.microsoft.com/groups/${WS}/list`,
      env
    );
    expect(parsed.workspaceId).toBe(WS);
    expect(env.RAYFIN_FABRIC_API_URL).toBe(
      'https://env1api.fabric.microsoft.com/v1'
    );
    expect(env.RAYFIN_FABRIC_PORTAL_URL).toBe(
      'https://env1.fabric.microsoft.com/'
    );
    // getFabricSettings should observe the override.
    const settings = getFabricSettings(env);
    expect(settings.fabricApiBaseUrl).toBe(
      'https://env1api.fabric.microsoft.com/v1'
    );
    expect(settings.fabricPortalUrl).toBe('https://env1.fabric.microsoft.com/');
  });

  it('preserves a portal override while the URI retargets the API', () => {
    const env: Record<string, string | undefined> = {
      RAYFIN_FABRIC_API_URL: 'https://oldapi.fabric.microsoft.com/v1',
      RAYFIN_FABRIC_PORTAL_URL: 'https://old.fabric.microsoft.com/',
    };
    applyWorkspaceUriOverrides(
      `https://env2.fabric.microsoft.com/groups/${WS}/list`,
      env
    );
    expect(env.RAYFIN_FABRIC_API_URL).toBe(
      'https://env2api.fabric.microsoft.com/v1'
    );
    expect(env.RAYFIN_FABRIC_PORTAL_URL).toBe(
      'https://old.fabric.microsoft.com/'
    );
  });
});

describe('applyBaseApiUrlOverride', () => {
  it('normalizes a bare-origin API URL to <origin>/v1 and sets RAYFIN_FABRIC_API_URL', () => {
    const env: Record<string, string | undefined> = {};
    const result = applyBaseApiUrlOverride(
      'https://envapi.fabric.microsoft.com',
      env
    );
    expect(result.fabricApiBaseUrl).toBe(
      'https://envapi.fabric.microsoft.com/v1'
    );
    expect(env.RAYFIN_FABRIC_API_URL).toBe(
      'https://envapi.fabric.microsoft.com/v1'
    );
  });

  it('derives the portal URL from a "<env>api" Fabric host', () => {
    const env: Record<string, string | undefined> = {};
    const result = applyBaseApiUrlOverride(
      'https://envapi.fabric.microsoft.com',
      env
    );
    expect(result.fabricPortalUrl).toBe('https://env.fabric.microsoft.com/');
    expect(env.RAYFIN_FABRIC_PORTAL_URL).toBe(
      'https://env.fabric.microsoft.com/'
    );
    // getFabricSettings should observe the derived portal override.
    const settings = getFabricSettings(env);
    expect(settings.fabricPortalUrl).toBe('https://env.fabric.microsoft.com/');
  });

  it('maps the production "api" host to the "app" portal host', () => {
    const env: Record<string, string | undefined> = {};
    const result = applyBaseApiUrlOverride(
      'https://api.fabric.microsoft.com/v1',
      env
    );
    expect(result.fabricApiBaseUrl).toBe('https://api.fabric.microsoft.com/v1');
    expect(result.fabricPortalUrl).toBe('https://app.fabric.microsoft.com/');
    expect(env.RAYFIN_FABRIC_PORTAL_URL).toBe(
      'https://app.fabric.microsoft.com/'
    );
  });

  it('overrides a pre-existing RAYFIN_FABRIC_PORTAL_URL when derivable', () => {
    const env: Record<string, string | undefined> = {
      RAYFIN_FABRIC_API_URL: 'https://oldapi.fabric.microsoft.com/v1',
      RAYFIN_FABRIC_PORTAL_URL: 'https://old.fabric.microsoft.com/',
    };
    applyBaseApiUrlOverride('https://customenvapi.fabric.microsoft.com', env);
    expect(env.RAYFIN_FABRIC_API_URL).toBe(
      'https://customenvapi.fabric.microsoft.com/v1'
    );
    expect(env.RAYFIN_FABRIC_PORTAL_URL).toBe(
      'https://customenv.fabric.microsoft.com/'
    );
  });

  it('does not derive a portal URL for non-Fabric hosts', () => {
    const env: Record<string, string | undefined> = {
      RAYFIN_FABRIC_PORTAL_URL: 'https://preexisting.fabric.microsoft.com/',
    };
    const result = applyBaseApiUrlOverride('https://localhost:5000', env);
    expect(result.fabricPortalUrl).toBeUndefined();
    // Pre-existing portal override is left untouched.
    expect(env.RAYFIN_FABRIC_PORTAL_URL).toBe(
      'https://preexisting.fabric.microsoft.com/'
    );
  });

  it('does not derive a portal URL when the subdomain does not end in "api"', () => {
    const env: Record<string, string | undefined> = {};
    const result = applyBaseApiUrlOverride(
      'https://myenv.fabric.microsoft.com',
      env
    );
    expect(result.fabricPortalUrl).toBeUndefined();
    expect(env.RAYFIN_FABRIC_PORTAL_URL).toBeUndefined();
  });

  it('preserves a path prefix verbatim and appends /v1', () => {
    const env: Record<string, string | undefined> = {};
    const result = applyBaseApiUrlOverride(
      'https://my-proxy.example.com/cli-proxy/fabric/abc123',
      env
    );
    expect(result.fabricApiBaseUrl).toBe(
      'https://my-proxy.example.com/cli-proxy/fabric/abc123/v1'
    );
    expect(env.RAYFIN_FABRIC_API_URL).toBe(
      'https://my-proxy.example.com/cli-proxy/fabric/abc123/v1'
    );
    // Non-Fabric host: no derived portal override.
    expect(result.fabricPortalUrl).toBeUndefined();
  });

  it('preserves a path prefix that already ends in /v1', () => {
    const env: Record<string, string | undefined> = {};
    const result = applyBaseApiUrlOverride(
      'https://my-proxy.example.com/cli-proxy/fabric/abc123/v1',
      env
    );
    expect(result.fabricApiBaseUrl).toBe(
      'https://my-proxy.example.com/cli-proxy/fabric/abc123/v1'
    );
  });

  it('strips extra path segments from a canonical Fabric host', () => {
    // Fabric hosts have a known shape, so extra path is treated as
    // accidental and dropped — preserving the historical behavior of
    // the pre-PR normalizer when given e.g. a copy-pasted REST URL.
    const env: Record<string, string | undefined> = {};
    const result = applyBaseApiUrlOverride(
      'https://api.fabric.microsoft.com/v1/workspaces/abc',
      env
    );
    expect(result.fabricApiBaseUrl).toBe('https://api.fabric.microsoft.com/v1');
    expect(env.RAYFIN_FABRIC_API_URL).toBe(
      'https://api.fabric.microsoft.com/v1'
    );
    // Portal still derives from the host.
    expect(result.fabricPortalUrl).toBe('https://app.fabric.microsoft.com/');
  });
});
