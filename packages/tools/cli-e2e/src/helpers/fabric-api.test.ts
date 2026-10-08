import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupStaleTestArtifacts,
  createTestArtifact,
  getCreateRetryDelayMs,
} from './fabric-api.js';

const config = {
  environment: 'prod',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  tenantId: 'tenant-id',
  workspaceName: 'workspace',
};

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: HeadersInit
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function successfulSetupResponses(): Response[] {
  return [
    jsonResponse({
      access_token: 'access-token',
      token_type: 'Bearer',
      expires_in: 3600,
    }),
    jsonResponse({
      value: [{ id: 'workspace-id', displayName: 'workspace' }],
    }),
  ];
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('createTestArtifact', () => {
  it('uses server retry headers and falls back to a bounded delay', () => {
    expect(getCreateRetryDelayMs(new Response())).toBe(15_000);
    expect(
      getCreateRetryDelayMs(
        new Response(null, { headers: { 'x-ms-retry-after-ms': '2500' } })
      )
    ).toBe(2500);
    expect(
      getCreateRetryDelayMs(
        new Response(null, { headers: { 'Retry-After': '3' } })
      )
    ).toBe(3000);
  });

  it('retries Fabric capacity throttling and returns the created artifact', async () => {
    vi.stubEnv('GITHUB_RUN_ID', '123');
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '1');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(successfulSetupResponses()[0])
      .mockResolvedValueOnce(successfulSetupResponses()[1])
      .mockResolvedValueOnce(
        jsonResponse(
          {
            errorCode: 'CapacityLimitExceeded',
            isRetriable: true,
          },
          429,
          { 'Retry-After': '0' }
        )
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'artifact-id',
          displayName: 'DO_NOT_DELETE_BAAS_SERVICE_PRINCIPAL_123_1',
          type: 'AppBackend',
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(createTestArtifact(config)).resolves.toEqual({
      artifactId: 'artifact-id',
      artifactName: 'DO_NOT_DELETE_BAAS_SERVICE_PRINCIPAL_123_1',
      workspaceId: 'workspace-id',
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('retries while stale item deletion releases workspace capacity', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(successfulSetupResponses()[0])
      .mockResolvedValueOnce(successfulSetupResponses()[1])
      .mockResolvedValueOnce(
        new Response(
          'The workspace has reached the maximum number of items allowed.',
          {
            status: 400,
            headers: { 'x-ms-retry-after-ms': '0' },
          }
        )
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'artifact-id',
          displayName: 'DO_NOT_DELETE_BAAS_SERVICE_PRINCIPAL_123_1',
          type: 'AppBackend',
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(createTestArtifact(config)).resolves.toMatchObject({
      artifactId: 'artifact-id',
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('fails after the bounded capacity retry budget is exhausted', async () => {
    const throttled = () =>
      jsonResponse(
        { errorCode: 'CapacityLimitExceeded', isRetriable: true },
        429,
        { 'x-ms-retry-after-ms': '0' }
      );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(successfulSetupResponses()[0])
      .mockResolvedValueOnce(successfulSetupResponses()[1]);
    for (let attempt = 0; attempt <= 5; attempt++) {
      fetchMock.mockResolvedValueOnce(throttled());
    }
    vi.stubGlobal('fetch', fetchMock);

    await expect(createTestArtifact(config)).rejects.toThrow(
      /CapacityLimitExceeded/u
    );
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });
});

describe('cleanupStaleTestArtifacts', () => {
  it('deletes only E2E AppBackend artifacts across all pages', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(successfulSetupResponses()[0])
      .mockResolvedValueOnce(successfulSetupResponses()[1])
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              id: 'stale-1',
              displayName: 'DO_NOT_DELETE_BAAS_SERVICE_PRINCIPAL_111_1_fab',
              type: 'AppBackend',
            },
            {
              id: 'unrelated',
              displayName: 'Production app',
              type: 'AppBackend',
            },
          ],
          continuationToken: 'next page',
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              id: 'stale-2',
              displayName: 'DO_NOT_DELETE_BAAS_SERVICE_PRINCIPAL_222_1_sec',
              type: 'AppBackend',
            },
          ],
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(cleanupStaleTestArtifacts(config)).resolves.toBe(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('continuationToken=next%20page'),
      expect.any(Object)
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining('/items/stale-1'),
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      expect.stringContaining('/items/stale-2'),
      expect.objectContaining({ method: 'DELETE' })
    );
  });
});
