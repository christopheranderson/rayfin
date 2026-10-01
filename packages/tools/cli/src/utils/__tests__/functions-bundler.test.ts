import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  BUNDLE_OUTPUT_DIRNAME,
  RETAINED_METAFILE_FILENAME,
  RETAINED_ZIP_ROOT_DIRNAME,
  buildBundledPackageJson,
  bundleFunctionsForDeploy,
  resolveFunctionsEntryPoint,
  resolveRetainedBundleDir,
} from '../functions-bundler.js';

describe('functions-bundler', () => {
  let functionsDir: string;

  beforeEach(() => {
    functionsDir = mkdtempSync(join(tmpdir(), 'rayfin-bundler-test-'));
    mkdirSync(join(functionsDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    rmSync(functionsDir, { recursive: true, force: true });
  });

  describe('resolveFunctionsEntryPoint', () => {
    it('prefers the TypeScript entry point when present', () => {
      writeFileSync(join(functionsDir, 'src', 'function_app.ts'), '');
      writeFileSync(join(functionsDir, 'src', 'function_app.js'), '');

      expect(resolveFunctionsEntryPoint(functionsDir)).toBe(
        join(functionsDir, 'src', 'function_app.ts')
      );
    });

    it('falls back to the JavaScript entry point', () => {
      writeFileSync(join(functionsDir, 'src', 'function_app.js'), '');

      expect(resolveFunctionsEntryPoint(functionsDir)).toBe(
        join(functionsDir, 'src', 'function_app.js')
      );
    });

    it('honors an explicit entry point override', () => {
      writeFileSync(join(functionsDir, 'src', 'custom.ts'), '');

      expect(resolveFunctionsEntryPoint(functionsDir, 'src/custom.ts')).toBe(
        join(functionsDir, 'src', 'custom.ts')
      );
    });

    it('throws when an explicit entry point is missing', () => {
      expect(() =>
        resolveFunctionsEntryPoint(functionsDir, 'src/missing.ts')
      ).toThrow(/entry point not found/i);
    });

    it('throws and names the candidates when no entry point exists', () => {
      expect(() => resolveFunctionsEntryPoint(functionsDir)).toThrow(
        /src\/function_app\.ts/
      );
    });
  });

  describe('buildBundledPackageJson', () => {
    it('carries over name and version and points main at the bundle', () => {
      writeFileSync(
        join(functionsDir, 'package.json'),
        JSON.stringify({ name: '@rayfin-app/functions', version: '1.2.3' })
      );

      const pkg = JSON.parse(
        buildBundledPackageJson(functionsDir, 'function_app.js')
      );

      expect(pkg).toMatchObject({
        name: '@rayfin-app/functions',
        version: '1.2.3',
        type: 'module',
        main: `${BUNDLE_OUTPUT_DIRNAME}/function_app.js`,
      });
    });

    it('drops dependencies so the remote host never tries to install them', () => {
      writeFileSync(
        join(functionsDir, 'package.json'),
        JSON.stringify({
          name: '@rayfin-app/functions',
          version: '1.0.0',
          dependencies: { '@rayfin-app/shared': '*' },
          devDependencies: { typescript: '^5.8.3' },
        })
      );

      const pkg = JSON.parse(
        buildBundledPackageJson(functionsDir, 'function_app.js')
      );

      expect(pkg.dependencies).toBeUndefined();
      expect(pkg.devDependencies).toBeUndefined();
    });

    it('falls back to defaults when package.json is absent', () => {
      const pkg = JSON.parse(
        buildBundledPackageJson(functionsDir, 'function_app.js')
      );

      expect(pkg.name).toBe('rayfin-functions');
      expect(pkg.version).toBe('0.0.0');
    });

    it('falls back to defaults when package.json is malformed', () => {
      writeFileSync(join(functionsDir, 'package.json'), '{ not json');

      const pkg = JSON.parse(
        buildBundledPackageJson(functionsDir, 'function_app.js')
      );

      expect(pkg.name).toBe('rayfin-functions');
    });
  });

  describe('resolveRetainedBundleDir', () => {
    it('returns undefined when the variable is unset', () => {
      expect(resolveRetainedBundleDir({})).toBeUndefined();
    });

    it('treats a blank value as unset', () => {
      expect(
        resolveRetainedBundleDir({ RAYFIN_FUNCTIONS_BUNDLE_OUT: '   ' })
      ).toBeUndefined();
    });

    it('resolves a relative path against the working directory', () => {
      expect(
        resolveRetainedBundleDir({ RAYFIN_FUNCTIONS_BUNDLE_OUT: './out' })
      ).toBe(join(process.cwd(), 'out'));
    });
  });
});

describe('bundleFunctionsForDeploy', () => {
  let functionsDir: string;
  let bundle: Awaited<ReturnType<typeof bundleFunctionsForDeploy>> | undefined;

  beforeEach(() => {
    functionsDir = mkdtempSync(join(tmpdir(), 'rayfin-bundle-int-'));
    mkdirSync(join(functionsDir, 'src', 'lib'), { recursive: true });
  });

  afterEach(() => {
    bundle?.cleanup();
    bundle = undefined;
    rmSync(functionsDir, { recursive: true, force: true });
  });

  it('inlines relative imports so the artifact is self-contained', async () => {
    writeFileSync(
      join(functionsDir, 'src', 'lib', 'greeting.ts'),
      'export const greeting = (n: string): string => `hi ${n}`;\n'
    );
    writeFileSync(
      join(functionsDir, 'src', 'function_app.ts'),
      "import { greeting } from './lib/greeting.js';\n" +
        'export const handler = (): string => greeting("world");\n'
    );

    bundle = await bundleFunctionsForDeploy(functionsDir, { minify: false });

    const entry = readFileSync(
      join(bundle.outDir, bundle.entryFileName),
      'utf8'
    );
    // The dependency's source is present, and no import of it remains.
    expect(entry).toContain('hi ');
    expect(entry).not.toMatch(/from\s*["'].*greeting/);
    expect(bundle.totalSizeBytes).toBeGreaterThan(0);
  });

  it('emits the createRequire banner so CJS deps can call require()', async () => {
    writeFileSync(
      join(functionsDir, 'src', 'function_app.ts'),
      'export const handler = (): string => "ok";\n'
    );

    bundle = await bundleFunctionsForDeploy(functionsDir, { minify: false });

    const entry = readFileSync(
      join(bundle.outDir, bundle.entryFileName),
      'utf8'
    );
    expect(entry).toContain('createRequire');
    expect(entry).toContain('import.meta.url');
  });

  it('keeps typescript external rather than inlining the compiler', async () => {
    writeFileSync(
      join(functionsDir, 'src', 'function_app.ts'),
      "const load = async (): Promise<unknown> => import('typescript');\n" +
        'export const handler = load;\n'
    );

    bundle = await bundleFunctionsForDeploy(functionsDir, { minify: false });

    const entry = readFileSync(
      join(bundle.outDir, bundle.entryFileName),
      'utf8'
    );
    expect(entry).toContain('typescript');
    // The compiler itself is multiple MB; an inlined copy would dwarf this.
    expect(bundle.totalSizeBytes).toBeLessThan(500_000);
  });

  it('emits a single entry file with no lazily-loaded chunks', async () => {
    writeFileSync(
      join(functionsDir, 'src', 'lib', 'greeting.ts'),
      'export const greeting = (n: string): string => `hi ${n}`;\n'
    );
    writeFileSync(
      join(functionsDir, 'src', 'function_app.ts'),
      "import { greeting } from './lib/greeting.js';\n" +
        'export const handler = (): string => greeting("world");\n'
    );

    bundle = await bundleFunctionsForDeploy(functionsDir, { minify: false });

    // Code splitting was only ever needed to hold the external `typescript`
    // import in a lazy chunk. Runtime metadata replaced source analysis, so
    // the compiler is unreachable and the output collapses to one module.
    const emitted = readdirSync(bundle.outDir).filter((f) => f.endsWith('.js'));
    expect(emitted).toEqual([bundle.entryFileName]);
  });

  it('cleans up its temp directory', async () => {
    writeFileSync(
      join(functionsDir, 'src', 'function_app.ts'),
      'export const handler = (): string => "ok";\n'
    );

    const result = await bundleFunctionsForDeploy(functionsDir);
    expect(existsSync(result.stageDir)).toBe(true);

    result.cleanup();
    expect(existsSync(result.stageDir)).toBe(false);
  });

  it('surfaces an actionable error when an import cannot resolve', async () => {
    writeFileSync(
      join(functionsDir, 'src', 'function_app.ts'),
      "import '@rayfin-app/definitely-not-installed';\n"
    );

    await expect(bundleFunctionsForDeploy(functionsDir)).rejects.toThrow(
      /npm install/
    );
  });

  describe('when retained for inspection', () => {
    let retainedDir: string;

    beforeEach(() => {
      retainedDir = mkdtempSync(join(tmpdir(), 'rayfin-bundle-out-'));
      writeFileSync(
        join(functionsDir, 'src', 'function_app.ts'),
        'export const handler = (): string => "ok";\n'
      );
    });

    afterEach(() => {
      rmSync(retainedDir, { recursive: true, force: true });
    });

    it('stages into a nested zip root so siblings never ship', async () => {
      bundle = await bundleFunctionsForDeploy(functionsDir, {
        outputDir: retainedDir,
      });

      expect(bundle.stageDir).toBe(
        join(retainedDir, RETAINED_ZIP_ROOT_DIRNAME)
      );
      expect(bundle.retainedDir).toBe(retainedDir);
      expect(existsSync(join(bundle.outDir, bundle.entryFileName))).toBe(true);
    });

    it('writes the metafile outside the zip root', async () => {
      bundle = await bundleFunctionsForDeploy(functionsDir, {
        outputDir: retainedDir,
      });

      const metafilePath = join(retainedDir, RETAINED_METAFILE_FILENAME);
      expect(existsSync(metafilePath)).toBe(true);
      // Inside the zip root it would end up in the deploy artifact.
      expect(
        existsSync(join(bundle.stageDir, RETAINED_METAFILE_FILENAME))
      ).toBe(false);

      const metafile = JSON.parse(readFileSync(metafilePath, 'utf8'));
      expect(Object.keys(metafile.outputs ?? {}).length).toBeGreaterThan(0);
    });

    it('does not delete the bundle on cleanup', async () => {
      bundle = await bundleFunctionsForDeploy(functionsDir, {
        outputDir: retainedDir,
      });

      bundle.cleanup();

      expect(existsSync(bundle.stageDir)).toBe(true);
    });

    it('clears stale output from a previous run', async () => {
      const staleFile = join(
        retainedDir,
        RETAINED_ZIP_ROOT_DIRNAME,
        BUNDLE_OUTPUT_DIRNAME,
        'stale.js'
      );
      mkdirSync(
        join(retainedDir, RETAINED_ZIP_ROOT_DIRNAME, BUNDLE_OUTPUT_DIRNAME),
        {
          recursive: true,
        }
      );
      writeFileSync(staleFile, '// from an earlier deploy\n');

      bundle = await bundleFunctionsForDeploy(functionsDir, {
        outputDir: retainedDir,
      });

      expect(existsSync(staleFile)).toBe(false);
    });

    it('leaves a sibling file in the retained dir untouched', async () => {
      const keepMe = join(retainedDir, 'notes.txt');
      writeFileSync(keepMe, 'mine\n');

      bundle = await bundleFunctionsForDeploy(functionsDir, {
        outputDir: retainedDir,
      });

      expect(readFileSync(keepMe, 'utf8')).toBe('mine\n');
    });
  });
});
