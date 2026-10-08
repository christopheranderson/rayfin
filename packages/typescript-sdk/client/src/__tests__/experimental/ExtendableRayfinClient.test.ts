import { describe, expect, it } from 'vitest';

import RayfinClient from '../../client';
import { ExtendableRayfinClient } from '../../experimental/ExtendableRayfinClient';

const baseConfig = {
  baseUrl: 'https://example.invalid',
  publishableKey: 'pk-test-1234567890',
};

describe('ExtendableRayfinClient', () => {
  it('composes plain service API objects alongside the inherited client', () => {
    const client = ExtendableRayfinClient.create({
      ...baseConfig,
      services: {
        connectorApi: () => ({ query: () => 'connected' }),
      },
    });

    expect(client).toBeInstanceOf(RayfinClient);
    expect(client.data).toBeDefined();
    expect(client.auth).toBeDefined();
    expect(client.connectorApi.query()).toBe('connected');
  });
});
