import { describe, it, expect, vi } from 'vitest';

import {
  HttpError,
  withRetry,
  RETRY_CONFIG,
  parseRetryAfterHeader,
} from '../index.js';

// ---------------------------------------------------------------------------
// HttpError
// ---------------------------------------------------------------------------

describe('HttpError', () => {
  it('should have the correct name', () => {
    const err = new HttpError('not found', 404);
    expect(err.name).toBe('HttpError');
  });

  it('should store the status code', () => {
    const err = new HttpError('server error', 500);
    expect(err.statusCode).toBe(500);
  });

  it('should preserve the message', () => {
    const err = new HttpError('gateway timeout', 504);
    expect(err.message).toBe('gateway timeout');
  });

  it('should be an instance of Error', () => {
    const err = new HttpError('bad request', 400);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HttpError);
  });

  it('should preserve an optional cause', () => {
    const cause = new Error('socket failure');
    const err = new HttpError('server error', 500, undefined, { cause });

    expect(err.cause).toBe(cause);
  });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe('withRetry', () => {
  const noop = () => {};

  it('should return the result on first success', async () => {
    const result = await withRetry(async () => 42, {
      label: 'test',
      verbose: noop,
    });
    expect(result).toBe(42);
  });

  it('should retry on failure and succeed on later attempt', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('transient');
        return 'ok';
      },
      { label: 'test', verbose: noop, maxAttempts: 5, baseDelay: 1 }
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('should throw the last error after exhausting all attempts', async () => {
    await expect(
      withRetry(
        async () => {
          throw new Error('always fails');
        },
        {
          label: 'test',
          verbose: noop,
          maxAttempts: 3,
          baseDelay: 1,
        }
      )
    ).rejects.toThrow('always fails');
  });

  it('should stop immediately when shouldRetry returns false', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new HttpError('not found', 404);
        },
        {
          label: 'test',
          verbose: noop,
          maxAttempts: 5,
          baseDelay: 1,
          shouldRetry: (err) =>
            err instanceof HttpError && err.statusCode !== 404,
        }
      )
    ).rejects.toThrow('not found');
    expect(calls).toBe(1); // stopped after first attempt
  });

  it('should continue retrying when shouldRetry returns true', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new HttpError('service unavailable', 503);
        },
        {
          label: 'test',
          verbose: noop,
          maxAttempts: 3,
          baseDelay: 1,
          shouldRetry: (err) =>
            err instanceof HttpError && [502, 503].includes(err.statusCode),
        }
      )
    ).rejects.toThrow('service unavailable');
    expect(calls).toBe(3); // tried all attempts
  });

  it('should call onRetry before each wait', async () => {
    const onRetry = vi.fn();
    await expect(
      withRetry(
        async () => {
          throw new Error('fail');
        },
        {
          label: 'test',
          verbose: noop,
          maxAttempts: 3,
          baseDelay: 1,
          onRetry,
        }
      )
    ).rejects.toThrow('fail');

    // onRetry called for attempt 1→2 and 2→3, but not after the last attempt
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0]).toBe(1); // attempt
    expect(onRetry.mock.calls[1][0]).toBe(2);
  });

  it('should pass delay and error to onRetry', async () => {
    const onRetry = vi.fn();
    const baseDelay = 10;
    await expect(
      withRetry(
        async () => {
          throw new Error('oops');
        },
        {
          label: 'test',
          verbose: noop,
          maxAttempts: 2,
          baseDelay,
          onRetry,
        }
      )
    ).rejects.toThrow('oops');

    expect(onRetry).toHaveBeenCalledTimes(1);
    const [attempt, delay, error] = onRetry.mock.calls[0];
    expect(attempt).toBe(1);
    expect(delay).toBe(baseDelay); // 2^0 * baseDelay = baseDelay
    expect(error.message).toBe('oops');
  });

  it('should use RETRY_CONFIG defaults when options are omitted', async () => {
    expect(RETRY_CONFIG.maxAttempts).toBe(5);
    expect(RETRY_CONFIG.baseDelay).toBe(2000);
  });

  it('should call verbose with attempt info', async () => {
    const verbose = vi.fn();
    await withRetry(async () => 'ok', {
      label: 'my-op',
      verbose,
    });
    expect(verbose).toHaveBeenCalledWith('[my-op] Attempt 1/5');
  });

  it('should honor an HttpError retryAfterMs over exponential backoff', async () => {
    const onRetry = vi.fn();
    await expect(
      withRetry(
        async () => {
          // retryAfterMs (500) takes precedence over 2^0 * baseDelay (10).
          throw new HttpError('rate limited', 429, 500);
        },
        {
          label: 'test',
          verbose: () => {},
          maxAttempts: 2,
          baseDelay: 10,
          onRetry,
        }
      )
    ).rejects.toThrow('rate limited');

    expect(onRetry).toHaveBeenCalledTimes(1);
    const [, delay] = onRetry.mock.calls[0];
    expect(delay).toBe(500); // Retry-After delay, not the 10ms backoff
  });
});

// ---------------------------------------------------------------------------
// parseRetryAfterHeader
// ---------------------------------------------------------------------------

describe('parseRetryAfterHeader', () => {
  const res = (v?: string) =>
    ({ headers: { get: () => v ?? null } }) as unknown as Response;

  it('converts numeric seconds to milliseconds', () => {
    expect(parseRetryAfterHeader(res('120'))).toBe(120_000);
  });

  it('handles a zero-second delay', () => {
    expect(parseRetryAfterHeader(res('0'))).toBe(0);
  });

  it('returns undefined when the header is absent', () => {
    expect(parseRetryAfterHeader(res())).toBeUndefined();
  });

  it('returns undefined for the HTTP-date form (not supported)', () => {
    expect(
      parseRetryAfterHeader(res('Wed, 30 Apr 2026 20:15:00 GMT'))
    ).toBeUndefined();
  });

  it('returns undefined for a non-numeric value', () => {
    expect(parseRetryAfterHeader(res('soon'))).toBeUndefined();
  });
});
