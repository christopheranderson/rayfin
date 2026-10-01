import { describe, expect, it } from 'vitest';

import {
  clearDeploymentPublicEnv,
  composeFabricItemDeepLink,
  DEPLOYMENT_PUBLIC_ENV_KEYS,
  deploymentInfoToPublicEnv,
  extractPortalUrl,
  mapPublicEnvForFramework,
  mapPublicEnvKey,
  mergeEnvVars,
  parseEnvContent,
  RAYFIN_PUBLIC_PREFIX,
  serializeEnvContent,
} from '../config/env.js';

// ── parseEnvContent ─────────────────────────────────────────────────

describe('parseEnvContent', () => {
  it('parses simple KEY=VALUE lines', () => {
    const vars = parseEnvContent('FOO=bar\nBAZ=qux');
    expect(vars.get('FOO')).toBe('bar');
    expect(vars.get('BAZ')).toBe('qux');
  });

  it('ignores blank lines and full-line comments', () => {
    const vars = parseEnvContent('\n# comment\nFOO=bar\n\n# more\n');
    expect(vars.size).toBe(1);
    expect(vars.get('FOO')).toBe('bar');
  });

  it('supports the `export ` prefix', () => {
    const vars = parseEnvContent('export FOO=bar');
    expect(vars.get('FOO')).toBe('bar');
  });

  it('strips double quotes and expands escape sequences', () => {
    const vars = parseEnvContent('FOO="line1\\nline2\\ttab"');
    expect(vars.get('FOO')).toBe('line1\nline2\ttab');
  });

  it('strips single quotes without escape expansion', () => {
    const vars = parseEnvContent("FOO='line1\\nline2'");
    expect(vars.get('FOO')).toBe('line1\\nline2');
  });

  it('strips trailing inline comments on unquoted values', () => {
    const vars = parseEnvContent('FOO=bar # trailing');
    expect(vars.get('FOO')).toBe('bar');
  });

  it('preserves `#` inside quoted values', () => {
    const vars = parseEnvContent('FOO="bar # not a comment"');
    expect(vars.get('FOO')).toBe('bar # not a comment');
  });

  it('later occurrences overwrite earlier ones', () => {
    const vars = parseEnvContent('FOO=1\nFOO=2');
    expect(vars.get('FOO')).toBe('2');
  });

  it('skips invalid keys', () => {
    const vars = parseEnvContent('1BAD=x\nGOOD=y\n=nokey');
    expect(vars.has('1BAD')).toBe(false);
    expect(vars.get('GOOD')).toBe('y');
  });

  it('handles CRLF line endings', () => {
    const vars = parseEnvContent('A=1\r\nB=2\r\n');
    expect(vars.get('A')).toBe('1');
    expect(vars.get('B')).toBe('2');
  });
});

// ── serializeEnvContent ─────────────────────────────────────────────

describe('serializeEnvContent', () => {
  it('emits KEY=VALUE lines in insertion order', () => {
    const vars = new Map([
      ['Z', '1'],
      ['A', '2'],
    ]);
    const content = serializeEnvContent(vars);
    expect(content).toBe('Z=1\nA=2\n');
  });

  it('quotes values with whitespace', () => {
    const vars = new Map([['FOO', 'hello world']]);
    expect(serializeEnvContent(vars)).toBe('FOO="hello world"\n');
  });

  it('escapes newlines, tabs, and quotes', () => {
    const vars = new Map([['FOO', 'a\nb\t"c"']]);
    expect(serializeEnvContent(vars)).toBe('FOO="a\\nb\\t\\"c\\""\n');
  });

  it('round-trips through parseEnvContent', () => {
    const input = new Map<string, string>([
      ['SIMPLE', 'value'],
      ['SPACES', 'has spaces'],
      ['NEWLINES', 'one\ntwo'],
      ['HASH', 'has # hash'],
    ]);
    const serialized = serializeEnvContent(input);
    const parsed = parseEnvContent(serialized);
    for (const [k, v] of input) {
      expect(parsed.get(k)).toBe(v);
    }
  });

  it('prefixes non-comment header lines with `# `', () => {
    const vars = new Map([['A', '1']]);
    const content = serializeEnvContent(vars, [
      'Auto-generated',
      '# already commented',
    ]);
    expect(
      content.startsWith('# Auto-generated\n# already commented\n\n')
    ).toBe(true);
  });
});

// ── mergeEnvVars ────────────────────────────────────────────────────

describe('mergeEnvVars', () => {
  it('updates values from updates', () => {
    const base = new Map([
      ['A', '1'],
      ['B', '2'],
    ]);
    const updates = new Map([['A', 'new']]);
    const merged = mergeEnvVars(base, updates);
    expect(merged.get('A')).toBe('new');
    expect(merged.get('B')).toBe('2');
  });

  it('appends new keys', () => {
    const base = new Map([['A', '1']]);
    const updates = new Map([['C', '3']]);
    expect(mergeEnvVars(base, updates).get('C')).toBe('3');
  });

  it('does not mutate inputs', () => {
    const base = new Map([['A', '1']]);
    const updates = new Map([['A', '2']]);
    mergeEnvVars(base, updates);
    expect(base.get('A')).toBe('1');
    expect(updates.get('A')).toBe('2');
  });
});

// ── mapPublicEnvKey / mapPublicEnvForFramework ──────────────────────

describe('mapPublicEnvKey', () => {
  it('returns null for non-public keys', () => {
    expect(mapPublicEnvKey('RAYFIN_POSTGRES_PASSWORD', 'vite')).toBeNull();
    expect(mapPublicEnvKey('NODE_ENV', 'vite')).toBeNull();
  });

  it('maps known Vite aliases', () => {
    expect(mapPublicEnvKey('RAYFIN_PUBLIC_API_URL', 'vite')).toBe(
      'VITE_RAYFIN_API_URL'
    );
    expect(mapPublicEnvKey('RAYFIN_PUBLIC_ITEM_ID', 'vite')).toBe(
      'VITE_FABRIC_ITEM_ID'
    );
  });

  it('maps known Next.js aliases', () => {
    expect(mapPublicEnvKey('RAYFIN_PUBLIC_API_URL', 'nextjs')).toBe(
      'NEXT_PUBLIC_RAYFIN_API_URL'
    );
    expect(mapPublicEnvKey('RAYFIN_PUBLIC_WORKSPACE_ID', 'nextjs')).toBe(
      'NEXT_PUBLIC_FABRIC_WORKSPACE_ID'
    );
  });

  it('strips the RAYFIN_PUBLIC_ prefix for `plain`', () => {
    expect(mapPublicEnvKey('RAYFIN_PUBLIC_API_URL', 'plain')).toBe('API_URL');
  });

  it('falls back to generic prefix for unknown public keys', () => {
    expect(mapPublicEnvKey('RAYFIN_PUBLIC_CUSTOM_FLAG', 'vite')).toBe(
      'VITE_RAYFIN_CUSTOM_FLAG'
    );
    expect(mapPublicEnvKey('RAYFIN_PUBLIC_CUSTOM_FLAG', 'nextjs')).toBe(
      'NEXT_PUBLIC_RAYFIN_CUSTOM_FLAG'
    );
  });
});

describe('mapPublicEnvForFramework', () => {
  it('drops non-public keys entirely', () => {
    const input = new Map([
      ['RAYFIN_PUBLIC_API_URL', 'https://api'],
      ['RAYFIN_POSTGRES_PASSWORD', 'secret'],
      ['SHELL_ONLY', 'x'],
    ]);
    const result = mapPublicEnvForFramework(input, 'vite');
    expect(result.size).toBe(1);
    expect(result.get('VITE_RAYFIN_API_URL')).toBe('https://api');
    expect(result.has('RAYFIN_POSTGRES_PASSWORD')).toBe(false);
  });

  it('maps all known Rayfin public vars for Vite', () => {
    const input = new Map([
      ['RAYFIN_PUBLIC_API_URL', 'a'],
      ['RAYFIN_PUBLIC_PUBLISHABLE_KEY', 'b'],
      ['RAYFIN_PUBLIC_ITEM_ID', 'c'],
      ['RAYFIN_PUBLIC_WORKSPACE_ID', 'd'],
      ['RAYFIN_PUBLIC_TENANT_ID', 'f'],
      ['RAYFIN_PUBLIC_PORTAL_URL', 'e'],
    ]);
    const result = mapPublicEnvForFramework(input, 'vite');
    expect(result.get('VITE_RAYFIN_API_URL')).toBe('a');
    expect(result.get('VITE_RAYFIN_PUBLISHABLE_KEY')).toBe('b');
    expect(result.get('VITE_FABRIC_ITEM_ID')).toBe('c');
    expect(result.get('VITE_FABRIC_WORKSPACE_ID')).toBe('d');
    expect(result.get('VITE_FABRIC_TENANT_ID')).toBe('f');
    expect(result.get('VITE_FABRIC_PORTAL_URL')).toBe('e');
  });

  it('maps the frontend dev-server port to VITE_PORT and Next.js PORT', () => {
    const input = new Map([['RAYFIN_PUBLIC_FRONTEND_PORT', '5174']]);
    expect(mapPublicEnvForFramework(input, 'vite').get('VITE_PORT')).toBe(
      '5174'
    );
    expect(mapPublicEnvForFramework(input, 'nextjs').get('PORT')).toBe('5174');
  });
});

describe('RAYFIN_PUBLIC_PREFIX', () => {
  it('is exported as a constant', () => {
    expect(RAYFIN_PUBLIC_PREFIX).toBe('RAYFIN_PUBLIC_');
  });
});

describe('deploymentInfoToPublicEnv', () => {
  it('emits RAYFIN_PUBLIC_TENANT_ID when fabricTenantId is set', () => {
    const result = deploymentInfoToPublicEnv({
      fabricApiUrl: 'https://api',
      fabricItemId: 'item-1',
      fabricWorkspaceId: 'ws-1',
      fabricTenantId: 'tenant-1',
      publishableKey: 'pk_test',
    });
    expect(result.get('RAYFIN_PUBLIC_TENANT_ID')).toBe('tenant-1');
    expect(result.get('RAYFIN_PUBLIC_API_URL')).toBe('https://api');
  });

  it('omits RAYFIN_PUBLIC_TENANT_ID when fabricTenantId is missing', () => {
    const result = deploymentInfoToPublicEnv({
      fabricApiUrl: 'https://api',
      fabricItemId: 'item-1',
      fabricWorkspaceId: 'ws-1',
    });
    expect(result.has('RAYFIN_PUBLIC_TENANT_ID')).toBe(false);
  });

  it('never emits hostingUrl', () => {
    const result = deploymentInfoToPublicEnv({
      fabricApiUrl: 'https://api',
      fabricItemId: 'item-1',
      fabricWorkspaceId: 'ws-1',
      hostingUrl: 'https://hosting.example.com',
    });
    expect(result.has('RAYFIN_PUBLIC_HOSTING_URL')).toBe(false);
  });
});

describe('clearDeploymentPublicEnv', () => {
  it('removes every deployment-derived RAYFIN_PUBLIC_* key', () => {
    const input = new Map<string, string>();
    for (const key of DEPLOYMENT_PUBLIC_ENV_KEYS) {
      input.set(key, 'old-value');
    }
    const result = clearDeploymentPublicEnv(input);
    for (const key of DEPLOYMENT_PUBLIC_ENV_KEYS) {
      expect(result.has(key)).toBe(false);
    }
  });

  it('preserves user-defined RAYFIN_PUBLIC_* keys and secrets', () => {
    const input = new Map([
      ['RAYFIN_PUBLIC_API_URL', 'old'],
      ['RAYFIN_PUBLIC_FEATURE_X', 'keep-me'],
      ['RAYFIN_POSTGRES_PASSWORD', 'secret'],
      ['RAYFIN_SERVICES_DATA_PORT', '5432'],
    ]);
    const result = clearDeploymentPublicEnv(input);
    expect(result.has('RAYFIN_PUBLIC_API_URL')).toBe(false);
    expect(result.get('RAYFIN_PUBLIC_FEATURE_X')).toBe('keep-me');
    expect(result.get('RAYFIN_POSTGRES_PASSWORD')).toBe('secret');
    expect(result.get('RAYFIN_SERVICES_DATA_PORT')).toBe('5432');
  });

  it('does not mutate the input map', () => {
    const input = new Map([['RAYFIN_PUBLIC_API_URL', 'v']]);
    const result = clearDeploymentPublicEnv(input);
    expect(input.get('RAYFIN_PUBLIC_API_URL')).toBe('v');
    expect(result.has('RAYFIN_PUBLIC_API_URL')).toBe(false);
  });
});

// ── composeFabricItemDeepLink + extractPortalUrl round-trip ─────────

describe('composeFabricItemDeepLink', () => {
  const PORTAL = 'https://app.fabric.microsoft.com';
  const WS = 'ws-cc71c48b';
  const ITEM = 'item-3f652a9b';
  const TENANT = 'tenant-72f988bf';

  it('composes /groups/<ws>/appbackends/<item> without ctid when tenant is omitted', () => {
    expect(composeFabricItemDeepLink(PORTAL, WS, ITEM)).toBe(
      `${PORTAL}/groups/${WS}/appbackends/${ITEM}`
    );
  });

  it('appends ?ctid=<tenantId> when a tenantId is supplied', () => {
    expect(composeFabricItemDeepLink(PORTAL, WS, ITEM, TENANT)).toBe(
      `${PORTAL}/groups/${WS}/appbackends/${ITEM}?ctid=${TENANT}`
    );
  });

  it('omits ctid for the MSIT Power BI portal', () => {
    expect(
      composeFabricItemDeepLink('https://msit.powerbi.com', WS, ITEM, TENANT)
    ).toBe(`https://msit.powerbi.com/groups/${WS}/appbackends/${ITEM}`);
  });

  it('omits the ctid suffix when tenantId is an empty string', () => {
    expect(composeFabricItemDeepLink(PORTAL, WS, ITEM, '')).toBe(
      `${PORTAL}/groups/${WS}/appbackends/${ITEM}`
    );
  });

  it('tolerates a trailing slash on portalUrl without doubling', () => {
    expect(composeFabricItemDeepLink(`${PORTAL}/`, WS, ITEM)).toBe(
      `${PORTAL}/groups/${WS}/appbackends/${ITEM}`
    );
    expect(composeFabricItemDeepLink(`${PORTAL}///`, WS, ITEM, TENANT)).toBe(
      `${PORTAL}/groups/${WS}/appbackends/${ITEM}?ctid=${TENANT}`
    );
  });

  it('round-trips through extractPortalUrl', () => {
    const link = composeFabricItemDeepLink(PORTAL, WS, ITEM, TENANT);
    expect(extractPortalUrl(link, WS)).toBe(PORTAL);
  });

  it('round-trips through extractPortalUrl without tenant', () => {
    const link = composeFabricItemDeepLink(PORTAL, WS, ITEM);
    expect(extractPortalUrl(link, WS)).toBe(PORTAL);
  });

  it('URL-encodes special characters in tenantId', () => {
    const result = composeFabricItemDeepLink(
      PORTAL,
      WS,
      ITEM,
      'tenant&with=special?chars'
    );
    expect(result).toContain('ctid=tenant%26with%3Dspecial%3Fchars');
  });

  it('throws when workspaceId is empty', () => {
    expect(() => composeFabricItemDeepLink(PORTAL, '', ITEM)).toThrow(
      /workspaceId and itemId must be non-empty/
    );
  });

  it('throws when itemId is empty', () => {
    expect(() => composeFabricItemDeepLink(PORTAL, WS, '')).toThrow(
      /workspaceId and itemId must be non-empty/
    );
  });
});
