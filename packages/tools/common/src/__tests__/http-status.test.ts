import { describe, expect, it } from 'vitest';

import {
  formatHttpStatus,
  getHttpErrorRecoveryHint,
  HTTP_STATUS_INFO,
} from '../http-status.js';

describe('http-status helpers', () => {
  it('formats known statuses with reason phrases', () => {
    expect(formatHttpStatus(401)).toBe('HTTP 401 Unauthorized');
    expect(formatHttpStatus(503)).toBe('HTTP 503 Service Unavailable');
  });

  it('formats unknown statuses without a reason phrase', () => {
    expect(formatHttpStatus(599)).toBe('HTTP 599');
  });

  it('returns a friendly recovery hint for known status codes', () => {
    expect(getHttpErrorRecoveryHint(429, 'fallback')).toContain(
      'Too many requests'
    );
  });

  it('uses fallback recovery hint for unknown status codes', () => {
    expect(getHttpErrorRecoveryHint(599, 'fallback')).toBe('fallback');
  });

  it('contains the common unauthorized reason phrase', () => {
    expect(HTTP_STATUS_INFO[401]?.reason).toBe('Unauthorized');
  });
});
