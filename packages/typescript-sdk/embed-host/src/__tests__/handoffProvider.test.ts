import { afterEach, describe, expect, it, vi } from 'vitest';

import { EmbedHostError } from '../errors';
import { createExternalEntraHandoffProvider } from '../handoffProvider';
import type { HandoffRequest } from '../types';

const request: HandoffRequest = {
  brokeredAuthorizeUrl:
    'https://cap.pbidedicated.windows.net/api/auth/v1/brokered/authorize/external',
  artifactId: 'artifact-1',
  returnOrigin: 'https://app.example.com',
  codeChallenge: 'challenge',
  codeChallengeMethod: 'S256',
  state: 'state-1',
  getAccessToken: () => 'secret-token',
};

function mockFetch(
  response: Partial<Response> & { json?: () => Promise<unknown> }
) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(response as Response);
}

describe('external-Entra handoff provider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts the token, moniker, and PKCE body and returns the code', async () => {
    const fetchSpy = mockFetch({
      ok: true,
      status: 200,
      json: async () => ({ handoffCode: 'code-1', state: 'state-1' }),
    });
    const result = await createExternalEntraHandoffProvider().acquire(request);
    expect(result).toEqual({ handoffCode: 'code-1', state: 'state-1' });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(request.brokeredAuthorizeUrl);
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer secret-token');
    expect(headers['x-ms-workload-resource-moniker']).toBe('artifact-1');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      returnOrigin: 'https://app.example.com',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      state: 'state-1',
    });
  });

  it.each([
    [400, 'EXCHANGE_NOT_ENABLED'],
    [401, 'AUTH_FAILED'],
    [403, 'INSUFFICIENT_PERMISSIONS'],
    [404, 'NOT_AVAILABLE'],
    [500, 'AUTHORIZE_FAILED'],
    [503, 'AUTHORIZE_FAILED'],
  ])('maps status %i to %s', async (status, code) => {
    mockFetch({ ok: false, status, json: async () => ({}) });
    await expect(
      createExternalEntraHandoffProvider().acquire(request)
    ).rejects.toMatchObject({ code });
  });

  it('maps a network failure to AUTHORIZE_FAILED without leaking the token', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('boom secret-token')
    );
    let caught: unknown;
    try {
      await createExternalEntraHandoffProvider().acquire(request);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EmbedHostError);
    const err = caught as EmbedHostError;
    expect(err.code).toBe('AUTHORIZE_FAILED');
    expect(err.message).not.toContain('secret-token');
  });

  it('rejects a response with no handoff code', async () => {
    mockFetch({ ok: true, status: 200, json: async () => ({}) });
    await expect(
      createExternalEntraHandoffProvider().acquire(request)
    ).rejects.toMatchObject({ code: 'AUTHORIZE_FAILED' });
  });
});
