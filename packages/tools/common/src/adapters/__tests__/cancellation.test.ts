import { describe, it, expect, vi } from 'vitest';

import {
  abortSignalFromCancellationToken,
  cancellationTokenFromSignal,
  createLinkedCancellation,
  noopCancellationToken,
} from '../cancellation.js';

describe('createLinkedCancellation', () => {
  it('fires when the parent fires', () => {
    const ac = new AbortController();
    const linked = createLinkedCancellation(
      cancellationTokenFromSignal(ac.signal)
    );
    const cb = vi.fn();
    linked.token.onCancellationRequested(cb);

    ac.abort();

    expect(linked.token.isCancellationRequested).toBe(true);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('cancels the derived token without cancelling the parent', () => {
    const parent = cancellationTokenFromSignal(new AbortController().signal);
    const linked = createLinkedCancellation(parent);
    const cb = vi.fn();
    linked.token.onCancellationRequested(cb);

    linked.cancel();
    linked.cancel();

    expect(linked.token.isCancellationRequested).toBe(true);
    expect(parent.isCancellationRequested).toBe(false);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('starts cancelled when the parent already is, notifying late subscribers', async () => {
    const ac = new AbortController();
    ac.abort();
    const linked = createLinkedCancellation(
      cancellationTokenFromSignal(ac.signal)
    );
    const cb = vi.fn();

    linked.token.onCancellationRequested(cb);
    await Promise.resolve();

    expect(linked.token.isCancellationRequested).toBe(true);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('stops observing the parent once disposed', () => {
    const ac = new AbortController();
    const linked = createLinkedCancellation(
      cancellationTokenFromSignal(ac.signal)
    );
    const cb = vi.fn();
    linked.token.onCancellationRequested(cb);

    linked.dispose();
    ac.abort();

    expect(cb).not.toHaveBeenCalled();
  });

  it('works with no parent token', () => {
    const linked = createLinkedCancellation();
    const cb = vi.fn();
    linked.token.onCancellationRequested(cb);

    expect(linked.token.isCancellationRequested).toBe(false);
    linked.cancel();
    expect(cb).toHaveBeenCalledOnce();
  });
});

describe('noopCancellationToken', () => {
  it('is never cancelled and returns an inert disposable', () => {
    expect(noopCancellationToken.isCancellationRequested).toBe(false);
    const cb = vi.fn();
    const sub = noopCancellationToken.onCancellationRequested(cb);
    sub.dispose();
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('cancellationTokenFromSignal', () => {
  it('reflects abort via isCancellationRequested', () => {
    const ac = new AbortController();
    const token = cancellationTokenFromSignal(ac.signal);
    expect(token.isCancellationRequested).toBe(false);
    ac.abort();
    expect(token.isCancellationRequested).toBe(true);
  });

  it('fires the listener once on abort', () => {
    const ac = new AbortController();
    const cb = vi.fn();
    cancellationTokenFromSignal(ac.signal).onCancellationRequested(cb);
    ac.abort();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not fire the listener again on a second abort', () => {
    const ac = new AbortController();
    const cb = vi.fn();
    cancellationTokenFromSignal(ac.signal).onCancellationRequested(cb);
    ac.abort();
    ac.abort();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('dispose() before abort prevents the listener from firing', () => {
    const ac = new AbortController();
    const cb = vi.fn();
    cancellationTokenFromSignal(ac.signal)
      .onCancellationRequested(cb)
      .dispose();
    ac.abort();
    expect(cb).not.toHaveBeenCalled();
  });

  it('pre-aborted signal fires the listener asynchronously (microtask)', async () => {
    const ac = new AbortController();
    ac.abort();
    const token = cancellationTokenFromSignal(ac.signal);
    expect(token.isCancellationRequested).toBe(true);

    const cb = vi.fn();
    token.onCancellationRequested(cb);
    // Not yet — scheduled on the microtask queue, not called synchronously.
    expect(cb).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('pre-aborted dispose() is inert and does NOT cancel the scheduled listener', async () => {
    // Documents the intentional asymmetry: on the pre-aborted path the
    // listener is already scheduled and the disposable is a no-op, so an
    // eager-disposing host still observes the callback.
    const ac = new AbortController();
    ac.abort();
    const cb = vi.fn();
    cancellationTokenFromSignal(ac.signal)
      .onCancellationRequested(cb)
      .dispose();
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('abortSignalFromCancellationToken', () => {
  it('aborts when the source token is cancelled', () => {
    const linked = createLinkedCancellation();
    const derived = abortSignalFromCancellationToken(linked.token);

    linked.cancel();

    expect(derived.signal.aborted).toBe(true);
  });

  it('starts aborted when the source token is already cancelled', () => {
    const linked = createLinkedCancellation();
    linked.cancel();

    const derived = abortSignalFromCancellationToken(linked.token);

    expect(derived.signal.aborted).toBe(true);
  });

  it('stops observing the source token after disposal', () => {
    const linked = createLinkedCancellation();
    const derived = abortSignalFromCancellationToken(linked.token);

    derived.dispose();
    linked.cancel();

    expect(derived.signal.aborted).toBe(false);
  });
});
