import { describe, expect, it } from 'vitest';

import { validateServiceDependencies } from '../serviceDependencies.js';

describe('validateServiceDependencies', () => {
  it('rejects storage when data is disabled', () => {
    expect(
      validateServiceDependencies({
        dataEnabled: false,
        storageEnabled: true,
      })
    ).toEqual([
      {
        code: 'storage-requires-data',
        message: 'Storage requires the Data service.',
        hint: 'Enable services.data or disable services.storage in rayfin.yml.',
      },
    ]);
  });

  it.each([
    { dataEnabled: false, storageEnabled: false },
    { dataEnabled: true, storageEnabled: false },
    { dataEnabled: true, storageEnabled: true },
  ])('accepts valid service state %o', (state) => {
    expect(validateServiceDependencies(state)).toEqual([]);
  });
});
