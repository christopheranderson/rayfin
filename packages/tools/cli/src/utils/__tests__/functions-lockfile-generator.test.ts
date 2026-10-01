import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { resolveDeployLockfile } from '../functions-lockfile-generator';

describe('functions-lockfile-generator', () => {
  let functionsDir: string;

  beforeEach(() => {
    functionsDir = join(
      tmpdir(),
      `rayfin-lockfile-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    );
    mkdirSync(functionsDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(functionsDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  function writePackageJson(pkg: Record<string, unknown>): void {
    writeFileSync(
      join(functionsDir, 'package.json'),
      JSON.stringify(pkg, null, 2),
      'utf8'
    );
  }

  describe('on-disk source', () => {
    it('returns the on-disk lockfile verbatim when present', async () => {
      writePackageJson({ name: 'sample', version: '1.0.0' });
      const lockfileContent = JSON.stringify({
        name: 'sample',
        lockfileVersion: 3,
        packages: { '': { name: 'sample', version: '1.0.0' } },
      });
      writeFileSync(
        join(functionsDir, 'package-lock.json'),
        lockfileContent,
        'utf8'
      );

      const result = await resolveDeployLockfile(functionsDir);

      expect(result.source).toBe('on-disk');
      expect(result.lockfileJson).toBe(lockfileContent);
      expect(result.warning).toBeUndefined();
    });
  });

  describe('unavailable source', () => {
    it('returns unavailable when package.json is missing', async () => {
      // No package.json written.
      const result = await resolveDeployLockfile(functionsDir);

      expect(result.source).toBe('unavailable');
      expect(result.lockfileJson).toBeUndefined();
      expect(result.warning).toMatch(/package\.json not found/);
    });

    it('returns unavailable when npm install fails (timeout)', async () => {
      // Provide a package.json that references a non-existent local file
      // dep so npm install will error out promptly.
      writePackageJson({
        name: 'sample',
        version: '1.0.0',
        dependencies: {
          'nonexistent-dep': 'file:./does-not-exist.tgz',
        },
      });

      const result = await resolveDeployLockfile(functionsDir, {
        timeoutMs: 30_000,
      });

      // The npm install should fail; we expect 'unavailable' (not a throw).
      expect(result.source).toBe('unavailable');
      expect(result.warning).toBeDefined();
      expect(result.warning!.length).toBeGreaterThan(0);
    }, 60_000);

    it('does not throw on failure', async () => {
      writePackageJson({
        name: 'sample',
        dependencies: { 'no-such-dep': 'file:./missing.tgz' },
      });

      // The function must not throw — caller decides whether to deploy
      // without a lockfile.
      await expect(resolveDeployLockfile(functionsDir)).resolves.toBeDefined();
    }, 60_000);
  });

  describe('generated source', () => {
    it('does not mutate the source functions folder', async () => {
      writePackageJson({ name: 'sample', version: '1.0.0' });
      const beforeSnapshot = readFileSync(
        join(functionsDir, 'package.json'),
        'utf8'
      );

      await resolveDeployLockfile(functionsDir, { timeoutMs: 30_000 });

      // package.json content unchanged.
      const afterSnapshot = readFileSync(
        join(functionsDir, 'package.json'),
        'utf8'
      );
      expect(afterSnapshot).toBe(beforeSnapshot);
      // No lockfile materialized in the source folder.
      expect(existsSync(join(functionsDir, 'package-lock.json'))).toBe(false);
      // No node_modules materialized in the source folder.
      expect(existsSync(join(functionsDir, 'node_modules'))).toBe(false);
    }, 60_000);
  });
});
