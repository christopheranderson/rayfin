import { describe, expect, it } from 'vitest';

import { formatDiagnosticRecord } from '../format.js';
import { sanitizeDiagnosticEvent } from '../sanitize.js';

describe('sanitizeDiagnosticEvent', () => {
  it('redacts sensitive keys and inline credentials', () => {
    const event = sanitizeDiagnosticEvent({
      area: 'fabric.request',
      message:
        'Bearer abc.def user@example.com https://user:pass@example.com?sig=abc',
      data: {
        authorization: 'Bearer secret',
        refreshToken: 'refresh-secret',
        nested: { connectionString: 'Server=x;Password=hunter2' },
        safeStatus: 429,
      },
    });

    expect(event.message).toBe(
      'Bearer [REDACTED] [REDACTED] https://[REDACTED]@example.com?sig=[REDACTED]'
    );
    expect(event.data).toEqual({
      authorization: '[REDACTED]',
      refreshToken: '[REDACTED]',
      nested: { connectionString: '[REDACTED]' },
      safeStatus: 429,
    });
  });

  it('keeps useful project and home paths but redacts other absolute paths', () => {
    const event = sanitizeDiagnosticEvent(
      {
        area: 'build',
        message:
          'project /work/project/src/index.ts home /home/test/.rayfin other /tmp/raw.log',
      },
      { projectRoot: '/work/project', homeDir: '/home/test' }
    );

    expect(event.message).toBe(
      'project ./src/index.ts home ~/.rayfin other [path]'
    );
  });

  it('bounds arrays, object keys, strings, depth, and circular values', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const manyKeys = Object.fromEntries(
      Array.from({ length: 55 }, (_, index) => [`key${index}`, index])
    );

    const event = sanitizeDiagnosticEvent({
      area: 'limits',
      message: 'x'.repeat(3_000),
      data: {
        circular,
        manyKeys,
        manyItems: Array.from({ length: 55 }, (_, index) => index),
        deep: { a: { b: { c: { d: { e: 'hidden' } } } } },
      },
    });

    expect(event.message).toHaveLength(2_048);
    expect(event.data?.['circular']).toEqual({ self: '[CIRCULAR]' });
    expect(event.data?.['manyKeys']).toMatchObject({ __truncatedKeys: 5 });
    expect(event.data?.['manyItems']).toHaveLength(51);
    expect(event.data?.['deep']).toEqual({
      a: { b: { c: { d: '[MAX_DEPTH]' } } },
    });
  });

  it('sanitizes Error objects without throwing', () => {
    const event = sanitizeDiagnosticEvent({
      area: 'exception',
      message: 'failed',
      data: { cause: new Error('token=abc at /tmp/private.ts') },
    });

    expect(event.data?.['cause']).toMatchObject({
      name: 'Error',
      message: 'token=[REDACTED] at [path]',
    });
  });

  it('does not split a Unicode code point at the string bound', () => {
    const event = sanitizeDiagnosticEvent({
      area: 'unicode',
      message: '😀'.repeat(3_000),
    });

    expect(event.message).toBe('😀'.repeat(2_048));
  });

  it('formats untrusted area and message text as one physical line', () => {
    const line = formatDiagnosticRecord(
      new Date('2026-09-01T14:30:12.123Z'),
      'DEBUG',
      { area: 'build\nchild', message: 'first\r\nsecond' }
    );

    expect(line).toContain('DEBUG build.child first\\nsecond');
    expect(line.split('\n')).toHaveLength(2);
  });
});
