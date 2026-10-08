import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { readZipEntries } from '../../../utils/__tests__/helpers/zip-entries.js';
import type { ProgressIndicator } from '../../../utils/output-mode.js';
import { DeployState } from '../functions/types.js';

const mocks = vi.hoisted(() => ({
  findRayfinProjectRoot: vi.fn(),
  loadRayfinConfig: vi.fn(),
  resolveServiceRoot: vi.fn(),
  resolveDeployLockfile: vi.fn(),
  generateFunctionsMetadataFiles: vi.fn(),
  validateFunctionsForDeploy: vi.fn(),
  countPackageableFiles: vi.fn(),
  packageFolderWithOverrides: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  openAsBlob: vi.fn(),
  ensureAuthenticated: vi.fn(),
  getUdfMetadataUrl: vi.fn(),
  getRemoteFunctionsDeployUrl: vi.fn(),
  hasRemoteEndpoint: vi.fn(),
  pollDeployStatus: vi.fn(),
  handleDeployResult: vi.fn(),
  withRetry: vi.fn(),
  bundleFunctionsForDeploy: vi.fn(),
  buildBundledPackageJson: vi.fn(),
}));

class MockHttpError extends Error {
  statusCode: number;
  retryAfter?: number;
  constructor(message: string, statusCode: number, retryAfter?: number) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
  }
}

vi.mock('../../../utils/project-utils.js', () => ({
  findRayfinProjectRoot: mocks.findRayfinProjectRoot,
}));

vi.mock('../../../utils/config-utils.js', () => ({
  loadRayfinConfig: mocks.loadRayfinConfig,
  resolveServiceRoot: mocks.resolveServiceRoot,
  runServiceBuildCommand: vi.fn(),
}));

vi.mock('../../../utils/functions-lockfile-generator.js', () => ({
  resolveDeployLockfile: mocks.resolveDeployLockfile,
}));

vi.mock('../../../utils/functions-metadata-generator.js', () => ({
  RUNTIME_METADATA_FILENAME: 'runtimemetadata.json',
  RUNTIME_METADATA_SCHEMA_VERSION: '2.0',
  generateFunctionsMetadataFiles: mocks.generateFunctionsMetadataFiles,
}));

vi.mock('../../../utils/functions-package-validator.js', () => ({
  validateFunctionsForDeploy: mocks.validateFunctionsForDeploy,
  formatViolation: vi.fn(),
}));

vi.mock('../../../utils/functions-utils.js', () => ({
  countPackageableFiles: mocks.countPackageableFiles,
  packageFolderWithOverrides: mocks.packageFolderWithOverrides,
}));

vi.mock('../../../utils/functions-bundler.js', () => ({
  BUNDLE_OUTPUT_DIRNAME: 'dist',
  bundleFunctionsForDeploy: mocks.bundleFunctionsForDeploy,
  buildBundledPackageJson: mocks.buildBundledPackageJson,
}));

vi.mock('../../../utils/format-utils.js', () => ({
  formatBytes: vi.fn(() => '0 B'),
}));

vi.mock('../../../auth/index.js', () => ({
  ensureAuthenticated: mocks.ensureAuthenticated,
}));

vi.mock('../../../utils/remote-endpoint-utils.js', () => ({
  getUdfMetadataUrl: mocks.getUdfMetadataUrl,
  getRemoteFunctionsDeployUrl: mocks.getRemoteFunctionsDeployUrl,
  hasRemoteEndpoint: mocks.hasRemoteEndpoint,
}));

vi.mock('../../../utils/retry-utils.js', () => ({
  HttpError: MockHttpError,
  RETRY_CONFIG: { maxAttempts: 3 },
  parseRetryAfterHeader: vi.fn(() => undefined),
  withRetry: mocks.withRetry,
}));

vi.mock('../functions/poll-deploy-status.js', () => ({
  pollDeployStatus: mocks.pollDeployStatus,
  handleDeployResult: mocks.handleDeployResult,
}));

vi.mock('fs', async () => ({
  ...(await vi.importActual<typeof import('fs')>('fs')),
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
  writeFileSync: mocks.writeFileSync,
  openAsBlob: mocks.openAsBlob,
}));

const DEPLOY_METADATA_JSON = '{"deploy":true}';
const RUNTIME_METADATA_JSON = '{"schemaVersion":"2.0","functions":[]}';

describe('prepareFunctionsDeployPackage', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Bundling is the default deploy path; these suites exercise
    // packaging and cleanup, so stub the bundler with a fixed result.
    mocks.bundleFunctionsForDeploy.mockResolvedValue({
      stageDir: '/tmp/bundle',
      outDir: '/tmp/bundle/dist',
      entryFileName: 'function_app.js',
      fileCount: 3,
      totalSizeBytes: 1024,
      cleanup: vi.fn(),
    });
    mocks.buildBundledPackageJson.mockReturnValue('{"name":"fn"}');

    mocks.findRayfinProjectRoot.mockReturnValue('/repo');
    mocks.loadRayfinConfig.mockReturnValue({
      services: {
        functions: {
          path: 'packages/functions',
        },
      },
    });
    mocks.resolveServiceRoot.mockImplementation(
      (
        projectRoot: string,
        _serviceName: string,
        servicePath: string | undefined
      ) => (servicePath ? `${projectRoot}/${servicePath}` : projectRoot)
    );

    mocks.validateFunctionsForDeploy.mockReturnValue({
      valid: true,
      violations: [],
    });
    mocks.generateFunctionsMetadataFiles.mockResolvedValue({
      deployMetadataJson: DEPLOY_METADATA_JSON,
      runtimeMetadataJson: RUNTIME_METADATA_JSON,
    });
    mocks.countPackageableFiles.mockReturnValue({
      fileCount: 1,
      totalSizeBytes: 123,
    });
    mocks.resolveDeployLockfile.mockResolvedValue({
      source: 'unavailable',
      warning: 'no lockfile',
    });
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue('{}');
    mocks.packageFolderWithOverrides.mockResolvedValue({
      zipPath: '/tmp/rayfin-fnzip-test/source.zip',
      byteLength: 3,
      cleanup: vi.fn(),
    });
  });

  it('uses functions path from rayfin.yml instead of the caller serviceRoot', async () => {
    const { prepareFunctionsDeployPackage } =
      await import('../up-functions.js');

    await prepareFunctionsDeployPackage('/repo/incorrect/functions-root');

    expect(mocks.findRayfinProjectRoot).toHaveBeenCalledWith(
      '/repo/incorrect/functions-root',
      {
        verbose: false,
        silent: true,
      }
    );
    expect(mocks.resolveServiceRoot).toHaveBeenCalledWith(
      '/repo',
      'functions',
      'packages/functions'
    );
    // Bundling inlines every dependency, so the portability check that
    // guards the legacy source-zip path is deliberately skipped.
    expect(mocks.validateFunctionsForDeploy).toHaveBeenCalledWith(
      '/repo/packages/functions',
      { checkDependencyPortability: false, runtimeMetadataSchemaVersion: '2.0' }
    );
    expect(mocks.generateFunctionsMetadataFiles).toHaveBeenCalledWith(
      '/repo/packages/functions',
      expect.any(Object)
    );
    expect(mocks.writeFileSync).toHaveBeenCalledTimes(1);
    expect(mocks.writeFileSync).toHaveBeenCalledWith(
      join('/repo/packages/functions', 'deploymetadata.json'),
      DEPLOY_METADATA_JSON
    );
    // The bundled path packages the esbuild stage dir, not the source
    // folder, and ships metadata as zip overrides alongside it.
    expect(mocks.packageFolderWithOverrides).toHaveBeenCalledWith(
      '/tmp/bundle',
      expect.objectContaining({
        'runtimemetadata.json': RUNTIME_METADATA_JSON,
      })
    );
  });

  it('counts the override files and their bytes in the reported totals', async () => {
    const { prepareFunctionsDeployPackage } =
      await import('../up-functions.js');
    const result = await prepareFunctionsDeployPackage({
      serviceRoot: '/ignored',
    } as never);

    // The zip is the esbuild output plus the in-memory overrides, so the
    // reported totals have to account for both halves -- counting the
    // override files but not their bytes understates what actually ships.
    const [, overrides] = mocks.packageFolderWithOverrides.mock.calls[0] as [
      string,
      Record<string, string | Buffer>,
    ];
    const overrideBytes = Object.values(overrides).reduce(
      (total, contents) => total + Buffer.byteLength(contents),
      0
    );

    expect(overrideBytes).toBeGreaterThan(0);
    expect(result.fileCount).toBe(3 + Object.keys(overrides).length);
    expect(result.totalSizeBytes).toBe(1024 + overrideBytes);
  });

  it('falls back to the legacy source zip when bundling is opted out', async () => {
    vi.stubEnv('RAYFIN_FUNCTIONS_NO_BUNDLE', '1');
    mocks.resolveDeployLockfile.mockResolvedValue({ source: 'on-disk' });

    const { prepareFunctionsDeployPackage } =
      await import('../up-functions.js');
    await prepareFunctionsDeployPackage({ serviceRoot: '/ignored' } as never);

    // The legacy path zips the source folder and never invokes esbuild.
    expect(mocks.bundleFunctionsForDeploy).not.toHaveBeenCalled();
    expect(mocks.packageFolderWithOverrides).toHaveBeenCalledWith(
      '/repo/packages/functions',
      expect.any(Object),
      expect.any(Object)
    );
    // Dependency portability matters again once deps are not inlined.
    // The worker check applies to the legacy path too: an old worker rejects
    // 2.0 metadata regardless of how the zip was built.
    expect(mocks.validateFunctionsForDeploy).toHaveBeenCalledWith(
      '/repo/packages/functions',
      { checkDependencyPortability: true, runtimeMetadataSchemaVersion: '2.0' }
    );

    vi.unstubAllEnvs();
  });

  it('mirrors the zip overrides onto disk when the bundle is retained', async () => {
    mocks.bundleFunctionsForDeploy.mockResolvedValue({
      stageDir: '/tmp/inspect/zip-root',
      outDir: '/tmp/inspect/zip-root/dist',
      entryFileName: 'function_app.js',
      fileCount: 3,
      totalSizeBytes: 1024,
      retainedDir: '/tmp/inspect',
      cleanup: vi.fn(),
    });

    const { prepareFunctionsDeployPackage } =
      await import('../up-functions.js');
    await prepareFunctionsDeployPackage('/repo/packages/functions');

    // esbuild only emits dist/; without this the retained zip root would
    // be missing everything that ships as an override.
    for (const name of [
      'host.json',
      'package.json',
      'deploymetadata.json',
      'runtimemetadata.json',
    ]) {
      expect(mocks.writeFileSync).toHaveBeenCalledWith(
        join('/tmp/inspect/zip-root', name),
        expect.anything()
      );
    }
  });

  it('does not write overrides to the stage dir for an ordinary deploy', async () => {
    const { prepareFunctionsDeployPackage } =
      await import('../up-functions.js');
    await prepareFunctionsDeployPackage('/repo/packages/functions');

    // Only deploymetadata.json, written into the source folder.
    expect(mocks.writeFileSync).toHaveBeenCalledTimes(1);
    expect(mocks.writeFileSync).not.toHaveBeenCalledWith(
      join('/tmp/bundle', 'host.json'),
      expect.anything()
    );
  });

  it('logs metadata diagnostics with their source location', async () => {
    mocks.generateFunctionsMetadataFiles.mockImplementationOnce(
      async (_functionsDir, options) => {
        options.onDiagnostic({
          code: 'unresolved-connection-property',
          severity: 'warning',
          message: "Connection option 'audienceType' could not be resolved.",
          filePath: 'src/function_app.ts',
          line: 12,
          column: 35,
          functionName: 'searchWork',
        });
        return {
          deployMetadataJson: DEPLOY_METADATA_JSON,
          runtimeMetadataJson: RUNTIME_METADATA_JSON,
        };
      }
    );
    const logger = vi.fn();
    const { prepareFunctionsDeployPackage } =
      await import('../up-functions.js');

    await prepareFunctionsDeployPackage('/repo/functions', { logger });

    expect(logger).toHaveBeenCalledWith(
      "Warning: src/function_app.ts:12:35: Connection option 'audienceType' could not be resolved."
    );
  });

  it.each([false, true])(
    'counts final overrides with the ZIP policy (compiled=%s)',
    async (isCompiledZip) => {
      // Source-mode policy: bundling replaces the zip root entirely, so the
      // exclusion sets only apply when the caller opts out of bundling.
      vi.stubEnv('RAYFIN_FUNCTIONS_NO_BUNDLE', '1');
      mocks.resolveDeployLockfile.mockResolvedValue({
        source: 'generated',
        lockfileJson: '{"lockfileVersion":3}',
      });
      mocks.countPackageableFiles
        .mockReturnValueOnce({ fileCount: 1, totalSizeBytes: 123 })
        .mockReturnValueOnce({ fileCount: 4, totalSizeBytes: 456 });
      const logger = vi.fn();
      const { prepareFunctionsDeployPackage } =
        await import('../up-functions.js');
      const result = await prepareFunctionsDeployPackage('/repo/functions', {
        isCompiledZip,
        logger,
      });
      const [, overrides, packageOptions] =
        mocks.packageFolderWithOverrides.mock.calls[0];

      expect(overrides).toEqual({
        'host.json': '{}',
        'runtimemetadata.json': RUNTIME_METADATA_JSON,
        'package-lock.json': '{"lockfileVersion":3}',
      });
      expect(mocks.countPackageableFiles).toHaveBeenLastCalledWith(
        '/repo/packages/functions',
        packageOptions,
        overrides
      );
      expect(mocks.countPackageableFiles.mock.calls[0][1]).toBe(packageOptions);
      expect(packageOptions.excludeDirNames).toEqual(
        new Set(
          isCompiledZip
            ? ['bin', 'obj']
            : ['dist', 'node_modules', 'bin', 'obj']
        )
      );
      expect(packageOptions.excludeFileNames).toEqual(
        new Set(['local.settings.json'])
      );
      if (!isCompiledZip) {
        expect(packageOptions.excludeFileSuffixes).toBeUndefined();
        expect(packageOptions.excludeRootPaths).toBeUndefined();
      }
      expect(result.fileCount).toBe(4);
      expect(result.totalSizeBytes).toBe(456);
      expect(logger).toHaveBeenCalledWith(
        '📦 Packaging 4 functions files (0 B)...'
      );
    }
  );

  it.each([false, true])(
    'preserves compiled inputs and filters only the intended ZIP entries (existing metadata=%s)',
    async (existingMetadata) => {
      // Exercises the source-mode zip walker, which bundling bypasses.
      vi.stubEnv('RAYFIN_FUNCTIONS_NO_BUNDLE', '1');
      const fs = await vi.importActual<typeof import('fs')>('fs');
      const packager = await vi.importActual<
        typeof import('../../../utils/functions-utils.js')
      >('../../../utils/functions-utils.js');
      const { prepareFunctionsDeployPackage } =
        await import('../up-functions.js');
      const dir = fs.mkdtempSync(join(tmpdir(), 'rayfin-package-policy-'));
      const zips: import('../../../utils/functions-utils.js').PackagedZip[] =
        [];
      const files: Record<string, string | Buffer> = {
        'package.json':
          '{"name":"fixture","dependencies":{"typescript":"5.8.3"}}',
        'package-lock.json': '{"lockfileVersion":3}',
        'npm-shrinkwrap.json': '{}',
        'tsconfig.json': '{"compilerOptions":{"declaration":true}}',
        'tsconfig.build.json': '{}',
        'host.json': '{"extensionBundle":{"id":"Preview"}}',
        'deploymetadata.json': DEPLOY_METADATA_JSON,
        'dist/index.js':
          'export const run = () => 42;\n//# sourceMappingURL=index.js.map',
        'dist/inline.js':
          '//# sourceMappingURL=data:application/json;base64,e30=',
        'assets/world.map': 'runtime map data',
        'assets/module.wasm': Buffer.from([0, 97, 115, 109]),
        'assets/addon.node': Buffer.from([0, 1, 255]),
        'assets/template.html': '<main>hello</main>',
        'assets/config.json': '{"runtime":true}',
        'packages/local.tgz': Buffer.from([31, 139, 8, 0]),
        LICENSE: 'license',
        NOTICE: 'notice',
        'node_modules/typescript/lib/typescript.js':
          'exports.version = "5.8.3"',
        'node_modules/pkg/package.json': '{"main":"index.cjs"}',
        'node_modules/pkg/index.cjs': 'module.exports = 42',
        'node_modules/pkg/index.mjs': 'export default 42',
        'tests/fixture.ts': 'export const fixture = true;',
        'docs/readme.txt': 'documentation',
        'logs/runtime.log': 'retained log',
        '.cache/data.json': 'generic cache retained',
        'src/external.js.map': 'source-mode map retained',
        'project.tsbuildinfo': 'source-mode build state retained',
      };
      const excluded: string[] = ['src/external.js.map', 'project.tsbuildinfo'];
      for (const prefix of ['', 'node_modules/pkg/']) {
        for (const extension of [
          'ts',
          'tsx',
          'mts',
          'cts',
          'd.ts',
          'd.mts',
          'd.cts',
        ]) {
          files[`${prefix}src/index.${extension}`] =
            `// retained ${extension}\nexport {};\n`;
        }
        for (const suffix of [
          '.js.map',
          '.mjs.map',
          '.cjs.map',
          '.d.ts.map',
          '.d.mts.map',
          '.d.cts.map',
          '.tsbuildinfo',
        ]) {
          const path = `${prefix}dist/nested/output${suffix}`;
          files[path] = Array.from(
            { length: 512 },
            (_, i) => `mapping-${i}-${suffix}`
          ).join('\n');
          excluded.push(path);
          files[`${path}.backup`] = 'not an exact suffix';
        }
        files[`${prefix}src/resource.ts.map`] = 'arbitrary map retained';
      }
      for (const path of [
        '.git',
        '.vscode',
        '.idea',
        '.eslintcache',
        '.prettiercache',
        'coverage',
        '.nyc_output',
      ]) {
        const rootPath = ['.eslintcache', '.prettiercache'].includes(path)
          ? path
          : `${path}/data`;
        files[rootPath] = 'root tooling';
        excluded.push(rootPath);
        files[`${path}-copy/data`] = 'root sibling retained';
        files[`node_modules/pkg/${rootPath}`] = 'dependency path retained';
        files[`src/${rootPath}`] = 'nested app path retained';
      }
      const legacyExcluded = [
        'local.settings.json',
        'src/local.settings.json',
        'bin/output',
        'obj/output',
        'node_modules/pkg/bin/output',
        'src/obj/output',
      ];
      for (const path of legacyExcluded) files[path] = 'existing exclusion';
      if (existingMetadata) files['runtimemetadata.json'] = '{"stale":true}';
      else delete files['package-lock.json'];

      try {
        for (const [path, content] of Object.entries(files)) {
          fs.mkdirSync(dirname(join(dir, path)), { recursive: true });
          fs.writeFileSync(join(dir, path), content);
        }
        mocks.resolveServiceRoot.mockReturnValue(dir);
        mocks.existsSync.mockImplementation(fs.existsSync);
        mocks.writeFileSync.mockImplementation(fs.writeFileSync);
        mocks.countPackageableFiles.mockImplementation(
          packager.countPackageableFiles
        );
        mocks.packageFolderWithOverrides.mockImplementation(
          packager.packageFolderWithOverrides
        );
        mocks.resolveDeployLockfile.mockResolvedValue(
          existingMetadata
            ? { source: 'on-disk' }
            : {
                source: 'generated',
                lockfileJson: '{"lockfileVersion":3,"generated":true}',
              }
        );
        const compiled = await prepareFunctionsDeployPackage(dir, {
          isCompiledZip: true,
        });
        zips.push(compiled.zip);
        const overrides = mocks.packageFolderWithOverrides.mock.calls[0][1];
        const baseline = await packager.packageFolderWithOverrides(
          dir,
          overrides,
          {
            excludeDirNames: new Set(['bin', 'obj']),
            excludeFileNames: new Set(['local.settings.json']),
          }
        );
        zips.push(baseline);
        const entries = readZipEntries(fs.readFileSync(compiled.zip.zipPath));
        const baselineEntries = readZipEntries(
          fs.readFileSync(baseline.zipPath)
        );
        const expected = new Map(
          Object.entries(files).filter(
            ([path]) =>
              !excluded.includes(path) && !legacyExcluded.includes(path)
          )
        );
        for (const [path, content] of Object.entries(overrides))
          expected.set(path, content as string | Buffer);
        expect(entries.map((entry) => entry.name).sort()).toEqual(
          [...expected.keys()].sort()
        );
        for (const { name, content } of entries)
          expect(content).toEqual(Buffer.from(expected.get(name)!));
        expect(compiled.fileCount).toBe(entries.length);
        expect(compiled.totalSizeBytes).toBe(
          entries.reduce((sum, entry) => sum + entry.content.length, 0)
        );
        expect(compiled.zip.byteLength).toBeLessThan(baseline.byteLength);
        expect(baselineEntries.length - entries.length).toBe(excluded.length);

        const source = await prepareFunctionsDeployPackage(dir);
        zips.push(source.zip);
        const sourceEntries = readZipEntries(
          fs.readFileSync(source.zip.zipPath)
        );
        const sourceExpected = [
          ...new Set([...Object.keys(files), ...Object.keys(overrides)]),
        ].filter(
          (path) =>
            !path
              .split('/')
              .some((part) =>
                [
                  'dist',
                  'node_modules',
                  'bin',
                  'obj',
                  'local.settings.json',
                ].includes(part)
              )
        );
        expect(sourceEntries.map((entry) => entry.name).sort()).toEqual(
          sourceExpected.sort()
        );
        expect(source.fileCount).toBe(sourceEntries.length);
        expect(source.totalSizeBytes).toBe(
          sourceEntries.reduce((sum, entry) => sum + entry.content.length, 0)
        );
        for (const [path, content] of Object.entries(files)) {
          expect(fs.readFileSync(join(dir, path))).toEqual(
            Buffer.from(content)
          );
        }
        expect(fs.existsSync(join(dir, 'runtimemetadata.json'))).toBe(
          existingMetadata
        );
        expect(packager.countPackageableFiles(dir).fileCount).toBe(
          Object.keys(files).length
        );
      } finally {
        for (const zip of zips) zip.cleanup();
        fs.rmSync(dir, { recursive: true, force: true });
        mocks.countPackageableFiles.mockReset();
        mocks.packageFolderWithOverrides.mockReset();
        mocks.existsSync.mockReset();
        mocks.writeFileSync.mockReset();
      }
    }
  );
});

/** Minimal ProgressIndicator stub so deployFunctions can drive its spinners. */
function stubIndicator(): ProgressIndicator {
  return {
    stop: vi.fn(),
    start: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
    log: vi.fn(),
    getDurationStr: () => '0ms',
  } as unknown as ProgressIndicator;
}

describe('deployFunctions — temp-zip cleanup and interrupt handling', () => {
  let cleanupSpy: ReturnType<typeof vi.fn>;

  function primePackaging(): void {
    // Everything prepareFunctionsDeployPackage touches, so deployFunctions can
    // run the real package phase and hand us a PackagedZip whose cleanup we own.
    mocks.findRayfinProjectRoot.mockReturnValue('/repo');
    mocks.loadRayfinConfig.mockReturnValue({
      services: { functions: { path: 'packages/functions' } },
    });
    mocks.resolveServiceRoot.mockImplementation(
      (root: string, _name: string, p: string | undefined) =>
        p ? `${root}/${p}` : root
    );
    mocks.validateFunctionsForDeploy.mockReturnValue({
      valid: true,
      violations: [],
    });
    mocks.generateFunctionsMetadataFiles.mockResolvedValue({
      deployMetadataJson: DEPLOY_METADATA_JSON,
      runtimeMetadataJson: RUNTIME_METADATA_JSON,
    });
    mocks.countPackageableFiles.mockReturnValue({
      fileCount: 1,
      totalSizeBytes: 123,
    });
    mocks.resolveDeployLockfile.mockResolvedValue({
      source: 'unavailable',
      warning: 'no lockfile',
    });
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue('{}');

    cleanupSpy = vi.fn();
    mocks.packageFolderWithOverrides.mockResolvedValue({
      zipPath: '/tmp/rayfin-fnzip-test/source.zip',
      byteLength: 3,
      cleanup: cleanupSpy,
    });
  }

  function baseOptions(over: Record<string, unknown> = {}) {
    return {
      serviceRoot: '/repo/packages/functions',
      deployUrl: 'https://deploy.example/functions',
      rayfinItemId: 'item-1',
      authorizationHeader: 'Bearer token',
      functionsConfig: {} as never,
      mode: 'json' as const,
      showProgress: vi.fn(() => stubIndicator()),
      ...over,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();

    // Bundling is the default deploy path; these suites exercise
    // packaging and cleanup, so stub the bundler with a fixed result.
    mocks.bundleFunctionsForDeploy.mockResolvedValue({
      stageDir: '/tmp/bundle',
      outDir: '/tmp/bundle/dist',
      entryFileName: 'function_app.js',
      fileCount: 3,
      totalSizeBytes: 1024,
      cleanup: vi.fn(),
    });
    mocks.buildBundledPackageJson.mockReturnValue('{"name":"fn"}');
    primePackaging();

    // Default: withRetry runs the upload attempt exactly once.
    mocks.withRetry.mockImplementation(
      async (fn: () => Promise<void>) => void (await fn())
    );
    mocks.openAsBlob.mockResolvedValue(
      new Blob(['zip-bytes'], { type: 'application/zip' })
    );
    mocks.getUdfMetadataUrl.mockReturnValue('https://meta.example/udf-1');
    mocks.pollDeployStatus.mockResolvedValue({ status: DeployState.Complete });
    mocks.handleDeployResult.mockReturnValue(undefined);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        json: async () => ({ udfArtifactId: 'udf-1' }),
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([false, true])(
    'releases the temp zip after a skip-build deploy (compiled=%s)',
    async (isCompiledZip) => {
      // Source mode: bundling always sets isCompiledZip and swaps the zip
      // root, so the per-flag ZIP policy is only observable when opted out.
      vi.stubEnv('RAYFIN_FUNCTIONS_NO_BUNDLE', '1');
      const { deployFunctions } = await import('../up-functions.js');
      const sigintBefore = process.listenerCount('SIGINT');
      const sigtermBefore = process.listenerCount('SIGTERM');

      await deployFunctions(baseOptions({ skipBuild: true, isCompiledZip }));

      // finally -> releaseZip -> cleanup, invoked once (idempotency guard holds).
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      // Handlers registered for the upload window must be detached again, so a
      // long-lived process (or repeated deploys) doesn't accumulate listeners.
      expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
      expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
      const request = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
      const body = request.body as FormData;
      expect(body.has('SourceZipFile')).toBe(true);
      expect(body.get('DeployMetaData')).toBe(DEPLOY_METADATA_JSON);
      expect(body.has('RuntimeMetaData')).toBe(false);
      expect(body.get('isCompiledZip')).toBe(isCompiledZip ? 'true' : null);
      const packageOptions = mocks.packageFolderWithOverrides.mock.calls[0][2];
      expect(
        packageOptions.excludeFileSuffixes?.includes('.js.map') ?? false
      ).toBe(isCompiledZip);
      const { runServiceBuildCommand } =
        await import('../../../utils/config-utils.js');
      expect(runServiceBuildCommand).not.toHaveBeenCalled();
    }
  );

  it('releases the temp zip when the upload fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Server Error',
        text: async () => 'boom',
      })
    );
    const { deployFunctions } = await import('../up-functions.js');
    const sigintBefore = process.listenerCount('SIGINT');

    await expect(deployFunctions(baseOptions())).rejects.toThrow();

    // The upload-phase finally must still run cleanup and detach handlers.
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
  });

  it('releases the temp zip when authentication fails', async () => {
    mocks.ensureAuthenticated.mockRejectedValue(new Error('no token'));
    const { deployFunctions } = await import('../up-functions.js');
    const sigintBefore = process.listenerCount('SIGINT');

    // Omit authorizationHeader so deployFunctions takes the ensureAuthenticated
    // path, whose .catch releases the zip before any upload.
    await expect(
      deployFunctions(baseOptions({ authorizationHeader: undefined }))
    ).rejects.toThrow();

    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
  });
});

describe('uploadFunctionsDeployPackage — disk-backed retry', () => {
  const prepared = {
    zip: {
      zipPath: '/tmp/rayfin-fnzip-test/source.zip',
      byteLength: 3,
      cleanup: vi.fn(),
    },
    deployMetaData: '{}',
    fileCount: 1,
    totalSizeBytes: 3,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Bundling is the default deploy path; these suites exercise
    // packaging and cleanup, so stub the bundler with a fixed result.
    mocks.bundleFunctionsForDeploy.mockResolvedValue({
      stageDir: '/tmp/bundle',
      outDir: '/tmp/bundle/dist',
      entryFileName: 'function_app.js',
      fileCount: 3,
      totalSizeBytes: 1024,
      cleanup: vi.fn(),
    });
    mocks.buildBundledPackageJson.mockReturnValue('{"name":"fn"}');
    mocks.openAsBlob.mockResolvedValue(
      new Blob(['zip-bytes'], { type: 'application/zip' })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('re-opens the zip from disk on each retry attempt (no in-memory reuse)', async () => {
    // First attempt gets a retryable 503, second succeeds. withRetry is mocked
    // to run the attempt callback again when shouldRetry is satisfied.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Unavailable',
        text: async () => 'not ready',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({ udfArtifactId: 'udf-1' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    mocks.withRetry.mockImplementation(
      async (
        fn: () => Promise<void>,
        opts: { shouldRetry?: (e: unknown) => boolean }
      ) => {
        try {
          await fn();
        } catch (err) {
          if (opts.shouldRetry?.(err)) {
            await fn();
          } else {
            throw err;
          }
        }
      }
    );

    const { uploadFunctionsDeployPackage } = await import('../up-functions.js');

    const accepted = await uploadFunctionsDeployPackage(
      prepared as never,
      'https://deploy.example/functions',
      'item-1',
      'Bearer token'
    );

    expect(accepted).toEqual({ udfArtifactId: 'udf-1' });
    // The whole point of the disk-backed change: each attempt re-opens the
    // file from its path rather than holding a Blob/Buffer across retries.
    expect(mocks.openAsBlob).toHaveBeenCalledTimes(2);
    expect(mocks.openAsBlob).toHaveBeenNthCalledWith(1, prepared.zip.zipPath, {
      type: 'application/zip',
    });
    expect(mocks.openAsBlob).toHaveBeenNthCalledWith(2, prepared.zip.zipPath, {
      type: 'application/zip',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('isBundlingDisabled', () => {
  it('bundles by default', async () => {
    const { isBundlingDisabled } = await import('../up-functions.js');
    expect(isBundlingDisabled({})).toBe(false);
  });

  it.each(['1', 'true', 'TRUE', 'yes', 'on', ' true '])(
    'treats %j as an opt-out of bundling',
    async (value) => {
      const { isBundlingDisabled } = await import('../up-functions.js');
      expect(isBundlingDisabled({ RAYFIN_FUNCTIONS_NO_BUNDLE: value })).toBe(
        true
      );
    }
  );

  it.each(['0', 'false', 'no', '', 'maybe'])(
    'keeps bundling enabled for %j',
    async (value) => {
      const { isBundlingDisabled } = await import('../up-functions.js');
      expect(isBundlingDisabled({ RAYFIN_FUNCTIONS_NO_BUNDLE: value })).toBe(
        false
      );
    }
  );
});
