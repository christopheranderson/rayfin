import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { CLI_VERSION_KEY, postRuntimeSettings } from '../runtime-settings.js';
import { getPackageVersion } from '../version.js';

// Spied, not replaced: most assertions want the real version, but the
// unreadable-manifest guard needs the sentinel.
vi.mock('../version.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../version.js')>();
  return { ...actual, getPackageVersion: vi.fn(actual.getPackageVersion) };
});

const services = {
  auth: { enabled: true },
  data: { enabled: false },
  functions: { enabled: true, auth: { type: 'application' } },
} as unknown as RayfinConfig['services'];

// `rayfin.yml` carries connectors as an array of self-describing entries.
const connectors = [
  {
    name: 'mySource',
    type: 'fabric-sqldatabase',
    operations: [{ name: 'op' }],
  },
] as unknown as RayfinConfig['connectors'];

// `postRuntimeSettings` transforms the array into the host's wire shape:
// a map keyed by name with `type` renamed to `connector`.
const connectorsWire = {
  mySource: { connector: 'fabric-sqldatabase', operations: [{ name: 'op' }] },
};

describe('postRuntimeSettings', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function lastRequestBody(): Record<string, unknown> {
    const init = fetchMock.mock.calls.at(-1)?.[1] as { body: string };
    return JSON.parse(init.body) as Record<string, unknown>;
  }

  it.each([
    ['protected', false],
    ['public', true],
  ] as const)(
    'maps assetAccess %s to anonymousAccess %s without mutating the config',
    async (assetAccess, anonymousAccess) => {
      const staticHostingServices = {
        ...services,
        staticHosting: {
          enabled: true,
          folder: 'dist',
          assetAccess,
        },
      } as unknown as RayfinConfig['services'];
      const snapshot = structuredClone(staticHostingServices);

      await postRuntimeSettings(
        'https://api/item',
        staticHostingServices,
        '******',
        () => {}
      );

      expect(lastRequestBody().staticHosting).toEqual({
        enabled: true,
        folder: 'dist',
        anonymousAccess,
      });
      expect(lastRequestBody().staticHosting).not.toHaveProperty('assetAccess');
      expect(staticHostingServices).toEqual(snapshot);
    }
  );

  it('fails before the request when assetAccess is invalid', async () => {
    const staticHostingServices = {
      ...services,
      staticHosting: {
        enabled: true,
        folder: 'dist',
        assetAccess: 'private',
      },
    } as unknown as RayfinConfig['services'];

    await expect(
      postRuntimeSettings(
        'https://api/item',
        staticHostingServices,
        '******',
        () => {}
      )
    ).rejects.toThrow(/services\.staticHosting\.assetAccess/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs to the projectRuntimeSettings endpoint with auth and extra headers', async () => {
    await postRuntimeSettings(
      'https://api/item',
      services,
      'Bearer abc',
      () => {},
      'runtime-settings',
      { moniker: 'item-1' }
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string> },
    ];
    expect(url).toBe('https://api/item/__private/projectRuntimeSettings');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer abc');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers.moniker).toBe('item-1');
  });

  it('never sends the local connectors opt-in as the host connectors block', async () => {
    // `services.connectors.enabled` lets a project opt in before any connector
    // exists. The host's `connectors` is a map of ConnectorSettings, so passing
    // the boolean through fails the whole deploy with a 400.
    const optedIn = {
      ...services,
      connectors: { enabled: true },
    } as unknown as RayfinConfig['services'];

    await postRuntimeSettings(
      'https://api/item',
      optedIn,
      'Bearer abc',
      () => {}
    );

    expect(lastRequestBody()).not.toHaveProperty('connectors');
  });

  it('keeps the declared connectors when the project has also opted in', async () => {
    const optedIn = {
      ...services,
      connectors: { enabled: true },
    } as unknown as RayfinConfig['services'];

    await postRuntimeSettings(
      'https://api/item',
      optedIn,
      'Bearer abc',
      () => {},
      'runtime-settings',
      undefined,
      connectors
    );

    expect(lastRequestBody().connectors).toEqual(connectorsWire);
  });

  describe('packageVersions', () => {
    // The host and the BaaS write gate match on this exact string; a typo here is
    // invisible to every other assertion in this file.
    it('pins the wire key string', () => {
      expect(CLI_VERSION_KEY).toBe('@microsoft/rayfin-cli');
    });

    it('declares the running CLI version on every write', async () => {
      await postRuntimeSettings(
        'https://api/item',
        services,
        'Bearer abc',
        () => {}
      );

      expect(lastRequestBody().packageVersions).toEqual({
        [CLI_VERSION_KEY]: getPackageVersion(),
      });
    });

    it('includes caller-supplied component versions alongside the CLI', async () => {
      await postRuntimeSettings(
        'https://api/item',
        services,
        'Bearer abc',
        () => {},
        'runtime-settings',
        undefined,
        undefined,
        { '@microsoft/rayfin-auth': '1.2.3' }
      );

      expect(lastRequestBody().packageVersions).toEqual({
        '@microsoft/rayfin-auth': '1.2.3',
        [CLI_VERSION_KEY]: getPackageVersion(),
      });
    });

    it('replaces a checked-in packageVersions rather than merging into it', async () => {
      const authored = {
        ...services,
        packageVersions: { [CLI_VERSION_KEY]: '0.0.1-stale', stale: '9.9.9' },
      } as unknown as RayfinConfig['services'];

      await postRuntimeSettings(
        'https://api/item',
        authored,
        'Bearer abc',
        () => {}
      );

      expect(lastRequestBody().packageVersions).toEqual({
        [CLI_VERSION_KEY]: getPackageVersion(),
      });
    });

    describe('when the CLI cannot read its own version', () => {
      const staticHostingServices = {
        ...services,
        staticHosting: { enabled: true },
      } as unknown as RayfinConfig['services'];

      it('fails locally rather than sending the sentinel on a static-hosted deploy', async () => {
        vi.mocked(getPackageVersion).mockReturnValueOnce('Unknown');

        await expect(
          postRuntimeSettings(
            'https://api/item',
            staticHostingServices,
            'Bearer abc',
            () => {}
          )
        ).rejects.toThrow(/package\.json/);

        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('leaves a deploy without static hosting alone', async () => {
        vi.mocked(getPackageVersion).mockReturnValueOnce('Unknown');

        await postRuntimeSettings(
          'https://api/item',
          services,
          'Bearer abc',
          () => {}
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(lastRequestBody().packageVersions).toEqual({
          [CLI_VERSION_KEY]: 'Unknown',
        });
      });
    });

    describe('when the control plane rejects the client version', () => {
      const remediation =
        "This version of the Rayfin CLI cannot deploy a static-hosted app. Upgrade with 'npm install -g @microsoft/rayfin-cli@latest', then deploy again.";

      function rejectWith(body: string) {
        fetchMock.mockResolvedValue({
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          text: async () => body,
          headers: { get: () => null },
        });
      }

      // The remediation is the only actionable part of the rejection, and the
      // control plane returns it under two different shapes.
      it.each([
        ['a root message', JSON.stringify({ message: remediation })],
        [
          'a nested error message',
          JSON.stringify({
            error: { code: 'UnsupportedCliVersion', message: remediation },
          }),
        ],
      ])('surfaces the returned remediation from %s', async (_shape, body) => {
        rejectWith(body);

        await expect(
          postRuntimeSettings(
            'https://api/item',
            services,
            'Bearer abc',
            () => {}
          )
        ).rejects.toThrow(/npm install -g @microsoft\/rayfin-cli@latest/);
      });

      it('fails the deployment without retrying', async () => {
        rejectWith(JSON.stringify({ message: remediation }));

        await expect(
          postRuntimeSettings(
            'https://api/item',
            services,
            'Bearer abc',
            () => {}
          )
        ).rejects.toThrow();

        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    });

    describe('when the control plane returns legacy posture guidance', () => {
      it.each([
        [
          'StaticHostingPostureRequired',
          "Static hosting requires an explicit access posture. Set 'services.staticHosting.anonymousAccess' in your app configuration - false restricts the app to signed-in visitors, true serves it to anyone with the link - then deploy again.",
          'services.staticHosting.assetAccess',
        ],
        [
          'InvalidStaticHostingPosture',
          "Invalid static hosting posture: 'embedded.only' and 'anonymousAccess' cannot both be true - an embedded app has no standalone surface to be anonymous on.",
          'services.staticHosting.assetAccess: public',
        ],
      ])(
        'surfaces Builder guidance for %s',
        async (code, message, expected) => {
          fetchMock.mockResolvedValue({
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            text: async () => JSON.stringify({ error: { code, message } }),
            headers: { get: () => null },
          });

          await expect(
            postRuntimeSettings(
              'https://api/item',
              services,
              '******',
              () => {}
            )
          ).rejects.toThrow(expected);

          await expect(
            postRuntimeSettings(
              'https://api/item',
              services,
              '******',
              () => {}
            )
          ).rejects.not.toThrow(/anonymousAccess/);
        }
      );
    });
  });

  it('merges a non-empty connectors block as a sibling of the service keys', async () => {
    await postRuntimeSettings(
      'https://api/item',
      services,
      'Bearer abc',
      () => {},
      'runtime-settings',
      undefined,
      connectors
    );

    const body = lastRequestBody();
    expect(body.connectors).toEqual(connectorsWire);
    expect(body.auth).toEqual(services.auth);
    expect(body.data).toEqual(services.data);
    expect(body.functions).toEqual(services.functions);
  });

  it('forwards connectors identically for the redirect-patch label', async () => {
    await postRuntimeSettings(
      'https://api/item',
      services,
      'Bearer abc',
      () => {},
      'runtime-settings-patch',
      undefined,
      connectors
    );

    expect(lastRequestBody().connectors).toEqual(connectorsWire);
  });

  it('omits connectors when the block is empty', async () => {
    await postRuntimeSettings(
      'https://api/item',
      services,
      'Bearer abc',
      () => {},
      'runtime-settings',
      undefined,
      [] as unknown as RayfinConfig['connectors']
    );

    expect(lastRequestBody()).not.toHaveProperty('connectors');
  });

  it('omits connectors when the block is undefined', async () => {
    await postRuntimeSettings(
      'https://api/item',
      services,
      'Bearer abc',
      () => {}
    );

    expect(lastRequestBody()).not.toHaveProperty('connectors');
  });

  it('retries a transient 500, then rejects after exhausting attempts', async () => {
    // 500 is in the transient allowlist, so `shouldRetry` keeps it in the retry
    // loop; fake timers drain the exponential backoff without real delay.
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => '{}',
        headers: { get: () => null },
      });

      const result = postRuntimeSettings(
        'https://api/item',
        services,
        'Bearer abc',
        () => {},
        'runtime-settings'
      );
      const assertion = expect(result).rejects.toThrow();
      await vi.runAllTimersAsync();
      await assertion;
      // Retried, not a single shot.
      expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails fast on a terminal 403 without retrying', async () => {
    // A 403 build-permission denial is terminal — `shouldRetry` returns false so
    // the request is issued exactly once and the error surfaces immediately.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () =>
        "You do not have Build permission on semantic model '...'.",
      headers: { get: () => null },
    });

    await expect(
      postRuntimeSettings(
        'https://api/item',
        services,
        '******',
        () => {},
        'runtime-settings'
      )
    ).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
