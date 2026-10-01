/**
 * @packageDocumentation Audience inspection for supplied bearer tokens.
 *
 * These guard the seam where a command asks for one audience and can be handed
 * another: `ensureAuthenticated` returns an ambient `RAYFIN_TOKEN` verbatim
 * without consulting the requested scopes, so the caller has to check.
 */
import { describe, expect, it } from 'vitest';

import {
  audienceFromScope,
  audienceMatches,
  readTokenAudience,
} from '../token-audience.js';

/** Builds an unsigned JWT carrying the given claims. */
function jwt(claims: Record<string, unknown>): string {
  const segment = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${segment({ alg: 'none', typ: 'JWT' })}.${segment(claims)}.signature`;
}

const POWER_BI = 'https://analysis.windows.net/powerbi/api';
const FABRIC = 'https://api.fabric.microsoft.com';

describe('readTokenAudience', () => {
  it('reads the audience from a bearer token', () => {
    expect(readTokenAudience(jwt({ aud: POWER_BI }))).toBe(POWER_BI);
  });

  it('tolerates an Authorization header value', () => {
    expect(readTokenAudience(`Bearer ${jwt({ aud: FABRIC })}`)).toBe(FABRIC);
    expect(readTokenAudience(`bearer ${jwt({ aud: FABRIC })}`)).toBe(FABRIC);
  });

  it('reports undefined rather than throwing on anything it cannot read', () => {
    for (const input of [
      undefined,
      '',
      'opaque-token',
      'not.a.jwt',
      // Well-formed JWT, no audience claim.
      jwt({ sub: 'user' }),
      // Audience present but not a string, so not a resource name.
      jwt({ aud: ['a', 'b'] }),
      jwt({ aud: '' }),
      jwt({ aud: 42 }),
    ]) {
      expect(readTokenAudience(input)).toBeUndefined();
    }
  });

  it('never returns anything but the audience claim', () => {
    // A caller may put the result in an error message, so nothing else from
    // the token may ride along.
    const audience = readTokenAudience(
      jwt({ aud: POWER_BI, upn: 'user@contoso.com', oid: 'secret-oid' })
    );
    expect(audience).toBe(POWER_BI);
  });
});

describe('audienceFromScope', () => {
  it('derives the resource a scope targets', () => {
    expect(audienceFromScope(`${POWER_BI}/.default`)).toBe(POWER_BI);
    expect(audienceFromScope(`${FABRIC}/.default`)).toBe(FABRIC);
  });

  it('follows a non-production ring rather than a hard-coded constant', () => {
    // `RAYFIN_FABRIC_SCOPE` can point at an INT resource; the guard has to
    // expect that audience, not the production one.
    const int = 'https://analysis.windows-int.net/powerbi/api';
    expect(audienceFromScope(`${int}/.default`)).toBe(int);
  });

  it('leaves a scope that is already a bare resource alone', () => {
    expect(audienceFromScope(POWER_BI)).toBe(POWER_BI);
  });
});

describe('audienceMatches', () => {
  it('ignores trailing slashes on either side', () => {
    expect(audienceMatches(`${POWER_BI}/`, POWER_BI)).toBe(true);
    expect(audienceMatches(POWER_BI, `${POWER_BI}/`)).toBe(true);
    expect(audienceMatches(`${POWER_BI}///`, POWER_BI)).toBe(true);
  });

  it('rejects a different resource', () => {
    expect(audienceMatches(FABRIC, POWER_BI)).toBe(false);
  });

  it('rejects a near miss', () => {
    // The INT resource differs by four characters and is a different tenant
    // boundary, so it must not satisfy a production requirement.
    expect(
      audienceMatches('https://analysis.windows-int.net/powerbi/api', POWER_BI)
    ).toBe(false);
    expect(audienceMatches(`${POWER_BI}.evil.com`, POWER_BI)).toBe(false);
    expect(audienceMatches(`${POWER_BI}/extra`, POWER_BI)).toBe(false);
  });
});
