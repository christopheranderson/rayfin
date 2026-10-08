import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initiateFabricLogin } from '../initiateFabricLogin';

// ---- module-level mock ----
// vi.restoreAllMocks() would reset these vi.fn() implementations,
// so we re-apply them in a top-level beforeEach to keep them stable.
vi.mock('@microsoft/rayfin-auth', () => ({
  generateCodeVerifier: vi.fn().mockReturnValue('mock-verifier-12345'),
  generateCodeChallenge: vi.fn().mockResolvedValue('mock-challenge-67890'),
  generateState: vi.fn().mockReturnValue('mock-state-abc'),
}));

// Re-import the mocked functions so we can re-apply implementations.
// eslint-disable-next-line import/order -- must come after vi.mock() call above
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
} from '@microsoft/rayfin-auth';

// ---- helpers ----
const FABRIC_ORIGIN = 'https://app.fabric.microsoft.com';

function validOptions() {
  return {
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    fabricPortalUrl: `${FABRIC_ORIGIN}/portal`,
    returnOrigin: 'https://myapp.com',
  };
}

function createMockAuth() {
  return {
    getAuthApi: vi.fn().mockReturnValue({
      exchangeVerificationCode: vi.fn().mockResolvedValue({
        accessToken: 'at',
        refreshToken: 'rt',
        expiresIn: 3600,
      }),
    }),
    createSessionFromTokenResponse: vi.fn(),
  } as any;
}

/**
 * Re-apply mock implementations that vi.restoreAllMocks() may have cleared.
 * Must be called in a top-level beforeEach so every test starts with stable mocks.
 */
function resetModuleMocks() {
  vi.mocked(generateCodeVerifier).mockReturnValue('mock-verifier-12345');
  vi.mocked(generateCodeChallenge).mockResolvedValue('mock-challenge-67890');
  vi.mocked(generateState).mockReturnValue('mock-state-abc');
}

// ---- top-level hooks ----
beforeEach(() => {
  resetModuleMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// Validation
// ===========================================================================
describe('initiateFabricLogin – validation', () => {
  it('should reject when workspaceId is missing', async () => {
    const opts = validOptions();
    opts.workspaceId = '';
    await expect(initiateFabricLogin(createMockAuth(), opts)).rejects.toThrow(
      'workspaceId is required'
    );
  });

  it('should reject when projectId is missing', async () => {
    const opts = validOptions();
    opts.projectId = '';
    await expect(initiateFabricLogin(createMockAuth(), opts)).rejects.toThrow(
      'projectId is required'
    );
  });

  it('should reject when returnOrigin is missing', async () => {
    const opts = validOptions();
    opts.returnOrigin = '';
    await expect(initiateFabricLogin(createMockAuth(), opts)).rejects.toThrow(
      'returnOrigin is required'
    );
  });

  it('should reject when fabricPortalUrl is missing', async () => {
    const opts = validOptions();
    opts.fabricPortalUrl = '';
    await expect(initiateFabricLogin(createMockAuth(), opts)).rejects.toThrow(
      'fabricPortalUrl is required'
    );
  });

  it('should reject when tab is blocked', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const auth = createMockAuth();
    await expect(initiateFabricLogin(auth, validOptions())).rejects.toThrow(
      'Failed to open Fabric sign-in page'
    );
  });
});

// ===========================================================================
// Message handling – successful handoff
// ===========================================================================
describe('initiateFabricLogin – message handling', () => {
  let openSpy: any;
  let closeFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    closeFn = vi.fn();
    openSpy = vi.spyOn(window, 'open').mockReturnValue({
      close: closeFn,
      closed: false,
    } as any);
  });

  it('should resolve on valid brokeredAuth.handoff', async () => {
    const auth = createMockAuth();
    const promise = initiateFabricLogin(auth, validOptions());

    // Yield so the async preamble (generateCodeChallenge) settles
    await new Promise((r) => setTimeout(r, 10));

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: FABRIC_ORIGIN,
        data: {
          type: 'brokeredAuth.handoff',
          state: 'mock-state-abc',
          handoffCode: 'hcode-1',
        },
      })
    );

    await expect(promise).resolves.toBeUndefined();
    expect(auth.getAuthApi().exchangeVerificationCode).toHaveBeenCalledWith({
      verificationCode: 'hcode-1',
      codeVerifier: 'mock-verifier-12345',
      codeType: 'fabric_handoff',
      redirectUri: 'https://myapp.com',
    });
    expect(auth.createSessionFromTokenResponse).toHaveBeenCalled();
  });

  it('should close the Fabric tab after handoff', async () => {
    const auth = createMockAuth();
    const promise = initiateFabricLogin(auth, validOptions());
    await new Promise((r) => setTimeout(r, 10));

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: FABRIC_ORIGIN,
        data: {
          type: 'brokeredAuth.handoff',
          state: 'mock-state-abc',
          handoffCode: 'hcode-2',
        },
      })
    );

    await promise;
    expect(closeFn).toHaveBeenCalled();
  });

  it('should reject on brokeredAuth.error', async () => {
    const auth = createMockAuth();
    const promise = initiateFabricLogin(auth, validOptions());
    await new Promise((r) => setTimeout(r, 10));

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: FABRIC_ORIGIN,
        data: {
          type: 'brokeredAuth.error',
          state: 'mock-state-abc',
          error: 'CONSENT_DENIED',
          errorDescription: 'User denied consent',
        },
      })
    );

    await expect(promise).rejects.toThrow('User denied consent');
  });

  it('should reject when token exchange fails', async () => {
    const auth = createMockAuth();
    auth
      .getAuthApi()
      .exchangeVerificationCode.mockRejectedValueOnce(
        new Error('exchange failed')
      );

    const promise = initiateFabricLogin(auth, validOptions());
    await new Promise((r) => setTimeout(r, 10));

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: FABRIC_ORIGIN,
        data: {
          type: 'brokeredAuth.handoff',
          state: 'mock-state-abc',
          handoffCode: 'hcode-bad',
        },
      })
    );

    await expect(promise).rejects.toThrow('exchange failed');
  });

  it('should open the broker URL in a popup window', async () => {
    const auth = createMockAuth();
    const promise = initiateFabricLogin(auth, validOptions());
    await new Promise((r) => setTimeout(r, 10));

    expect(openSpy).toHaveBeenCalledWith(
      expect.stringContaining('app.fabric.microsoft.com'),
      'fabricAuth',
      expect.stringContaining('popup=yes')
    );

    // Resolve cleanly
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: FABRIC_ORIGIN,
        data: {
          type: 'brokeredAuth.handoff',
          state: 'mock-state-abc',
          handoffCode: 'hcode-url',
        },
      })
    );
    await promise;
  });

  it('should open broker URL with SecureItemEmbed params and extensionPath', async () => {
    const auth = createMockAuth();
    const promise = initiateFabricLogin(auth, validOptions());
    await new Promise((r) => setTimeout(r, 10));

    // The SIE URL is passed directly to window.open as the popup target.
    const openedUrl = openSpy.mock.calls[0]?.[0] as string;
    const parsed = new URL(openedUrl);
    expect(parsed.pathname).toBe('/portal/secureItemEmbed');
    expect(parsed.searchParams.get('itemType')).toBe('AppBackend');
    expect(parsed.searchParams.get('extensionPath')).toBe('/brokeredauth');
    // PKCE params are delivered via postMessage, not in the URL
    expect(parsed.searchParams.has('code_challenge')).toBe(false);
    expect(parsed.searchParams.has('state')).toBe(false);

    // Resolve cleanly
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: FABRIC_ORIGIN,
        data: {
          type: 'brokeredAuth.handoff',
          state: 'mock-state-abc',
          handoffCode: 'hcode-pkce',
        },
      })
    );
    await promise;
  });

  it('should resolve when handoff arrives via BroadcastChannel (backward compat)', async () => {
    const auth = createMockAuth();
    const promise = initiateFabricLogin(auth, validOptions());

    await new Promise((r) => setTimeout(r, 10));

    // Send via BroadcastChannel — simulates bridgeFabricCallback fallback path
    const { FABRIC_AUTH_CHANNEL } = await import('../bridgeFabricCallback');
    const sender = new BroadcastChannel(FABRIC_AUTH_CHANNEL);
    sender.postMessage({
      type: 'brokeredAuth.handoff',
      state: 'mock-state-abc',
      handoffCode: 'hcode-bc',
    });
    sender.close();

    await expect(promise).resolves.toBeUndefined();
    expect(auth.getAuthApi().exchangeVerificationCode).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationCode: 'hcode-bc',
        codeVerifier: 'mock-verifier-12345',
      })
    );
  });
});

// ===========================================================================
// Origin and state validation
// ===========================================================================
describe('initiateFabricLogin – origin and state validation', () => {
  let capturedHandler: ((event: MessageEvent) => void) | null;

  beforeEach(() => {
    vi.useFakeTimers();
    capturedHandler = null;
    vi.spyOn(window, 'addEventListener').mockImplementation(
      (type: string, handler: any) => {
        if (type === 'message') {
          capturedHandler = handler;
        }
      }
    );
    vi.spyOn(window, 'open').mockReturnValue({
      close: vi.fn(),
      closed: false,
    } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should log info and process messages from different origin (state + PKCE secure)', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const auth = createMockAuth();
    const promise = initiateFabricLogin(auth, validOptions());
    await vi.advanceTimersByTimeAsync(10);

    expect(capturedHandler).toBeTruthy();
    capturedHandler!(
      new MessageEvent('message', {
        origin: 'https://evil.com',
        data: {
          type: 'brokeredAuth.handoff',
          state: 'mock-state-abc',
          handoffCode: 'hcode-evil',
        },
      })
    );

    // Origin mismatch is advisory — message is processed because state matches
    await promise;
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('from origin=')
    );
  });

  it('should ignore messages with wrong state', async () => {
    const auth = createMockAuth();
    const promise = initiateFabricLogin(auth, validOptions());
    await vi.advanceTimersByTimeAsync(10);

    capturedHandler!(
      new MessageEvent('message', {
        origin: FABRIC_ORIGIN,
        data: {
          type: 'brokeredAuth.handoff',
          state: 'wrong-state',
          handoffCode: 'hcode-wrong',
        },
      })
    );

    vi.advanceTimersByTime(5 * 60 * 1000);
    await expect(promise).rejects.toThrow('timed out');
  });

  it('should ignore non-object payloads', async () => {
    const auth = createMockAuth();
    const promise = initiateFabricLogin(auth, validOptions());
    await vi.advanceTimersByTimeAsync(10);

    capturedHandler!(
      new MessageEvent('message', {
        origin: FABRIC_ORIGIN,
        data: 'not-an-object',
      })
    );

    vi.advanceTimersByTime(5 * 60 * 1000);
    await expect(promise).rejects.toThrow('timed out');
  });

  it('should reject after 5-minute timeout', async () => {
    const auth = createMockAuth();
    const promise = initiateFabricLogin(auth, validOptions());
    await vi.advanceTimersByTimeAsync(10);

    vi.advanceTimersByTime(5 * 60 * 1000);
    await expect(promise).rejects.toThrow('timed out');
  });
});

// ===========================================================================
// Ready signal handler (postMessage PKCE)
// ===========================================================================
describe('initiateFabricLogin – ready signal handler', () => {
  let closeFn: ReturnType<typeof vi.fn>;
  let mockPopup: {
    close: ReturnType<typeof vi.fn>;
    closed: boolean;
    postMessage: ReturnType<typeof vi.fn>;
  };
  let mockSource: { postMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    closeFn = vi.fn();
    mockPopup = {
      close: closeFn,
      closed: false,
      postMessage: vi.fn(),
    };
    mockSource = { postMessage: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(mockPopup as any);
  });

  /** Dispatch a brokeredAuth.ready with a mock event.source. */
  async function dispatchReady(
    source: object | null = mockSource,
    origin = 'http://localhost:4301'
  ) {
    const event = new MessageEvent('message', {
      origin,
      data: { type: 'brokeredAuth.ready' },
    });
    Object.defineProperty(event, 'source', { value: source, writable: false });
    window.dispatchEvent(event);
    // handleReady awaits the async code-challenge promise before posting the
    // challenge, so flush microtasks/timers before asserting on postMessage.
    await new Promise((r) => setTimeout(r, 0));
  }

  it('should send brokeredAuth.challenge to event.source on ready signal', async () => {
    const auth = createMockAuth();
    const promise = initiateFabricLogin(auth, validOptions());
    await new Promise((r) => setTimeout(r, 10));

    await dispatchReady();

    // Challenge goes to event.source (the extension iframe), NOT fabricWindow
    expect(mockSource.postMessage).toHaveBeenCalledWith(
      {
        type: 'brokeredAuth.challenge',
        returnOrigin: 'https://myapp.com',
        codeChallenge: 'mock-challenge-67890',
        codeChallengeMethod: 'S256',
        state: 'mock-state-abc',
      },
      'http://localhost:4301'
    );
    expect(mockPopup.postMessage).not.toHaveBeenCalled();

    // Resolve cleanly
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: FABRIC_ORIGIN,
        data: {
          type: 'brokeredAuth.handoff',
          state: 'mock-state-abc',
          handoffCode: 'hcode-ready',
        },
      })
    );
    await promise;
  });

  it('should fall back to fabricWindow when event.source is null', async () => {
    const auth = createMockAuth();
    const promise = initiateFabricLogin(auth, validOptions());
    await new Promise((r) => setTimeout(r, 10));

    await dispatchReady(null);

    expect(mockPopup.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'brokeredAuth.challenge' }),
      FABRIC_ORIGIN
    );
    expect(mockSource.postMessage).not.toHaveBeenCalled();

    // Resolve cleanly
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: FABRIC_ORIGIN,
        data: {
          type: 'brokeredAuth.handoff',
          state: 'mock-state-abc',
          handoffCode: 'hcode-fallback',
        },
      })
    );
    await promise;
  });

  it('should ignore subsequent ready signals after the first', async () => {
    const auth = createMockAuth();
    const promise = initiateFabricLogin(auth, validOptions());
    await new Promise((r) => setTimeout(r, 10));

    await dispatchReady();
    await dispatchReady();

    expect(mockSource.postMessage).toHaveBeenCalledTimes(1);

    // Resolve cleanly
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: FABRIC_ORIGIN,
        data: {
          type: 'brokeredAuth.handoff',
          state: 'mock-state-abc',
          handoffCode: 'hcode-dup',
        },
      })
    );
    await promise;
  });

  it('should clean up ready listener on handoff completion', async () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const auth = createMockAuth();
    const promise = initiateFabricLogin(auth, validOptions());
    await new Promise((r) => setTimeout(r, 10));

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: FABRIC_ORIGIN,
        data: {
          type: 'brokeredAuth.handoff',
          state: 'mock-state-abc',
          handoffCode: 'hcode-cleanup',
        },
      })
    );

    await promise;

    const removeCalls = removeSpy.mock.calls.filter(
      ([type]) => type === 'message'
    );
    expect(removeCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('should use wildcard targetOrigin when event.origin is empty', async () => {
    const auth = createMockAuth();
    const promise = initiateFabricLogin(auth, validOptions());
    await new Promise((r) => setTimeout(r, 10));

    await dispatchReady(mockSource, '');

    expect(mockSource.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'brokeredAuth.challenge' }),
      '*'
    );

    // Resolve cleanly
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: FABRIC_ORIGIN,
        data: {
          type: 'brokeredAuth.handoff',
          state: 'mock-state-abc',
          handoffCode: 'hcode-wildcard',
        },
      })
    );
    await promise;
  });

  it('should reject with PKCE_CHALLENGE_FAILED when the code challenge cannot be computed', async () => {
    vi.mocked(generateCodeChallenge).mockRejectedValueOnce(
      new Error('subtle.digest blew up')
    );
    const auth = createMockAuth();
    const promise = initiateFabricLogin(auth, validOptions());
    await new Promise((r) => setTimeout(r, 10));

    // Attach the rejection matcher before triggering the reject so the handler
    // is registered when handleReady settles (avoids an unhandled rejection).
    const assertion = expect(promise).rejects.toThrow(
      'Failed to prepare Fabric authentication'
    );
    await dispatchReady();
    await assertion;

    expect(mockSource.postMessage).not.toHaveBeenCalled();
  });

  it('should normalize event.origin "null" to a wildcard targetOrigin', async () => {
    const auth = createMockAuth();
    const promise = initiateFabricLogin(auth, validOptions());
    await new Promise((r) => setTimeout(r, 10));

    // Opaque/sandboxed senders report origin === 'null' (a truthy string that
    // is an invalid targetOrigin) — it must fall back to '*', not stay 'null'.
    await dispatchReady(mockSource, 'null');

    expect(mockSource.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'brokeredAuth.challenge' }),
      '*'
    );

    // Resolve cleanly
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: FABRIC_ORIGIN,
        data: {
          type: 'brokeredAuth.handoff',
          state: 'mock-state-abc',
          handoffCode: 'hcode-null-origin',
        },
      })
    );
    await promise;
  });

  it('should reject with CHALLENGE_DELIVERY_FAILED when posting the challenge throws', async () => {
    mockSource.postMessage.mockImplementation(() => {
      throw new SyntaxError("Invalid target origin 'null'");
    });
    const auth = createMockAuth();
    const promise = initiateFabricLogin(auth, validOptions());
    await new Promise((r) => setTimeout(r, 10));

    const assertion = expect(promise).rejects.toThrow(
      'Failed to deliver Fabric authentication challenge'
    );
    await dispatchReady();
    await assertion;
  });
});
