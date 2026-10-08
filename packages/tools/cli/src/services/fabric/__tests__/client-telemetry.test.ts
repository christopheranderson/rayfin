import { InvocationContext } from '@microsoft/rayfin-tools-common/_internal/telemetry';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setCurrentContext } from '../../../telemetry/context-store.js';
import FabricApiClient from '../client.js';

class TestFabricApiClient extends FabricApiClient {
  get(path: string): Promise<Record<string, unknown>> {
    return this.request(path);
  }

  poll(operationLocation: string): Promise<Record<string, unknown>> {
    return this.pollOperationStatus(operationLocation, 0, 2);
  }
}

describe('FabricApiClient telemetry', () => {
  afterEach(() => {
    setCurrentContext(undefined);
    vi.unstubAllGlobals();
  });

  it('accumulates root activity IDs across Fabric API responses', async () => {
    const responses = ['activity-1', 'activity-2'].map(
      (activityId) =>
        new Response('{}', {
          status: 200,
          headers: { 'x-ms-root-activity-id': activityId },
        })
    );
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(responses[0])
        .mockResolvedValueOnce(responses[1])
    );
    const context = new InvocationContext('rayfin-cli', '1.0.0');
    setCurrentContext(context);
    const client = new TestFabricApiClient('token', {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });

    await client.get('/first');
    await client.get('/second');

    expect(
      context.finalize({
        osType: 'linux',
        osVersion: 'test',
        nodeVersion: 'test',
      }).properties?.fabric_activity_ids
    ).toBe('["activity-1","activity-2"]');
  });

  it('accumulates root activity IDs across operation status responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, {
            status: 202,
            headers: { 'x-ms-root-activity-id': 'poll-activity-1' },
          })
        )
        .mockResolvedValueOnce(
          new Response('{"status":"Succeeded"}', {
            status: 200,
            headers: { 'x-ms-root-activity-id': 'poll-activity-2' },
          })
        )
    );
    const context = new InvocationContext('rayfin-cli', '1.0.0');
    setCurrentContext(context);
    const client = new TestFabricApiClient('token', {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });

    await client.poll('https://api.fabric.microsoft.com/operations/1');

    expect(
      context.finalize({
        osType: 'linux',
        osVersion: 'test',
        nodeVersion: 'test',
      }).properties?.fabric_activity_ids
    ).toBe('["poll-activity-1","poll-activity-2"]');
  });
});
