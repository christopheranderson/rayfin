import { ApiClient } from '@microsoft/rayfin-lib';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { Auth } from '..';
import { AuthApi } from '../AuthApi';
import type { OpaqueSession } from '../types';

// Mock fetch for auth endpoints
global.fetch = vi.fn(async (url: any, init?: any) => {
  const urlString = typeof url === 'string' ? url : url.toString();

  let body: any = {};
  if (init?.body) {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = {};
    }
  }

  // Token endpoint — handles both standard and fabric handoff exchanges
  if (urlString.endsWith('/api/auth/v1/token')) {
    // Fabric handoff exchange
    if (body.codeType === 'fabric_handoff' && body.verificationCode) {
      return new Response(
        JSON.stringify({
          accessToken: 'FABRIC_ACCESS_TOKEN',
          tokenType: 'Bearer',
          expiresIn: 900,
          refreshToken: 'FABRIC_REFRESH_TOKEN',
        }),
        { status: 200 }
      );
    }
    // Standard verification code exchange (no codeType)
    if (
      body.grantType === 'authorization_code' &&
      body.verificationCode &&
      !body.codeType
    ) {
      return new Response(
        JSON.stringify({
          accessToken: 'STANDARD_ACCESS_TOKEN',
          tokenType: 'Bearer',
          expiresIn: 900,
          refreshToken: 'STANDARD_REFRESH_TOKEN',
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ message: 'Invalid request' }), {
      status: 400,
    });
  }

  // Runtime settings endpoint — return fabric-enabled settings
  if (urlString.includes('/api/projectRuntimeSettings')) {
    return new Response(
      JSON.stringify({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        publishableKey: 'pk-test',
        serviceSettings: {
          auth: {
            enabled: true,
            password: { enabled: true },
            passwordless: { magicLink: { enabled: false } },
            fabric: { enabled: true },
          },
          data: { enabled: true },
          storage: { enabled: false },
        },
      }),
      { status: 200 }
    );
  }

  // Sign out - needed for afterEach cleanup
  if (urlString.endsWith('/api/auth/v1/signout')) {
    return new Response(
      JSON.stringify({ message: 'Signed out successfully' }),
      { status: 200 }
    );
  }

  return new Response(JSON.stringify({ message: 'Not Found' }), {
    status: 404,
  });
});

describe('Fabric Auth Extensions', () => {
  let auth: Auth;
  let apiClient: ApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    apiClient = new ApiClient({
      baseUrl: 'https://example.com',
      publishableKey: 'pk-test',
    });
    auth = new Auth(apiClient, { storage: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('exchangeVerificationCode with codeType', () => {
    it('includes codeType when provided', async () => {
      const authApi = auth.getAuthApi();
      const result = await authApi.exchangeVerificationCode({
        verificationCode: 'handoff-code-123',
        codeVerifier: 'test-verifier',
        redirectUri: 'http://localhost:5173/auth/fabric/callback',
        codeType: 'fabric_handoff',
      });

      expect(result.accessToken).toBe('FABRIC_ACCESS_TOKEN');

      // Verify the fetch was called with codeType in the body
      const fetchCalls = (global.fetch as any).mock.calls;
      const tokenCall = fetchCalls.find((call: any[]) =>
        call[0]?.toString().endsWith('/api/auth/v1/token')
      );
      expect(tokenCall).toBeDefined();
      const requestBody = JSON.parse(tokenCall[1].body);
      expect(requestBody.codeType).toBe('fabric_handoff');
    });

    it('omits codeType when not provided', async () => {
      const authApi = auth.getAuthApi();
      const result = await authApi.exchangeVerificationCode({
        verificationCode: 'standard-code',
        codeVerifier: 'test-verifier',
        redirectUri: 'http://localhost:5173/auth/callback',
      });

      expect(result.accessToken).toBe('STANDARD_ACCESS_TOKEN');

      // Verify the fetch was called without codeType
      const fetchCalls = (global.fetch as any).mock.calls;
      const tokenCall = fetchCalls.find((call: any[]) =>
        call[0]?.toString().endsWith('/api/auth/v1/token')
      );
      const requestBody = JSON.parse(tokenCall[1].body);
      expect(requestBody.codeType).toBeUndefined();
    });
  });

  describe('Auth.getAuthApi', () => {
    it('returns the internal AuthApi instance', () => {
      const authApi = auth.getAuthApi();
      expect(authApi).toBeInstanceOf(AuthApi);
    });

    it('returns the same instance on multiple calls', () => {
      const authApi1 = auth.getAuthApi();
      const authApi2 = auth.getAuthApi();
      expect(authApi1).toBe(authApi2);
    });
  });

  describe('Auth.createSessionFromTokenResponse', () => {
    it('creates session and returns OpaqueSession', async () => {
      const session = await auth.createSessionFromTokenResponse({
        accessToken:
          // Minimal JWT with sub and email claims for test
          'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
          btoa(
            JSON.stringify({
              sub: 'user-fabric-1',
              email: 'fabric@example.com',
              exp: Math.floor(Date.now() / 1000) + 3600,
            })
          )
            .replace(/=/g, '')
            .replace(/\+/g, '-')
            .replace(/\//g, '_') +
          '.signature',
        tokenType: 'Bearer',
        expiresIn: 3600,
        refreshToken: 'fabric-refresh-token',
      });

      expect(session.isAuthenticated).toBe(true);
      expect(session.user).toBeDefined();
    });

    it('emits AUTH_LOGIN event', async () => {
      const events: OpaqueSession[] = [];
      auth.on('AUTH_LOGIN', (session) => events.push(session));

      await auth.createSessionFromTokenResponse({
        accessToken:
          'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
          btoa(
            JSON.stringify({
              sub: 'user-fabric-1',
              email: 'fabric@example.com',
              exp: Math.floor(Date.now() / 1000) + 3600,
            })
          )
            .replace(/=/g, '')
            .replace(/\+/g, '-')
            .replace(/\//g, '_') +
          '.signature',
        tokenType: 'Bearer',
        expiresIn: 3600,
        refreshToken: null,
      });

      expect(events.length).toBe(1);
      expect(events[0]!.isAuthenticated).toBe(true);
    });
  });

  describe('parseAuthSettings with fabric', () => {
    it('includes fabric when present in response', async () => {
      const settings = await auth.getAuthSettings();
      expect(settings.fabric).toBeDefined();
      expect(settings.fabric!.enabled).toBe(true);
      expect(settings.availableMethods).toContain('fabric');
    });

    it('defaults fabric to false when absent in response', async () => {
      // Override fetch for this test to return settings without fabric
      (global.fetch as any).mockImplementationOnce(async (url: any) => {
        const urlString = typeof url === 'string' ? url : url.toString();
        if (urlString.includes('/api/projectRuntimeSettings')) {
          return new Response(
            JSON.stringify({
              serviceSettings: {
                auth: {
                  enabled: true,
                  password: { enabled: true },
                  passwordless: { magicLink: { enabled: false } },
                  // No fabric block
                },
              },
            }),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 404 });
      });

      // Create a fresh auth instance to avoid cached settings
      const freshAuth = new Auth(apiClient, { storage: false });
      const settings = await freshAuth.getAuthSettings();
      expect(settings.fabric).toBeDefined();
      expect(settings.fabric!.enabled).toBe(false);
      expect(settings.availableMethods).not.toContain('fabric');
    });
  });
});
