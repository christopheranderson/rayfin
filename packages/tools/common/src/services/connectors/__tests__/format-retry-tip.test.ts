import { describe, expect, it } from 'vitest';

import { formatFailedConnectorsRetryTip } from '../index.js';

describe('formatFailedConnectorsRetryTip', () => {
  it('returns an empty array when nothing failed', () => {
    expect(formatFailedConnectorsRetryTip([])).toEqual([]);
  });

  it('formats a single failed connector with copy-pasteable retry commands', () => {
    expect(formatFailedConnectorsRetryTip(['inventory'])).toEqual([
      '1 connector(s) failed to apply: inventory',
      'Retry all:      rayfin up connector apply',
      'Retry one:      rayfin up connector apply --name inventory',
    ]);
  });

  it('lists one retry command per line, aligned, for multiple failures', () => {
    expect(formatFailedConnectorsRetryTip(['a', 'b', 'c'])).toEqual([
      '3 connector(s) failed to apply: a, b, c',
      'Retry all:      rayfin up connector apply',
      'Retry one:      rayfin up connector apply --name a',
      '                rayfin up connector apply --name b',
      '                rayfin up connector apply --name c',
    ]);
  });
});
