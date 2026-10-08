import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bridgeFabricCallback,
  FABRIC_AUTH_CHANNEL,
} from '../bridgeFabricCallback';

describe('bridgeFabricCallback', () => {
  let originalOpener: typeof window.opener;
  let originalLocation: typeof window.location;
  let originalHistory: typeof window.history;

  beforeEach(() => {
    originalOpener = window.opener;
    originalLocation = window.location;
    originalHistory = window.history;
  });

  afterEach(() => {
    Object.defineProperty(window, 'opener', {
      value: originalOpener,
      writable: true,
    });
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
    Object.defineProperty(window, 'history', {
      value: originalHistory,
      writable: true,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  function setOpener(postMessageFn: ReturnType<typeof vi.fn>) {
    Object.defineProperty(window, 'opener', {
      value: { postMessage: postMessageFn },
      writable: true,
    });
  }

  function setSearchParams(params: string) {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: params, hash: '' },
      writable: true,
    });
  }

  function setHashParams(hash: string) {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '', hash },
      writable: true,
    });
  }

  it('should fall back to BroadcastChannel when no opener (COOP severed) with handoff param', () => {
    Object.defineProperty(window, 'opener', {
      value: null,
      writable: true,
    });
    setSearchParams('?handoff=hcode&state=abc');
    vi.spyOn(window, 'close').mockImplementation(() => {});

    // Listen on BroadcastChannel to verify the bridge sends the message
    const received: any[] = [];
    const channel = new BroadcastChannel(FABRIC_AUTH_CHANNEL);
    channel.onmessage = (e: MessageEvent) => received.push(e.data);

    const result = bridgeFabricCallback();

    expect(result).toBe(true);
    channel.close();
  });

  it('should NOT match query-param verification_code without opener (magic link scenario)', () => {
    Object.defineProperty(window, 'opener', {
      value: null,
      writable: true,
    });
    setSearchParams('?verification_code=hcode&state=abc');

    const result = bridgeFabricCallback();

    expect(result).toBe(false);
  });

  it('should return false when no handoff params in URL', () => {
    setSearchParams('');

    expect(bridgeFabricCallback()).toBe(false);
  });

  it('should return false when state is missing', () => {
    setSearchParams('?verification_code=hcode');

    expect(bridgeFabricCallback()).toBe(false);
  });

  it('should return false when handoff code is missing', () => {
    setSearchParams('?state=abc');

    expect(bridgeFabricCallback()).toBe(false);
  });

  it('should bridge verification_code and state via postMessage', () => {
    const postMessageFn = vi.fn();
    setOpener(postMessageFn);
    setSearchParams('?verification_code=hcode-1&state=state-1');
    vi.spyOn(window, 'close').mockImplementation(() => {});

    const result = bridgeFabricCallback();

    expect(result).toBe(true);
    expect(postMessageFn).toHaveBeenCalledWith(
      {
        type: 'brokeredAuth.handoff',
        state: 'state-1',
        handoffCode: 'hcode-1',
      },
      window.location.origin
    );
  });

  it('should bridge code param as fallback', () => {
    const postMessageFn = vi.fn();
    setOpener(postMessageFn);
    setSearchParams('?code=hcode-2&state=state-2');
    vi.spyOn(window, 'close').mockImplementation(() => {});

    const result = bridgeFabricCallback();

    expect(result).toBe(true);
    expect(postMessageFn).toHaveBeenCalledWith(
      {
        type: 'brokeredAuth.handoff',
        state: 'state-2',
        handoffCode: 'hcode-2',
      },
      window.location.origin
    );
  });

  it('should prefer verification_code over code', () => {
    const postMessageFn = vi.fn();
    setOpener(postMessageFn);
    setSearchParams('?verification_code=preferred&code=fallback&state=s');
    vi.spyOn(window, 'close').mockImplementation(() => {});

    bridgeFabricCallback();

    expect(postMessageFn).toHaveBeenCalledWith(
      expect.objectContaining({ handoffCode: 'preferred' }),
      window.location.origin
    );
  });

  it('should close the popup after sending the bridge message', () => {
    setOpener(vi.fn());
    setSearchParams('?verification_code=hcode&state=s');
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});

    bridgeFabricCallback();

    expect(closeSpy).toHaveBeenCalled();
  });

  // --- Hash fragment tests (old Fabric Portal redirect format) ---

  it('should bridge handoff param from hash fragment', () => {
    const postMessageFn = vi.fn();
    setOpener(postMessageFn);
    setHashParams('#handoff=hash-code-1&state=hash-state-1');
    vi.spyOn(window, 'close').mockImplementation(() => {});

    const result = bridgeFabricCallback();

    expect(result).toBe(true);
    expect(postMessageFn).toHaveBeenCalledWith(
      {
        type: 'brokeredAuth.handoff',
        state: 'hash-state-1',
        handoffCode: 'hash-code-1',
      },
      window.location.origin
    );
  });

  it('should bridge verification_code from hash fragment', () => {
    const postMessageFn = vi.fn();
    setOpener(postMessageFn);
    setHashParams('#verification_code=vc-hash&state=vs-hash');
    vi.spyOn(window, 'close').mockImplementation(() => {});

    const result = bridgeFabricCallback();

    expect(result).toBe(true);
    expect(postMessageFn).toHaveBeenCalledWith(
      expect.objectContaining({ handoffCode: 'vc-hash', state: 'vs-hash' }),
      window.location.origin
    );
  });

  it('should prefer query params over hash fragment', () => {
    const postMessageFn = vi.fn();
    setOpener(postMessageFn);
    // Set both query and hash — query should win
    Object.defineProperty(window, 'location', {
      value: {
        ...window.location,
        search: '?verification_code=from-query&state=qs',
        hash: '#handoff=from-hash&state=hs',
      },
      writable: true,
    });
    vi.spyOn(window, 'close').mockImplementation(() => {});

    bridgeFabricCallback();

    expect(postMessageFn).toHaveBeenCalledWith(
      expect.objectContaining({ handoffCode: 'from-query', state: 'qs' }),
      window.location.origin
    );
  });

  it('should return false when hash has no handoff params', () => {
    setHashParams('#other=value');

    expect(bridgeFabricCallback()).toBe(false);
  });

  it('should NOT match query-param code without opener (magic link scenario)', () => {
    Object.defineProperty(window, 'opener', {
      value: null,
      writable: true,
    });
    setSearchParams('?code=some-code&state=some-state');

    const result = bridgeFabricCallback();

    expect(result).toBe(false);
  });

  it('should still match hash-fragment verification_code without opener', () => {
    Object.defineProperty(window, 'opener', {
      value: null,
      writable: true,
    });
    setHashParams('#verification_code=vc-hash&state=vs-hash');
    vi.spyOn(window, 'close').mockImplementation(() => {});

    const received: any[] = [];
    const channel = new BroadcastChannel(FABRIC_AUTH_CHANNEL);
    channel.onmessage = (e: MessageEvent) => received.push(e.data);

    const result = bridgeFabricCallback();

    expect(result).toBe(true);
    channel.close();
  });
});
