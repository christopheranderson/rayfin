import type { ProgressUpdate } from '@microsoft/rayfin-tools-common/_internal/adapters';
import { describe, expect, it, vi } from 'vitest';

import {
  createDiagnosticProgress,
  createOraProgress,
  plainProgress,
  silentProgress,
} from '../progress.js';

/**
 * Drive `formatUpdate` through the public `createOraProgress` seam by reading
 * back the spinner text it sets, so the formatting branches are covered
 * without widening the module's export surface.
 */
function formattedText(update: ProgressUpdate): string {
  const spinner = { text: '' } as { text: string };
  // The interactive Progress only ever mutates `spinner.text`.
  createOraProgress(
    spinner as unknown as Parameters<typeof createOraProgress>[0]
  ).report(update);
  return spinner.text;
}

describe('progress formatting (via createOraProgress)', () => {
  it('joins phase and message with a colon', () => {
    expect(formattedText({ phase: 'deploy', message: 'uploading' })).toBe(
      'deploy: uploading'
    );
  });

  it('uses the phase alone when no message is given', () => {
    expect(formattedText({ phase: 'deploy' })).toBe('deploy');
  });

  it('uses the message alone when no phase is given', () => {
    expect(formattedText({ message: 'working hard' })).toBe('working hard');
  });

  it("falls back to 'working' when neither phase nor message is given", () => {
    expect(formattedText({})).toBe('working');
  });

  it('appends a percent suffix when a percent is provided', () => {
    expect(formattedText({ phase: 'deploy', percent: 42 })).toBe(
      'deploy (42%)'
    );
  });

  it('appends a percent suffix to the fallback label', () => {
    expect(formattedText({ percent: 0 })).toBe('working (0%)');
  });
});

describe('plainProgress', () => {
  it('writes a single prefixed line to stderr', () => {
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    plainProgress.report({ phase: 'deploy', message: 'uploading' });

    expect(spy).toHaveBeenCalledWith('[rayfin] deploy: uploading\n');
    spy.mockRestore();
  });
});

describe('silentProgress', () => {
  it('does not write to stderr', () => {
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    silentProgress.report({ phase: 'deploy', message: 'uploading' });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('diagnostic progress', () => {
  it('forwards structured phase details to the selected diagnostic sink', () => {
    const diagnostics = { debug: vi.fn() };

    createDiagnosticProgress(diagnostics, 'status').report({
      phase: 'management',
      message: 'Checking management endpoint',
      percent: 0,
    });

    expect(diagnostics.debug).toHaveBeenCalledWith({
      area: 'status',
      message: 'Checking management endpoint',
      data: { phase: 'management', percent: 0 },
    });
  });
});
