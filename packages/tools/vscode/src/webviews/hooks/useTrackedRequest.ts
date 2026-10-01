/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react';

import { isAbortError } from '../utils/setupUtils';

/**
 * Encapsulates the request-ID + AbortController + loading-state lifecycle
 * that every async setup check repeats. Handles staleness guards,
 * abort-on-re-run, and abort-error swallowing.
 */
export function useTrackedRequest() {
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  const run = useCallback(
    async <T>(
      fn: (requestId: number, signal: AbortSignal) => Promise<T>,
      options?: { skipAbortPrevious?: boolean }
    ): Promise<
      { value: T; stale: boolean } | { value: undefined; stale: true }
    > => {
      const requestId = ++requestIdRef.current;
      if (!options?.skipAbortPrevious) {
        abortRef.current?.abort();
      }
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);

      try {
        const value = await fn(requestId, controller.signal);
        const stale = requestId !== requestIdRef.current;
        if (!stale) setLoading(false);
        return { value, stale };
      } catch (error) {
        if (isAbortError(error) || requestId !== requestIdRef.current) {
          return { value: undefined, stale: true };
        }
        if (requestId === requestIdRef.current) setLoading(false);
        throw error;
      }
    },
    []
  );

  const isCurrent = useCallback(
    (requestId: number) => requestId === requestIdRef.current,
    []
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const resetLoading = useCallback(() => {
    setLoading(false);
  }, []);

  const isLoading = useCallback(() => loadingRef.current, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return { loading, run, isCurrent, abort, resetLoading, isLoading };
}
