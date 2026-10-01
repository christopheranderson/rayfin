import { describe, expect, it } from 'vitest';

import { reservedRuntimeUrls } from '../reserve-local-runtimes.js';

describe('reservedRuntimeUrls', () => {
  it('maps reserved URLs and omits runtimes without one', () => {
    expect(
      reservedRuntimeUrls({
        status: 'reserved',
        reservations: [
          { id: 'frontend', label: 'frontend dev server' },
          {
            id: 'functions',
            label: 'functions runtime',
            url: 'http://localhost:7072',
          },
        ],
      })
    ).toEqual({ functions: 'http://localhost:7072' });
  });

  it('returns no URLs when reservation is unavailable', () => {
    expect(
      reservedRuntimeUrls({
        status: 'unavailable',
        code: 'functions-port-unavailable',
        message: 'No port available.',
      })
    ).toEqual({});
  });
});
