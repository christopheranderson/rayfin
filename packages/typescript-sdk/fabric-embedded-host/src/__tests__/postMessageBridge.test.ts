import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  sendBridgeRequest,
  subscribeBridgeEvents,
  BridgeError,
} from '../postMessageBridge';

describe('sendBridgeRequest', () => {
  let originalParent: typeof window.parent;
  let mockPostMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    originalParent = window.parent;

    mockPostMessage = vi.fn();

    // Simulate being inside an iframe (parent !== self)
    Object.defineProperty(window, 'parent', {
      value: { postMessage: mockPostMessage },
      writable: true,
      configurable: true,
    });

    // Stable UUID for deterministic request matching
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    );
  });

  afterEach(() => {
    Object.defineProperty(window, 'parent', {
      value: originalParent,
      writable: true,
      configurable: true,
    });
  });

  it('sends an envelope-shaped message to the target window', async () => {
    const promise = sendBridgeRequest<{ foo: string }, { bar: string }>({
      target: window.parent,
      channel: 'test-channel',
      kind: 'test.doSomething',
      payload: { foo: 'hello' },
    });

    // Simulate host response
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        data: {
          requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          kind: 'response',
          success: true,
          result: { bar: 'world' },
        },
      })
    );

    await promise;

    expect(mockPostMessage).toHaveBeenCalledOnce();
    const sentMessage = mockPostMessage.mock.calls[0][0];
    expect(sentMessage.channel).toBe('test-channel');
    expect(sentMessage.version).toBe(1);
    expect(sentMessage.kind).toBe('test.doSomething');
    expect(sentMessage.requestId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(sentMessage.payload).toEqual({ foo: 'hello' });
  });

  it('resolves with result on success response', async () => {
    const promise = sendBridgeRequest<unknown, { code: string }>({
      target: window.parent,
      channel: 'test',
      kind: 'test.request',
      payload: {},
    });

    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        data: {
          requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          kind: 'response',
          success: true,
          result: { code: 'abc-123' },
        },
      })
    );

    const result = await promise;
    expect(result).toEqual({ code: 'abc-123' });
  });

  it('rejects with BridgeError on error response', async () => {
    const promise = sendBridgeRequest({
      target: window.parent,
      channel: 'test',
      kind: 'test.request',
      payload: {},
    });

    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        data: {
          requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          kind: 'response',
          success: false,
          error: { code: 'PLUGIN_ERROR', message: 'Something went wrong' },
        },
      })
    );

    await expect(promise).rejects.toThrow('Something went wrong');
    await expect(promise).rejects.toBeInstanceOf(BridgeError);
  });

  it('rejects on timeout when no response arrives', async () => {
    const promise = sendBridgeRequest({
      target: window.parent,
      channel: 'test',
      kind: 'test.request',
      payload: {},
      timeoutMs: 50,
    });

    await expect(promise).rejects.toThrow('timed out');
  });

  it('ignores messages with non-matching requestId', async () => {
    const promise = sendBridgeRequest<unknown, { ok: boolean }>({
      target: window.parent,
      channel: 'test',
      kind: 'test.request',
      payload: {},
    });

    // Wrong requestId
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          requestId: 'wrong-id',
          kind: 'response',
          success: true,
          result: { ok: false },
        },
      })
    );

    // Correct requestId
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        data: {
          requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          kind: 'response',
          success: true,
          result: { ok: true },
        },
      })
    );

    const result = await promise;
    expect(result).toEqual({ ok: true });
  });

  it('ignores non-object messages', async () => {
    const promise = sendBridgeRequest<unknown, { ok: boolean }>({
      target: window.parent,
      channel: 'test',
      kind: 'test.request',
      payload: {},
    });

    window.dispatchEvent(
      new MessageEvent('message', { data: 'just a string' })
    );
    window.dispatchEvent(new MessageEvent('message', { data: null }));

    // Real response
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        data: {
          requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          kind: 'response',
          success: true,
          result: { ok: true },
        },
      })
    );

    const result = await promise;
    expect(result).toEqual({ ok: true });
  });

  it('removes listener after receiving response', async () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const promise = sendBridgeRequest({
      target: window.parent,
      channel: 'test',
      kind: 'test.request',
      payload: {},
    });

    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        data: {
          requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          kind: 'response',
          success: true,
          result: {},
        },
      })
    );

    await promise;
    expect(removeSpy).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('rejects when target is the window itself (not in iframe)', async () => {
    Object.defineProperty(window, 'parent', {
      value: window,
      writable: true,
      configurable: true,
    });

    await expect(
      sendBridgeRequest({
        target: window.parent,
        channel: 'test',
        kind: 'test.request',
        payload: {},
      })
    ).rejects.toThrow('No host window');
  });

  it('uses specified targetOrigin', async () => {
    const promise = sendBridgeRequest({
      target: window.parent,
      channel: 'test',
      kind: 'test.request',
      payload: {},
      targetOrigin: 'https://fabric.microsoft.com',
    });

    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'https://fabric.microsoft.com',
        data: {
          requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          kind: 'response',
          success: true,
          result: {},
        },
      })
    );

    await promise;

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.any(Object),
      'https://fabric.microsoft.com'
    );
  });

  it('ignores responses from wrong origin when targetOrigin is specified', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const promise = sendBridgeRequest<unknown, { ok: boolean }>({
      target: window.parent,
      channel: 'test',
      kind: 'test.request',
      payload: {},
      targetOrigin: 'https://fabric.microsoft.com',
      timeoutMs: 200,
    });

    // Response from wrong origin — should be ignored
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'https://evil.example.com',
        data: {
          requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          kind: 'response',
          success: true,
          result: { ok: false },
        },
      })
    );

    // Response from correct origin — should be accepted
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'https://fabric.microsoft.com',
        data: {
          requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          kind: 'response',
          success: true,
          result: { ok: true },
        },
      })
    );

    const result = await promise;
    expect(result).toEqual({ ok: true });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('evil.example.com')
    );
  });

  it('accepts responses from any origin when targetOrigin is wildcard', async () => {
    const promise = sendBridgeRequest<unknown, { ok: boolean }>({
      target: window.parent,
      channel: 'test',
      kind: 'test.request',
      payload: {},
      // targetOrigin defaults to '*'
    });

    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'https://any-origin.example.com',
        data: {
          requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          kind: 'response',
          success: true,
          result: { ok: true },
        },
      })
    );

    const result = await promise;
    expect(result).toEqual({ ok: true });
  });

  it('ignores responses from wrong source window', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const promise = sendBridgeRequest<unknown, { ok: boolean }>({
      target: window.parent,
      channel: 'test',
      kind: 'test.request',
      payload: {},
      timeoutMs: 200,
    });

    // Response from a different source — should be ignored
    const otherWindow = {} as Window;
    window.dispatchEvent(
      new MessageEvent('message', {
        source: otherWindow,
        data: {
          requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          kind: 'response',
          success: true,
          result: { ok: false },
        },
      })
    );

    // Response from correct source — should be accepted
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        data: {
          requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          kind: 'response',
          success: true,
          result: { ok: true },
        },
      })
    );

    const result = await promise;
    expect(result).toEqual({ ok: true });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('event.source does not match target window')
    );
  });
});

describe('subscribeBridgeEvents', () => {
  let originalParent: typeof window.parent;
  let onEvent: ReturnType<typeof vi.fn>;

  interface DispatchInit {
    source?: Window;
    origin?: string;
  }

  function dispatch(data: unknown, init: DispatchInit = {}): void {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        ...init,
        data,
      })
    );
  }

  function validEvent(overrides: Record<string, unknown> = {}): unknown {
    return {
      channel: 'test-channel',
      version: 1,
      kind: 'test.changed',
      revision: 1,
      epoch: 0,
      payload: { value: 42 },
      ...overrides,
    };
  }

  function subscribe(origin?: string): () => void {
    return subscribeBridgeEvents<{ value: number }>({
      source: window.parent,
      channel: 'test-channel',
      kind: 'test.changed',
      ...(origin !== undefined ? { origin } : {}),
      onEvent,
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    originalParent = window.parent;
    onEvent = vi.fn();

    Object.defineProperty(window, 'parent', {
      value: { postMessage: vi.fn() },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'parent', {
      value: originalParent,
      writable: true,
      configurable: true,
    });
  });

  it('delivers payload, revision, and epoch', () => {
    subscribe();
    dispatch(validEvent({ revision: 7, epoch: 3 }));

    expect(onEvent).toHaveBeenCalledWith({ value: 42 }, 7, 3);
  });

  // A host that omitted epoch would read as a permanent generation 0, so the
  // first revision reset would silently suppress every event after it.
  it('ignores an event that omits epoch', () => {
    subscribe();
    const event = validEvent() as Record<string, unknown>;
    delete event.epoch;
    dispatch(event);

    expect(onEvent).not.toHaveBeenCalled();
  });

  // A non-finite epoch never compares equal to itself, so a subscriber
  // would reset its high-water mark on every event and lose replay
  // protection entirely. Reject the envelope instead.
  it.each([
    ['NaN', Number.NaN],
    ['a string', 'one'],
    ['null', null],
  ])('ignores an event whose epoch is %s', (_label, epoch) => {
    subscribe();
    dispatch(validEvent({ revision: 2, epoch }));

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('ignores events from another window', () => {
    subscribe();
    dispatch(validEvent(), { source: {} as Window });

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('ignores events from an unexpected origin', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    subscribe('https://app.fabric.microsoft.com');

    dispatch(validEvent(), { origin: 'https://evil.example.com' });
    expect(onEvent).not.toHaveBeenCalled();

    dispatch(validEvent(), { origin: 'https://app.fabric.microsoft.com' });
    expect(onEvent).toHaveBeenCalledOnce();
  });

  it.each([
    ['a response envelope', { requestId: 'r1', kind: 'response' }],
    ['another channel', { channel: 'other-channel' }],
    ['another kind', { kind: 'test.other' }],
    ['a future protocol version', { version: 2 }],
    ['a non-numeric revision', { revision: 'first' }],
  ])('ignores %s', (_label, overrides) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    subscribe();
    dispatch(validEvent(overrides));

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('ignores malformed data', () => {
    subscribe();
    dispatch(null);
    dispatch('a string');
    dispatch(undefined);

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe', () => {
    const unsubscribe = subscribe();
    unsubscribe();
    dispatch(validEvent());

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('survives a throwing listener', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    onEvent.mockImplementation(() => {
      throw new Error('listener blew up');
    });

    subscribe();
    expect(() => dispatch(validEvent())).not.toThrow();
  });
});
