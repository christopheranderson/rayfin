import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import { addAllowedRedirectUri } from '@microsoft/rayfin-tools-common/_internal/config';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  validateStaticFolder,
  validateStaticHostingInputs,
  packageStaticFolder,
  MAX_ZIP_SIZE_BYTES,
} from '../../utils/static-hosting-utils';
import { resolveServiceRoot, resolveServiceSubpath } from '../config-utils';

// Lets one test reproduce the Linux behaviour that CI caught and Windows cannot
// show: a large `node --check` diagnostic truncated at the stderr pipe, keeping
// the leading `[stdin]:<line>` header and losing the trailing `SyntaxError:`
// summary. Every other call delegates to the real `spawnSync`.
const truncation = vi.hoisted(() => ({ enabled: false }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: ((...args: Parameters<typeof actual.spawnSync>) => {
      const result = actual.spawnSync(...args);
      if (
        truncation.enabled &&
        typeof result.stderr === 'string' &&
        result.stderr.startsWith('[stdin]:')
      ) {
        return { ...result, stderr: result.stderr.slice(0, 64) };
      }
      return result;
    }) as typeof actual.spawnSync,
  };
});

describe('static-hosting-utils', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `rayfin-static-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('resolveServiceSubpath', () => {
    it('returns the normalized service path that it validated', () => {
      mkdirSync(join(testDir, 'packages', 'frontend'), { recursive: true });

      expect(
        resolveServiceRoot(testDir, 'staticHosting', 'packages\\frontend')
      ).toBe(join(testDir, 'packages', 'frontend'));
    });

    it.each([
      '../outside',
      'nested/../../outside',
      '..\\outside',
      'nested\\..\\..\\outside',
    ])('rejects separator-aware parent traversal: %s', (configuredPath) => {
      const serviceRoot = join(testDir, 'frontend');

      expect(() =>
        resolveServiceSubpath(
          serviceRoot,
          'staticHosting',
          'root',
          configuredPath
        )
      ).toThrow(`root '${configuredPath}' escapes the service root`);
    });

    it.each(['/outside', 'C:\\outside', '\\\\server\\share\\outside'])(
      'rejects POSIX, drive, and UNC absolute roots: %s',
      (configuredPath) => {
        expect(() =>
          resolveServiceSubpath(
            join(testDir, 'frontend'),
            'staticHosting',
            'root',
            configuredPath
          )
        ).toThrow(`root '${configuredPath}' must be a relative path`);
      }
    );

    it('rejects a sibling-prefix path and reports its resolved destination', () => {
      const serviceRoot = join(testDir, 'frontend');
      const sibling = join(testDir, 'frontend-other');

      expect(() =>
        resolveServiceSubpath(
          serviceRoot,
          'staticHosting',
          'root',
          '../frontend-other'
        )
      ).toThrow(sibling);
    });

    it.each(['src/assets', 'src\\assets'])(
      'allows a valid nested root with either separator: %s',
      (configuredPath) => {
        expect(
          resolveServiceSubpath(
            join(testDir, 'frontend'),
            'staticHosting',
            'root',
            configuredPath
          )
        ).toBe(join(testDir, 'frontend', 'src', 'assets'));
      }
    );
  });

  describe('validateStaticHostingInputs', () => {
    it('allows build output to be absent when a build command will create it', () => {
      mkdirSync(join(testDir, 'frontend'));

      expect(() =>
        validateStaticHostingInputs(testDir, {
          enabled: true,
          path: 'frontend',
          folder: 'dist',
          buildCommand: 'npm run build',
        })
      ).not.toThrow();
    });

    it.each(['missing', 'file'])(
      'rejects a %s service path even with a build command',
      (path) => {
        if (path === 'file') writeFileSync(join(testDir, path), '');
        expect(() =>
          validateStaticHostingInputs(testDir, {
            enabled: true,
            path,
            folder: 'dist',
            buildCommand: 'npm run build',
          })
        ).toThrow(`Service 'staticHosting' path '${path}'`);
        expect(() =>
          validateStaticHostingInputs(testDir, {
            enabled: true,
            path,
            folder: 'dist',
            buildCommand: 'npm run build',
          })
        ).toThrow(join(testDir, path));
      }
    );

    it('preserves the service path traversal guard', () => {
      expect(() =>
        validateStaticHostingInputs(testDir, {
          enabled: true,
          path: '../outside',
          folder: 'dist',
          buildCommand: 'npm run build',
        })
      ).toThrow('escapes the project root');
    });

    it('validates a nested build root without requiring generated output', () => {
      mkdirSync(join(testDir, 'package', 'frontend'), { recursive: true });
      expect(() =>
        validateStaticHostingInputs(testDir, {
          enabled: true,
          path: 'package',
          root: 'frontend',
          folder: 'dist',
          buildCommand: 'npm run build',
        })
      ).not.toThrow();
      expect(() =>
        validateStaticHostingInputs(testDir, {
          enabled: true,
          path: 'package',
          root: 'missing',
          folder: 'dist',
          buildCommand: 'npm run build',
        })
      ).toThrow(join(testDir, 'package', 'missing'));
    });

    it.each(['../outside', 'nested/../../outside'])(
      'rejects an existing root outside the service path: %s',
      (root) => {
        mkdirSync(join(testDir, 'packages', 'frontend'), { recursive: true });
        mkdirSync(join(testDir, 'packages', 'outside'), { recursive: true });

        expect(() =>
          validateStaticHostingInputs(testDir, {
            enabled: true,
            path: 'packages/frontend',
            root,
            folder: 'dist',
            buildCommand: 'npm run build',
          })
        ).toThrow(`Service 'staticHosting' root '${root}'`);
        expect(() =>
          validateStaticHostingInputs(testDir, {
            enabled: true,
            path: 'packages/frontend',
            root,
            folder: 'dist',
            buildCommand: 'npm run build',
          })
        ).toThrow(join(testDir, 'packages', 'outside'));
      }
    );

    it('rejects an output folder outside the validated build root', () => {
      mkdirSync(join(testDir, 'frontend'));

      expect(() =>
        validateStaticHostingInputs(testDir, {
          enabled: true,
          path: 'frontend',
          folder: '../outside',
          buildCommand: 'npm run build',
        })
      ).toThrow("Service 'staticHosting' folder '../outside'");
    });

    it('requires nonempty existing output when no build is configured', () => {
      const config = { enabled: true, folder: 'dist' };
      expect(() => validateStaticHostingInputs(testDir, config)).toThrow(
        'Static folder not found'
      );
      mkdirSync(join(testDir, 'dist'));
      expect(() => validateStaticHostingInputs(testDir, config)).toThrow(
        'Static folder is empty'
      );
      writeFileSync(join(testDir, 'dist', 'index.html'), '<html></html>');
      expect(() => validateStaticHostingInputs(testDir, config)).not.toThrow();
    });
  });

  describe('validateStaticFolder', () => {
    it('should return exists=false when folder does not exist', () => {
      const result = validateStaticFolder(testDir, {
        enabled: true,
        folder: 'dist',
      });
      expect(result.exists).toBe(false);
      expect(result.empty).toBe(true);
      expect(result.message).toContain('Static folder not found');
      expect(result.fileCount).toBe(0);
      expect(result.totalSizeBytes).toBe(0);
    });

    it('should return empty=true when folder exists but is empty', () => {
      const distDir = join(testDir, 'dist');
      mkdirSync(distDir, { recursive: true });

      const result = validateStaticFolder(testDir, {
        enabled: true,
        folder: 'dist',
      });
      expect(result.exists).toBe(true);
      expect(result.empty).toBe(true);
      expect(result.message).toContain('Static folder is empty');
      expect(result.fileCount).toBe(0);
    });

    it('should return valid result when folder contains files', () => {
      const distDir = join(testDir, 'dist');
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, 'index.html'), '<html></html>');
      writeFileSync(join(distDir, 'style.css'), 'body {}');

      const result = validateStaticFolder(testDir, {
        enabled: true,
        folder: 'dist',
      });
      expect(result.exists).toBe(true);
      expect(result.empty).toBe(false);
      expect(result.fileCount).toBe(2);
      expect(result.totalSizeBytes).toBeGreaterThan(0);
      expect(result.message).toBeUndefined();
    });

    it('should respect custom root directory', () => {
      const frontendDir = join(testDir, 'frontend', 'build');
      mkdirSync(frontendDir, { recursive: true });
      writeFileSync(join(frontendDir, 'index.html'), '<html></html>');

      const result = validateStaticFolder(testDir, {
        enabled: true,
        root: './frontend',
        folder: 'build',
      });
      expect(result.exists).toBe(true);
      expect(result.empty).toBe(false);
      expect(result.fileCount).toBe(1);
    });

    it('should count files recursively in subdirectories', () => {
      const distDir = join(testDir, 'dist');
      const assetsDir = join(distDir, 'assets');
      mkdirSync(assetsDir, { recursive: true });
      writeFileSync(join(distDir, 'index.html'), '<html></html>');
      writeFileSync(join(assetsDir, 'app.js'), 'console.log("hi")');
      writeFileSync(join(assetsDir, 'style.css'), 'body {}');

      const result = validateStaticFolder(testDir, {
        enabled: true,
        folder: 'dist',
      });
      expect(result.fileCount).toBe(3);
    });

    it('should use default root "." when root is not specified', () => {
      const distDir = join(testDir, 'dist');
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, 'index.html'), '<html></html>');

      const result = validateStaticFolder(testDir, {
        enabled: true,
        folder: 'dist',
      });
      expect(result.exists).toBe(true);
      expect(result.resolvedPath).toContain('dist');
    });
  });

  describe('packageStaticFolder', () => {
    it('should create a valid zip buffer from static files', async () => {
      const distDir = join(testDir, 'dist');
      mkdirSync(distDir, { recursive: true });
      writeFileSync(
        join(distDir, 'index.html'),
        '<html><body>Hello</body></html>'
      );
      writeFileSync(join(distDir, 'app.js'), 'console.log("app")');

      const buffer = await packageStaticFolder(distDir);

      // Verify it's a valid ZIP (starts with PK signature 0x04034b50)
      expect(buffer.length).toBeGreaterThan(0);
      expect(buffer.readUInt32LE(0)).toBe(0x04034b50);
    });

    it('should include files from subdirectories', async () => {
      const distDir = join(testDir, 'dist');
      const assetsDir = join(distDir, 'assets');
      mkdirSync(assetsDir, { recursive: true });
      writeFileSync(join(distDir, 'index.html'), '<html></html>');
      writeFileSync(join(assetsDir, 'style.css'), 'body {}');

      const buffer = await packageStaticFolder(distDir);
      expect(buffer.length).toBeGreaterThan(0);
      expect(buffer.readUInt32LE(0)).toBe(0x04034b50);
    });

    it('should enforce the 100 MB compressed size limit', () => {
      expect(MAX_ZIP_SIZE_BYTES).toBe(100 * 1024 * 1024);
    });

    it('refuses to package a bundle the browser cannot parse', async () => {
      // The measured failure: decorators emitted onto a class *expression*.
      // Vite exits 0, typecheck and lint pass, and the deployed app is a blank
      // page with one console error.
      const distDir = join(testDir, 'dist');
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, 'index.html'), '<html></html>');
      writeFileSync(join(distDir, 'app.js'), 'const C = @dec class {};');

      await expect(packageStaticFolder(distDir)).rejects.toThrow(
        /not parseable JavaScript/u
      );
      // The file has to be named, or the builder is told their app is broken
      // without being told where.
      await expect(packageStaticFolder(distDir)).rejects.toThrow(/app\.js/u);
    });

    it('reads scripts in subdirectories, where bundlers put their chunks', async () => {
      const distDir = join(testDir, 'dist');
      const assetsDir = join(distDir, 'assets');
      mkdirSync(assetsDir, { recursive: true });
      writeFileSync(join(distDir, 'index.html'), '<html></html>');
      writeFileSync(
        join(assetsDir, 'chunk-abc123.js'),
        'const o = { a: 1,, };'
      );

      await expect(packageStaticFolder(distDir)).rejects.toThrow(
        /chunk-abc123\.js/u
      );
    });

    it('accepts module syntax, which every emitted bundle uses', async () => {
      // `--check` reading an ESM chunk as a classic script would fail every
      // valid Vite build, so this pins that it does not.
      const distDir = join(testDir, 'dist');
      mkdirSync(distDir, { recursive: true });
      writeFileSync(
        join(distDir, 'app.js'),
        'import { x } from "./vendor.js";\nexport const a = x;\n'
      );
      writeFileSync(join(distDir, 'vendor.mjs'), 'export const x = 1;\n');

      const buffer = await packageStaticFolder(distDir);
      expect(buffer.readUInt32LE(0)).toBe(0x04034b50);
    });

    it('accepts an ESM bundle sitting under "type": "commonjs"', async () => {
      // For a bare `.js`, Node takes the parse goal from the nearest
      // package.json. Checking the file in place therefore rejected valid ESM
      // whenever `"type": "commonjs"` applied - and on Node 20, which had no
      // module-syntax detection, whenever no `"type"` applied either. That is a
      // healthy app blocked from deploying by where it happens to sit.
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify({ type: 'commonjs' })
      );
      const distDir = join(testDir, 'dist');
      mkdirSync(distDir, { recursive: true });
      writeFileSync(
        join(distDir, 'app.js'),
        'import { x } from "./vendor.js";\nexport const a = x;\n'
      );

      const buffer = await packageStaticFolder(distDir);
      expect(buffer.readUInt32LE(0)).toBe(0x04034b50);
    });

    it('accepts CommonJS-only syntax, which parses under neither goal alone', async () => {
      // `with` is a syntax error in a module and legal in a sloppy-mode script,
      // so this only passes if the check falls back to the script goal rather
      // than reporting the first failure.
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify({ type: 'module' })
      );
      const distDir = join(testDir, 'dist');
      mkdirSync(distDir, { recursive: true });
      writeFileSync(
        join(distDir, 'legacy.js'),
        'function f(o) { with (o) { return a; } }\nmodule.exports = f;\n'
      );

      const buffer = await packageStaticFolder(distDir);
      expect(buffer.readUInt32LE(0)).toBe(0x04034b50);
    });

    it('still rejects source that parses under neither goal', async () => {
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify({ type: 'commonjs' })
      );
      const distDir = join(testDir, 'dist');
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, 'bad.js'), 'const o = { a: 1,, };');

      await expect(packageStaticFolder(distDir)).rejects.toThrow(
        /not parseable JavaScript/u
      );
    });

    it('reports a broken minified bundle as broken, not as an environment failure', async () => {
      // Node echoes the offending line, so one long minified line produces a
      // diagnostic about the size of the source, which the default 1 MB buffer
      // truncates to ENOBUFS with no `SyntaxError` in it.
      const distDir = join(testDir, 'dist');
      mkdirSync(distDir, { recursive: true });
      writeFileSync(
        join(distDir, 'app.js'),
        `const o = {${'a:1,'.repeat(500000)},,};`
      );

      await expect(packageStaticFolder(distDir)).rejects.toThrow(
        /not parseable JavaScript/u
      );
      await expect(packageStaticFolder(distDir)).rejects.not.toThrow(
        /environment problem/u
      );
    });

    it('accepts a large valid minified bundle', async () => {
      // The positive control for the case above: same size, legal syntax. A
      // buffer fix that rejected everything large would also "pass" that test.
      const distDir = join(testDir, 'dist');
      mkdirSync(distDir, { recursive: true });
      writeFileSync(
        join(distDir, 'app.js'),
        `export const o = {${'a:1,'.repeat(500000)}};`
      );

      const buffer = await packageStaticFolder(distDir);
      expect(buffer.readUInt32LE(0)).toBe(0x04034b50);
    });

    it('reports a broken bundle whose diagnostic was truncated mid-stream', async () => {
      // Node emits `[stdin]:<line>`, the offending line in full, then
      // `SyntaxError:`. For a minified bundle the middle part is megabytes, and on
      // Linux the child can exit before it drains, losing the summary. Windows
      // delivers the whole diagnostic, so the truncation is simulated here.
      truncation.enabled = true;
      try {
        const distDir = join(testDir, 'dist');
        mkdirSync(distDir, { recursive: true });
        writeFileSync(join(distDir, 'app.js'), 'const o = { a: 1,, };');

        await expect(packageStaticFolder(distDir)).rejects.toThrow(
          /not parseable JavaScript/u
        );
        await expect(packageStaticFolder(distDir)).rejects.not.toThrow(
          /environment problem/u
        );
      } finally {
        truncation.enabled = false;
      }
    });

    it('sizes the diagnostic buffer in bytes, not UTF-16 units', async () => {
      // A CJK literal is one UTF-16 unit and three UTF-8 bytes, while `maxBuffer`
      // caps bytes. Sizing from `source.length` under-allocates ~3x on non-ASCII
      // bundles and lands back on ENOBUFS.
      const distDir = join(testDir, 'dist');
      mkdirSync(distDir, { recursive: true });
      writeFileSync(
        join(distDir, 'app.js'),
        `const s = ${JSON.stringify('漢'.repeat(1_100_000))};const o = {,,};`
      );

      await expect(packageStaticFolder(distDir)).rejects.toThrow(
        /not parseable JavaScript/u
      );
      await expect(packageStaticFolder(distDir)).rejects.not.toThrow(
        /environment problem/u
      );
    });

    it('ignores non-script files, which are not the browser parsing them', async () => {
      const distDir = join(testDir, 'dist');
      mkdirSync(distDir, { recursive: true });
      // A `.json` or `.css` that happens not to be valid JavaScript is normal.
      writeFileSync(join(distDir, 'data.json'), '{ "a": 1 }');
      writeFileSync(join(distDir, 'style.css'), 'body { color: red }');

      const buffer = await packageStaticFolder(distDir);
      expect(buffer.readUInt32LE(0)).toBe(0x04034b50);
    });
  });

  // ---------------------------------------------------------------------------
  // addAllowedRedirectUri
  // ---------------------------------------------------------------------------

  describe('addAllowedRedirectUri', () => {
    /** Minimal services object with auth + passwordless + magicLink. */
    function servicesWithUris(uris: string[]): RayfinConfig['services'] {
      return {
        auth: {
          enabled: true,
          allowedRedirectUris: uris,
          passwordless: {
            magicLink: {
              enabled: true,
            },
          },
        },
        data: { enabled: false },
        storage: { enabled: false },
        staticHosting: { enabled: false, folder: 'dist' },
      };
    }

    it('should add a new URI to an empty list', () => {
      const services = servicesWithUris([]);
      const result = addAllowedRedirectUri(services, 'https://example.com');
      const uris = result.auth.allowedRedirectUris ?? [];
      expect(uris).toEqual(['https://example.com']);
    });

    it('should preserve existing URIs and append the new one', () => {
      const services = servicesWithUris(['http://localhost:5173']);
      const result = addAllowedRedirectUri(
        services,
        'https://deployed.example.com'
      );
      const uris = result.auth.allowedRedirectUris ?? [];
      expect(uris).toEqual([
        'http://localhost:5173',
        'https://deployed.example.com',
      ]);
    });

    it('should not add a duplicate URI (exact match)', () => {
      const services = servicesWithUris(['https://example.com']);
      const result = addAllowedRedirectUri(services, 'https://example.com');
      const uris = result.auth.allowedRedirectUris ?? [];
      expect(uris).toEqual(['https://example.com']);
      // Should return the same reference when nothing changed
      expect(result).toBe(services);
    });

    it('should deduplicate with case-insensitive comparison', () => {
      const services = servicesWithUris(['https://Example.COM']);
      const result = addAllowedRedirectUri(services, 'https://example.com');
      const uris = result.auth.allowedRedirectUris ?? [];
      expect(uris).toEqual(['https://Example.COM']);
      expect(result).toBe(services);
    });

    it('should deduplicate ignoring trailing slashes', () => {
      const services = servicesWithUris(['https://example.com/']);
      const result = addAllowedRedirectUri(services, 'https://example.com');
      const uris = result.auth.allowedRedirectUris ?? [];
      expect(uris).toEqual(['https://example.com/']);
      expect(result).toBe(services);
    });

    it('should deduplicate with mixed casing AND trailing slash', () => {
      const services = servicesWithUris(['https://Example.COM/']);
      const result = addAllowedRedirectUri(services, 'https://example.com');
      expect(result).toBe(services);
    });

    it('should reject URIs without http(s) scheme', () => {
      const services = servicesWithUris([]);
      expect(() =>
        addAllowedRedirectUri(services, 'ftp://example.com')
      ).toThrow(/Invalid redirect URI scheme/);
      expect(() =>
        addAllowedRedirectUri(services, 'javascript:alert(1)')
      ).toThrow(/Invalid redirect URI scheme/);
      expect(() => addAllowedRedirectUri(services, '//example.com')).toThrow(
        /Invalid redirect URI scheme/
      );
      expect(() => addAllowedRedirectUri(services, 'example.com')).toThrow(
        /Invalid redirect URI scheme/
      );
    });

    it('should allow http:// scheme (localhost use-case)', () => {
      const services = servicesWithUris([]);
      const result = addAllowedRedirectUri(services, 'http://localhost:5173');
      const uris = result.auth.allowedRedirectUris ?? [];
      expect(uris).toEqual(['http://localhost:5173']);
    });

    it('should not mutate the original services object', () => {
      const services = servicesWithUris(['http://localhost:5173']);
      const snapshot = JSON.parse(JSON.stringify(services));
      Object.freeze(services);

      const result = addAllowedRedirectUri(services, 'https://new.example.com');

      // Input unchanged
      expect(services).toEqual(snapshot);
      // Output contains the new URI
      const uris = result.auth.allowedRedirectUris ?? [];
      expect(uris).toContain('https://new.example.com');
      expect(uris).toContain('http://localhost:5173');
      // Result is a different reference
      expect(result).not.toBe(services);
    });

    it('should maintain stable ordering (append-only)', () => {
      let services = servicesWithUris(['http://localhost:5173']);
      services = addAllowedRedirectUri(services, 'https://a.example.com');
      services = addAllowedRedirectUri(services, 'https://b.example.com');
      const uris = services.auth.allowedRedirectUris ?? [];
      expect(uris).toEqual([
        'http://localhost:5173',
        'https://a.example.com',
        'https://b.example.com',
      ]);
    });

    it('should handle missing passwordless config gracefully', () => {
      const services: RayfinConfig['services'] = {
        auth: { enabled: true },
        data: { enabled: false },
        storage: { enabled: false },
        staticHosting: { enabled: false, folder: 'dist' },
      };
      const result = addAllowedRedirectUri(services, 'https://example.com');
      const uris = result.auth.allowedRedirectUris ?? [];
      expect(uris).toEqual(['https://example.com']);
    });
  });
});
