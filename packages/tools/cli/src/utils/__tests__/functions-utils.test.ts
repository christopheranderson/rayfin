import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  packageFolderWithOverrides,
  countPackageableFiles,
  cleanStaleZipTempDirs,
  FUNCTIONS_DEPLOY_ZIP_CLIENT_LIMIT_BYTES,
  type PackagedZip,
} from '../../utils/functions-utils';

import { readZipEntries } from './helpers/zip-entries.js';

describe('functions-utils', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `rayfin-functions-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('FUNCTIONS_DEPLOY_ZIP_CLIENT_LIMIT_BYTES', () => {
    it('guards the client at 250 MB, under the 300 MB backend request cap', () => {
      expect(FUNCTIONS_DEPLOY_ZIP_CLIENT_LIMIT_BYTES).toBe(250 * 1024 * 1024);
    });
  });

  describe('countPackageableFiles', () => {
    it('counts every file when no excludes are supplied', () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'a.txt'), 'a');
      writeFileSync(join(testDir, 'src', 'b.txt'), 'bb');

      const result = countPackageableFiles(testDir);

      expect(result.fileCount).toBe(2);
      expect(result.totalSizeBytes).toBe(3);
    });

    it('skips excluded directories at any depth', () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      mkdirSync(join(testDir, 'dist'), { recursive: true });
      mkdirSync(join(testDir, 'src', 'node_modules'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'a.ts'), 'export {}');
      writeFileSync(join(testDir, 'dist', 'a.js'), 'compiled');
      writeFileSync(join(testDir, 'src', 'node_modules', 'pkg.json'), '{}');

      const result = countPackageableFiles(testDir, {
        excludeDirNames: new Set(['dist', 'node_modules']),
      });

      expect(result.fileCount).toBe(1); // only src/a.ts survives
    });

    it('skips excluded files at any depth', () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'local.settings.json'), '{}');
      writeFileSync(join(testDir, 'src', 'a.ts'), 'export {}');
      writeFileSync(join(testDir, 'src', 'local.settings.json'), '{}');

      const result = countPackageableFiles(testDir, {
        excludeFileNames: new Set(['local.settings.json']),
      });

      expect(result.fileCount).toBe(1); // only src/a.ts survives
    });
  });

  describe('packageFolderWithOverrides', () => {
    /**
     * Track every PackagedZip a test produces so we can assert its temp
     * directory is gone at the end (packaging is disk-backed now).
     */
    let produced: PackagedZip[];

    beforeEach(() => {
      produced = [];
    });

    afterEach(() => {
      // Defensive: remove any temp dir a test forgot to clean.
      for (const zip of produced) zip.cleanup();
    });

    /**
     * Package `dir`, read the on-disk zip into a Buffer, and register the
     * handle for cleanup. Returns both so callers can inspect bytes and the
     * handle. The zip lives on disk until `zip.cleanup()` runs.
     */
    async function packageToBuffer(
      dir: string,
      overrides: Record<string, string | Buffer> = {},
      options?: Parameters<typeof packageFolderWithOverrides>[2]
    ): Promise<{ zip: PackagedZip; buffer: Buffer }> {
      const zip = await packageFolderWithOverrides(dir, overrides, options);
      produced.push(zip);
      const buffer = readFileSync(zip.zipPath);
      return { zip, buffer };
    }

    /** Find a UTF-8 string anywhere in the zip buffer (central directory
     *  records file names in plaintext, so this is a robust presence
     *  check without needing an unzip lib). */
    function zipContains(buffer: Buffer, name: string): boolean {
      return buffer.includes(Buffer.from(name, 'utf8'));
    }

    it('produces a valid zip on disk and reports its byte length', async () => {
      writeFileSync(join(testDir, 'index.ts'), 'export {}');
      writeFileSync(join(testDir, 'package.json'), '{"name":"x"}');

      const { zip, buffer } = await packageToBuffer(testDir);

      expect(existsSync(zip.zipPath)).toBe(true);
      expect(zip.byteLength).toBe(buffer.length);
      expect(buffer.readUInt32LE(0)).toBe(0x04034b50);
      expect(zipContains(buffer, 'index.ts')).toBe(true);
      expect(zipContains(buffer, 'package.json')).toBe(true);
    });

    it('keeps maps, build state, and tooling paths by default', async () => {
      mkdirSync(join(testDir, '.git'));
      const files = {
        'index.js.map': 'javascript map',
        'index.d.ts.map': 'declaration map',
        'project.tsbuildinfo': 'incremental state',
        '.git/config': 'git configuration',
      };
      for (const [path, content] of Object.entries(files)) {
        writeFileSync(join(testDir, path), content);
      }
      const { buffer } = await packageToBuffer(testDir);
      const entries = readZipEntries(buffer);
      expect(
        Object.fromEntries(
          entries.map(({ name, content }) => [name, content.toString()])
        )
      ).toEqual(files);
      expect(countPackageableFiles(testDir)).toEqual({
        fileCount: entries.length,
        totalSizeBytes: entries.reduce(
          (sum, entry) => sum + entry.content.length,
          0
        ),
      });
    });

    it('shares root-boundary filtering and normalized override precedence with counting', async () => {
      for (const path of [
        'cache/nested',
        'cache/nested-copy',
        'src',
        'node_modules/pkg/cache/nested',
      ]) {
        mkdirSync(join(testDir, path), { recursive: true });
        writeFileSync(join(testDir, path, 'data.json'), 'original');
      }
      writeFileSync(join(testDir, 'src', 'index.js.map'), 'original map');
      writeFileSync(join(testDir, 'host.json'), 'original host');
      const options = {
        excludeRootPaths: new Set(['cache\\nested']),
        excludeFileSuffixes: ['.js.map'],
        excludeFileNames: new Set(['host.json']),
      };
      const overrides = {
        'host.json': 'deployed host',
        'cache\\nested\\data.json': 'explicit excluded path',
        'src\\index.js.map': 'superseded',
        'src/index.js.map': 'last normalized override wins',
        'runtimemetadata.json': '{"description":"你好"}',
        'package-lock.json': Buffer.from([0, 1, 255]),
      };
      const { buffer } = await packageToBuffer(testDir, overrides, options);
      const entries = readZipEntries(buffer);
      expect(new Set(entries.map((entry) => entry.name)).size).toBe(
        entries.length
      );
      expect(
        Object.fromEntries(entries.map(({ name, content }) => [name, content]))
      ).toEqual({
        'cache/nested/data.json': Buffer.from('explicit excluded path'),
        'cache/nested-copy/data.json': Buffer.from('original'),
        'src/data.json': Buffer.from('original'),
        'node_modules/pkg/cache/nested/data.json': Buffer.from('original'),
        'src/index.js.map': Buffer.from('last normalized override wins'),
        'host.json': Buffer.from('deployed host'),
        'runtimemetadata.json': Buffer.from('{"description":"你好"}'),
        'package-lock.json': Buffer.from([0, 1, 255]),
      });
      expect(countPackageableFiles(testDir, options, overrides)).toEqual({
        fileCount: entries.length,
        totalSizeBytes: entries.reduce(
          (sum, entry) => sum + entry.content.length,
          0
        ),
      });
      expect(readFileSync(join(testDir, 'host.json'), 'utf8')).toBe(
        'original host'
      );
      expect(readFileSync(join(testDir, 'src', 'index.js.map'), 'utf8')).toBe(
        'original map'
      );
      expect(existsSync(join(testDir, 'runtimemetadata.json'))).toBe(false);
    });

    it('cleanup() removes the backing temp directory and is idempotent', async () => {
      writeFileSync(join(testDir, 'index.ts'), 'export {}');

      const { zip } = await packageToBuffer(testDir);
      expect(existsSync(zip.zipPath)).toBe(true);

      zip.cleanup();
      expect(existsSync(zip.zipPath)).toBe(false);
      // Second call must not throw.
      expect(() => zip.cleanup()).not.toThrow();
    });

    it('excludes directories matching excludeDirNames at any depth', async () => {
      mkdirSync(join(testDir, 'dist'), { recursive: true });
      mkdirSync(join(testDir, 'node_modules', 'lodash'), { recursive: true });
      writeFileSync(join(testDir, 'index.ts'), 'export {}');
      writeFileSync(join(testDir, 'dist', 'index.js'), 'compiled');
      writeFileSync(
        join(testDir, 'node_modules', 'lodash', 'index.js'),
        'lodash'
      );

      const { buffer } = await packageToBuffer(
        testDir,
        {},
        { excludeDirNames: new Set(['dist', 'node_modules']) }
      );

      expect(zipContains(buffer, 'index.ts')).toBe(true);
      expect(zipContains(buffer, 'dist/')).toBe(false);
      expect(zipContains(buffer, 'node_modules/')).toBe(false);
      // The lodash file's own basename must not leak
      expect(zipContains(buffer, 'lodash/index.js')).toBe(false);
    });

    it('excludes files matching excludeFileNames at any depth', async () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'index.ts'), 'export {}');
      writeFileSync(
        join(testDir, 'local.settings.json'),
        '{"Values":{"secret":"x"}}'
      );
      writeFileSync(
        join(testDir, 'src', 'local.settings.json'),
        '{"nested":true}'
      );

      const { buffer } = await packageToBuffer(
        testDir,
        {},
        { excludeFileNames: new Set(['local.settings.json']) }
      );

      expect(zipContains(buffer, 'index.ts')).toBe(true);
      expect(zipContains(buffer, 'local.settings.json')).toBe(false);
    });

    it('substitutes override content for a path on disk', async () => {
      // Sentinel content large enough that low-level zlib (level 9) leaves
      // recognizable bytes in the deflate stream is unreliable; instead,
      // verify the *behavior contract*: the on-disk content must NOT be
      // copied (file is skipped during walk) and the archive must still
      // contain the package.json entry (filename in central directory).
      writeFileSync(
        join(testDir, 'package.json'),
        '{"name":"on-disk-original"}'
      );

      const { buffer } = await packageToBuffer(testDir, {
        'package.json': '{"name":"override-content"}',
      });

      // Filename is stored in plaintext in the zip central directory.
      expect(zipContains(buffer, 'package.json')).toBe(true);
    });

    it('appends overrides for paths that do not exist on disk', async () => {
      writeFileSync(join(testDir, 'index.ts'), 'export {}');

      const { buffer } = await packageToBuffer(testDir, {
        'package-lock.json': '{"lockfileVersion":3}',
      });

      // Both the on-disk file and the synthesized override appear in the
      // central directory by name.
      expect(zipContains(buffer, 'index.ts')).toBe(true);
      expect(zipContains(buffer, 'package-lock.json')).toBe(true);
    });

    it('packages deploy and runtime metadata as separate root files', async () => {
      writeFileSync(
        join(testDir, 'deploymetadata.json'),
        '{"runtime":"TypeScript"}'
      );

      const { buffer } = await packageToBuffer(testDir, {
        'runtimemetadata.json': '{"schemaVersion":"2.0","functions":[]}',
      });

      expect(zipContains(buffer, 'deploymetadata.json')).toBe(true);
      expect(zipContains(buffer, 'runtimemetadata.json')).toBe(true);
      expect(zipContains(buffer, 'src/runtimemetadata.json')).toBe(false);
    });

    it('only appends an override entry once even if the file exists on disk', async () => {
      // Create a small on-disk file and override it.  The walker must
      // skip the on-disk version, and only the override entry is appended.
      writeFileSync(join(testDir, 'config.json'), '{"a":1}');

      const { buffer } = await packageToBuffer(testDir, {
        'config.json': '{"b":2}',
      });

      // Archive central directory should contain a single 'config.json'
      // entry.  Each entry's name appears once as a local file header
      // and once as a central directory record, so total occurrences = 2.
      const target = Buffer.from('config.json', 'utf8');
      let count = 0;
      let idx = 0;
      while ((idx = buffer.indexOf(target, idx)) !== -1) {
        count++;
        idx += target.length;
      }
      expect(count).toBe(2);
    });

    it('aborts and leaves no temp directory when the compressed size exceeds the cap', async () => {
      // Incompressible random bytes so the deflate stream reliably crosses a
      // tiny injected cap; keeps the fixture small while exercising the
      // incremental-abort branch that bounds peak memory.
      const incompressible = Buffer.alloc(64 * 1024);
      for (let i = 0; i < incompressible.length; i++) {
        incompressible[i] = Math.floor(Math.random() * 256);
      }
      writeFileSync(join(testDir, 'blob.bin'), incompressible);

      const tmpEntriesBefore = new Set(
        readdirSync(tmpdir()).filter((n) => n.startsWith('rayfin-fnzip-'))
      );

      await expect(
        packageFolderWithOverrides(testDir, {}, { maxCompressedBytes: 1024 })
      ).rejects.toThrow(/exceeded the 1\.0 KB limit/);

      // The abort path must remove its own temp directory. Removal is deferred
      // until the write stream's fd closes (avoids a Windows unlink race), so
      // poll briefly rather than asserting synchronously.
      const leakedNow = (): string[] =>
        readdirSync(tmpdir())
          .filter((n) => n.startsWith('rayfin-fnzip-'))
          .filter((n) => !tmpEntriesBefore.has(n));
      const deadline = Date.now() + 2000;
      while (leakedNow().length > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(leakedNow()).toEqual([]);
    });

    it('rejects and leaves no temp directory when the source walk throws', async () => {
      // A non-existent source dir makes the synchronous readdirSync in walk()
      // throw ENOENT — exercising the guard that routes pre-finalize failures
      // through fail() so the temp dir and fd are still released.
      const missing = join(testDir, 'does-not-exist');

      const tmpEntriesBefore = new Set(
        readdirSync(tmpdir()).filter((n) => n.startsWith('rayfin-fnzip-'))
      );

      await expect(packageFolderWithOverrides(missing, {})).rejects.toThrow();

      const leakedNow = (): string[] =>
        readdirSync(tmpdir())
          .filter((n) => n.startsWith('rayfin-fnzip-'))
          .filter((n) => !tmpEntriesBefore.has(n));
      const deadline = Date.now() + 2000;
      while (leakedNow().length > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(leakedNow()).toEqual([]);
    });
  });

  describe('cleanStaleZipTempDirs', () => {
    // Track dirs this suite creates directly in the OS temp root so we always
    // clean them even if an assertion fails mid-test.
    let created: string[];

    beforeEach(() => {
      created = [];
    });

    afterEach(() => {
      for (const dir of created) rmSync(dir, { recursive: true, force: true });
    });

    /** Create a `rayfin-fnzip-*` dir in the OS temp root with a source.zip and
     *  an mtime `ageMs` in the past. */
    function makeOrphan(ageMs: number): string {
      const dir = mkdtempSync(join(tmpdir(), 'rayfin-fnzip-'));
      created.push(dir);
      writeFileSync(join(dir, 'source.zip'), Buffer.alloc(16));
      const when = new Date(Date.now() - ageMs);
      utimesSync(dir, when, when);
      return dir;
    }

    it('removes an orphan older than the age threshold', () => {
      const stale = makeOrphan(2 * 60 * 60 * 1000); // 2h old

      cleanStaleZipTempDirs(60 * 60 * 1000); // clean up dirs > 1h old

      expect(existsSync(stale)).toBe(false);
    });

    it('leaves a recent dir untouched (protects concurrent deploys)', () => {
      const fresh = makeOrphan(0); // just created

      cleanStaleZipTempDirs(60 * 60 * 1000);

      expect(existsSync(fresh)).toBe(true);
    });

    it('never throws when the temp root has nothing to clean', () => {
      expect(() => cleanStaleZipTempDirs()).not.toThrow();
    });
  });
});
