import { describe, expect, it, vi, afterEach } from 'vitest';

import { RayfinItemClient } from '../services/fabric/rayfinItem';

const WORKSPACE = 'ws-1';
const ITEM = 'item-1';

describe('RayfinItemClient.updateHostingRedirectSettings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(['application', 'delegated', undefined])(
    'overlays auth without changing recorded Functions auth (%s) or static posture',
    async (recordedAuth) => {
      const recorded = {
        auth: { enabled: true, allowedRedirectUris: ['https://old'] },
        data: { enabled: false },
        staticHosting: { enabled: true, anonymousAccess: false },
        ...(recordedAuth
          ? {
              functions: {
                enabled: true,
                auth: { type: recordedAuth },
                path: 'recorded-functions',
                buildCommand: 'recorded-build',
              },
            }
          : {}),
      };
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(200, { serviceSettings: recorded }))
        .mockResolvedValueOnce(jsonResponse(200, {}));
      vi.stubGlobal('fetch', fetchMock);

      await new RayfinItemClient('tok').updateHostingRedirectSettings(
        WORKSPACE,
        ITEM,
        {
          auth: { enabled: true, allowedRedirectUris: ['https://new'] },
          data: { enabled: false },
          functions: {
            enabled: false,
            auth: { type: 'application' },
            path: 'local-functions',
            buildCommand: 'local-build',
          },
          staticHosting: {
            enabled: true,
            folder: 'dist',
            assetAccess: 'public',
          },
        }
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [, postInit] = fetchMock.mock.calls[1];
      const body: unknown = JSON.parse(String(postInit?.body));

      expect(body).toEqual({
        ...recorded,
        auth: { enabled: true, allowedRedirectUris: ['https://new'] },
        packageVersions: { '@microsoft/rayfin-cli': expect.any(String) },
      });
    }
  );

  it('fails when the recorded settings are missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { somethingElse: true }))
    );

    await expect(
      new RayfinItemClient('tok').updateHostingRedirectSettings(
        WORKSPACE,
        ITEM,
        { auth: { enabled: true }, data: { enabled: false } }
      )
    ).rejects.toThrow(/did not include serviceSettings/);
  });

  it('reports a rejected write in Builder-facing terms', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(200, {
            serviceSettings: { auth: { enabled: true }, data: {} },
          })
        )
        .mockResolvedValueOnce(
          jsonResponse(400, {
            error: {
              code: 'StaticHostingPostureRequired',
              message: 'anonymousAccess is required',
            },
          })
        )
    );

    await expect(
      new RayfinItemClient('tok').updateHostingRedirectSettings(
        WORKSPACE,
        ITEM,
        { auth: { enabled: true }, data: { enabled: false } }
      )
    ).rejects.toThrow(/services\.staticHosting\.assetAccess/);
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}
