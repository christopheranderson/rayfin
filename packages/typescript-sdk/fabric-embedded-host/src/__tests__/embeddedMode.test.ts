import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  isEmbeddedMode,
  clearEmbeddedMode,
  persistEmbeddedModeFromUrl,
} from '../embeddedMode';

describe('isEmbeddedMode', () => {
  let originalSearch: string;

  beforeEach(() => {
    originalSearch = window.location.search;
    sessionStorage.clear();
  });

  afterEach(() => {
    // Restore original search
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: originalSearch },
      writable: true,
      configurable: true,
    });
  });

  it('returns true when fabricEmbedded option is true', () => {
    expect(isEmbeddedMode({ fabricEmbedded: true })).toBe(true);
  });

  it('returns false when fabricEmbedded option is false', () => {
    expect(isEmbeddedMode({ fabricEmbedded: false })).toBe(false);
  });

  it('returns false when fabricEmbedded option is undefined and no URL or storage', () => {
    expect(isEmbeddedMode({})).toBe(false);
  });

  it('returns true when fabricEmbedded=true is in URL', () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?fabricEmbedded=true' },
      writable: true,
      configurable: true,
    });

    expect(isEmbeddedMode({})).toBe(true);
  });

  it('persists flag to sessionStorage when detected from URL', () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?fabricEmbedded=true' },
      writable: true,
      configurable: true,
    });

    isEmbeddedMode({});

    expect(sessionStorage.getItem('fabricEmbedded')).toBe('true');
  });

  it('returns true when flag is in sessionStorage', () => {
    sessionStorage.setItem('fabricEmbedded', 'true');

    expect(isEmbeddedMode({})).toBe(true);
  });

  it('returns false when URL has fabricEmbedded=false', () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?fabricEmbedded=false' },
      writable: true,
      configurable: true,
    });

    expect(isEmbeddedMode({})).toBe(false);
  });
});

describe('clearEmbeddedMode', () => {
  it('removes the sessionStorage flag', () => {
    sessionStorage.setItem('fabricEmbedded', 'true');

    clearEmbeddedMode();

    expect(sessionStorage.getItem('fabricEmbedded')).toBeNull();
  });

  it('does not throw when sessionStorage is empty', () => {
    expect(() => clearEmbeddedMode()).not.toThrow();
  });
});

describe('persistEmbeddedModeFromUrl', () => {
  let originalSearch: string;

  beforeEach(() => {
    originalSearch = window.location.search;
    sessionStorage.clear();
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: originalSearch },
      writable: true,
      configurable: true,
    });
  });

  it('writes the sessionStorage flag and returns true when URL has fabricEmbedded=true', () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?fabricEmbedded=true' },
      writable: true,
      configurable: true,
    });

    expect(persistEmbeddedModeFromUrl()).toBe(true);
    expect(sessionStorage.getItem('fabricEmbedded')).toBe('true');
  });

  it('returns false and does not write when URL flag is absent', () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '' },
      writable: true,
      configurable: true,
    });

    expect(persistEmbeddedModeFromUrl()).toBe(false);
    expect(sessionStorage.getItem('fabricEmbedded')).toBeNull();
  });
});
