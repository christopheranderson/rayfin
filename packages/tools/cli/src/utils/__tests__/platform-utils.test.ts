import type { ChildProcess } from 'node:child_process';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';

import {
  getPlatformCommand,
  isWindows,
  needsWindowsShell,
  pathListSeparator,
  quoteWindowsArg,
  spawnSafe,
  spawnSyncSafe,
  terminateWindowsProcessTree,
} from '../platform-utils.js';

// The module-level `isWindows` / `pathListSeparator` are captured at import
// time, so they reflect the actual OS.  The tests below validate the exported
// functions whose results can be influenced by mocking `process.platform`.

describe('platform-utils', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  // -----------------------------------------------------------------------
  // isWindows
  // -----------------------------------------------------------------------

  describe('isWindows', () => {
    it('should be a boolean', () => {
      expect(typeof isWindows).toBe('boolean');
    });

    it('should match current process.platform', () => {
      expect(isWindows).toBe(process.platform === 'win32');
    });
  });

  // -----------------------------------------------------------------------
  // pathListSeparator
  // -----------------------------------------------------------------------

  describe('pathListSeparator', () => {
    describe('on Unix-like platforms', () => {
      beforeEach(() => {
        Object.defineProperty(process, 'platform', {
          value: 'linux',
          configurable: true,
        });
      });

      it('should be ":" on non-Windows platforms', () => {
        if (!isWindows) {
          expect(pathListSeparator).toBe(':');
        }
      });
    });

    describe('on macOS', () => {
      beforeEach(() => {
        Object.defineProperty(process, 'platform', {
          value: 'darwin',
          configurable: true,
        });
      });

      it('should be ":" on macOS', () => {
        if (!isWindows) {
          expect(pathListSeparator).toBe(':');
        }
      });
    });

    describe('on Windows', () => {
      beforeEach(() => {
        Object.defineProperty(process, 'platform', {
          value: 'win32',
          configurable: true,
        });
      });

      it('should be ";" on Windows', () => {
        if (isWindows) {
          expect(pathListSeparator).toBe(';');
        }
      });
    });

    it('should be one of the two valid separators', () => {
      expect([':', ';']).toContain(pathListSeparator);
    });
  });

  // -----------------------------------------------------------------------
  // getPlatformCommand
  // -----------------------------------------------------------------------

  describe('getPlatformCommand', () => {
    describe('on Unix-like platforms', () => {
      beforeEach(() => {
        Object.defineProperty(process, 'platform', {
          value: 'linux',
          configurable: true,
        });
      });

      it('should return "npm" unchanged', () => {
        // Note: getPlatformCommand reads the module-level `isWindows` which
        // was captured at import time.  On a real Unix machine this test
        // exercises the happy path.  On Windows (hypothetically) the dynamic
        // mock won't affect the already-captured constant — that's expected
        // and covered by the spawn-level integration tests.
        if (!isWindows) {
          expect(getPlatformCommand('npm')).toBe('npm');
        }
      });

      it('should return "npx" unchanged', () => {
        if (!isWindows) {
          expect(getPlatformCommand('npx')).toBe('npx');
        }
      });

      it('should return unknown commands unchanged', () => {
        if (!isWindows) {
          expect(getPlatformCommand('docker')).toBe('docker');
        }
      });
    });

    describe('on macOS', () => {
      beforeEach(() => {
        Object.defineProperty(process, 'platform', {
          value: 'darwin',
          configurable: true,
        });
      });

      it('should return "npm" unchanged', () => {
        if (!isWindows) {
          expect(getPlatformCommand('npm')).toBe('npm');
        }
      });

      it('should return "npx" unchanged', () => {
        if (!isWindows) {
          expect(getPlatformCommand('npx')).toBe('npx');
        }
      });

      it('should return unknown commands unchanged', () => {
        if (!isWindows) {
          expect(getPlatformCommand('docker')).toBe('docker');
        }
      });
    });

    describe('on Windows', () => {
      // These tests can only truly run on Windows.  On Unix they are skipped
      // because the module-level constant was already resolved at import time.
      it('should append .cmd to npm on Windows', () => {
        if (isWindows) {
          expect(getPlatformCommand('npm')).toBe('npm.cmd');
        }
      });

      it('should append .cmd to npx on Windows', () => {
        if (isWindows) {
          expect(getPlatformCommand('npx')).toBe('npx.cmd');
        }
      });

      it('should NOT append .cmd to unknown commands on Windows', () => {
        if (isWindows) {
          expect(getPlatformCommand('docker')).toBe('docker');
        }
      });
    });

    it('should never modify commands that are not in the known set', () => {
      // Platform-independent assertion
      expect(getPlatformCommand('git')).toBe('git');
      expect(getPlatformCommand('node')).toBe('node');
      expect(getPlatformCommand('docker')).toBe('docker');
    });

    it('should NOT append .cmd to func (shell-resolved via PATHEXT instead)', () => {
      // func may be installed as func.cmd (npm) or func.exe (winget/MSI).
      // getPlatformCommand returns the bare name; shell:true handles resolution.
      expect(getPlatformCommand('func')).toBe('func');
    });
  });

  // -----------------------------------------------------------------------
  // needsWindowsShell
  // -----------------------------------------------------------------------

  describe('needsWindowsShell', () => {
    it('returns true for .cmd resolved commands on Windows', () => {
      if (isWindows) {
        expect(needsWindowsShell('npm', 'npm.cmd')).toBe(true);
      }
    });

    it('returns true for shell-resolved commands (func) on Windows', () => {
      if (isWindows) {
        // func is not appended with .cmd but still needs shell:true for PATHEXT
        expect(needsWindowsShell('func', 'func')).toBe(true);
      }
    });

    it('returns false for unknown commands on Windows', () => {
      if (isWindows) {
        expect(needsWindowsShell('node', 'node')).toBe(false);
      }
    });

    it('returns false on non-Windows regardless of command', () => {
      if (!isWindows) {
        expect(needsWindowsShell('func', 'func')).toBe(false);
        expect(needsWindowsShell('npm', 'npm.cmd')).toBe(false);
      }
    });
  });

  // -----------------------------------------------------------------------
  // quoteWindowsArg
  // -----------------------------------------------------------------------

  describe('quoteWindowsArg', () => {
    it('wraps a plain flag in double quotes', () => {
      expect(quoteWindowsArg('-p')).toBe('"-p"');
    });

    it('wraps a plain identifier in double quotes', () => {
      expect(quoteWindowsArg('tsc')).toBe('"tsc"');
    });

    it('handles a typical Windows path without trailing backslash', () => {
      expect(quoteWindowsArg('C:\\Users\\name\\project')).toBe(
        '"C:\\Users\\name\\project"'
      );
    });

    it('handles a path with spaces', () => {
      expect(quoteWindowsArg('C:\\Users\\John Doe\\project')).toBe(
        '"C:\\Users\\John Doe\\project"'
      );
    });

    it('handles the OneDrive-style path from the review comment', () => {
      expect(
        quoteWindowsArg('C:\\User\\copilot\\OneDrive - Documents\\rayfin')
      ).toBe('"C:\\User\\copilot\\OneDrive - Documents\\rayfin"');
    });

    it('doubles a single trailing backslash to protect the closing quote', () => {
      // 'C:\trailing\' → "C:\trailing\\"
      expect(quoteWindowsArg('C:\\trailing\\')).toBe('"C:\\trailing\\\\"');
    });

    it('doubles multiple trailing backslashes', () => {
      // Input: C:\two\\  (two trailing backslashes) → "C:\two\\\\"
      expect(quoteWindowsArg('C:\\two\\\\')).toBe('"C:\\two\\\\\\\\"');
    });

    it('handles an empty string', () => {
      expect(quoteWindowsArg('')).toBe('""');
    });
  });

  // -----------------------------------------------------------------------
  // spawnSafe
  // -----------------------------------------------------------------------

  describe('spawnSafe', () => {
    it('should return a ChildProcess with a pid', () => {
      const child = spawnSafe('node', ['--version']);
      expect(child).toBeDefined();
      expect(child.pid).toBeDefined();
      child.kill();
    });

    it('should successfully run a command and capture output', async () => {
      const result = await new Promise<string>((resolve, reject) => {
        const child = spawnSafe('node', ['-e', 'console.log("hello-safe")']);
        let output = '';
        child.stdout?.on('data', (data) => {
          output += data.toString();
        });
        child.on('close', (code) => {
          if (code === 0) resolve(output.trim());
          else reject(new Error(`Exit code: ${code}`));
        });
        child.on('error', reject);
      });

      expect(result).toBe('hello-safe');
    });

    it('should pass cwd option correctly', async () => {
      const { tmpdir } = await import('os');
      const { realpathSync } = await import('fs');
      // Use realpathSync to resolve symlinks (e.g. macOS /var → /private/var)
      const cwd = realpathSync(tmpdir());

      const result = await new Promise<string>((resolve, reject) => {
        const child = spawnSafe('node', ['-e', 'console.log(process.cwd())'], {
          cwd,
        });
        let output = '';
        child.stdout?.on('data', (data) => {
          output += data.toString();
        });
        child.on('close', (code) => {
          if (code === 0) resolve(output.trim());
          else reject(new Error(`Exit code: ${code}`));
        });
        child.on('error', reject);
      });

      expect(result).toBe(cwd);
    });

    it('should handle paths with spaces in arguments', async () => {
      const result = await new Promise<string>((resolve, reject) => {
        const child = spawnSafe('node', [
          '-e',
          'console.log(process.argv[1])',
          '--',
          'path with spaces',
        ]);
        let output = '';
        child.stdout?.on('data', (data) => {
          output += data.toString();
        });
        child.on('close', (code) => {
          if (code === 0) resolve(output.trim());
          else reject(new Error(`Exit code: ${code}`));
        });
        child.on('error', reject);
      });

      expect(result).toBe('path with spaces');
    });

    it('should resolve npm to the correct platform command', async () => {
      // We can't inspect the spawned command directly without mocking,
      // but we can verify through getPlatformCommand which spawnSafe uses.
      const expected = isWindows ? 'npm.cmd' : 'npm';
      expect(getPlatformCommand('npm')).toBe(expected);
    });
  });

  // -----------------------------------------------------------------------
  // spawnSyncSafe
  // -----------------------------------------------------------------------

  describe('spawnSyncSafe', () => {
    it('returns the spawnSync result with a zero exit code on success', () => {
      const result = spawnSyncSafe('node', ['--version']);
      expect(result.status).toBe(0);
      const stdout = String(result.stdout ?? '').trim();
      expect(stdout).toMatch(/^v\d+\.\d+\.\d+/);
    });

    it('captures stdout when stdio is piped', () => {
      const result = spawnSyncSafe(
        'node',
        ['-e', 'console.log("hello-sync-safe")'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      expect(result.status).toBe(0);
      expect(String(result.stdout ?? '').trim()).toBe('hello-sync-safe');
    });

    it('reports a non-zero status for failed commands without throwing', () => {
      // Use node -e with a process.exit(7) so we exercise the synchronous
      // exit-status surface without relying on a binary that may not be on
      // PATH on every CI host.
      const result = spawnSyncSafe('node', ['-e', 'process.exit(7)'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      expect(result.status).toBe(7);
    });
  });
});

describe('terminateWindowsProcessTree', () => {
  it('warns before falling back to killing only the shell wrapper', () => {
    const kill = vi.fn();
    const warn = vi.fn();

    terminateWindowsProcessTree(
      { kill } as unknown as ChildProcess,
      42,
      'SIGTERM',
      warn,
      () => ({ status: 1 })
    );

    expect(warn).toHaveBeenCalledWith(
      'Could not terminate the process tree for PID 42; a stray `func` or `node` process may remain.'
    );
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not warn or kill the wrapper when taskkill succeeds', () => {
    const kill = vi.fn();
    const warn = vi.fn();

    terminateWindowsProcessTree(
      { kill } as unknown as ChildProcess,
      42,
      'SIGTERM',
      warn,
      () => ({ status: 0 })
    );

    expect(warn).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it('does not warn when the process already exited (Ctrl+C reached it first)', () => {
    const kill = vi.fn();
    const warn = vi.fn();

    terminateWindowsProcessTree(
      { kill } as unknown as ChildProcess,
      42,
      'SIGTERM',
      warn,
      () => ({ status: 128 })
    );

    expect(warn).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });
});
