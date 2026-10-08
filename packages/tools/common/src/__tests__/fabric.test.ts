import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FABRIC_SETTINGS,
  getFabricSettings,
  resolveFabricPortalUrl,
} from '../fabric.js';

describe('getFabricSettings', () => {
  it('returns defaults when no env is provided and process.env is empty', () => {
    const settings = getFabricSettings({});
    expect(settings).toEqual({
      fabricApiBaseUrl: DEFAULT_FABRIC_SETTINGS.fabricApiBaseUrl,
      fabricPortalUrl: DEFAULT_FABRIC_SETTINGS.fabricPortalUrl,
      workloadId: DEFAULT_FABRIC_SETTINGS.workloadId,
      itemType: DEFAULT_FABRIC_SETTINGS.itemType,
    });
  });

  it('overrides fabricApiBaseUrl from RAYFIN_FABRIC_API_URL', () => {
    const customUrl = 'https://api.fabric.microsoft.com/v1';
    const settings = getFabricSettings({
      RAYFIN_FABRIC_API_URL: customUrl,
    });
    expect(settings.fabricApiBaseUrl).toBe(customUrl);
    // Others remain default
    expect(settings.fabricPortalUrl).toBe(
      DEFAULT_FABRIC_SETTINGS.fabricPortalUrl
    );
  });

  it('overrides fabricPortalUrl from RAYFIN_FABRIC_PORTAL_URL', () => {
    const customPortal = 'https://app.fabric.microsoft.com/';
    const settings = getFabricSettings({
      RAYFIN_FABRIC_PORTAL_URL: customPortal,
    });
    expect(settings.fabricPortalUrl).toBe(customPortal);
    expect(settings.fabricApiBaseUrl).toBe(
      DEFAULT_FABRIC_SETTINGS.fabricApiBaseUrl
    );
  });

  it('overrides both env vars simultaneously', () => {
    const settings = getFabricSettings({
      RAYFIN_FABRIC_API_URL: 'https://dxtapi.fabric.microsoft.com/v1',
      RAYFIN_FABRIC_PORTAL_URL: 'https://dxt.fabric.microsoft.com/',
    });
    expect(settings.fabricApiBaseUrl).toBe(
      'https://dxtapi.fabric.microsoft.com/v1'
    );
    expect(settings.fabricPortalUrl).toBe('https://dxt.fabric.microsoft.com/');
  });

  it('never overrides workloadId or itemType', () => {
    const settings = getFabricSettings({
      RAYFIN_FABRIC_API_URL: 'https://custom.api/v1',
    });
    expect(settings.workloadId).toBe('BaaS');
    expect(settings.itemType).toBe('AppBackend');
  });

  it('ignores empty string env values and uses defaults', () => {
    const settings = getFabricSettings({
      RAYFIN_FABRIC_API_URL: '',
      RAYFIN_FABRIC_PORTAL_URL: '',
    });
    expect(settings.fabricApiBaseUrl).toBe(
      DEFAULT_FABRIC_SETTINGS.fabricApiBaseUrl
    );
    expect(settings.fabricPortalUrl).toBe(
      DEFAULT_FABRIC_SETTINGS.fabricPortalUrl
    );
  });

  it('ignores undefined env values and uses defaults', () => {
    const settings = getFabricSettings({
      RAYFIN_FABRIC_API_URL: undefined,
    });
    expect(settings.fabricApiBaseUrl).toBe(
      DEFAULT_FABRIC_SETTINGS.fabricApiBaseUrl
    );
  });

  it('appends /v1 when RAYFIN_FABRIC_API_URL lacks a version path', () => {
    const settings = getFabricSettings({
      RAYFIN_FABRIC_API_URL: 'https://dailyapi.powerbi.com',
    });
    expect(settings.fabricApiBaseUrl).toBe('https://dailyapi.powerbi.com/v1');
  });

  it('appends /v1 when RAYFIN_FABRIC_API_URL has a trailing slash but no version', () => {
    const settings = getFabricSettings({
      RAYFIN_FABRIC_API_URL: 'https://dailyapi.powerbi.com/',
    });
    expect(settings.fabricApiBaseUrl).toBe('https://dailyapi.powerbi.com/v1');
  });

  it('does not double-append /v1 when already present', () => {
    const settings = getFabricSettings({
      RAYFIN_FABRIC_API_URL: 'https://api.fabric.microsoft.com/v1',
    });
    expect(settings.fabricApiBaseUrl).toBe(
      'https://api.fabric.microsoft.com/v1'
    );
  });

  it('does not double-append /v1 when present with trailing slash', () => {
    const settings = getFabricSettings({
      RAYFIN_FABRIC_API_URL: 'https://api.fabric.microsoft.com/v1/',
    });
    expect(settings.fabricApiBaseUrl).toBe(
      'https://api.fabric.microsoft.com/v1'
    );
  });

  it('strips trailing slash but preserves a path prefix as-is', () => {
    const settings = getFabricSettings({
      RAYFIN_FABRIC_API_URL:
        'https://my-proxy.example.com/cli-proxy/fabric/abc123/',
    });
    expect(settings.fabricApiBaseUrl).toBe(
      'https://my-proxy.example.com/cli-proxy/fabric/abc123/v1'
    );
  });

  it('appends /v1 to a path prefix that does not already end in /v1', () => {
    const settings = getFabricSettings({
      RAYFIN_FABRIC_API_URL:
        'https://my-proxy.example.com/cli-proxy/fabric/abc123',
    });
    expect(settings.fabricApiBaseUrl).toBe(
      'https://my-proxy.example.com/cli-proxy/fabric/abc123/v1'
    );
  });

  it('preserves a path prefix that already ends in /v1', () => {
    const settings = getFabricSettings({
      RAYFIN_FABRIC_API_URL:
        'https://my-proxy.example.com/cli-proxy/fabric/abc123/v1',
    });
    expect(settings.fabricApiBaseUrl).toBe(
      'https://my-proxy.example.com/cli-proxy/fabric/abc123/v1'
    );
  });

  it('drops query string and fragment from RAYFIN_FABRIC_API_URL', () => {
    // Fabric API base URLs do not use query strings or fragments, and
    // preserving them would interact badly with path concatenation at
    // call sites (e.g. `${baseUrl}/workspaces/123` would slot the path
    // before the query). normalizeFabricApiUrl drops both unconditionally.
    const settings = getFabricSettings({
      RAYFIN_FABRIC_API_URL:
        'https://my-proxy.example.com/cli-proxy/fabric/abc123/?foo=bar#frag',
    });
    expect(settings.fabricApiBaseUrl).toBe(
      'https://my-proxy.example.com/cli-proxy/fabric/abc123/v1'
    );
  });

  describe('canonical Fabric host normalization', () => {
    // For *.fabric.microsoft.com hosts we know the canonical API shape,
    // so any extra path is treated as accidental and replaced with /v1.
    // This preserves the historical normalizer behavior — anyone setting
    // RAYFIN_FABRIC_API_URL to a URL like
    // `https://api.fabric.microsoft.com/v1/workspaces/<id>` (intentionally
    // or by accident) gets back `<origin>/v1`, not a double-pathed result.
    it('strips extra path segments from production api host back to /v1', () => {
      const settings = getFabricSettings({
        RAYFIN_FABRIC_API_URL:
          'https://api.fabric.microsoft.com/v1/workspaces/abc',
      });
      expect(settings.fabricApiBaseUrl).toBe(
        'https://api.fabric.microsoft.com/v1'
      );
    });

    it('strips extra path segments from environment-specific api host', () => {
      const settings = getFabricSettings({
        RAYFIN_FABRIC_API_URL:
          'https://envapi.fabric.microsoft.com/v1/workspaces/abc',
      });
      expect(settings.fabricApiBaseUrl).toBe(
        'https://envapi.fabric.microsoft.com/v1'
      );
    });

    it('strips deep path segments from a Fabric host', () => {
      const settings = getFabricSettings({
        RAYFIN_FABRIC_API_URL:
          'https://api.fabric.microsoft.com/v1/workspaces/abc/items/def',
      });
      expect(settings.fabricApiBaseUrl).toBe(
        'https://api.fabric.microsoft.com/v1'
      );
    });

    it('treats Fabric host matching as case-insensitive', () => {
      // The WHATWG URL parser lowercases `.hostname` for us, so this case
      // proves the end-to-end contract for an uppercase override even
      // though `isFabricHost` itself never sees the original casing. The
      // explicit `.toLowerCase()` inside `isFabricHost` is a belt-and-
      // suspenders guard for any future caller that hands it a raw host.
      const settings = getFabricSettings({
        RAYFIN_FABRIC_API_URL:
          'https://API.FABRIC.MICROSOFT.COM/v1/workspaces/abc',
      });
      expect(settings.fabricApiBaseUrl).toBe(
        'https://api.fabric.microsoft.com/v1'
      );
    });

    it('treats trailing-dot Fabric FQDN as a Fabric host', () => {
      // A root-anchored FQDN like `api.fabric.microsoft.com.` would
      // otherwise slip past the suffix check (WHATWG URL preserves the
      // trailing dot in `.hostname`) and get routed through the
      // path-preserving branch, which would then break parseWorkspaceUri.
      const settings = getFabricSettings({
        RAYFIN_FABRIC_API_URL:
          'https://api.fabric.microsoft.com./v1/workspaces/abc',
      });
      expect(settings.fabricApiBaseUrl).toBe(
        'https://api.fabric.microsoft.com./v1'
      );
    });

    it('does not match Fabric suffix on hosts like notfabric.microsoft.com', () => {
      // The check requires `.fabric.microsoft.com` (with leading dot) so
      // hosts that happen to share the suffix without being a real
      // subdomain fall through to the path-preserving branch.
      const settings = getFabricSettings({
        RAYFIN_FABRIC_API_URL: 'https://notfabric.microsoft.com/proxy/abc',
      });
      expect(settings.fabricApiBaseUrl).toBe(
        'https://notfabric.microsoft.com/proxy/abc/v1'
      );
    });
  });
});

describe('resolveFabricPortalUrl', () => {
  it('falls back to the commercial portal for a commercial deployment', () => {
    expect(
      resolveFabricPortalUrl({
        backendUrl:
          'https://prod.pbidedicated.windows.net/webapi/capacities/capacity-id',
      })
    ).toBe(DEFAULT_FABRIC_SETTINGS.fabricPortalUrl);
  });

  it('infers the MSIT portal from the resolved backend URL', () => {
    expect(
      resolveFabricPortalUrl({
        backendUrl:
          'https://cluster-msit.pbidedicated.windows.net/webapi/capacities/capacity-id',
      })
    ).toBe('https://msit.powerbi.com/');
  });

  it('infers the MSIT portal from the resolved hosting URL', () => {
    expect(
      resolveFabricPortalUrl({
        hostingUrl: 'https://webapp.msit.fabricapps.net/app-id',
      })
    ).toBe('https://msit.powerbi.com/');
  });

  it('does not infer MSIT from hosts with extra prefix labels', () => {
    expect(
      resolveFabricPortalUrl({
        backendUrl:
          'https://extra.cluster-msit.pbidedicated.windows.net/webapi',
        hostingUrl: 'https://extra.webapp.msit.fabricapps.net/app-id',
      })
    ).toBe(DEFAULT_FABRIC_SETTINGS.fabricPortalUrl);
  });

  it('prefers an explicit portal URL over endpoint inference', () => {
    expect(
      resolveFabricPortalUrl({
        configuredPortalUrl: 'https://portal.example.invalid/',
        backendUrl:
          'https://cluster-msit.pbidedicated.windows.net/webapi/capacities/capacity-id',
      })
    ).toBe('https://portal.example.invalid/');
  });
});
