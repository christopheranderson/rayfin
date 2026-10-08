import { SdkError } from '@microsoft/rayfin-lib';
import { describe, it, expect, afterEach } from 'vitest';

import { createFabricAppStateClient } from '../fabricAppState';

/**
 * Verifies that the browser-only entry point throws SdkError with
 * code BROWSER_ONLY when invoked outside a browser environment.
 */
describe('assertBrowser guards', () => {
  const savedWindow = globalThis.window;

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', {
      value: savedWindow,
      writable: true,
      configurable: true,
    });
  });

  function deleteWindow(): void {
    // @ts-expect-error - intentionally removing window for test
    delete globalThis.window;
  }

  it('createFabricAppStateClient throws BROWSER_ONLY in Node', () => {
    deleteWindow();
    expect(() => createFabricAppStateClient()).toThrowError(SdkError);
    try {
      createFabricAppStateClient();
    } catch (e) {
      expect((e as SdkError).code).toBe('BROWSER_ONLY');
    }
  });
});
