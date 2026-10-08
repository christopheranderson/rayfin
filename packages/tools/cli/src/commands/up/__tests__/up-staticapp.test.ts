import { afterEach, describe, expect, it, vi } from 'vitest';

import { updateHostingRedirectSettings } from '../up-staticapp.js';

describe('updateHostingRedirectSettings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(['application', 'delegated'])(
    'preserves recorded %s Functions auth during a content-only redirect update',
    async (authType) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              serviceSettings: {
                auth: { enabled: true, redirectUris: ['https://old.test'] },
                staticHosting: { enabled: true, anonymousAccess: false },
                functions: { enabled: true, auth: { type: authType } },
              },
            }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(new Response('', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await updateHostingRedirectSettings({
        settingsUrl: 'https://api.test/projectRuntimeSettings',
        headers: { Authorization: 'Bearer token' },
        updatedServices: {
          auth: {
            enabled: true,
            redirectUris: ['https://new.test'],
          },
          functions: { enabled: true, auth: { type: 'application' } },
        } as never,
        packageVersions: { '@microsoft/rayfin-cli': '1.2.3' },
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        'https://api.test/projectRuntimeSettings',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            auth: {
              enabled: true,
              redirectUris: ['https://new.test'],
            },
            staticHosting: { enabled: true, anonymousAccess: false },
            functions: { enabled: true, auth: { type: authType } },
            packageVersions: { '@microsoft/rayfin-cli': '1.2.3' },
          }),
        })
      );
    }
  );

  it('translates workload posture errors from the settings update', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ serviceSettings: {} }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 'StaticHostingPostureRequired',
              message:
                "Set 'services.staticHosting.anonymousAccess' before deploying.",
            },
          }),
          { status: 400, statusText: 'Bad Request' }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      updateHostingRedirectSettings({
        settingsUrl: 'https://api.test/projectRuntimeSettings',
        headers: { Authorization: 'Bearer token' },
        updatedServices: { auth: { enabled: true } } as never,
        packageVersions: { '@microsoft/rayfin-cli': '1.2.3' },
      })
    ).rejects.toThrow('services.staticHosting.assetAccess');
  });
});
