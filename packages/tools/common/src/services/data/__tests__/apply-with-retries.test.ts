import { describe, expect, it, vi } from 'vitest';

import { HttpError } from '../../../utils/retry/index.js';
import {
  applyDataConfigWithRetries,
  isRetryableDataApplyError,
} from '../apply-with-retries.js';

describe('data apply retry policy', () => {
  it('retries a transient server error and returns the later result', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new HttpError('service unavailable', 503))
      .mockResolvedValue('applied');

    await expect(
      applyDataConfigWithRetries(operation, {
        maxAttempts: 3,
        baseDelay: 0,
      })
    ).resolves.toBe('applied');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it.each([408, 425, 429, 500, 502, 503, 504])(
    'classifies HTTP %s as transient',
    (statusCode) => {
      expect(
        isRetryableDataApplyError(new HttpError('transient', statusCode))
      ).toBe(true);
    }
  );

  it.each([400, 401, 403, 404, 409, 422, 501, 505])(
    'classifies HTTP %s as terminal',
    (statusCode) => {
      expect(
        isRetryableDataApplyError(new HttpError('terminal', statusCode))
      ).toBe(false);
    }
  );

  it('classifies destructive-change errors as terminal', () => {
    expect(
      isRetryableDataApplyError(
        new Error('Destructive schema changes detected')
      )
    ).toBe(false);
  });

  it('classifies an arbitrary programming error as terminal', () => {
    expect(isRetryableDataApplyError(new Error('unexpected state'))).toBe(
      false
    );
  });

  it('classifies a fetch network failure as transient', () => {
    expect(isRetryableDataApplyError(new TypeError('fetch failed'))).toBe(true);
  });

  it('classifies a nested transient network code as transient', () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }),
    });

    expect(isRetryableDataApplyError(error)).toBe(true);
  });

  it('classifies an invalid URL as terminal', () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('invalid URL'), {
        code: 'ERR_INVALID_URL',
      }),
    });

    expect(isRetryableDataApplyError(error)).toBe(false);
  });
});
