import { InvocationContext } from '@microsoft/rayfin-tools-common/_internal/telemetry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MONIKER_HEADER } from '../../config/constants.js';
import { setCurrentContext } from '../../telemetry/context-store.js';
import { getPublishableKey } from '../publishable-key-utils.js';
import { RETRY_CONFIG } from '../retry-utils.js';

const fetchMock = vi.fn();
global.fetch = fetchMock as unknown as typeof fetch;

const ITEM_ENDPOINT =
  'https://api.fabric.example/workspaces/ws-1/appBackends/item-1';
const ITEM_ID = 'item-1';
const AUTH_HEADER = 'Bearer test-token';
const EXPECTED_URL = `${ITEM_ENDPOINT}/__private/publishable-key`;

function mockOk(bodyText: string): void {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: () => Promise.resolve(bodyText),
    headers: { get: vi.fn().mockReturnValue(null) },
  });
}

describe('getPublishableKey', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    setCurrentContext(undefined);
    vi.useRealTimers();
  });

  it('returns the publishable key when the body is a bare JSON string', async () => {
    mockOk('"pk_test_abc123"');

    const key = await getPublishableKey(ITEM_ENDPOINT, ITEM_ID, {
      authorizationHeader: AUTH_HEADER,
    });

    expect(key).toBe('pk_test_abc123');
    expect(fetchMock).toHaveBeenCalledWith(EXPECTED_URL, {
      method: 'GET',
      headers: {
        Authorization: AUTH_HEADER,
        [MONIKER_HEADER]: ITEM_ID,
      },
    });
  });

  it('returns the publishable key when the body wraps it in an envelope', async () => {
    mockOk(JSON.stringify({ publishableKey: 'pk_test_xyz789' }));

    const key = await getPublishableKey(ITEM_ENDPOINT, ITEM_ID, {
      authorizationHeader: AUTH_HEADER,
    });

    expect(key).toBe('pk_test_xyz789');
  });

  it('returns the trimmed raw body when the response is not JSON', async () => {
    mockOk('  pk_test_raw_value  ');

    const key = await getPublishableKey(ITEM_ENDPOINT, ITEM_ID, {
      authorizationHeader: AUTH_HEADER,
    });

    expect(key).toBe('pk_test_raw_value');
  });

  it('falls back to the trimmed body when the JSON envelope is unrecognised', async () => {
    mockOk(JSON.stringify({ somethingElse: 'no key here' }));

    const key = await getPublishableKey(ITEM_ENDPOINT, ITEM_ID, {
      authorizationHeader: AUTH_HEADER,
    });

    expect(key).toBe('{"somethingElse":"no key here"}');
  });

  it('surfaces a clean error when the server returns non-2xx', async () => {
    // `getPublishableKey` runs inside `withRetry` (5 attempts, exponential
    // backoff). Mock all attempts to return the same 401 and use fake timers
    // so the test does not wait the full backoff.
    vi.useFakeTimers();
    const make401 = () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: () => Promise.resolve('unauthorized'),
      headers: { get: vi.fn().mockReturnValue(null) },
    });
    for (let attempt = 0; attempt < RETRY_CONFIG.maxAttempts; attempt++) {
      fetchMock.mockResolvedValueOnce(make401());
    }

    const promise = getPublishableKey(ITEM_ENDPOINT, ITEM_ID, {
      authorizationHeader: AUTH_HEADER,
    });
    // Catch on the promise immediately so vitest sees the rejection rather
    // than treating the timer advance as an unhandled rejection.
    const expectation = expect(promise).rejects.toThrow(
      /Could not retrieve publishable key/
    );
    await vi.runAllTimersAsync();
    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(RETRY_CONFIG.maxAttempts);
  });

  it('accumulates activity IDs from failed and successful retry responses', async () => {
    vi.useFakeTimers();
    const response = (
      ok: boolean,
      status: number,
      activityId: string,
      body: string
    ) => ({
      ok,
      status,
      statusText: ok ? 'OK' : 'Service Unavailable',
      text: () => Promise.resolve(body),
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'x-ms-root-activity-id' ? activityId : null,
      },
    });
    fetchMock
      .mockResolvedValueOnce(response(false, 503, 'activity-1', 'retry'))
      .mockResolvedValueOnce(response(true, 200, 'activity-2', '"pk_retry"'));
    const context = new InvocationContext('rayfin-cli', '1.0.0');
    setCurrentContext(context);

    const promise = getPublishableKey(ITEM_ENDPOINT, ITEM_ID, {
      authorizationHeader: AUTH_HEADER,
    });
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe('pk_retry');
    expect(
      context.finalize({
        osType: 'linux',
        osVersion: 'test',
        nodeVersion: 'test',
      }).properties?.fabric_activity_ids
    ).toBe('["activity-1","activity-2"]');
  });

  it('uses the provided verbose logger', async () => {
    mockOk('"pk_verbose"');
    const verbose = vi.fn();

    await getPublishableKey(ITEM_ENDPOINT, ITEM_ID, {
      authorizationHeader: AUTH_HEADER,
      verbose,
    });

    expect(verbose).toHaveBeenCalled();
  });
});
