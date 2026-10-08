/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useTrackedRequest } from '../webviews/hooks/useTrackedRequest';

describe('useTrackedRequest', () => {
  it('starts with loading false', () => {
    const { result } = renderHook(() => useTrackedRequest());
    expect(result.current.loading).toBe(false);
  });

  it('sets loading to true while run is in-flight', async () => {
    const { result } = renderHook(() => useTrackedRequest());

    let resolvePromise: (v: string) => void;
    const promise = new Promise<string>((r) => {
      resolvePromise = r;
    });

    let runPromise: Promise<unknown>;
    act(() => {
      runPromise = result.current.run(() => promise);
    });

    // Loading should be true while promise is pending
    expect(result.current.loading).toBe(true);

    await act(async () => {
      resolvePromise!('done');
      await runPromise!;
    });

    expect(result.current.loading).toBe(false);
  });

  it('returns value and stale=false for current request', async () => {
    const { result } = renderHook(() => useTrackedRequest());

    let runResult: Awaited<ReturnType<typeof result.current.run>>;
    await act(async () => {
      runResult = await result.current.run(async () => 'hello');
    });

    expect(runResult!).toEqual({ value: 'hello', stale: false });
  });

  it('marks result as stale when a newer request supersedes', async () => {
    const { result } = renderHook(() => useTrackedRequest());

    let resolveFirst: (v: string) => void;
    const firstPromise = new Promise<string>((r) => {
      resolveFirst = r;
    });

    let firstRunPromise: Promise<unknown>;
    act(() => {
      firstRunPromise = result.current.run(() => firstPromise);
    });

    // Start a second request while first is in-flight
    let secondResult: Awaited<ReturnType<typeof result.current.run>>;
    await act(async () => {
      secondResult = await result.current.run(async () => 'second');
    });

    expect(secondResult!).toEqual({ value: 'second', stale: false });

    // Resolve first — should be stale
    let firstResult: Awaited<ReturnType<typeof result.current.run>>;
    await act(async () => {
      resolveFirst!('first');
      firstResult = (await firstRunPromise) as typeof firstResult;
    });

    expect(firstResult!.stale).toBe(true);
  });

  it('aborts previous request by default', async () => {
    const { result } = renderHook(() => useTrackedRequest());

    let capturedSignal: AbortSignal | undefined;
    act(() => {
      result.current.run(async (_id, signal) => {
        capturedSignal = signal;
        return new Promise(() => {});
      });
    });

    expect(capturedSignal!.aborted).toBe(false);

    // Start a new request — previous should be aborted
    await act(async () => {
      await result.current.run(async () => 'new');
    });

    expect(capturedSignal!.aborted).toBe(true);
  });

  it('does not abort previous when skipAbortPrevious is set', async () => {
    const { result } = renderHook(() => useTrackedRequest());

    let capturedSignal: AbortSignal | undefined;
    act(() => {
      result.current.run(async (_id, signal) => {
        capturedSignal = signal;
        return new Promise(() => {});
      });
    });

    await act(async () => {
      await result.current.run(async () => 'new', {
        skipAbortPrevious: true,
      });
    });

    expect(capturedSignal!.aborted).toBe(false);
  });

  it('returns stale result when request is superseded by abort', async () => {
    const { result } = renderHook(() => useTrackedRequest());

    // Start a long request, then immediately start a second one.
    // The first should be aborted and return stale.
    // The second should succeed and return fresh.

    const secondResult: { value: unknown; stale: boolean } = {
      value: undefined,
      stale: true,
    };

    const firstRunPromise = act(() =>
      result.current.run(async (_id, signal) => {
        // Wait for the abort signal
        return new Promise<string>((resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(new globalThis.DOMException('Aborted', 'AbortError'))
          );
          // If not aborted within 50ms, resolve
          setTimeout(() => resolve('first'), 50);
        });
      })
    );

    // Start second request immediately (aborts first)
    await act(async () => {
      const result2 = await result.current.run(async () => 'second');
      Object.assign(secondResult, result2);
    });

    const firstResolved = await firstRunPromise;

    expect(firstResolved!.stale).toBe(true);
    expect(secondResult!).toEqual({ value: 'second', stale: false });
  });

  it('re-throws non-abort errors', async () => {
    const { result } = renderHook(() => useTrackedRequest());

    await expect(
      act(async () => {
        await result.current.run(async () => {
          throw new Error('network failure');
        });
      })
    ).rejects.toThrow('network failure');

    expect(result.current.loading).toBe(false);
  });

  it('abort() aborts current in-flight request', async () => {
    const { result } = renderHook(() => useTrackedRequest());

    let capturedSignal: AbortSignal | undefined;
    act(() => {
      result.current.run(async (_id, signal) => {
        capturedSignal = signal;
        return new Promise(() => {});
      });
    });

    act(() => {
      result.current.abort();
    });

    expect(capturedSignal!.aborted).toBe(true);
  });

  it('resetLoading() sets loading to false', async () => {
    const { result } = renderHook(() => useTrackedRequest());

    act(() => {
      result.current.run(async () => new Promise(() => {}));
    });

    expect(result.current.loading).toBe(true);

    act(() => {
      result.current.resetLoading();
    });

    expect(result.current.loading).toBe(false);
  });

  it('cleans up by aborting on unmount', () => {
    const { result, unmount } = renderHook(() => useTrackedRequest());

    let capturedSignal: AbortSignal | undefined;
    act(() => {
      result.current.run(async (_id, signal) => {
        capturedSignal = signal;
        return new Promise(() => {});
      });
    });

    unmount();

    expect(capturedSignal!.aborted).toBe(true);
  });
});
