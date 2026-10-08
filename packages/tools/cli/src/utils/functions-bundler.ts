/**
 * @packageDocumentation Bundle a `rayfin/functions/` project into a
 * self-contained deploy artifact with esbuild.
 *
 * ## Why bundling
 *
 * A Rayfin app is typically an npm workspace: `rayfin/functions/` sits
 * alongside sibling packages and shares the app root's `node_modules/`.
 * npm hoists most dependencies — including
 * `@microsoft/fabric-user-data-functions` and workspace siblings like
 * `@rayfin-app/shared` — up to that root, which is *outside* the folder
 * `rayfin up` zips. The worker extension therefore never reaches the
 * remote host, which starts, finds no worker, and reports
 * "No job functions found".
 *
 * Shipping `node_modules/` does not fix this (the hoisted copies still
 * live above the zip root, and workspace links are symlinks the zip
 * walker skips), and neither does a remote `npm install` (workspace
 * siblings are private and unpublished, so they cannot be resolved from
 * a registry).
 *
 * Bundling sidesteps the entire question: esbuild follows Node resolution
 * from the entry point and inlines every reachable module, wherever npm
 * happened to put it on disk. The result is a handful of files that
 * depend on nothing but the host-injected runtime.
 *
 * ## Externals
 *
 *  - `@azure/functions-core` is injected by the Functions host at runtime
 *    and is deliberately absent from `node_modules`. It must stay
 *    external or the bundle fails to build.
 *  - `typescript` is unreachable from the worker's entry point: the
 *    worker reads `runtimemetadata.json` and no longer parses source. It
 *    is held external purely as a guard, so that if an import path ever
 *    reaches the compiler again the bundle fails loudly instead of
 *    silently growing by several MB.
 *
 * ## The `createRequire` banner
 *
 * `@azure/functions` calls `require()` for Node built-ins. In an ESM
 * bundle there is no ambient `require`, and esbuild leaves those calls
 * intact, so the worker dies at load with a "Dynamic require of util is
 * not supported" error. The Functions host surfaces that as a bare "No
 * job functions found" with no stack trace, which is near-impossible to
 * diagnose. The banner re-establishes `require` from `import.meta.url`.
 *
 * ## Inspecting the bundle
 *
 * A deploy bundles into a temp directory that is deleted as soon as the
 * zip is written, so there is normally nothing left to examine. Set
 * `RAYFIN_FUNCTIONS_BUNDLE_OUT=<dir>` to retain it instead:
 *
 * ```text
 * <dir>/
 *   zip-root/                 exactly what ships, byte for byte
 *     dist/                   bundled output and sourcemaps
 *     host.json               deploy variant
 *     package.json            minimal, dependency-free
 *     deploymetadata.json
 *     runtimemetadata.json
 *   esbuild-metafile.json     feed to https://esbuild.github.io/analyze/
 * ```
 *
 * The zip root is nested so that the metafile — and anything else placed
 * beside it — stays out of the deploy artifact.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

/**
 * Injected by the Functions host at runtime; never present on disk, so it
 * can never be bundled.
 */
const HOST_INJECTED_MODULE = '@azure/functions-core';

/**
 * Unreachable from the worker entry point now that runtime metadata is the
 * only metadata path. Held external as a guard: if the compiler ever
 * re-enters the import graph, the deploy fails loudly rather than silently
 * inlining several MB.
 */
const OPTIONAL_COMPILER_MODULE = 'typescript';

/**
 * Restores `require` for CommonJS dependencies that call it for Node
 * built-ins. See the module docs for why omitting this produces a silent
 * "No job functions found".
 */
const CREATE_REQUIRE_BANNER =
  "import { createRequire as __rayfinCreateRequire } from 'node:module';\n" +
  'const require = __rayfinCreateRequire(import.meta.url);';

/** Entry points tried, in order, when none is configured. */
const DEFAULT_ENTRY_CANDIDATES: readonly string[] = [
  'src/function_app.ts',
  'src/function_app.js',
];

/**
 * Set to a directory path to retain the bundle on disk for inspection
 * instead of building into a temp dir that is deleted as soon as the zip
 * is written. See the module docs for the resulting layout.
 */
export const BUNDLE_OUT_ENV_VAR = 'RAYFIN_FUNCTIONS_BUNDLE_OUT';

/**
 * Subdirectory of the retained bundle dir holding the exact zip root.
 *
 * The nesting is not cosmetic: the stage directory is archived verbatim,
 * so anything written beside it — the metafile, most obviously — would
 * otherwise ship inside the deploy artifact.
 */
export const RETAINED_ZIP_ROOT_DIRNAME = 'zip-root';

/** esbuild metafile written beside the zip root when the bundle is retained. */
export const RETAINED_METAFILE_FILENAME = 'esbuild-metafile.json';

/**
 * Resolve the directory in which to retain the bundle, if any.
 *
 * @returns An absolute path, or undefined when the bundle should be
 *   built in a temp dir and discarded after packaging.
 */
export function resolveRetainedBundleDir(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const raw = env[BUNDLE_OUT_ENV_VAR];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return resolve(trimmed);
}

export interface BundleFunctionsOptions {
  /** Verbose diagnostic logger; defaults to a no-op. */
  verbose?: (...args: unknown[]) => void;
  /**
   * Entry point relative to the functions directory. Defaults to the
   * first of {@link DEFAULT_ENTRY_CANDIDATES} that exists on disk.
   */
  entryPoint?: string;
  /**
   * Node target passed to esbuild, e.g. `node20`. Defaults to the value
   * derived from the deploy host's supported runtime.
   */
  target?: string;
  /** Minify the output. Defaults to true. */
  minify?: boolean;
  /**
   * Retain the bundle in this directory instead of a temp dir. Defaults
   * to {@link resolveRetainedBundleDir}, i.e. the `RAYFIN_FUNCTIONS_BUNDLE_OUT`
   * environment variable.
   */
  outputDir?: string;
}

export interface BundleFunctionsResult {
  /**
   * Absolute path to a temp directory laid out exactly as the deploy zip
   * root: bundled output under `dist/`, ready for the caller to add
   * `host.json`, `package.json`, and metadata as zip overrides.
   *
   * The caller MUST invoke {@link cleanup} once packaging completes.
   */
  stageDir: string;
  /** Absolute path to `dist/` within {@link stageDir}. */
  outDir: string;
  /** Entry file name within `dist/`, e.g. `function_app.js`. */
  entryFileName: string;
  /** Number of emitted files. */
  fileCount: number;
  /** Total size of emitted files in bytes. */
  totalSizeBytes: number;
  /**
   * Directory the bundle was retained in for inspection, when one was
   * requested. Undefined for an ordinary deploy, whose {@link stageDir}
   * is a temp dir removed by {@link cleanup}.
   */
  retainedDir?: string;
  /**
   * Remove the temp directory. Best-effort and idempotent. A no-op when
   * the bundle was retained for inspection.
   */
  cleanup(): void;
}

/** Directory within the deploy zip that holds the bundled output. */
export const BUNDLE_OUTPUT_DIRNAME = 'dist';

/**
 * The Functions host runs a recent Node LTS. Targeting it explicitly
 * keeps esbuild from down-levelling syntax the host supports natively.
 */
const DEFAULT_NODE_TARGET = 'node20';

/**
 * Resolve the bundle entry point, preferring an explicit override and
 * otherwise probing the conventional scaffolded locations.
 *
 * @throws When no entry point can be found, naming the paths tried.
 */
export function resolveFunctionsEntryPoint(
  functionsDir: string,
  explicitEntry?: string
): string {
  if (explicitEntry) {
    const resolved = join(functionsDir, explicitEntry);
    if (!existsSync(resolved)) {
      throw new Error(
        `Functions entry point not found: ${resolved}\n` +
          'Check the configured entry point and retry.'
      );
    }
    return resolved;
  }

  for (const candidate of DEFAULT_ENTRY_CANDIDATES) {
    const resolved = join(functionsDir, candidate);
    if (existsSync(resolved)) return resolved;
  }

  throw new Error(
    `No functions entry point found in ${functionsDir}. Tried: ` +
      `${DEFAULT_ENTRY_CANDIDATES.join(', ')}.\n` +
      '💡 Run `rayfin functions init` to scaffold the project, or create ' +
      'src/function_app.ts and register a function with `udf.func(...)`.'
  );
}

/**
 * Bundle the functions project into a temp directory.
 *
 * esbuild performs no type checking, so this complements — and does not
 * replace — the `tsc --build` step run earlier in the deploy pipeline.
 *
 * @param functionsDir - The resolved functions service root.
 * @returns A {@link BundleFunctionsResult} whose temp dir the caller must
 *   `cleanup()` after packaging.
 */
export async function bundleFunctionsForDeploy(
  functionsDir: string,
  options: BundleFunctionsOptions = {}
): Promise<BundleFunctionsResult> {
  const verbose = options.verbose ?? ((): void => {});
  const retainedDir = options.outputDir ?? resolveRetainedBundleDir();
  const entryPoint = resolveFunctionsEntryPoint(
    functionsDir,
    options.entryPoint
  );

  // Imported lazily so the esbuild binary is only loaded on the deploy
  // path, keeping it off the CLI's startup cost for every other command.
  const { build } = await import('esbuild');

  const stageDir = retainedDir
    ? join(retainedDir, RETAINED_ZIP_ROOT_DIRNAME)
    : await mkdtemp(join(tmpdir(), 'rayfin-fn-bundle-'));
  const outDir = join(stageDir, BUNDLE_OUTPUT_DIRNAME);
  const cleanup = (): void => {
    // Retaining the bundle is the whole point of the opt-in; deleting it
    // here would defeat it.
    if (retainedDir) return;
    try {
      rmSync(stageDir, { recursive: true, force: true });
    } catch {
      // Best-effort: a leftover temp dir is reclaimed by the OS eventually.
    }
  };

  if (retainedDir) {
    // Clear only the directory we own, so a stale file from an earlier
    // run cannot be mistaken for current output. Anything else the user
    // keeps in the retained dir is left alone.
    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true });
  }

  verbose('bundling entry:', entryPoint);
  verbose('bundle stageDir:', stageDir);
  try {
    let result: Awaited<ReturnType<typeof build>>;
    try {
      result = await build({
        entryPoints: [entryPoint],
        outdir: outDir,
        bundle: true,
        // ESM keeps `import.meta.url` meaningful for the banner and matches
        // the scaffolded package's `"type": "module"`.
        format: 'esm',
        platform: 'node',
        target: options.target ?? DEFAULT_NODE_TARGET,
        // No splitting: nothing in the worker's import graph is loaded
        // lazily any more, so esbuild emits a single entry file. Note that
        // re-introducing a dynamic import of an `external` module would
        // require splitting too — without it the import hoists to the top
        // of the entry file and fails at load with ERR_MODULE_NOT_FOUND.
        external: [HOST_INJECTED_MODULE, OPTIONAL_COMPILER_MODULE],
        banner: { js: CREATE_REQUIRE_BANNER },
        minify: options.minify ?? true,
        // Keep stack traces useful despite minification.
        sourcemap: true,
        // Preserve third-party licence headers without inlining them into
        // every bundle; esbuild emits a sibling .LEGAL.txt instead.
        legalComments: 'linked',
        metafile: true,
        logLevel: 'silent',
      });
    } catch (err) {
      // esbuild rejects with a BuildFailure carrying structured
      // diagnostics. Unwrap them so the caller sees the actionable
      // message rather than a raw "Build failed with N errors".
      const errors = (err as { errors?: EsbuildDiagnostic[] })?.errors;
      if (Array.isArray(errors) && errors.length > 0) {
        throw new Error(formatEsbuildFailure(errors), { cause: err });
      }
      throw err;
    }

    if (result.errors.length > 0) {
      throw new Error(formatEsbuildFailure(result.errors));
    }
    for (const warning of result.warnings) {
      verbose('[esbuild warning]', warning.text);
    }

    const outputs = result.metafile?.outputs ?? {};
    const outputPaths = Object.keys(outputs);
    const totalSizeBytes = outputPaths.reduce(
      (sum, path) => sum + (outputs[path]?.bytes ?? 0),
      0
    );

    const entryOutput = outputPaths.find(
      (path) => outputs[path]?.entryPoint !== undefined
    );
    if (!entryOutput) {
      throw new Error(
        'esbuild produced no entry output for the functions bundle.'
      );
    }
    const entryFileName = entryOutput.split('/').pop()!;

    verbose(
      `bundled ${outputPaths.length} files, entry: ${entryFileName}`,
      `(${totalSizeBytes} bytes)`
    );

    if (retainedDir) {
      // The metafile is the input to esbuild's bundle-size analyzer, so
      // it is worth keeping whenever someone is inspecting the output.
      writeFileSync(
        join(retainedDir, RETAINED_METAFILE_FILENAME),
        `${JSON.stringify(result.metafile, null, 2)}\n`,
        'utf8'
      );
    }

    return {
      stageDir,
      outDir,
      entryFileName,
      fileCount: outputPaths.length,
      totalSizeBytes,
      retainedDir,
      cleanup,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** Structured diagnostic shape shared by esbuild results and failures. */
interface EsbuildDiagnostic {
  text: string;
  location?: { file: string; line: number; column: number } | null;
}

/** Render esbuild diagnostics as an actionable multi-line message. */
function formatEsbuildFailure(errors: readonly EsbuildDiagnostic[]): string {
  const lines = ['Failed to bundle functions for deploy:', ''];
  for (const error of errors) {
    const location = error.location
      ? `${error.location.file}:${error.location.line}:${error.location.column}: `
      : '';
    lines.push(`  • ${location}${error.text}`);
  }
  lines.push('');
  lines.push(
    '💡 Every import must resolve from rayfin/functions/. Run `npm install` ' +
      'in your app root so workspace dependencies are linked, then retry.'
  );
  return lines.join('\n');
}

/**
 * Build the minimal `package.json` that ships beside the bundle.
 *
 * The bundle is self-contained, so runtime dependencies are dropped
 * entirely — nothing is installed on the remote host. Retaining the
 * original dependency list would be actively harmful: workspace siblings
 * are unpublished and would fail to resolve if anything tried to install
 * them.
 *
 * @param functionsDir - Source of the original `package.json`, read for
 *   its name and version only.
 * @param entryFileName - Bundle entry file name within `dist/`.
 */
export function buildBundledPackageJson(
  functionsDir: string,
  entryFileName: string
): string {
  const sourcePath = join(functionsDir, 'package.json');
  let name = 'rayfin-functions';
  let version = '0.0.0';

  if (existsSync(sourcePath)) {
    try {
      const pkg = JSON.parse(readFileSync(sourcePath, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (typeof pkg.name === 'string' && pkg.name) name = pkg.name;
      if (typeof pkg.version === 'string' && pkg.version) version = pkg.version;
    } catch {
      // A malformed package.json is reported by the deploy validator;
      // fall back to defaults rather than failing the bundle here.
    }
  }

  return `${JSON.stringify(
    {
      name,
      version,
      private: true,
      // The Functions Node worker loads the entry as ESM based on this.
      type: 'module',
      main: `dist/${entryFileName}`,
    },
    null,
    2
  )}\n`;
}
