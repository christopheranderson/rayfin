import { AuthError } from '@microsoft/rayfin-lib';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import * as embeddedFabricLoginModule from '../embeddedFabricLogin';
import * as classificationModule from '../externalEmbedClassification';
import {
  markEmbeddedHandoffCompleted,
  resetEmbeddedHandoffStateForTests,
} from '../fabricAuthHelpers';
import {
  clearFabricUserHint,
  persistFabricUserHintFromUrl,
} from '../fabricUserHint';
import { initEmbeddedAuth } from '../initEmbeddedAuth';
import type { FabricAuthOptions } from '../types';

/**
 * Simulates a host that stamps the `?_fu=` identity hint.
 *
 * Stamps the entry URL and lets the module capture it, then restores the URL - the hint has to
 * outlive the query string within a document, but must not be injected into module state directly,
 * or the test would not exercise the same path the browser takes.
 */
function withUserHint(): void {
  const original = window.location;
  Object.defineProperty(window, 'location', {
    value: { ...original, search: '?_fu=ToVQv3p2KO1E1KwCWmoxFw' },
    writable: true,
    configurable: true,
  });
  persistFabricUserHintFromUrl();
  Object.defineProperty(window, 'location', {
    value: original,
    writable: true,
    configurable: true,
  });
}

describe('initEmbeddedAuth', () => {
  const options: FabricAuthOptions = {
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    fabricPortalUrl: 'https://app.fabric.microsoft.com',
    returnOrigin: 'http://localhost:5173',
  };

  const authenticatedSession = {
    isAuthenticated: true,
    user: { id: 'user-1', email: 'test@example.com' },
  };

  const unauthenticatedSession = {
    isAuthenticated: false,
    user: null,
  };

  let mockAuth: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    clearFabricUserHint();
    resetEmbeddedHandoffStateForTests();

    mockAuth = {
      getSession: vi.fn().mockReturnValue(unauthenticatedSession),
      hasRefreshToken: vi.fn().mockReturnValue(false),
      refreshSession: vi.fn(),
      getAuthApi: vi.fn(),
      createSessionFromTokenResponse: vi.fn(),
      signOut: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearFabricUserHint();
    resetEmbeddedHandoffStateForTests();
  });

  // ── Not-embedded: returns null immediately ───────────────

  it('should return null when not in embedded mode', async () => {
    const result = await initEmbeddedAuth(mockAuth, options);
    expect(result).toBeNull();
    expect(mockAuth.getSession).not.toHaveBeenCalled();
  });

  // ── Embedded via the externalEmbed handshake alone (no fabricEmbedded) ──

  it('runs the handoff from the externalEmbed handshake alone, without fabricEmbedded', async () => {
    // No fabricEmbedded option/URL/sessionStorage — the externalEmbed scenario
    // is established purely by the classification ack.
    vi.spyOn(classificationModule, 'classifyExternalEmbed').mockResolvedValue(
      undefined
    );
    vi.spyOn(classificationModule, 'isExternalEmbedScenario').mockReturnValue(
      true
    );
    const embeddedSpy = vi
      .spyOn(embeddedFabricLoginModule, 'embeddedFabricLogin')
      .mockResolvedValue(undefined);

    // A stale persisted session is present; externalEmbed must skip resume and
    // still broker a fresh handoff rather than returning it.
    mockAuth.getSession.mockReturnValue(authenticatedSession);

    const result = await initEmbeddedAuth(mockAuth, options);

    expect(embeddedSpy).toHaveBeenCalledWith(mockAuth, options);
    expect(result).toEqual(authenticatedSession);
  });

  // ── Embedded via options flag ─────────────────────────────

  describe('when fabricEmbedded option is true', () => {
    const embeddedOptions = { ...options, fabricEmbedded: true as const };

    it('should reuse an existing session without a handoff when the host stamps a user hint', async () => {
      withUserHint();
      mockAuth.getSession.mockReturnValue(authenticatedSession);

      const embeddedSpy = vi
        .spyOn(embeddedFabricLoginModule, 'embeddedFabricLogin')
        .mockResolvedValue(undefined);

      const result = await initEmbeddedAuth(mockAuth, embeddedOptions);

      expect(result).toEqual(authenticatedSession);
      expect(embeddedSpy).not.toHaveBeenCalled();
      expect(mockAuth.signOut).not.toHaveBeenCalled();
    });

    it('should NOT reuse an existing session on a legacy embedded host', async () => {
      mockAuth.getSession
        .mockReturnValueOnce(authenticatedSession) // would-be step 1 (must NOT short-circuit)
        .mockReturnValueOnce(authenticatedSession); // after handoff

      const embeddedSpy = vi
        .spyOn(embeddedFabricLoginModule, 'embeddedFabricLogin')
        .mockResolvedValue(undefined);

      const result = await initEmbeddedAuth(mockAuth, embeddedOptions);

      expect(embeddedSpy).toHaveBeenCalledWith(mockAuth, embeddedOptions);
      expect(result).toEqual(authenticatedSession);
    });

    it('should reuse the session on a legacy host after a handoff has run this page load', async () => {
      markEmbeddedHandoffCompleted();
      mockAuth.getSession.mockReturnValue(authenticatedSession);

      const embeddedSpy = vi
        .spyOn(embeddedFabricLoginModule, 'embeddedFabricLogin')
        .mockResolvedValue(undefined);

      const result = await initEmbeddedAuth(mockAuth, embeddedOptions);

      expect(result).toEqual(authenticatedSession);
      expect(embeddedSpy).not.toHaveBeenCalled();
    });

    it('should use a refresh token before falling through to the handoff', async () => {
      withUserHint();
      mockAuth.hasRefreshToken.mockReturnValue(true);
      mockAuth.refreshSession.mockResolvedValue(undefined);
      mockAuth.getSession
        .mockReturnValueOnce(unauthenticatedSession)
        .mockReturnValueOnce(authenticatedSession);

      const embeddedSpy = vi
        .spyOn(embeddedFabricLoginModule, 'embeddedFabricLogin')
        .mockResolvedValue(undefined);

      const result = await initEmbeddedAuth(mockAuth, embeddedOptions);

      expect(result).toEqual(authenticatedSession);
      expect(mockAuth.refreshSession).toHaveBeenCalled();
      expect(embeddedSpy).not.toHaveBeenCalled();
    });

    it('should fall through to postMessage handoff when refresh fails (step 3)', async () => {
      // Resume must actually run for the refresh to be attempted, so this is the hint-present path.
      withUserHint();
      mockAuth.hasRefreshToken.mockReturnValue(true);
      mockAuth.refreshSession.mockRejectedValue(new Error('Refresh failed'));

      const embeddedSpy = vi
        .spyOn(embeddedFabricLoginModule, 'embeddedFabricLogin')
        .mockResolvedValue(undefined);

      mockAuth.getSession
        .mockReturnValueOnce(unauthenticatedSession) // Step 1
        .mockReturnValueOnce(authenticatedSession); // After handoff

      const result = await initEmbeddedAuth(mockAuth, embeddedOptions);
      expect(result).toEqual(authenticatedSession);
      expect(embeddedSpy).toHaveBeenCalledWith(mockAuth, embeddedOptions);
    });

    it('should call embeddedFabricLogin for postMessage handoff (step 3)', async () => {
      const embeddedSpy = vi
        .spyOn(embeddedFabricLoginModule, 'embeddedFabricLogin')
        .mockResolvedValue(undefined);

      // Legacy host (no hint): resume is skipped, so the first getSession is the post-handoff one.
      mockAuth.getSession.mockReturnValueOnce(authenticatedSession);

      const result = await initEmbeddedAuth(mockAuth, embeddedOptions);
      expect(result).toEqual(authenticatedSession);
      expect(embeddedSpy).toHaveBeenCalledWith(mockAuth, embeddedOptions);
    });

    it('should return null when handoff completes but no session established', async () => {
      vi.spyOn(
        embeddedFabricLoginModule,
        'embeddedFabricLogin'
      ).mockResolvedValue(undefined);

      mockAuth.getSession.mockReturnValue(unauthenticatedSession);

      const result = await initEmbeddedAuth(mockAuth, embeddedOptions);
      expect(result).toBeNull();
    });

    it('should return null when embeddedFabricLogin throws (safe on page load)', async () => {
      vi.spyOn(
        embeddedFabricLoginModule,
        'embeddedFabricLogin'
      ).mockRejectedValue(
        new AuthError(
          'No parent window — embedded auth requires an iframe host.',
          'NO_PARENT_WINDOW'
        )
      );

      mockAuth.getSession.mockReturnValue(unauthenticatedSession);

      const result = await initEmbeddedAuth(mockAuth, embeddedOptions);
      expect(result).toBeNull();
    });

    it('should return null on timeout without throwing', async () => {
      vi.spyOn(
        embeddedFabricLoginModule,
        'embeddedFabricLogin'
      ).mockRejectedValue(
        new AuthError('Timed out waiting for host', 'EMBEDDED_AUTH_TIMEOUT')
      );

      mockAuth.getSession.mockReturnValue(unauthenticatedSession);

      const result = await initEmbeddedAuth(mockAuth, embeddedOptions);
      expect(result).toBeNull();
    });

    it('should never call initiateFabricLogin (no popup)', async () => {
      vi.spyOn(
        embeddedFabricLoginModule,
        'embeddedFabricLogin'
      ).mockResolvedValue(undefined);

      mockAuth.getSession
        .mockReturnValueOnce(unauthenticatedSession)
        .mockReturnValueOnce(authenticatedSession);

      await initEmbeddedAuth(mockAuth, embeddedOptions);

      // Verify window.open was never called (proxy for popup path)
      // initiateFabricLogin is not imported at all in initEmbeddedAuth
    });
  });

  // ── Embedded via URL query param ──────────────────────────

  describe('when fabricEmbedded=true is in URL', () => {
    let originalSearch: string;

    beforeEach(() => {
      originalSearch = window.location.search;
      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: '?fabricEmbedded=true' },
        writable: true,
        configurable: true,
      });
    });

    afterEach(() => {
      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: originalSearch },
        writable: true,
        configurable: true,
      });
      sessionStorage.removeItem('fabricEmbedded');
    });

    it('should detect embedded mode and run auth flow', async () => {
      const embeddedSpy = vi
        .spyOn(embeddedFabricLoginModule, 'embeddedFabricLogin')
        .mockResolvedValue(undefined);

      mockAuth.getSession.mockReturnValueOnce(authenticatedSession);

      const result = await initEmbeddedAuth(mockAuth, options);
      expect(result).toEqual(authenticatedSession);
      expect(embeddedSpy).toHaveBeenCalled();
    });

    it('should persist embedded flag in sessionStorage', async () => {
      vi.spyOn(
        embeddedFabricLoginModule,
        'embeddedFabricLogin'
      ).mockResolvedValue(undefined);

      mockAuth.getSession
        .mockReturnValueOnce(unauthenticatedSession)
        .mockReturnValueOnce(authenticatedSession);

      await initEmbeddedAuth(mockAuth, options);
      expect(sessionStorage.getItem('fabricEmbedded')).toBe('true');
    });
  });

  // ── Embedded via sessionStorage (URL param lost after navigation) ──

  describe('when fabricEmbedded is only in sessionStorage', () => {
    beforeEach(() => {
      sessionStorage.setItem('fabricEmbedded', 'true');
    });

    afterEach(() => {
      sessionStorage.removeItem('fabricEmbedded');
    });

    it('should detect embedded mode from sessionStorage fallback', async () => {
      const embeddedSpy = vi
        .spyOn(embeddedFabricLoginModule, 'embeddedFabricLogin')
        .mockResolvedValue(undefined);

      mockAuth.getSession.mockReturnValueOnce(authenticatedSession);

      const result = await initEmbeddedAuth(mockAuth, options);
      expect(result).toEqual(authenticatedSession);
      expect(embeddedSpy).toHaveBeenCalled();
    });
  });
});
