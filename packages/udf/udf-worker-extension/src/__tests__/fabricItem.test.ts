import { describe, test, expect } from '@jest/globals';

import { FabricItem, Endpoint } from '../types/fabricItem.js';

describe('FabricItem.getAccessToken', () => {
  test('returns the first token when multiple endpoints exist', () => {
    const endpoints = new Map<string, Endpoint>([
      ['sqlendpoint', { connectionString: 'sql-cs', accessToken: 'sql-token' }],
      [
        'fileendpoint',
        { connectionString: 'file-cs', accessToken: 'file-token' },
      ],
    ]);
    const item = new FabricItem('alias', endpoints);
    expect(item.getAccessToken()).toBe('sql-token');
  });

  test('throws when there are no endpoints', () => {
    const item = new FabricItem('alias', new Map());
    expect(() => item.getAccessToken()).toThrow(
      'has no endpoints with an access token'
    );
  });
});
