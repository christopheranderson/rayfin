import { SdkError } from '@microsoft/rayfin-lib';
import { describe, it, expect, afterEach } from 'vitest';

import { isEmbeddedMode, clearEmbeddedMode } from '../embeddedMode';
import { sendBridgeRequest } from '../postMessageBridge';

/**
 * Verifies that browser-only entry points throw SdkError with
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

  it('isEmbeddedMode throws BROWSER_ONLY in Node', () => {
    deleteWindow();
    expect(() => isEmbeddedMode({})).toThrowError(SdkError);
    try {
      isEmbeddedMode({});
    } catch (e) {
      expect((e as SdkError).code).toBe('BROWSER_ONLY');
    }
  });

  it('clearEmbeddedMode throws BROWSER_ONLY in Node', () => {
    deleteWindow();
    expect(() => clearEmbeddedMode()).toThrowError(SdkError);
    try {
      clearEmbeddedMode();
    } catch (e) {
      expect((e as SdkError).code).toBe('BROWSER_ONLY');
    }
  });

  it('sendBridgeRequest throws BROWSER_ONLY in Node', () => {
    deleteWindow();
    expect(() => sendBridgeRequest({} as any)).toThrowError(SdkError);
    try {
      sendBridgeRequest({} as any);
    } catch (e) {
      expect((e as SdkError).code).toBe('BROWSER_ONLY');
    }
  });
});
