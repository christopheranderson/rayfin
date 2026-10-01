import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { FabricAppStateError } from '../errors';
import { createFabricAppStateClient } from '../fabricAppState';
import { LAUNCH_STATE_PARAM, readLaunchStateFromUrl } from '../launchState';
import { FABRIC_APP_STATE_CHANNEL } from '../protocol';
import type { FabricAppState } from '../types';
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_ENCODED_BYTES,
  validateAppState,
} from '../validation';

/** Encode state the way the host is specified to seed it. */
function seed(state: unknown): string {
  const json = JSON.stringify(state);
  const bytes = new TextEncoder().encode(json);
  const binary = String.fromCharCode(...bytes);
  const b64 = btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `?${LAUNCH_STATE_PARAM}=v1.${b64}`;
}

/**
 * The bridge correlates replies by `requestId`, so tests must echo the
 * id captured from the outgoing message rather than inventing one.
 */
function respondTo(
  postMessage: ReturnType<typeof vi.fn>,
  source: Window,
  callIndex: number,
  body: Record<string, unknown>
): void {
  const sent = postMessage.mock.calls[callIndex][0] as {
    requestId: string;
    channel: string;
  };
  window.dispatchEvent(
    new MessageEvent('message', {
      source,
      data: {
        channel: sent.channel,
        version: 1,
        kind: 'response',
        requestId: sent.requestId,
        ...body,
      },
    })
  );
}

/**
 * Writes are queued behind a promise chain, so the outgoing
 * `postMessage` happens on a later microtask rather than synchronously.
 * Tests must yield before asserting on it.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function emitChanged(
  source: Window,
  revision: number,
  state: FabricAppState,
  overrides: Record<string, unknown> = {}
): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      source,
      data: {
        channel: FABRIC_APP_STATE_CHANNEL,
        version: 1,
        kind: 'appState.changed',
        eventId: `evt-${revision}`,
        revision,
        epoch: 0,
        payload: { state },
        ...overrides,
      },
    })
  );
}

describe('readLaunchStateFromUrl', () => {
  it('decodes seeded launch state', () => {
    const state = { view: 'sales-by-region', filter: 'AT' };
    expect(readLaunchStateFromUrl(seed(state))).toEqual(state);
  });

  it('round-trips Unicode', () => {
    const state = { city: 'Zürich', emoji: '📊' };
    expect(readLaunchStateFromUrl(seed(state))).toEqual(state);
  });

  it('returns undefined when the parameter is absent', () => {
    expect(readLaunchStateFromUrl('?other=1')).toBeUndefined();
  });

  it('returns undefined for an empty query string', () => {
    expect(readLaunchStateFromUrl('')).toBeUndefined();
  });

  // Tolerance is a rollback requirement: links shared while the feature
  // was on keep the parameter after it is turned off, and must still open.
  it('returns undefined for an unsupported version prefix', () => {
    expect(
      readLaunchStateFromUrl(`?${LAUNCH_STATE_PARAM}=v9.abc`)
    ).toBeUndefined();
  });

  it('returns undefined for truncated base64 rather than throwing', () => {
    const raw = seed({ a: 1 }).slice(0, -3);
    expect(() => readLaunchStateFromUrl(raw)).not.toThrow();
  });

  it('returns undefined for a non-object payload', () => {
    expect(readLaunchStateFromUrl(seed([1, 2, 3]))).toBeUndefined();
    expect(readLaunchStateFromUrl(seed('str'))).toBeUndefined();
    expect(readLaunchStateFromUrl(seed(null))).toBeUndefined();
  });
});

describe('validateAppState', () => {
  const max = DEFAULT_MAX_ENCODED_BYTES;
  const depth = DEFAULT_MAX_DEPTH;

  it('accepts plain nested JSON-compatible state', () => {
    const json = validateAppState(
      { view: 'sales', filters: ['AT', 'DE'], page: 2, live: true, x: null },
      max,
      depth
    );
    expect(JSON.parse(json)).toEqual({
      view: 'sales',
      filters: ['AT', 'DE'],
      page: 2,
      live: true,
      x: null,
    });
  });

  it('accepts an empty object, which clears state', () => {
    expect(validateAppState({}, max, depth)).toBe('{}');
  });

  // The host counts the version prefix inside its encoded budget, so the
  // largest state accepted here must still fit once encoded. Otherwise the
  // client waves through states the host rejects on the round trip, which
  // is exactly what the fast-fail check exists to prevent.
  it('leaves no gap between its budget and the host encoder', () => {
    const overhead = JSON.stringify({ k: '' }).length;
    let largestAccepted = '';

    for (let raw = max / 2; raw <= max; raw++) {
      try {
        largestAccepted = validateAppState(
          { k: 'a'.repeat(raw - overhead) },
          max,
          depth
        );
      } catch {
        break;
      }
    }

    expect(largestAccepted).not.toBe('');

    const rawBytes = new TextEncoder().encode(largestAccepted).length;
    // base64url is unpadded, so 3 raw bytes become 4 characters.
    const encodedLength = 'v1.'.length + Math.ceil((rawBytes * 4) / 3);

    expect(encodedLength).toBeLessThanOrEqual(max);
  });

  // `forEach` skips holes, so a sparse array used to pass the walk and then
  // reach the URL as null - the silent mutation the walk exists to prevent.
  it('rejects a sparse array rather than letting JSON fill the hole', () => {
    const items = new Array(3);
    items[0] = 1;
    items[2] = 3;

    expect(() => validateAppState({ items }, max, depth)).toThrow(
      FabricAppStateError
    );
  });

  it('preserves Unicode and reserved URL characters', () => {
    const json = validateAppState({ q: 'a&b=c?d#e ü 😀' }, max, depth);
    expect(JSON.parse(json).q).toBe('a&b=c?d#e ü 😀');
  });

  it.each([
    ['undefined', { a: undefined }],
    ['a function', { a: () => 1 }],
    ['a symbol', { a: Symbol('x') }],
    ['NaN', { a: NaN }],
    ['Infinity', { a: Infinity }],
  ])('rejects %s with INVALID_STATE', (_label: string, state: unknown) => {
    expect(() =>
      validateAppState(state as unknown as FabricAppState, max, depth)
    ).toThrow(FabricAppStateError);
    try {
      validateAppState(state as unknown as FabricAppState, max, depth);
    } catch (err) {
      expect((err as FabricAppStateError).code).toBe('INVALID_STATE');
    }
  });

  it('rejects non-plain objects such as Date and Map', () => {
    expect(() =>
      validateAppState(
        { d: new Date() } as unknown as FabricAppState,
        max,
        depth
      )
    ).toThrow(/plain object or array/);
    expect(() =>
      validateAppState(
        { m: new Map() } as unknown as FabricAppState,
        max,
        depth
      )
    ).toThrow(/plain object or array/);
  });

  it('rejects a circular reference instead of hanging', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    expect(() =>
      validateAppState(cyclic as FabricAppState, max, depth)
    ).toThrow(/circular reference/);
  });

  it('allows the same object twice as siblings', () => {
    const shared = { id: 1 };
    expect(() =>
      validateAppState({ a: shared, b: shared } as FabricAppState, max, depth)
    ).not.toThrow();
  });

  it('rejects nesting beyond the depth limit', () => {
    let node: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 25; i++) node = { child: node };
    try {
      validateAppState(node as FabricAppState, max, depth);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as FabricAppStateError).code).toBe('STATE_TOO_DEEP');
    }
  });

  it('rejects oversized state with STATE_TOO_LARGE', () => {
    const big = { blob: 'x'.repeat(DEFAULT_MAX_ENCODED_BYTES) };
    try {
      validateAppState(big, max, depth);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as FabricAppStateError).code).toBe('STATE_TOO_LARGE');
      // The error must not embed the state value itself.
      expect((err as Error).message).not.toContain('xxxxx');
    }
  });

  it('rejects a non-object root', () => {
    expect(() =>
      validateAppState([] as unknown as FabricAppState, max, depth)
    ).toThrow(/plain object/);
  });
});

describe('createFabricAppStateClient', () => {
  let postMessage: ReturnType<typeof vi.fn>;
  let host: Window;
  let originalParent: typeof window.parent;

  beforeEach(() => {
    vi.restoreAllMocks();
    originalParent = window.parent;
    postMessage = vi.fn();
    host = { postMessage } as unknown as Window;
    Object.defineProperty(window, 'parent', {
      value: host,
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

  it('falls back to a bridge request when the URL is not seeded', async () => {
    const client = createFabricAppStateClient({ launchSearch: '' });
    const promise = client.getLaunchState();

    const sent = postMessage.mock.calls[0][0];
    expect(sent.channel).toBe(FABRIC_APP_STATE_CHANNEL);
    expect(sent.kind).toBe('appState.getLaunchState');
    expect(sent.version).toBe(1);

    respondTo(postMessage, host, 0, {
      success: true,
      result: { state: { view: 'sales' }, revision: 3 },
    });

    await expect(promise).resolves.toEqual({ view: 'sales' });
    client.dispose();
  });

  // Issue 60 requires launch state before first render, so a seeded URL
  // must resolve without any bridge traffic at all.
  it('resolves seeded launch state without a round trip', async () => {
    const state = { view: 'sales-by-region', filter: 'AT' };
    const client = createFabricAppStateClient({ launchSearch: seed(state) });

    await expect(client.getLaunchState()).resolves.toEqual(state);
    expect(postMessage).not.toHaveBeenCalled();
    client.dispose();
  });

  it('exposes seeded launch state synchronously', () => {
    const state = { view: 'sales', period: '2026-Q2' };
    const client = createFabricAppStateClient({ launchSearch: seed(state) });

    expect(client.getLaunchStateSync()).toEqual(state);
    expect(postMessage).not.toHaveBeenCalled();
    client.dispose();
  });

  it('getLaunchStateSync returns undefined when the URL is not seeded', () => {
    const client = createFabricAppStateClient({ launchSearch: '' });
    expect(client.getLaunchStateSync()).toBeUndefined();
    client.dispose();
  });

  it('returns undefined when the URL carries no state', async () => {
    const client = createFabricAppStateClient({ launchSearch: '' });
    const promise = client.getLaunchState();
    respondTo(postMessage, host, 0, { success: true, result: {} });
    await expect(promise).resolves.toBeUndefined();
    client.dispose();
  });

  it('degrades to undefined launch state on a host without support', async () => {
    const client = createFabricAppStateClient({ launchSearch: '' });
    const promise = client.getLaunchState();
    respondTo(postMessage, host, 0, {
      success: false,
      error: { code: 'UNKNOWN_CHANNEL', message: 'No plugin' },
    });

    // Starting up must not require a try/catch. isSupported() is the
    // explicit way to detect a host that predates the feature.
    await expect(promise).resolves.toBeUndefined();
    client.dispose();
  });

  it('maps UNKNOWN_CHANNEL to UNSUPPORTED_HOST_CAPABILITY on write', async () => {
    const client = createFabricAppStateClient({ launchSearch: '' });
    const promise = client.setState({ a: 1 });
    await tick();
    respondTo(postMessage, host, 0, {
      success: false,
      error: { code: 'UNKNOWN_CHANNEL', message: 'No plugin' },
    });

    await expect(promise).rejects.toMatchObject({
      code: 'UNSUPPORTED_HOST_CAPABILITY',
    });
    client.dispose();
  });

  it('sends push for setState and replace for replaceState', async () => {
    const client = createFabricAppStateClient();

    const p1 = client.setState({ a: 1 });
    await tick();
    respondTo(postMessage, host, 0, {
      success: true,
      result: { revision: 1 },
    });
    await p1;

    const p2 = client.replaceState({ a: 2 });
    await tick();
    respondTo(postMessage, host, 1, {
      success: true,
      result: { revision: 2 },
    });
    await p2;

    expect(postMessage.mock.calls[0][0].kind).toBe('appState.push');
    expect(postMessage.mock.calls[0][0].payload).toEqual({ state: { a: 1 } });
    expect(postMessage.mock.calls[1][0].kind).toBe('appState.replace');
    client.dispose();
  });

  it('rejects invalid state before contacting the host', async () => {
    const client = createFabricAppStateClient();
    await expect(
      client.setState({ bad: undefined } as unknown as FabricAppState)
    ).rejects.toBeInstanceOf(FabricAppStateError);
    expect(postMessage).not.toHaveBeenCalled();
    client.dispose();
  });

  it('serialises concurrent writes so they reach the host in call order', async () => {
    const client = createFabricAppStateClient();

    const first = client.setState({ step: 1 });
    const second = client.setState({ step: 2 });
    await tick();

    // Only the first write may be in flight.
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].payload).toEqual({
      state: { step: 1 },
    });

    respondTo(postMessage, host, 0, { success: true, result: { revision: 1 } });
    await first;
    await tick();

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[1][0].payload).toEqual({
      state: { step: 2 },
    });

    respondTo(postMessage, host, 1, { success: true, result: { revision: 2 } });
    await second;
    client.dispose();
  });

  it('does not let a failed write poison later writes', async () => {
    const client = createFabricAppStateClient();

    const failing = client.setState({ step: 1 });
    const following = client.setState({ step: 2 });
    await tick();

    respondTo(postMessage, host, 0, {
      success: false,
      error: { code: 'NAVIGATION_FAILED', message: 'nope' },
    });
    await expect(failing).rejects.toMatchObject({ code: 'NAVIGATION_FAILED' });
    await tick();

    respondTo(postMessage, host, 1, { success: true, result: { revision: 5 } });
    await expect(following).resolves.toBeUndefined();
    client.dispose();
  });

  it('notifies listeners of host-published changes', () => {
    const client = createFabricAppStateClient();
    const listener = vi.fn();
    client.onStateChange(listener);

    emitChanged(host, 10, { view: 'restored' });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ view: 'restored' });
    client.dispose();
  });

  it('discards out-of-order and duplicate revisions', () => {
    const client = createFabricAppStateClient();
    const listener = vi.fn();
    client.onStateChange(listener);

    emitChanged(host, 5, { n: 5 });
    emitChanged(host, 4, { n: 4 });
    emitChanged(host, 5, { n: 5 });
    emitChanged(host, 6, { n: 6 });

    expect(listener.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      { n: 5 },
      { n: 6 },
    ]);
    client.dispose();
  });

  it('ignores events from a different window, channel, kind, or version', () => {
    const client = createFabricAppStateClient();
    const listener = vi.fn();
    client.onStateChange(listener);

    const impostor = { postMessage: vi.fn() } as unknown as Window;
    emitChanged(impostor, 1, { n: 1 });
    emitChanged(host, 2, { n: 2 }, { channel: 'fabric-auth' });
    emitChanged(host, 3, { n: 3 }, { kind: 'appState.other' });
    emitChanged(host, 4, { n: 4 }, { version: 2 });
    emitChanged(host, 5, { n: 5 }, { eventId: 42 });

    expect(listener).not.toHaveBeenCalled();
    client.dispose();
  });

  it('accepts an event that omits the optional eventId', () => {
    const client = createFabricAppStateClient();
    const listener = vi.fn();
    client.onStateChange(listener);

    // `revision` is the identity and ordering key; `eventId` exists only
    // for host-side log correlation, so a host may omit it entirely.
    emitChanged(host, 1, { n: 1 }, { eventId: undefined });

    expect(listener).toHaveBeenCalledWith({ n: 1 });
    client.dispose();
  });

  it('rejects events from an unexpected origin when targetOrigin is set', () => {
    const client = createFabricAppStateClient({
      targetOrigin: 'https://app.fabric.microsoft.com',
    });
    const listener = vi.fn();
    client.onStateChange(listener);

    window.dispatchEvent(
      new MessageEvent('message', {
        source: host,
        origin: 'https://evil.example.com',
        data: {
          channel: FABRIC_APP_STATE_CHANNEL,
          version: 1,
          kind: 'appState.changed',
          eventId: 'e1',
          revision: 1,
          payload: { state: { n: 1 } },
        },
      })
    );

    expect(listener).not.toHaveBeenCalled();
    client.dispose();
  });

  it('supports multiple subscribers and per-listener unsubscribe', () => {
    const client = createFabricAppStateClient();
    const a = vi.fn();
    const b = vi.fn();
    const offA = client.onStateChange(a);
    client.onStateChange(b);

    emitChanged(host, 1, { n: 1 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    offA();
    emitChanged(host, 2, { n: 2 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    client.dispose();
  });

  it('removes the window listener once the last subscriber leaves', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const client = createFabricAppStateClient();
    const off = client.onStateChange(vi.fn());
    off();
    expect(removeSpy).toHaveBeenCalledWith('message', expect.any(Function));

    const listener = vi.fn();
    client.onStateChange(listener);
    emitChanged(host, 1, { n: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it('keeps notifying other listeners when one throws', () => {
    const client = createFabricAppStateClient();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const good = vi.fn();
    client.onStateChange(() => {
      throw new Error('listener blew up');
    });
    client.onStateChange(good);

    emitChanged(host, 1, { n: 1 });

    // Regression: a throwing listener previously aborted the loop and
    // starved every listener registered after it.
    expect(good).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it('stops notifying after dispose', () => {
    const client = createFabricAppStateClient();
    const listener = vi.fn();
    client.onStateChange(listener);
    client.dispose();

    emitChanged(host, 99, { n: 99 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores a state event while a request is pending', async () => {
    const client = createFabricAppStateClient();
    const listener = vi.fn();
    client.onStateChange(listener);

    const promise = client.getLaunchState();
    // An event must never be mistaken for the reply to this request.
    emitChanged(host, 1, { n: 1 });
    expect(listener).toHaveBeenCalledTimes(1);

    respondTo(postMessage, host, 0, {
      success: true,
      result: { state: { n: 0 }, revision: 0 },
    });
    await expect(promise).resolves.toEqual({ n: 0 });
    client.dispose();
  });

  describe('epoch', () => {
    it('applies a lower revision after the epoch changes', () => {
      const client = createFabricAppStateClient();
      const listener = vi.fn();
      client.onStateChange(listener);

      emitChanged(host, 9, { n: 9 }, { epoch: 0 });
      // The host restarted its counter. Without epoch handling the
      // high-water mark would discard this and every later event.
      emitChanged(host, 1, { n: 1 }, { epoch: 1 });

      expect(listener.mock.calls).toEqual([[{ n: 9 }], [{ n: 1 }]]);
      client.dispose();
    });

    it('still discards stale revisions within one epoch', () => {
      const client = createFabricAppStateClient();
      const listener = vi.fn();
      client.onStateChange(listener);

      emitChanged(host, 5, { n: 5 }, { epoch: 2 });
      emitChanged(host, 4, { n: 4 }, { epoch: 2 });

      expect(listener.mock.calls).toEqual([[{ n: 5 }]]);
      client.dispose();
    });

    // Responses carry no epoch, so one still in flight when the host resets
    // its counter must not raise the new epoch's watermark - otherwise every
    // event after it is silently discarded.
    it('does not let an in-flight response raise the new epoch watermark', async () => {
      const client = createFabricAppStateClient();
      const listener = vi.fn();
      client.onStateChange(listener);

      const write = client.setState({ n: 1 });
      await tick();

      // The host restarted its counter while the write was in flight.
      emitChanged(host, 1, { n: 1 }, { epoch: 1 });
      expect(listener).toHaveBeenCalledTimes(1);

      respondTo(postMessage, host, 0, {
        success: true,
        result: { revision: 50 },
      });
      await write;

      emitChanged(host, 2, { n: 2 }, { epoch: 1 });
      expect(listener).toHaveBeenCalledTimes(2);

      client.dispose();
    });
  });

  describe('cleared state', () => {
    it('reports undefined when navigation reaches a stateless URL', () => {
      const client = createFabricAppStateClient();
      const listener = vi.fn();
      client.onStateChange(listener);

      window.dispatchEvent(
        new MessageEvent('message', {
          source: host,
          data: {
            channel: FABRIC_APP_STATE_CHANNEL,
            version: 1,
            kind: 'appState.changed',
            revision: 1,
            epoch: 0,
            payload: {},
          },
        })
      );

      // Distinguishable from `{}`, so the app knows to restore defaults.
      expect(listener).toHaveBeenCalledWith(undefined);
      client.dispose();
    });
  });

  describe('isSupported', () => {
    it('reports host capabilities and caches the result', async () => {
      const client = createFabricAppStateClient({ launchSearch: '' });

      const promise = client.isSupported();
      await tick();
      respondTo(postMessage, host, 0, {
        success: true,
        result: {
          version: 1,
          maxEncodedBytes: 2048,
          maxDepth: 10,
          canPush: true,
        },
      });

      await expect(promise).resolves.toEqual({
        version: 1,
        maxEncodedBytes: 2048,
        maxDepth: 10,
        canPush: true,
      });

      await client.isSupported();
      expect(postMessage).toHaveBeenCalledTimes(1);
      client.dispose();
    });

    it('reports a replace-only host', async () => {
      const client = createFabricAppStateClient({ launchSearch: '' });

      const promise = client.isSupported();
      await tick();
      respondTo(postMessage, host, 0, {
        success: true,
        result: { version: 1, canPush: false },
      });

      await expect(promise).resolves.toMatchObject({ canPush: false });
      client.dispose();
    });

    it('retries before concluding the host is unsupported', async () => {
      const client = createFabricAppStateClient({ launchSearch: '' });
      const promise = client.isSupported();

      // An unregistered channel may just mean the host has not mounted
      // yet, so a startup race must not be reported as downlevel.
      for (let attempt = 0; attempt < 3; attempt++) {
        await vi.waitFor(() =>
          expect(postMessage).toHaveBeenCalledTimes(attempt + 1)
        );
        respondTo(postMessage, host, attempt, {
          success: false,
          error: { code: 'UNKNOWN_CHANNEL', message: 'No plugin' },
        });
      }

      await expect(promise).resolves.toBeUndefined();
      expect(postMessage).toHaveBeenCalledTimes(3);
      client.dispose();
    });

    // A host that has not mounted its listener yet does not answer at all.
    // Caching that silence would hide the feature for the whole session,
    // even once the host is ready.
    it('re-probes after a timeout instead of caching the miss', async () => {
      const client = createFabricAppStateClient({
        launchSearch: '',
        timeoutMs: 5,
      });

      await expect(client.isSupported()).resolves.toBeUndefined();
      const callsWhileSilent = postMessage.mock.calls.length;

      const retry = client.isSupported();
      await vi.waitFor(() =>
        expect(postMessage.mock.calls.length).toBeGreaterThan(callsWhileSilent)
      );
      respondTo(postMessage, host, callsWhileSilent, {
        success: true,
        result: { version: 1, canPush: true },
      });

      await expect(retry).resolves.toMatchObject({ canPush: true });
      client.dispose();
    });

    // The SDK ships before the host, so a host may implement push and
    // replace without yet knowing this kind. It answered, so the channel
    // exists and the feature must not be reported as unavailable.
    it('falls back to client defaults when the host rejects the kind', async () => {
      const client = createFabricAppStateClient({ launchSearch: '' });
      const promise = client.isSupported();
      await tick();
      respondTo(postMessage, host, 0, {
        success: false,
        error: { code: 'UNKNOWN_OPERATION', message: 'Unsupported kind' },
      });

      await expect(promise).resolves.toEqual({
        version: 1,
        maxEncodedBytes: DEFAULT_MAX_ENCODED_BYTES,
        maxDepth: DEFAULT_MAX_DEPTH,
        canPush: true,
      });
      expect(postMessage).toHaveBeenCalledTimes(1);
      client.dispose();
    });

    // An operational failure is not evidence the feature exists. Reporting
    // capabilities here would let the app show a share button that fails.
    it('reports unavailable when the host fails for an operational reason', async () => {
      const client = createFabricAppStateClient({ launchSearch: '' });
      const promise = client.isSupported();
      await tick();
      respondTo(postMessage, host, 0, {
        success: false,
        error: { code: 'PLUGIN_ERROR', message: 'Controller threw' },
      });

      await expect(promise).resolves.toBeUndefined();
      client.dispose();
    });

    it('fills in limits the host omits', async () => {
      const client = createFabricAppStateClient({ launchSearch: '' });
      const promise = client.isSupported();
      await tick();
      respondTo(postMessage, host, 0, {
        success: true,
        result: { maxEncodedBytes: 1024 },
      });

      await expect(promise).resolves.toEqual({
        version: 1,
        maxEncodedBytes: 1024,
        maxDepth: DEFAULT_MAX_DEPTH,
        canPush: true,
      });
      client.dispose();
    });

    it('reports the feature unavailable when the host never answers', async () => {
      const client = createFabricAppStateClient({
        launchSearch: '',
        timeoutMs: 20,
      });

      await expect(client.isSupported()).resolves.toBeUndefined();
      client.dispose();
    });
  });

  describe('replace coalescing', () => {
    it('collapses rapid replaces to the newest value', async () => {
      const client = createFabricAppStateClient({ launchSearch: '' });

      const promises = Promise.all([
        client.replaceState({ zoom: 1 }),
        client.replaceState({ zoom: 2 }),
        client.replaceState({ zoom: 3 }),
      ]);

      await tick();
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(postMessage.mock.calls[0][0].payload).toEqual({
        state: { zoom: 3 },
      });

      respondTo(postMessage, host, 0, {
        success: true,
        result: { revision: 1 },
      });
      await promises;
      client.dispose();
    });

    // Drag, click, drag. While the host is slow the first flush has not
    // run yet, so the second drag must open its own flush behind the push
    // rather than joining the one queued ahead of it -- otherwise the URL
    // settles on the click's value instead of the last drag.
    it('keeps a replace issued after a push behind that push', async () => {
      const client = createFabricAppStateClient({ launchSearch: '' });

      const drag1 = client.replaceState({ v: 1 });
      const click = client.setState({ v: 2 });
      const drag2 = client.replaceState({ v: 3 });

      await tick();
      respondTo(postMessage, host, 0, {
        success: true,
        result: { revision: 1 },
      });
      await tick();
      respondTo(postMessage, host, 1, {
        success: true,
        result: { revision: 2 },
      });
      await tick();
      respondTo(postMessage, host, 2, {
        success: true,
        result: { revision: 3 },
      });

      await Promise.all([drag1, click, drag2]);

      expect(
        postMessage.mock.calls.map((call) => [
          call[0].kind,
          call[0].payload.state.v,
        ])
      ).toEqual([
        ['appState.replace', 1],
        ['appState.push', 2],
        ['appState.replace', 3],
      ]);

      client.dispose();
    });

    it('rejects an invalid replace without contacting the host', async () => {
      const client = createFabricAppStateClient({ launchSearch: '' });

      await expect(
        client.replaceState({ when: new Date() } as unknown as FabricAppState)
      ).rejects.toBeInstanceOf(FabricAppStateError);
      expect(postMessage).not.toHaveBeenCalled();
      client.dispose();
    });
  });

  describe('launch parameter scrubbing', () => {
    afterEach(() => {
      window.history.replaceState({}, '', '/');
    });

    it('removes the parameter from the app URL after reading it', () => {
      window.history.replaceState({}, '', `/app${seed({ view: 'sales' })}&k=1`);

      const client = createFabricAppStateClient();

      expect(client.getLaunchStateSync()).toEqual({ view: 'sales' });
      // Otherwise the state is resent to the app's own server on reload
      // and leaks into referrers to subresources.
      expect(window.location.search).toBe('?k=1');
      client.dispose();
    });

    it('leaves the URL untouched when scrubbing is disabled', () => {
      window.history.replaceState({}, '', `/app${seed({ view: 'sales' })}`);

      const client = createFabricAppStateClient({ scrubLaunchParam: false });

      expect(window.location.search).toContain(LAUNCH_STATE_PARAM);
      client.dispose();
    });

    // Standalone (non-embedded) page: no host seeded the parameter, so the
    // client must not rewrite a URL it does not own.
    it('leaves the URL untouched when the app is not embedded', () => {
      window.history.replaceState({}, '', `/app${seed({ view: 'sales' })}`);

      const client = createFabricAppStateClient({ target: window });

      expect(window.location.search).toContain(LAUNCH_STATE_PARAM);
      client.dispose();
    });
  });

  // Apps ship both embedded in Fabric and standalone. The standalone
  // contract has to be predictable: construction never throws, reads
  // degrade to "no state", and writes fail with one stable code so an
  // app can branch on it instead of pattern-matching messages.
  describe('standalone (non-embedded) behaviour', () => {
    afterEach(() => {
      window.history.replaceState({}, '', '/');
    });

    it('constructs without throwing and reports the feature unavailable', async () => {
      const client = createFabricAppStateClient({ target: window });

      await expect(client.isSupported()).resolves.toBeUndefined();
      expect(postMessage).not.toHaveBeenCalled();
      client.dispose();
    });

    it('reads seeded launch state from its own URL', async () => {
      const client = createFabricAppStateClient({
        target: window,
        launchSearch: seed({ view: 'sales' }),
      });

      expect(client.getLaunchStateSync()).toEqual({ view: 'sales' });
      await expect(client.getLaunchState()).resolves.toEqual({ view: 'sales' });
      client.dispose();
    });

    it('resolves launch state to undefined rather than throwing', async () => {
      const client = createFabricAppStateClient({
        target: window,
        launchSearch: '',
      });

      await expect(client.getLaunchState()).resolves.toBeUndefined();
      client.dispose();
    });

    it.each([['setState'], ['replaceState']] as const)(
      '%s rejects with NO_HOST_WINDOW',
      async (method) => {
        const client = createFabricAppStateClient({ target: window });

        await expect(client[method]({ view: 'sales' })).rejects.toMatchObject({
          code: 'NO_HOST_WINDOW',
        });
        expect(postMessage).not.toHaveBeenCalled();
        client.dispose();
      }
    );

    it('accepts and releases a listener that never fires', () => {
      const client = createFabricAppStateClient({ target: window });
      const listener = vi.fn();

      const unsubscribe = client.onStateChange(listener);
      expect(listener).not.toHaveBeenCalled();

      unsubscribe();
      client.dispose();
    });
  });
});
