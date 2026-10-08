import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  clearFabricUserHint,
  hasFabricUserHint,
  persistFabricUserHintFromUrl,
} from '../fabricUserHint';

const HINT = 'ToVQv3p2KO1E1KwCWmoxFw';

// Captured before any test tampers with it. Restoring from this rather than from the current
// `window.location` matters: one test installs a throwing getter, and spreading that to rebuild the
// object would re-throw and leak the poisoned location into every subsequent test.
const pristineLocation = window.location;

/** Replaces `window.location` with one carrying the given query string. */
function setSearch(search: string): void {
  Object.defineProperty(window, 'location', {
    value: { ...pristineLocation, search },
    writable: true,
    configurable: true,
  });
}

describe('fabricUserHint', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setSearch('');
    clearFabricUserHint();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'location', {
      value: pristineLocation,
      writable: true,
      configurable: true,
    });
    clearFabricUserHint();
  });

  describe('persistFabricUserHintFromUrl', () => {
    it('captures a hint from the URL', () => {
      setSearch(`?fabricEmbedded=true&_fu=${HINT}`);

      expect(persistFabricUserHintFromUrl()).toBe(true);
      expect(hasFabricUserHint()).toBe(true);
    });

    it('reports false and captures nothing when the URL carries no hint', () => {
      setSearch('?fabricEmbedded=true');

      expect(persistFabricUserHintFromUrl()).toBe(false);
      expect(hasFabricUserHint()).toBe(false);
    });

    it('treats an empty hint value as absent', () => {
      // A host that could not resolve the user must omit the parameter; an empty value is not a
      // usable hint and must not be mistaken for one.
      setSearch('?_fu=');

      expect(persistFabricUserHintFromUrl()).toBe(false);
      expect(hasFabricUserHint()).toBe(false);
    });

    it('is idempotent across repeated calls', () => {
      setSearch(`?_fu=${HINT}`);

      expect(persistFabricUserHintFromUrl()).toBe(true);
      expect(persistFabricUserHintFromUrl()).toBe(true);
    });

    it('reports false when the location cannot be read', () => {
      Object.defineProperty(window, 'location', {
        get() {
          throw new Error('location unavailable');
        },
        configurable: true,
      });

      expect(persistFabricUserHintFromUrl()).toBe(false);
    });

    it('reports false outside a browser', () => {
      // The module runs its capture eagerly at import, so it has to stay inert under SSR or Node
      // rather than throwing on a missing `window`.
      vi.stubGlobal('window', undefined);

      expect(persistFabricUserHintFromUrl()).toBe(false);
    });
  });

  describe('hasFabricUserHint', () => {
    it('is true when the hint is on the URL', () => {
      setSearch(`?_fu=${HINT}`);
      persistFabricUserHintFromUrl();

      expect(hasFabricUserHint()).toBe(true);
    });

    it('is true after a client-side navigation strips the query string', () => {
      // Without the in-document capture the SDK would conclude the host had become legacy mid-session
      // and start signing the user out on every later auth call.
      setSearch(`?_fu=${HINT}`);
      persistFabricUserHintFromUrl();
      expect(hasFabricUserHint()).toBe(true);

      setSearch('');

      expect(hasFabricUserHint()).toBe(true);
    });

    it('ignores a hint that appears only after the document loaded', () => {
      // The signal must not be forgeable by the page it protects. On the client, presence SUPPRESSES
      // the cross-user sign-out, so a value the gate never saw - added by app routing or a
      // query-preserving link - must not count. Server-side the polarity is reversed and a forged hint
      // can only force a re-authentication, which is why only this direction needs sealing.
      expect(hasFabricUserHint()).toBe(false);

      setSearch(`?_fu=${HINT}`);

      expect(hasFabricUserHint()).toBe(false);
    });

    it('does not carry a hint across a document load', async () => {
      // The other half of the boundary. A reload re-evaluates the module, and the capture must not
      // outlive it: otherwise a hint from an earlier load would vouch for a load the host never
      // stamped - after a user switch where identity resolution failed, say - and the SDK would resume
      // a session no server-side comparison ever checked. This is what rules out sessionStorage here.
      setSearch(`?_fu=${HINT}`);
      persistFabricUserHintFromUrl();
      expect(hasFabricUserHint()).toBe(true);

      vi.resetModules();
      setSearch('');
      const reloaded = await import('../fabricUserHint');

      expect(reloaded.hasFabricUserHint()).toBe(false);
    });

    it('is false when the URL carries no hint', () => {
      expect(hasFabricUserHint()).toBe(false);
    });

    it('is false again once the hint is cleared', () => {
      setSearch(`?_fu=${HINT}`);
      persistFabricUserHintFromUrl();
      expect(hasFabricUserHint()).toBe(true);

      setSearch('');
      clearFabricUserHint();

      expect(hasFabricUserHint()).toBe(false);
    });
  });
});
