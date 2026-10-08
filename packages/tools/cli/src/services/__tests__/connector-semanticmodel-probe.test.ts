import { InvocationContext } from '@microsoft/rayfin-tools-common/_internal/telemetry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureAuthenticated: vi.fn(),
}));

vi.mock('../../auth/index.js', () => ({
  ensureAuthenticated: mocks.ensureAuthenticated,
}));

import { setCurrentContext } from '../../telemetry/context-store.js';
import { checkSemanticModelAccess } from '../connector-semanticmodel-probe.js';

/** Builds an unsigned JWT with the given audience. */
function jwt(aud: string): string {
  const segment = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${segment({ alg: 'none' })}.${segment({ aud })}.signature`;
}

const POWER_BI = 'https://analysis.windows.net/powerbi/api';
const FABRIC = 'https://api.fabric.microsoft.com';

describe('checkSemanticModelAccess', () => {
  let context: InvocationContext;
  let savedToken: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    // Pinned rather than inherited: an ambient token in the developer's shell
    // would otherwise switch on the audience guard and change what these
    // tests exercise.
    savedToken = process.env['RAYFIN_TOKEN'];
    delete process.env['RAYFIN_TOKEN'];
    mocks.ensureAuthenticated.mockResolvedValue({ token: 'token' });
    context = new InvocationContext('rayfin-cli', '1.0.0');
    setCurrentContext(context);
  });

  afterEach(() => {
    setCurrentContext(undefined);
    if (savedToken === undefined) delete process.env['RAYFIN_TOKEN'];
    else process.env['RAYFIN_TOKEN'] = savedToken;
    vi.restoreAllMocks();
  });

  it('records a successful semantic-model response', async () => {
    const response = new Response(null, {
      status: 200,
      headers: { 'x-ms-root-activity-id': 'probe-activity-1' },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);

    await checkSemanticModelAccess({ workspaceId: 'ws-1', itemId: 'item-1' });

    expect(
      context.finalize({
        osType: 'linux',
        osVersion: 'test',
        nodeVersion: 'test',
      }).properties?.fabric_activity_ids
    ).toBe('["probe-activity-1"]');
  });

  it('records a failed semantic-model response before throwing', async () => {
    const response = new Response(null, {
      status: 403,
      headers: { 'x-ms-root-activity-id': 'probe-activity-2' },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);

    await expect(
      checkSemanticModelAccess({ workspaceId: 'ws-1', itemId: 'item-1' })
    ).rejects.toThrow('Semantic model access check failed with status 403');
    expect(
      context.finalize({
        osType: 'linux',
        osVersion: 'test',
        nodeVersion: 'test',
      }).properties?.fabric_activity_ids
    ).toBe('["probe-activity-2"]');
  });

  describe('ambient token audience guard', () => {
    // Without this the probe's own 401/403 reads as "no Build permission on
    // the model" — the single conclusion this function exists to report —
    // when the real cause is a token minted for another resource.
    let savedScope: string | undefined;

    beforeEach(() => {
      savedScope = process.env['RAYFIN_FABRIC_SCOPE'];
      delete process.env['RAYFIN_FABRIC_SCOPE'];
    });

    afterEach(() => {
      if (savedScope === undefined) delete process.env['RAYFIN_FABRIC_SCOPE'];
      else process.env['RAYFIN_FABRIC_SCOPE'] = savedScope;
    });

    it('rejects a token minted for another resource before probing', async () => {
      const token = jwt(FABRIC);
      process.env['RAYFIN_TOKEN'] = token;
      mocks.ensureAuthenticated.mockResolvedValue({ token });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      await expect(
        checkSemanticModelAccess({ workspaceId: 'ws-1', itemId: 'item-1' })
      ).rejects.toThrow(
        `Access token has the wrong audience for the semantic model access check (got ${FABRIC}, expected ${POWER_BI}).`
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects an ambient token whose audience cannot be read', async () => {
      process.env['RAYFIN_TOKEN'] = 'opaque';
      mocks.ensureAuthenticated.mockResolvedValue({ token: 'opaque' });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      await expect(
        checkSemanticModelAccess({ workspaceId: 'ws-1', itemId: 'item-1' })
      ).rejects.toThrow('could not be decoded as a JWT');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('allows a token minted for the database resource', async () => {
      const token = jwt(POWER_BI);
      process.env['RAYFIN_TOKEN'] = token;
      mocks.ensureAuthenticated.mockResolvedValue({ token });
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(null, { status: 200 })
      );

      await checkSemanticModelAccess({ workspaceId: 'ws-1', itemId: 'item-1' });
    });

    it('leaves the normal desktop path alone, opaque token included', async () => {
      delete process.env['RAYFIN_TOKEN'];
      mocks.ensureAuthenticated.mockResolvedValue({ token: 'opaque-msal' });
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(null, { status: 200 })
      );

      await checkSemanticModelAccess({ workspaceId: 'ws-1', itemId: 'item-1' });
    });

    it('asks for the Power BI scope even when RAYFIN_FABRIC_SCOPE is set', async () => {
      process.env['RAYFIN_FABRIC_SCOPE'] = `${FABRIC}/.default`;
      const token = jwt(POWER_BI);
      process.env['RAYFIN_TOKEN'] = token;
      mocks.ensureAuthenticated.mockResolvedValue({ token });
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(null, { status: 200 })
      );

      await checkSemanticModelAccess({ workspaceId: 'ws-1', itemId: 'item-1' });

      expect(mocks.ensureAuthenticated).toHaveBeenCalledWith([
        `${POWER_BI}/.default`,
      ]);
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

      const error = await checkSemanticModelAccess({
        workspaceId: 'ws-1',
        itemId: 'item-1',
      }).then(
        () => undefined,
        (caught: unknown) => caught as Error
      );

      const surfaced = `${error?.message ?? ''}\n${error?.stack ?? ''}`;
      expect(surfaced).not.toContain(signature);
      expect(surfaced).not.toContain(token);
    });
  });
});
