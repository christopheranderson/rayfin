import { describe, it, expect } from 'vitest';

import { buildBrokerUrl } from '../brokerUrl';
import type { FabricAuthOptions } from '../types';

describe('buildBrokerUrl', () => {
  const baseOptions: FabricAuthOptions = {
    workspaceId: 'aff5c95b-2443-4e77-acb9-09a9b2768467',
    projectId: '25e846d7-fa4f-4f26-9760-10e015d848c0',
    fabricPortalUrl: 'https://app.fabric.microsoft.com',
    returnOrigin: 'http://localhost:5173',
  };

  it('should construct correct URL with all parameters', () => {
    const url = buildBrokerUrl(baseOptions);
    const parsed = new URL(url);

    expect(parsed.origin).toBe('https://app.fabric.microsoft.com');
    expect(parsed.pathname).toBe('/secureItemEmbed');
    expect(parsed.searchParams.get('workspaceId')).toBe(
      baseOptions.workspaceId
    );
    expect(parsed.searchParams.get('itemType')).toBe('AppBackend');
    expect(parsed.searchParams.get('itemId')).toBe(baseOptions.projectId);
    expect(parsed.searchParams.get('extensionPath')).toBe('/brokeredauth');
  });

  it('should not include PKCE params as top-level SIE query params', () => {
    const url = buildBrokerUrl(baseOptions);
    const parsed = new URL(url);

    expect(parsed.searchParams.has('returnOrigin')).toBe(false);
    expect(parsed.searchParams.has('callbackUrl')).toBe(false);
    expect(parsed.searchParams.has('code_challenge')).toBe(false);
    expect(parsed.searchParams.has('code_challenge_method')).toBe(false);
    expect(parsed.searchParams.has('state')).toBe(false);
  });

  it('should preserve existing portal path', () => {
    const options: FabricAuthOptions = {
      ...baseOptions,
      fabricPortalUrl: 'https://app.fabric.microsoft.com/some/portal/path',
    };
    const url = buildBrokerUrl(options);
    const parsed = new URL(url);

    expect(parsed.pathname).toBe('/some/portal/path/secureItemEmbed');
  });

  it('should preserve existing query parameters', () => {
    const options: FabricAuthOptions = {
      ...baseOptions,
      fabricPortalUrl: 'https://daily.fabric.microsoft.com?experience=power-bi',
    };
    const url = buildBrokerUrl(options);
    const parsed = new URL(url);

    expect(parsed.pathname).toBe('/secureItemEmbed');
    expect(parsed.searchParams.get('experience')).toBe('power-bi');
    expect(parsed.searchParams.get('extensionPath')).toBe('/brokeredauth');
  });

  it('should strip trailing slash from portal path', () => {
    const options: FabricAuthOptions = {
      ...baseOptions,
      fabricPortalUrl: 'https://app.fabric.microsoft.com/',
    };
    const url = buildBrokerUrl(options);
    const parsed = new URL(url);

    expect(parsed.pathname).toBe('/secureItemEmbed');
  });

  it('should encode workspace and project IDs in query params', () => {
    const options: FabricAuthOptions = {
      ...baseOptions,
      workspaceId: 'id with spaces',
      projectId: 'id/with/slashes',
    };
    const url = buildBrokerUrl(options);
    const parsed = new URL(url);

    expect(parsed.searchParams.get('workspaceId')).toBe('id with spaces');
    expect(parsed.searchParams.get('itemId')).toBe('id/with/slashes');
  });

  describe('edog fallback', () => {
    const edogOptions: FabricAuthOptions = {
      ...baseOptions,
      fabricPortalUrl:
        'https://powerbi-df.analysis-df.windows.net?experience=power-bi',
    };

    it('should use the full-portal artifact deep-link instead of secureItemEmbed', () => {
      const url = buildBrokerUrl(edogOptions);
      const parsed = new URL(url);

      expect(parsed.pathname).toBe(
        `/groups/${baseOptions.workspaceId}/appbackends/${baseOptions.projectId}/brokeredauth`
      );
      expect(parsed.pathname).not.toContain('secureItemEmbed');
    });

    it('should not add SecureItemEmbed query params on edog', () => {
      const url = buildBrokerUrl(edogOptions);
      const parsed = new URL(url);

      expect(parsed.searchParams.has('workspaceId')).toBe(false);
      expect(parsed.searchParams.has('itemType')).toBe(false);
      expect(parsed.searchParams.has('itemId')).toBe(false);
      expect(parsed.searchParams.has('extensionPath')).toBe(false);
    });

    it('should preserve existing query params on edog', () => {
      const url = buildBrokerUrl(edogOptions);
      const parsed = new URL(url);

      expect(parsed.searchParams.get('experience')).toBe('power-bi');
    });

    it('should preserve debug.useLocalManifests when present on edog', () => {
      const options: FabricAuthOptions = {
        ...edogOptions,
        fabricPortalUrl:
          'https://powerbi-df.analysis-df.windows.net?debug.useLocalManifests=1&experience=power-bi',
      };
      const url = buildBrokerUrl(options);
      const parsed = new URL(url);

      expect(parsed.searchParams.get('debug.useLocalManifests')).toBe('1');
      expect(parsed.searchParams.get('experience')).toBe('power-bi');
    });

    it('should not include PKCE/state params on edog', () => {
      const url = buildBrokerUrl(edogOptions);
      const parsed = new URL(url);

      expect(parsed.searchParams.has('returnOrigin')).toBe(false);
      expect(parsed.searchParams.has('callbackUrl')).toBe(false);
      expect(parsed.searchParams.has('code_challenge')).toBe(false);
      expect(parsed.searchParams.has('code_challenge_method')).toBe(false);
      expect(parsed.searchParams.has('state')).toBe(false);
    });

    it('should preserve an existing portal path in the deep-link', () => {
      const options: FabricAuthOptions = {
        ...edogOptions,
        fabricPortalUrl: 'https://powerbi-df.analysis-df.windows.net/some/path',
      };
      const url = buildBrokerUrl(options);
      const parsed = new URL(url);

      expect(parsed.pathname).toBe(
        `/some/path/groups/${baseOptions.workspaceId}/appbackends/${baseOptions.projectId}/brokeredauth`
      );
    });

    it('should encode workspace and project IDs in the deep-link path', () => {
      const options: FabricAuthOptions = {
        ...edogOptions,
        workspaceId: 'id with spaces',
        projectId: 'id/with/slashes',
      };
      const url = buildBrokerUrl(options);
      const parsed = new URL(url);

      expect(parsed.pathname).toBe(
        '/groups/id%20with%20spaces/appbackends/id%2Fwith%2Fslashes/brokeredauth'
      );
    });

    it('should use secureItemEmbed for non-edog fabric hosts', () => {
      const options: FabricAuthOptions = {
        ...baseOptions,
        fabricPortalUrl: 'https://daily.fabric.microsoft.com',
      };
      const url = buildBrokerUrl(options);
      const parsed = new URL(url);

      expect(parsed.pathname).toBe('/secureItemEmbed');
      expect(parsed.searchParams.get('extensionPath')).toBe('/brokeredauth');
    });
  });
});
