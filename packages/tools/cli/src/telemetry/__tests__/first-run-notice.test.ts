import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({ configDir: '' }));

vi.mock('../../auth/constants.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../auth/constants.js')
  >('../../auth/constants.js');
  return {
    ...actual,
    get RAYFIN_CONFIG_DIR() {
      return testState.configDir;
    },
  };
});

import { showFirstRunNoticeIfNeeded } from '../first-run-notice.js';

describe('showFirstRunNoticeIfNeeded', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `rayfin-test-${crypto.randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    testState.configDir = join(tempDir, 'rayfin');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes notice to stderr on first invocation', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    showFirstRunNoticeIfNeeded();

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('RAYFIN_TELEMETRY_OPTOUT')
    );
    stderrSpy.mockRestore();
  });

  it('creates marker file after first invocation', () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    showFirstRunNoticeIfNeeded();

    const markerPath = join(tempDir, 'rayfin', 'telemetry-notice-shown');
    expect(existsSync(markerPath)).toBe(true);
    // Marker content is an ISO date string.
    const content = readFileSync(markerPath, 'utf8');
    expect(() => new Date(content)).not.toThrow();

    vi.restoreAllMocks();
  });

  it('creates the config directory with owner-only permissions', () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    showFirstRunNoticeIfNeeded();

    if (process.platform !== 'win32') {
      expect(statSync(join(tempDir, 'rayfin')).mode & 0o777).toBe(0o700);
    }

    vi.restoreAllMocks();
  });

  it('does not write notice on second invocation', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    showFirstRunNoticeIfNeeded();
    stderrSpy.mockClear();

    showFirstRunNoticeIfNeeded();
    expect(stderrSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
  });
});
