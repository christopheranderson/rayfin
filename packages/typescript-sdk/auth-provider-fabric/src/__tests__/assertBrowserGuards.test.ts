import { SdkError } from '@microsoft/rayfin-lib';
import { describe, it, expect, afterEach } from 'vitest';

import { bridgeFabricCallback } from '../bridgeFabricCallback';
import { embeddedFabricLogin } from '../embeddedFabricLogin';
import { ensureSignedInWithFabric } from '../ensureSignedInWithFabric';
import { initiateFabricLogin } from '../initiateFabricLogin';

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

  it('bridgeFabricCallback throws BROWSER_ONLY in Node', () => {
    deleteWindow();
    expect(() => bridgeFabricCallback()).toThrowError(SdkError);
    try {
      bridgeFabricCallback();
    } catch (e) {
      expect((e as SdkError).code).toBe('BROWSER_ONLY');
    }
  });

  it('initiateFabricLogin throws BROWSER_ONLY in Node', async () => {
    deleteWindow();
    await expect(
      initiateFabricLogin({} as any, {} as any)
    ).rejects.toThrowError(SdkError);
    try {
      await initiateFabricLogin({} as any, {} as any);
    } catch (e) {
      expect((e as SdkError).code).toBe('BROWSER_ONLY');
    }
  });

  it('embeddedFabricLogin throws BROWSER_ONLY in Node', async () => {
    deleteWindow();
    await expect(
      embeddedFabricLogin({} as any, {} as any)
    ).rejects.toThrowError(SdkError);
    try {
      await embeddedFabricLogin({} as any, {} as any);
    } catch (e) {
      expect((e as SdkError).code).toBe('BROWSER_ONLY');
    }
  });

  it('ensureSignedInWithFabric throws BROWSER_ONLY in Node', async () => {
    deleteWindow();
    await expect(
      ensureSignedInWithFabric({} as any, {} as any)
    ).rejects.toThrowError(SdkError);
    try {
      await ensureSignedInWithFabric({} as any, {} as any);
    } catch (e) {
      expect((e as SdkError).code).toBe('BROWSER_ONLY');
    }
  });
});
