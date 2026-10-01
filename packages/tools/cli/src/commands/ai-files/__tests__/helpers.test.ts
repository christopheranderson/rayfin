/**
 * Unit tests for `helpers.ts` — focused on the user-facing warning text rendered
 * by `printReport` for each warning state. The behavioral logic that produces
 * the warnings lives in `manager.ts` (and is tested there); these tests lock in
 * the shape of the message the user actually reads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UpdateReport } from '../../../services/agent-files/types.js';
import { printReport } from '../helpers.js';

function reportWith(warnings: UpdateReport['warnings']): UpdateReport {
  return {
    installed: [],
    updated: [],
    removed: [],
    disabled: [],
    enabled: [],
    skipped: [],
    warnings,
  };
}

describe('printReport — warning text suggests per-item --force', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  function captured(): string {
    return warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
  }

  it('user-modified suggests `--force <id>` (per-item, not global)', () => {
    printReport(
      'plain',
      reportWith([{ id: 'skill:rayfin', reason: 'user-modified' }])
    );
    const out = captured();
    expect(out).toContain('rayfin init ai-files install --force skill:rayfin');
    // Must NOT recommend the bare global form when an id is available — that
    // would risk stomping unrelated user-modified items in the same run.
    expect(out).not.toMatch(/install --force\s*$/m);
    expect(out).not.toMatch(/install --force\n/);
  });

  it('missing suggests `--force <id>` for restoration', () => {
    printReport('plain', reportWith([{ id: 'mcp:rayfin', reason: 'missing' }]));
    const out = captured();
    expect(out).toContain('rayfin init ai-files install --force mcp:rayfin');
    expect(out).not.toMatch(/install --force\s*$/m);
  });

  it('unreadable suggests `--force <id>` for overwrite', () => {
    printReport(
      'plain',
      reportWith([
        {
          id: 'mcp:rayfin',
          reason: 'unreadable',
          message: 'malformed JSON at .mcp.json:3',
        },
      ])
    );
    const out = captured();
    expect(out).toContain('rayfin init ai-files install --force mcp:rayfin');
    expect(out).toContain('malformed JSON at .mcp.json:3');
  });

  it('text emits `--disable <id>` alongside `--force <id>` for user-modified', () => {
    printReport(
      'plain',
      reportWith([{ id: 'skill:rayfin', reason: 'user-modified' }])
    );
    const out = captured();
    expect(out).toContain(
      'rayfin init ai-files install --disable skill:rayfin'
    );
  });

  it('json mode suppresses warning text (output is the structured envelope)', () => {
    printReport(
      'json',
      reportWith([{ id: 'skill:rayfin', reason: 'user-modified' }])
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
