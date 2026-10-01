import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { assertBrowser, SdkError } from '../errors.js';

describe('assertBrowser', () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    // Restore window after each test
    if (originalWindow !== undefined) {
      Object.defineProperty(globalThis, 'window', {
        value: originalWindow,
        writable: true,
        configurable: true,
      });
    }
  });

  it('throws SdkError with BROWSER_ONLY code when window is undefined', () => {
    // Temporarily remove window
    const saved = globalThis.window;
    // @ts-expect-error - intentionally deleting window for test
    delete globalThis.window;

    try {
      expect(() => assertBrowser('myApi')).toThrowError(SdkError);
      try {
        assertBrowser('myApi');
      } catch (e) {
        const err = e as SdkError;
        expect(err.code).toBe('BROWSER_ONLY');
        expect(err.message).toContain('myApi');
        expect(err.message).toContain('browser');
      }
    } finally {
      Object.defineProperty(globalThis, 'window', {
        value: saved,
        writable: true,
        configurable: true,
      });
    }
  });

  it('does not throw when window is defined', () => {
    // window should be defined in jsdom/happy-dom or real browser
    // If not, define it for the test
    if (typeof globalThis.window === 'undefined') {
      Object.defineProperty(globalThis, 'window', {
        value: {},
        writable: true,
        configurable: true,
      });
    }
    expect(() => assertBrowser('myApi')).not.toThrow();
  });

  it('includes the API name in the error message', () => {
    const saved = globalThis.window;
    // @ts-expect-error - intentionally deleting window for test
    delete globalThis.window;
    try {
      assertBrowser('testFunction');
    } catch (e) {
      expect((e as SdkError).message).toBe(
        'testFunction is only available in browser environments.'
      );
    } finally {
      Object.defineProperty(globalThis, 'window', {
        value: saved,
        writable: true,
        configurable: true,
      });
    }
  });
});
