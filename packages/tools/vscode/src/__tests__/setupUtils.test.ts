/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CheckResult } from '@microsoft/rayfin-tools-common/_internal/checks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  asFailedResult,
  getSectionStatus,
  isAbortError,
  withTimeout,
} from '../webviews/utils/setupUtils';

describe('setupUtils', () => {
  describe('asFailedResult', () => {
    it('returns a fail status CheckResult', () => {
      const result = asFailedResult('Docker', 'Not installed');
      expect(result).toEqual({
        status: 'fail',
        name: 'Docker',
        detail: 'Not installed',
      });
    });
  });

  describe('isAbortError', () => {
    it('returns true for AbortError', () => {
      const error = new globalThis.DOMException('Aborted', 'AbortError');
      expect(isAbortError(error)).toBe(true);
    });

    it('returns true for error with "aborted" in message', () => {
      const error = new Error('The operation was aborted');
      expect(isAbortError(error)).toBe(true);
    });

    it('returns false for regular errors', () => {
      expect(isAbortError(new Error('Network failure'))).toBe(false);
    });

    it('returns false for non-error values', () => {
      expect(isAbortError('string')).toBe(false);
      expect(isAbortError(null)).toBe(false);
      expect(isAbortError(undefined)).toBe(false);
    });
  });

  describe('getSectionStatus', () => {
    it('returns checking when loading', () => {
      const results: CheckResult[] = [
        { status: 'pass', name: 'a', detail: '' },
      ];
      expect(getSectionStatus(results, true)).toBe('checking');
    });

    it('returns fail when any result is fail', () => {
      const results: CheckResult[] = [
        { status: 'pass', name: 'a', detail: '' },
        { status: 'fail', name: 'b', detail: '' },
        { status: 'warn', name: 'c', detail: '' },
      ];
      expect(getSectionStatus(results, false)).toBe('fail');
    });

    it('returns warn when any result is warn but none fail', () => {
      const results: CheckResult[] = [
        { status: 'pass', name: 'a', detail: '' },
        { status: 'warn', name: 'b', detail: '' },
      ];
      expect(getSectionStatus(results, false)).toBe('warn');
    });

    it('returns pass when all results pass', () => {
      const results: CheckResult[] = [
        { status: 'pass', name: 'a', detail: '' },
        { status: 'pass', name: 'b', detail: '' },
      ];
      expect(getSectionStatus(results, false)).toBe('pass');
    });

    it('returns pass for empty results when not loading', () => {
      expect(getSectionStatus([], false)).toBe('pass');
    });
  });

  describe('withTimeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('resolves with the result of the run function', async () => {
      const result = await withTimeout('test', async () => 'hello');
      expect(result).toBe('hello');
    });

    it('passes an AbortSignal to the run function', async () => {
      let receivedSignal: AbortSignal | undefined;
      await withTimeout('test', async (signal) => {
        receivedSignal = signal;
      });
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
    });

    it('propagates errors from the run function', async () => {
      await expect(
        withTimeout('test', async () => {
          throw new Error('oops');
        })
      ).rejects.toThrow('oops');
    });

    it('aborts when external signal fires', async () => {
      const controller = new AbortController();
      const runPromise = withTimeout(
        'test',
        async (signal) => {
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () =>
              reject(new globalThis.DOMException('Aborted', 'AbortError'))
            );
          });
        },
        controller.signal
      );

      controller.abort();

      await expect(runPromise).rejects.toThrow();
    });

    it('aborts immediately if external signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      let signalAborted = false;
      await withTimeout(
        'test',
        async (signal) => {
          signalAborted = signal.aborted;
          if (signal.aborted)
            throw new globalThis.DOMException('Aborted', 'AbortError');
          return 'should not reach';
        },
        controller.signal
      ).catch(() => {
        // expected
      });

      expect(signalAborted).toBe(true);
    });
  });
});
