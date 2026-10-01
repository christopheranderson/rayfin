import { AuthError } from '@microsoft/rayfin-lib';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import * as embeddedFabricLoginModule from '../embeddedFabricLogin';
import { ensureSignedInWithFabric } from '../ensureSignedInWithFabric';
import * as classificationModule from '../externalEmbedClassification';
import {
  markEmbeddedHandoffCompleted,
  resetEmbeddedHandoffStateForTests,
} from '../fabricAuthHelpers';
import {
  clearFabricUserHint,
  persistFabricUserHintFromUrl,
} from '../fabricUserHint';
import * as initiateFabricLoginModule from '../initiateFabricLogin';
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

describe('ensureSignedInWithFabric', () => {
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

  it('should return existing session if already authenticated (step 1)', async () => {
    mockAuth.getSession.mockReturnValue(authenticatedSession);

    const result = await ensureSignedInWithFabric(mockAuth, options);
    expect(result).toEqual(authenticatedSession);
  });

  it('should refresh session when refresh token is available (step 2)', async () => {
    mockAuth.hasRefreshToken.mockReturnValue(true);
    mockAuth.refreshSession.mockResolvedValue(undefined);
    mockAuth.getSession
      .mockReturnValueOnce(unauthenticatedSession) // First call — not authenticated
      .mockReturnValueOnce(authenticatedSession); // After refresh

    const result = await ensureSignedInWithFabric(mockAuth, options);
    expect(result).toEqual(authenticatedSession);
    expect(mockAuth.refreshSession).toHaveBeenCalled();
  });

  it('should continue to step 3 when refresh fails', async () => {
    mockAuth.hasRefreshToken.mockReturnValue(true);
    mockAuth.refreshSession.mockRejectedValue(new Error('Refresh failed'));

    vi.spyOn(
      initiateFabricLoginModule,
      'initiateFabricLogin'
    ).mockResolvedValue(undefined);

    // After initiate completes, session should be available
    mockAuth.getSession
      .mockReturnValueOnce(unauthenticatedSession) // Step 1 check
      .mockReturnValueOnce(authenticatedSession); // After step 3 (refresh failure skips the inner getSession)

    const result = await ensureSignedInWithFabric(mockAuth, options);
    expect(result).toEqual(authenticatedSession);
    expect(initiateFabricLoginModule.initiateFabricLogin).toHaveBeenCalledWith(
      mockAuth,
      options
    );
  });

  it('should fall through to initiateFabricLogin when no other path available (step 3)', async () => {
    vi.spyOn(
      initiateFabricLoginModule,
      'initiateFabricLogin'
    ).mockResolvedValue(undefined);

    // After initiate completes, session should be available
    mockAuth.getSession
      .mockReturnValueOnce(unauthenticatedSession) // Step 1 check
      .mockReturnValueOnce(authenticatedSession); // After step 3

    const result = await ensureSignedInWithFabric(mockAuth, options);
    expect(result).toEqual(authenticatedSession);
    expect(initiateFabricLoginModule.initiateFabricLogin).toHaveBeenCalledWith(
      mockAuth,
      options
    );
  });

  it('should throw when no session established after step 3', async () => {
    vi.spyOn(
      initiateFabricLoginModule,
      'initiateFabricLogin'
    ).mockResolvedValue(undefined);

    mockAuth.getSession.mockReturnValue(unauthenticatedSession);

    await expect(ensureSignedInWithFabric(mockAuth, options)).rejects.toThrow(
      'no session was established'
    );
  });

  // ── Embedded branch (step 3) ─────────────────────────────

  describe('embedded mode', () => {
    let originalSearch: string;

    beforeEach(() => {
      originalSearch = window.location.search;
    });

    afterEach(() => {
      // Restore window.location.search
      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: originalSearch },
        writable: true,
        configurable: true,
      });
      sessionStorage.removeItem('fabricEmbedded');
    });

    it('should use embedded auth when fabricEmbedded option is true', async () => {
      const embeddedSpy = vi
        .spyOn(embeddedFabricLoginModule, 'embeddedFabricLogin')
        .mockResolvedValue(undefined);

      const embeddedOptions = { ...options, fabricEmbedded: true as const };

      // Legacy host (no hint): resume is skipped, so the first getSession is the post-handoff one.
      mockAuth.getSession.mockReturnValueOnce(authenticatedSession);

      const result = await ensureSignedInWithFabric(mockAuth, embeddedOptions);
      expect(result).toEqual(authenticatedSession);
      expect(embeddedSpy).toHaveBeenCalledWith(mockAuth, embeddedOptions);
    });

    it('uses embedded auth from the externalEmbed handshake alone, without fabricEmbedded', async () => {
      // No fabricEmbedded option, no URL param, no sessionStorage flag — the
      // externalEmbed scenario is established purely by the classification ack.
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
      // still broker a fresh handoff rather than returning the stale session.
      mockAuth.getSession.mockReturnValue(authenticatedSession);

      const result = await ensureSignedInWithFabric(mockAuth, options);

      expect(embeddedSpy).toHaveBeenCalledWith(mockAuth, options);
      expect(result).toEqual(authenticatedSession);
    });

    it('should use embedded auth when fabricEmbedded=true is in URL', async () => {
      // Simulate URL query param
      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: '?fabricEmbedded=true' },
        writable: true,
        configurable: true,
      });

      const embeddedSpy = vi
        .spyOn(embeddedFabricLoginModule, 'embeddedFabricLogin')
        .mockResolvedValue(undefined);

      mockAuth.getSession.mockReturnValueOnce(authenticatedSession);

      const result = await ensureSignedInWithFabric(mockAuth, options);
      expect(result).toEqual(authenticatedSession);
      expect(embeddedSpy).toHaveBeenCalledWith(mockAuth, options);
    });

    it('should use embedded auth when fabricEmbedded is in sessionStorage (URL param lost)', async () => {
      sessionStorage.setItem('fabricEmbedded', 'true');

      const embeddedSpy = vi
        .spyOn(embeddedFabricLoginModule, 'embeddedFabricLogin')
        .mockResolvedValue(undefined);

      mockAuth.getSession.mockReturnValueOnce(authenticatedSession);

      const result = await ensureSignedInWithFabric(mockAuth, options);
      expect(result).toEqual(authenticatedSession);
      expect(embeddedSpy).toHaveBeenCalledWith(mockAuth, options);
    });

    it('should fall back to popup when not in embedded mode', async () => {
      const embeddedSpy = vi.spyOn(
        embeddedFabricLoginModule,
        'embeddedFabricLogin'
      );
      const popupSpy = vi
        .spyOn(initiateFabricLoginModule, 'initiateFabricLogin')
        .mockResolvedValue(undefined);

      mockAuth.getSession
        .mockReturnValueOnce(unauthenticatedSession) // Step 1
        .mockReturnValueOnce(authenticatedSession); // After popup

      await ensureSignedInWithFabric(mockAuth, options);

      expect(embeddedSpy).not.toHaveBeenCalled();
      expect(popupSpy).toHaveBeenCalled();
    });

    it('should throw when embedded auth completes but no session', async () => {
      vi.spyOn(
        embeddedFabricLoginModule,
        'embeddedFabricLogin'
      ).mockResolvedValue(undefined);

      const embeddedOptions = { ...options, fabricEmbedded: true as const };
      mockAuth.getSession.mockReturnValue(unauthenticatedSession);

      await expect(
        ensureSignedInWithFabric(mockAuth, embeddedOptions)
      ).rejects.toThrow('no session was established');
    });

    it('should fall back to popup when embedded throws NO_PARENT_WINDOW', async () => {
      vi.spyOn(
        embeddedFabricLoginModule,
        'embeddedFabricLogin'
      ).mockRejectedValue(
        new AuthError(
          'No parent window — embedded auth requires an iframe host.',
          'NO_PARENT_WINDOW'
        )
      );

      const popupSpy = vi
        .spyOn(initiateFabricLoginModule, 'initiateFabricLogin')
        .mockResolvedValue(undefined);

      const embeddedOptions = { ...options, fabricEmbedded: true as const };

      mockAuth.getSession.mockReturnValueOnce(authenticatedSession); // After popup

      const result = await ensureSignedInWithFabric(mockAuth, embeddedOptions);
      expect(result).toEqual(authenticatedSession);
      expect(popupSpy).toHaveBeenCalledWith(mockAuth, embeddedOptions);
    });

    it('should rethrow non-NO_PARENT_WINDOW errors from embedded auth', async () => {
      vi.spyOn(
        embeddedFabricLoginModule,
        'embeddedFabricLogin'
      ).mockRejectedValue(
        new AuthError('Bridge request timed out', 'BRIDGE_TIMEOUT')
      );

      const embeddedOptions = { ...options, fabricEmbedded: true as const };
      mockAuth.getSession.mockReturnValue(unauthenticatedSession);

      await expect(
        ensureSignedInWithFabric(mockAuth, embeddedOptions)
      ).rejects.toThrow('Bridge request timed out');
    });

    it('should reuse an existing session on an embedded load when the host stamps a user hint', async () => {
      // The change this feature exists for: a returning user with a valid session no longer pays a
      // sign-out plus a full PKCE handoff on every embedded open.
      withUserHint();

      const embeddedSpy = vi.spyOn(
        embeddedFabricLoginModule,
        'embeddedFabricLogin'
      );

      const embeddedOptions = { ...options, fabricEmbedded: true as const };
      mockAuth.getSession.mockReturnValue(authenticatedSession);

      const result = await ensureSignedInWithFabric(mockAuth, embeddedOptions);

      expect(result).toEqual(authenticatedSession);
      expect(embeddedSpy).not.toHaveBeenCalled();
      expect(mockAuth.signOut).not.toHaveBeenCalled();
    });

    it('should NOT reuse an existing session on a legacy embedded host', async () => {
      // No `?_fu=` means nothing server-side compared identities, so the pre-feature behaviour holds.
      const embeddedSpy = vi
        .spyOn(embeddedFabricLoginModule, 'embeddedFabricLogin')
        .mockResolvedValue(undefined);
      const popupSpy = vi.spyOn(
        initiateFabricLoginModule,
        'initiateFabricLogin'
      );

      const embeddedOptions = { ...options, fabricEmbedded: true as const };
      mockAuth.getSession.mockReturnValue(authenticatedSession);

      const result = await ensureSignedInWithFabric(mockAuth, embeddedOptions);

      expect(embeddedSpy).toHaveBeenCalledWith(mockAuth, embeddedOptions);
      expect(popupSpy).not.toHaveBeenCalled();
      expect(result).toEqual(authenticatedSession);
    });

    it('should reuse the session on a legacy host after a handoff has run this page load', async () => {
      markEmbeddedHandoffCompleted();

      const embeddedSpy = vi.spyOn(
        embeddedFabricLoginModule,
        'embeddedFabricLogin'
      );

      const embeddedOptions = { ...options, fabricEmbedded: true as const };
      mockAuth.getSession.mockReturnValue(authenticatedSession);

      const result = await ensureSignedInWithFabric(mockAuth, embeddedOptions);

      expect(result).toEqual(authenticatedSession);
      expect(embeddedSpy).not.toHaveBeenCalled();
    });

    it('should not skip resume outside embedded mode even without a hint', async () => {
      mockAuth.getSession.mockReturnValue(authenticatedSession);

      const result = await ensureSignedInWithFabric(mockAuth, options);

      expect(result).toEqual(authenticatedSession);
    });
  });
});
