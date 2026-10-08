/**
 * Tests for the prereq-detection + install-plan layer of
 * `rayfin dev functions apply`. Mocks `child_process.spawnSync` so the
 * suite never touches the host's actual PATH or installs anything.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock `child_process` BEFORE importing the module under test so the
// `spawnSync` reference captured by `functions-prereqs` is the mocked one.
const spawnSyncMock = vi.fn();
vi.mock('child_process', () => ({
  spawnSync: spawnSyncMock,
}));

const osPlatformMock = vi.fn(() => 'win32');
vi.mock('os', () => ({
  platform: osPlatformMock,
}));

let originalPlatform: PropertyDescriptor | undefined;

beforeEach(async () => {
  spawnSyncMock.mockReset();
  osPlatformMock.mockReset();
  osPlatformMock.mockReturnValue('win32');
});

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});

/**
 * Test helper that swaps `process.platform` for the duration of a test.
 * Some code paths in the SUT consult `process.platform` directly (e.g.
 * `formatPrereqsReport` consumers downstream); we keep this here for
 * future-proofing even though the prereq module itself reads `os.platform()`
 * (which we've already mocked above).
 */
function withProcessPlatform(value: 'win32' | 'darwin' | 'linux'): void {
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true,
    writable: false,
  });
}

function mockFuncVersion(version: string | null): void {
  if (version === null) {
    spawnSyncMock.mockReturnValueOnce({
      status: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from('command not found'),
    });
    return;
  }
  spawnSyncMock.mockReturnValueOnce({
    status: 0,
    stdout: Buffer.from(`${version}\n`),
    stderr: Buffer.from(''),
  });
}

describe('inspectFunctionsPrereqs', () => {
  it('reports Node OK when running on Node ≥ 20', async () => {
    mockFuncVersion('4.0.6280');
    const { inspectFunctionsPrereqs } = await import('../functions-prereqs.js');

    const report = inspectFunctionsPrereqs();

    expect(report.node.ok).toBe(true);
    expect(report.node.minimumMajor).toBe(20);
    expect(report.funcCoreTools.ok).toBe(true);
    expect(report.funcCoreTools.version).toBe('4.0.6280');
  });

  it('reports func missing when spawnSync returns non-zero', async () => {
    mockFuncVersion(null);
    const { inspectFunctionsPrereqs } = await import('../functions-prereqs.js');

    const report = inspectFunctionsPrereqs();

    expect(report.funcCoreTools.ok).toBe(false);
    expect(report.funcCoreTools.version).toBeNull();
  });

  it('reports func missing when spawnSync throws (binary not on PATH)', async () => {
    spawnSyncMock.mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    const { inspectFunctionsPrereqs } = await import('../functions-prereqs.js');

    const report = inspectFunctionsPrereqs();

    expect(report.funcCoreTools.ok).toBe(false);
  });

  it('reads func --version through a child_process.spawnSync call (Windows .cmd safe)', async () => {
    // Windows installs Core Tools as `func.cmd`, so the prereq probe
    // must route through `spawnSyncSafe` (which resolves the .cmd shim
    // via `getPlatformCommand` and engages `shell: true` only on the
    // `.cmd` branch). Asserting that `spawnSync` is invoked at all
    // pins the wiring; the Node.js v22+ DEP0190 deprecation prevents
    // us from passing `shell: true` with a separate args array on
    // non-Windows hosts, and the `spawnSyncSafe` unit tests cover the
    // Windows-specific shell + quoting branch.
    mockFuncVersion('4.0.6280');
    const { inspectFunctionsPrereqs } = await import('../functions-prereqs.js');

    inspectFunctionsPrereqs();

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [resolvedCommand, args] = spawnSyncMock.mock.calls[0];
    expect(resolvedCommand).toMatch(/^func(?:\.cmd)?$/);
    // Args may be raw or Windows-quoted depending on resolved command.
    expect(args).toEqual(
      expect.arrayContaining([expect.stringContaining('--version')])
    );
  });

  it('picks the first non-empty stdout line as the version', async () => {
    // Some tools print banner / warning lines first; we must not let
    // those reach the version field.
    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: Buffer.from('\n  4.0.6280 (preview)  \nsecond line\n'),
      stderr: Buffer.from(''),
    });
    const { inspectFunctionsPrereqs } = await import('../functions-prereqs.js');

    const report = inspectFunctionsPrereqs();

    expect(report.funcCoreTools.version).toBe('4.0.6280 (preview)');
  });
});

describe('planFunctionsInstall', () => {
  it('returns an empty plan when nothing is missing', async () => {
    mockFuncVersion('4.0.6280');
    const { inspectFunctionsPrereqs, planFunctionsInstall } =
      await import('../functions-prereqs.js');

    const plan = planFunctionsInstall(inspectFunctionsPrereqs());

    expect(plan).toEqual([]);
  });

  it('uses winget on Windows when func is missing', async () => {
    osPlatformMock.mockReturnValue('win32');
    withProcessPlatform('win32');
    mockFuncVersion(null);
    const { inspectFunctionsPrereqs, planFunctionsInstall } =
      await import('../functions-prereqs.js');

    const plan = planFunctionsInstall(inspectFunctionsPrereqs());

    expect(plan).toHaveLength(1);
    expect(plan[0].command).toBe('winget');
    expect(plan[0].args).toContain('Microsoft.Azure.FunctionsCoreTools');
    expect(plan[0].source).toMatch(/winget/i);
  });

  it('uses Homebrew (two steps: tap + install) on macOS', async () => {
    osPlatformMock.mockReturnValue('darwin');
    withProcessPlatform('darwin');
    mockFuncVersion(null);
    const { inspectFunctionsPrereqs, planFunctionsInstall } =
      await import('../functions-prereqs.js');

    const plan = planFunctionsInstall(inspectFunctionsPrereqs());

    expect(plan).toHaveLength(2);
    expect(plan[0].command).toBe('brew');
    expect(plan[0].args).toEqual(['tap', 'azure/functions']);
    expect(plan[1].command).toBe('brew');
    expect(plan[1].args).toContain('azure-functions-core-tools@4');
  });

  it('falls back to npm global install on Linux', async () => {
    osPlatformMock.mockReturnValue('linux');
    withProcessPlatform('linux');
    mockFuncVersion(null);
    const { inspectFunctionsPrereqs, planFunctionsInstall } =
      await import('../functions-prereqs.js');

    const plan = planFunctionsInstall(inspectFunctionsPrereqs());

    expect(plan).toHaveLength(1);
    expect(plan[0].command).toBe('npm');
    expect(plan[0].args).toEqual([
      'install',
      '-g',
      'azure-functions-core-tools@4',
      '--unsafe-perm',
      'true',
    ]);
  });
});
