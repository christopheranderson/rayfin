import { ApiClient } from '@microsoft/rayfin-lib';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { Auth } from '..';

/**
 * Creates a mock JWT with the given payload claims.
 * Header and signature are minimal placeholders — only the payload matters for extraction.
 */
function createMockJwt(payload: Record<string, any>): string {
  const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const sig = 'mock-signature';
  return `${header}.${body}.${sig}`;
}

// Auth methods are private — test via createSessionFromTokenResponse which calls both
// extractUserIdFromToken and extractEmailFromToken internally.
describe('Token parsing: standard and managed hosting formats', () => {
  let auth: Auth;

  beforeEach(() => {
    vi.clearAllMocks();
    const apiClient = new ApiClient({
      baseUrl: 'https://example.com',
      publishableKey: 'pk-test',
    });
    auth = new Auth(apiClient, { storage: false });
  });

  describe('Standard tokens', () => {
    it('extracts userId from top-level sub', async () => {
      const token = createMockJwt({
        sub: 'b243a8e6-e18c-443f-b975-c44b5dc40946',
        email: 'alice@example.com',
      });

      const session = await auth.createSessionFromTokenResponse({
        accessToken: token,
        tokenType: 'Bearer',
        expiresIn: 3600,
      });

      expect(session.user?.id).toBe('b243a8e6-e18c-443f-b975-c44b5dc40946');
      expect(session.user?.email).toBe('alice@example.com');
    });
  });

  describe('Managed hosting tokens (hierarchical sub, xms_attr)', () => {
    it('extracts userId from hierarchical path in sub (via idtyp)', async () => {
      const token = createMockJwt({
        idtyp: 'fmi',
        sub: '/eid1/c/ppe/t/abc123/a/def456/workspaces/ws-1/projects/proj-1/users/b243a8e6-e18c-443f-b975-c44b5dc40946',
        xms_attr: {
          def456: {
            rfn_email: 'alice@ppeEdogTenant.ccsctp.net',
            rfn_role: 'Authenticated',
          },
        },
      });

      const session = await auth.createSessionFromTokenResponse({
        accessToken: token,
        tokenType: 'Bearer',
        expiresIn: 3600,
      });

      expect(session.user?.id).toBe('b243a8e6-e18c-443f-b975-c44b5dc40946');
      expect(session.user?.email).toBe('alice@ppeEdogTenant.ccsctp.net');
    });

    it('extracts userId from hierarchical path via /users/ fallback (no idtyp)', async () => {
      const token = createMockJwt({
        sub: '/eid1/c/ppe/t/abc123/a/def456/workspaces/ws-1/projects/proj-1/users/user-guid-123',
        xms_attr: {
          someAppId: {
            rfn_email: 'bob@contoso.com',
          },
        },
      });

      const session = await auth.createSessionFromTokenResponse({
        accessToken: token,
        tokenType: 'Bearer',
        expiresIn: 3600,
      });

      expect(session.user?.id).toBe('user-guid-123');
      expect(session.user?.email).toBe('bob@contoso.com');
    });

    it('returns unknown for managed hosting token without xms_attr', async () => {
      const token = createMockJwt({
        idtyp: 'fmi',
        sub: '/eid1/c/ppe/t/abc123/a/def456/workspaces/ws-1/projects/proj-1/users/user-1',
      });

      const session = await auth.createSessionFromTokenResponse({
        accessToken: token,
        tokenType: 'Bearer',
        expiresIn: 3600,
      });

      expect(session.user?.id).toBe('user-1');
      expect(session.user?.email).toBe('unknown');
    });
  });

  describe('edge cases', () => {
    it('returns unknown for non-JWT string', async () => {
      const session = await auth.createSessionFromTokenResponse({
        accessToken: 'not-a-jwt',
        tokenType: 'Bearer',
        expiresIn: 3600,
      });

      expect(session.user?.id).toBe('unknown');
      expect(session.user?.email).toBe('unknown');
    });

    it('returns unknown for token with empty sub', async () => {
      const token = createMockJwt({ sub: '' });

      const session = await auth.createSessionFromTokenResponse({
        accessToken: token,
        tokenType: 'Bearer',
        expiresIn: 3600,
      });

      expect(session.user?.id).toBe('unknown');
    });

    it('handles xms_attr with empty app keys', async () => {
      const token = createMockJwt({
        idtyp: 'fmi',
        sub: '/users/user-1',
        xms_attr: {},
      });

      const session = await auth.createSessionFromTokenResponse({
        accessToken: token,
        tokenType: 'Bearer',
        expiresIn: 3600,
      });

      expect(session.user?.email).toBe('unknown');
    });
  });
});
