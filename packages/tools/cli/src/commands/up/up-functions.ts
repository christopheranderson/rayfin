import { existsSync, openAsBlob, readFileSync, writeFileSync } from 'fs';
import { constants as osConstants } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import type { Diagnostics } from '@microsoft/rayfin-tools-common/_internal/adapters';
import type { FunctionsConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import { Command } from 'commander';

import { ensureAuthenticated } from '../../auth/index.js';
import { MONIKER_HEADER } from '../../config/constants.js';
import { CliHandledError } from '../../errors.js';
import {
  loadRayfinConfig,
  resolveServiceRoot,
  runServiceBuildCommand,
  type ServiceBuildOptions,
} from '../../utils/config-utils.js';
import { resolveDeploymentEnvFile } from '../../utils/env-fabric-utils.js';
import { formatBytes } from '../../utils/format-utils.js';
import {
  bundleFunctionsForDeploy,
  buildBundledPackageJson,
} from '../../utils/functions-bundler.js';
import { resolveDeployLockfile } from '../../utils/functions-lockfile-generator.js';
import {
  RUNTIME_METADATA_FILENAME,
  RUNTIME_METADATA_SCHEMA_VERSION,
  generateFunctionsMetadataFiles,
} from '../../utils/functions-metadata-generator.js';
import {
  formatViolation,
  validateFunctionsForDeploy,
} from '../../utils/functions-package-validator.js';
import {
  countPackageableFiles,
  packageFolderWithOverrides,
  type PackageFolderOptions,
  type PackagedZip,
} from '../../utils/functions-utils.js';
import { fabricFetch } from '../../utils/http-client.js';
import {
  type OutputMode,
  type ProgressIndicator,
  resolveOutputMode,
  resolveRootOutputFlags,
  createProgress,
  modeLog,
  modeError,
  emitJson,
  emitJsonError,
  formatDuration,
} from '../../utils/output-mode.js';
import { findRayfinProjectRoot } from '../../utils/project-utils.js';
import {
  getRemoteFunctionsDeployUrl,
  getUdfMetadataUrl,
  hasRemoteEndpoint,
} from '../../utils/remote-endpoint-utils.js';
import {
  HttpError,
  withRetry,
  RETRY_CONFIG,
  parseRetryAfterHeader,
} from '../../utils/retry-utils.js';
import { ensureSecretsTypes } from '../../utils/secrets-types-generator.js';

import {
  pollDeployStatus,
  handleDeployResult,
} from './functions/poll-deploy-status.js';
import { DeployState, type DeployAcceptedResponse } from './functions/types.js';

// TODO: Discover deploymetadata.json path from config instead of hardcoding filename
const DEPLOY_METADATA_FILENAME = 'deploymetadata.json';

/**
 * Escape hatch to restore the legacy source-zip deploy, which ships
 * `rayfin/functions/` verbatim and rebuilds it remotely.
 *
 * Bundling is the default because the source zip cannot express a
 * workspace layout: npm hoists dependencies above the zipped folder, and
 * workspace siblings are unpublished so a remote `npm install` cannot
 * resolve them. Set `RAYFIN_FUNCTIONS_NO_BUNDLE=1` to opt out if a
 * project hits a bundler-specific problem.
 */
const NO_BUNDLE_ENV_VAR = 'RAYFIN_FUNCTIONS_NO_BUNDLE';

const TRUTHY_ENV_VALUES: ReadonlySet<string> = new Set([
  '1',
  'true',
  'yes',
  'on',
]);

/** True when the legacy source-zip deploy has been explicitly requested. */
export function isBundlingDisabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = env[NO_BUNDLE_ENV_VAR];
  return raw !== undefined && TRUTHY_ENV_VALUES.has(raw.trim().toLowerCase());
}

// Directory names excluded from source-mode deploy zips.
// Source-mode functions are rebuilt remotely, so build outputs and dev-time symlinks
// would only bloat the upload and (in the case of `node_modules/`) leak
// dev-mode workspace symlinks that are unusable on the remote target.
const FUNCTIONS_DEPLOY_EXCLUDES: ReadonlySet<string> = new Set([
  'dist',
  'node_modules',
  'bin',
  'obj',
]);
// Directory names excluded from compiled (pre-built) deploy zips.
// bin/ and obj/ are stray .NET build artifacts that must never ship.
const FUNCTIONS_COMPILED_DEPLOY_EXCLUDES: ReadonlySet<string> = new Set([
  'bin',
  'obj',
]);
const FUNCTIONS_COMPILED_DEPLOY_EXCLUDE_SUFFIXES = [
  '.js.map',
  '.mjs.map',
  '.cjs.map',
  '.d.ts.map',
  '.d.mts.map',
  '.d.cts.map',
  '.tsbuildinfo',
] as const;
const FUNCTIONS_COMPILED_DEPLOY_EXCLUDE_ROOT_PATHS: ReadonlySet<string> =
  new Set([
    '.git',
    '.vscode',
    '.idea',
    '.eslintcache',
    '.prettiercache',
    'coverage',
    '.nyc_output',
  ]);

// File names that must never ship in a functions deploy zip, in any build
// mode. `local.settings.json` is the Azure Functions convention for
// developer-machine configuration and can hold secrets (connection strings,
// keys); it is local-only and must never be deployed.
const FUNCTIONS_DEPLOY_EXCLUDE_FILES: ReadonlySet<string> = new Set([
  'local.settings.json',
]);

/**
 * Validates that the functions folder exists and is non-empty after
 * applying deploy-time exclusions.
 */
function validateFunctionsFolder(
  resolvedPath: string,
  options: PackageFolderOptions
): {
  exists: boolean;
  empty: boolean;
  fileCount: number;
  totalSizeBytes: number;
  message?: string;
} {
  if (!existsSync(resolvedPath)) {
    return {
      exists: false,
      empty: true,
      fileCount: 0,
      totalSizeBytes: 0,
      message: `Functions folder not found: ${resolvedPath}`,
    };
  }

  const { fileCount, totalSizeBytes } = countPackageableFiles(
    resolvedPath,
    options
  );

  if (fileCount === 0) {
    return {
      exists: true,
      empty: true,
      fileCount: 0,
      totalSizeBytes: 0,
      message:
        'Functions folder has no files to deploy after applying deployment exclusions.',
    };
  }

  return {
    exists: true,
    empty: false,
    fileCount,
    totalSizeBytes,
  };
}

/**
 * Logger callback used by the deploy phase functions.  Defaults to a
 * `console.log` adapter inside the orchestrator (`deployFunctions`) so the
 * standalone subcommand keeps its existing UX.  Spinner-based callers
 * (`rayfin up`) supply a no-op logger to suppress progress lines that
 * would otherwise garble the spinner output.
 */
export type FunctionsDeployLogger = (message: string) => void;

const noopLogger: FunctionsDeployLogger = () => {};
const consoleLogger: FunctionsDeployLogger = (message) => {
  console.log(message);
};

// ---------------------------------------------------------------------------
// Phase 1 — Build
// ---------------------------------------------------------------------------

export interface BuildFunctionsOptions {
  output?: ServiceBuildOptions['output'];
  diagnostics?: Diagnostics;
  /** Skip the user-supplied build command. */
  skipBuild?: boolean;
  /** Logger for non-error progress lines.  Defaults to a no-op. */
  logger?: FunctionsDeployLogger;
}

/**
 * Run the user-supplied build command (if any) for the functions project.
 * The command's stdout/stderr are inherited so its output streams directly
 * to the user's terminal regardless of the caller's UX.
 *
 * Throws when the build command exits with a non-zero status.  Does
 * nothing when `skipBuild` is true or no build command is configured.
 */
export async function buildFunctionsForDeploy(
  serviceRoot: string,
  functionsConfig: FunctionsConfig,
  options: BuildFunctionsOptions = {}
): Promise<void> {
  const log = options.logger ?? noopLogger;

  if (options.skipBuild) {
    log('⏭️  Skipping functions build (--skip-build)');
    return;
  }
  if (!functionsConfig.buildCommand) return;

  // Handlers may already reference `ctx.Secrets.<NAME>` for a secret declared
  // in rayfin.yml. Without the generated registry the build fails with TS2339
  // and the deploy aborts before the metadata generator that would have
  // written it.
  ensureSecretsTypes(serviceRoot, (message) => log(`⚠️  ${message}`));

  log(`🔨 Running build command: ${functionsConfig.buildCommand}`);
  const buildSuccess = await runServiceBuildCommand(
    serviceRoot,
    functionsConfig.buildCommand,
    { output: options.output, diagnostics: options.diagnostics }
  );
  if (!buildSuccess) {
    throw new Error('Functions build command failed');
  }
  log('✔ Build completed');
}

// ---------------------------------------------------------------------------
// Phase 2 — Prepare deploy package
// ---------------------------------------------------------------------------

export interface PreparedFunctionsDeployPackage {
  /**
   * Handle to the compressed ZIP written to a temp file, ready to upload.
   * The caller MUST invoke {@link PackagedZip.cleanup} once the deploy
   * completes (or fails) to remove the backing temp directory.
   */
  zip: PackagedZip;
  /** Deploy metadata JSON string ready to send as the `DeployMetaData` field. */
  deployMetaData: string;
  /** Number of files in the zip, including generated overrides. */
  fileCount: number;
  /** Pre-compression total size of files in the zip, including overrides. */
  totalSizeBytes: number;
  /**
   * True when the zip holds a self-contained esbuild bundle rather than
   * source. Bundled packages need no remote build, so callers signal the
   * deploy server accordingly.
   */
  isBundled: boolean;
}

export interface PrepareFunctionsDeployOptions {
  /** Logger for non-error progress lines.  Defaults to a no-op. */
  logger?: FunctionsDeployLogger;
  /** Verbose diagnostic logger; defaults to a no-op. */
  verbose?: (...args: unknown[]) => void;
  /**
   * When true, includes `dist/` and `node_modules/` in the zip because
   * the package is already compiled locally. Excludes external JavaScript
   * and declaration maps, TypeScript build state, and root tooling paths.
   */
  isCompiledZip?: boolean;
}

/**
 * Validate the functions service folder, generate deploy metadata, resolve
 * the lockfile, and produce a disk-backed ZIP ready for upload.
 * The on-disk folder is never mutated (apart from the metadata
 * `deploymetadata.json` file written for the deploy server contract).
 *
 * @param serviceRoot - The resolved functions service root (from
 *   `services.functions.path`).
 *
 * Throws when validation fails or the folder has no files after
 * applying the deploy-time exclusions.
 */
export async function prepareFunctionsDeployPackage(
  serviceRoot: string,
  options: PrepareFunctionsDeployOptions = {}
): Promise<PreparedFunctionsDeployPackage> {
  const log = options.logger ?? noopLogger;
  const verbose = options.verbose ?? (() => {});
  // Re-resolve from rayfin.yml so deploy always targets the authoritative
  // FUNCTIONS service root even if a caller passes an outdated path.
  const projectRoot = findRayfinProjectRoot(serviceRoot, {
    verbose: false,
    silent: true,
  });
  const config = loadRayfinConfig(projectRoot, { silent: true });
  const functionsDir = resolveServiceRoot(
    projectRoot,
    'functions',
    config?.services?.functions?.path ?? 'rayfin/functions'
  );
  const useBundle = !isBundlingDisabled();
  const packageOptions: PackageFolderOptions = {
    excludeDirNames: options.isCompiledZip
      ? FUNCTIONS_COMPILED_DEPLOY_EXCLUDES
      : FUNCTIONS_DEPLOY_EXCLUDES,
    excludeFileNames: FUNCTIONS_DEPLOY_EXCLUDE_FILES,
    ...(options.isCompiledZip && {
      excludeFileSuffixes: FUNCTIONS_COMPILED_DEPLOY_EXCLUDE_SUFFIXES,
      excludeRootPaths: FUNCTIONS_COMPILED_DEPLOY_EXCLUDE_ROOT_PATHS,
    }),
  };

  // ── Validate folder structure + dep portability ─────────────────
  // Bundling inlines every reachable module, so `file:` deps pointing
  // outside the functions folder are no longer a portability problem.
  const deployValidation = validateFunctionsForDeploy(functionsDir, {
    checkDependencyPortability: !useBundle,
    runtimeMetadataSchemaVersion: RUNTIME_METADATA_SCHEMA_VERSION,
  });
  if (!deployValidation.valid) {
    const lines: string[] = [
      `Cannot deploy: ${functionsDir} is not deploy-ready.`,
      '',
      'Fix each of the following before retrying:',
      '',
    ];
    for (const violation of deployValidation.violations) {
      lines.push(formatViolation(violation));
      lines.push('');
    }
    if (!useBundle) {
      lines.push('💡 Local packages must use relative `file:./*.tgz` paths so');
      lines.push(
        '   the remote build host can resolve them from the deploy ZIP.'
      );
    }
    throw new Error(lines.join('\n'));
  }

  // ── Generate deploy and runtime metadata ────────────────────────
  log('🔍 Generating functions metadata from source...');
  const { deployMetadataJson: deployMetaData, runtimeMetadataJson } =
    await generateFunctionsMetadataFiles(functionsDir, {
      verbose: (...args) => verbose('[metadata]', ...args),
      onDiagnostic: (diagnostic) => {
        const location = `${diagnostic.filePath}:${diagnostic.line}:${diagnostic.column}`;
        log(`Warning: ${location}: ${diagnostic.message}`);
      },
    });
  const metadataOutputPath = join(functionsDir, DEPLOY_METADATA_FILENAME);
  writeFileSync(metadataOutputPath, deployMetaData);
  verbose('Metadata written to:', metadataOutputPath);

  // ── Validate packageable files after applying deploy excludes ───
  const folderStats = validateFunctionsFolder(functionsDir, packageOptions);
  if (!folderStats.exists || folderStats.empty) {
    throw new Error(folderStats.message ?? 'Functions folder is empty');
  }

  // ── Resolve the deploy host.json ─────────────────────────────────
  // Locally the scaffolded host.json references the *Preview* extension
  // bundle. For remote deploy, inject the prod host.json which pins the
  // GA (non-preview) extension bundle so the deployed function uses the
  // platform-managed stable bundle instead.
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const deployHostJsonPath = join(
    __dirname,
    '..',
    '..',
    '..',
    'assets',
    'functions',
    'host.deploy.json'
  );
  const deployHostJson = readFileSync(deployHostJsonPath, 'utf8');

  if (useBundle) {
    return await packageBundledDeploy({
      functionsDir,
      deployMetaData,
      runtimeMetadataJson,
      deployHostJson,
      log,
      verbose,
    });
  }

  // ── Resolve lockfile (on-disk → generated → unavailable) ────────
  const lockfileResult = await resolveDeployLockfile(functionsDir, {
    verbose,
  });
  const overrides: Record<string, string | Buffer> = {
    [RUNTIME_METADATA_FILENAME]: runtimeMetadataJson,
    'host.json': deployHostJson,
  };
  if (lockfileResult.source === 'generated') {
    log(
      '🔄 No package-lock.json on disk — generating one from package.json for deploy'
    );
    overrides['package-lock.json'] = lockfileResult.lockfileJson!;
  } else if (lockfileResult.source === 'unavailable') {
    log(`⚠️  Could not generate package-lock.json: ${lockfileResult.warning}`);
    log(
      '   Deploying without a lockfile; the remote build will resolve fresh versions.'
    );
  }

  // ── Package with final override counts ──────────────────────────
  const packageStats = countPackageableFiles(
    functionsDir,
    packageOptions,
    overrides
  );
  log(
    `📦 Packaging ${packageStats.fileCount} functions files (${formatBytes(packageStats.totalSizeBytes)})...`
  );
  const zip = await packageFolderWithOverrides(
    functionsDir,
    overrides,
    packageOptions
  );

  return {
    zip,
    deployMetaData,
    fileCount: packageStats.fileCount,
    totalSizeBytes: packageStats.totalSizeBytes,
    isBundled: false,
  };
}

/**
 * Bundle the functions project with esbuild and package the result.
 *
 * The zip root is the bundler's stage directory, so the archive contains
 * `dist/` plus the four files added as overrides — and nothing else. No
 * `node_modules/`, no sources, and no lockfile: the bundle is
 * self-contained, so the remote host installs nothing.
 */
async function packageBundledDeploy(args: {
  functionsDir: string;
  deployMetaData: string;
  runtimeMetadataJson: string;
  deployHostJson: string;
  log: FunctionsDeployLogger;
  verbose: (...args: unknown[]) => void;
}): Promise<PreparedFunctionsDeployPackage> {
  const {
    functionsDir,
    deployMetaData,
    runtimeMetadataJson,
    deployHostJson,
    log,
    verbose,
  } = args;

  log('📦 Bundling functions for deploy...');
  const bundle = await bundleFunctionsForDeploy(functionsDir, {
    verbose: (...bundleArgs) => verbose('[bundle]', ...bundleArgs),
  });

  try {
    const overrides: Record<string, string | Buffer> = {
      'host.json': deployHostJson,
      'package.json': buildBundledPackageJson(
        functionsDir,
        bundle.entryFileName
      ),
      [DEPLOY_METADATA_FILENAME]: deployMetaData,
      [RUNTIME_METADATA_FILENAME]: runtimeMetadataJson,
    };

    // The zip is the emitted bundle plus these in-memory overrides, so both
    // halves have to be counted for the reported totals to match what ships.
    const overrideSizeBytes = Object.values(overrides).reduce(
      (total, contents) => total + Buffer.byteLength(contents),
      0
    );
    const fileCount = bundle.fileCount + Object.keys(overrides).length;
    const totalSizeBytes = bundle.totalSizeBytes + overrideSizeBytes;

    log(
      `📦 Packaging bundled functions (${fileCount} files, ` +
        `${formatBytes(totalSizeBytes)})...`
    );
    if (bundle.retainedDir) {
      // esbuild only emits dist/; the rest of the zip is assembled as
      // overrides in memory. Write them out too, so the retained zip root
      // is a faithful copy of the artifact rather than a partial one.
      for (const [name, contents] of Object.entries(overrides)) {
        writeFileSync(join(bundle.stageDir, name), contents);
      }
      log(`📂 Bundle retained for inspection: ${bundle.retainedDir}`);
    }
    const zip = await packageFolderWithOverrides(bundle.stageDir, overrides);

    return {
      zip,
      deployMetaData,
      fileCount,
      totalSizeBytes,
      isBundled: true,
    };
  } finally {
    // The zip is fully written by this point, so the stage dir is no
    // longer needed regardless of outcome.
    bundle.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — Upload
// ---------------------------------------------------------------------------

export interface UploadFunctionsDeployOptions {
  diagnostics?: Diagnostics;
  /** Logger for default retry messages.  Defaults to `console.log`. */
  logger?: FunctionsDeployLogger;
  /** Verbose diagnostic logger; defaults to a no-op. */
  verbose?: (...args: unknown[]) => void;
  /**
   * Optional retry callback that overrides the default logger-based
   * message.  Spinner-aware callers use this to pause the spinner before
   * printing the retry notice and restart it afterward.
   */
  onRetry?: (attempt: number, delay: number, error: unknown) => void;
  /**
   * When true, signals the server that the zip contains pre-compiled
   * output and the remote build step should be skipped.
   */
  isCompiledZip?: boolean;
}

/**
 * Upload a prepared deploy package to the workload endpoint with retry on
 * transient failures (404/408/425/429/502/503).  The caller is responsible for
 * supplying a valid `Bearer <token>` `Authorization` header.
 */
export async function uploadFunctionsDeployPackage(
  prepared: PreparedFunctionsDeployPackage,
  deployUrl: string,
  rayfinItemId: string,
  authorizationHeader: string,
  options: UploadFunctionsDeployOptions = {}
): Promise<DeployAcceptedResponse> {
  const log = options.logger ?? consoleLogger;
  const verbose = options.verbose ?? (() => {});
  const monikerHeaders: Record<string, string> = {
    [MONIKER_HEADER]: rayfinItemId,
  };

  let accepted: DeployAcceptedResponse | undefined;

  await withRetry(
    async () => {
      const formData = new FormData();
      formData.append(
        'SourceZipFile',
        await openAsBlob(prepared.zip.zipPath, {
          type: 'application/zip',
        }),
        'source.zip'
      );
      formData.append('DeployMetaData', prepared.deployMetaData);
      if (options.isCompiledZip) {
        formData.append('isCompiledZip', 'true');
      }

      verbose(`POST ${deployUrl}`);
      const resp = await fabricFetch(
        deployUrl,
        {
          method: 'POST',
          headers: {
            Authorization: authorizationHeader,
            ...monikerHeaders,
            // Do not set Content-Type — fetch auto-sets multipart boundary
          },
          body: formData,
        },
        options.diagnostics
      );
      if (!resp.ok) {
        const errorBody = await resp.text().catch(() => '');
        verbose(`Response: ${resp.status} ${resp.statusText}`);
        verbose('Error body:', errorBody);
        throw new HttpError(
          `Functions deploy failed (${resp.status}): ${errorBody || resp.statusText}`,
          resp.status,
          parseRetryAfterHeader(resp)
        );
      }

      // Server returns 202 Accepted with the UDF artifact ID in the body.
      accepted = (await resp.json()) as DeployAcceptedResponse;
      verbose('UDF item ID:', accepted.udfArtifactId);
    },
    {
      label: 'functions-deploy',
      verbose: (...args) => {
        options.diagnostics?.debug({
          area: 'functions.retry',
          message: args.map(String).join(' '),
        });
        verbose(...args);
      },
      shouldRetry: (error) =>
        error instanceof HttpError &&
        [404, 408, 425, 429, 502, 503].includes(error.statusCode),
      onRetry:
        options.onRetry ??
        ((attempt, delay, error) => {
          const status =
            error instanceof HttpError ? error.statusCode : 'error';
          log(
            `⏳ Deploy endpoint not ready (${status}), retrying in ${delay / 1000}s... (${attempt}/${RETRY_CONFIG.maxAttempts})`
          );
        }),
    }
  );

  if (!accepted) {
    throw new Error(
      'Unexpected: deploy request succeeded but returned no response body.'
    );
  }
  return accepted;
}

// ---------------------------------------------------------------------------
// Orchestrator (used by the standalone subcommand)
// ---------------------------------------------------------------------------

/**
 * Options for {@link deployFunctions}.
 */
export interface DeployFunctionsOptions {
  buildOutput?: ServiceBuildOptions['output'];
  diagnostics?: Diagnostics;
  /** Absolute path to the functions service root (resolved from services.functions.path). */
  serviceRoot: string;
  /**
   * Fully-qualified deploy URL (e.g. `<itemEndpoint>/__private/functions/deploy`).
   * Callers that already have the workload `itemEndpoint` resolved (such
   * as `rayfin up`) build this directly; the standalone subcommand
   * resolves it via {@link getRemoteFunctionsDeployUrl}.
   */
  deployUrl: string;
  /** Rayfin item id used for the moniker header. */
  rayfinItemId: string;
  /**
   * `Bearer <token>` value for the `Authorization` header.  When omitted,
   * the helper acquires a fresh Fabric token via {@link ensureAuthenticated}.
   */
  authorizationHeader?: string;
  /** The `services.functions` config block from rayfin.yml. */
  functionsConfig: FunctionsConfig;
  /** Skip the user-supplied build command before packaging. */
  skipBuild?: boolean;
  /** Signal the server that the zip is pre-compiled (skip remote build). */
  isCompiledZip?: boolean;
  /** Verbose diagnostic logger; defaults to a no-op. */
  verbose?: (...args: unknown[]) => void;
  /** Output mode for progress display. Defaults to 'interactive'. */
  mode?: OutputMode;
  /**
   * Factory for creating progress indicators. When provided, each deploy
   * phase is wrapped in its own indicator (e.g. ora spinners in
   * interactive mode). When omitted, falls back to `modeLog`-based
   * progress messages.
   */
  showProgress?: (message: string, emoji: string) => ProgressIndicator;
}

/** Per-step timing information for JSON output. */
export interface DeployFunctionsStepResult {
  duration: string;
  status: 'success' | 'error';
  error?: string;
}

export interface DeployFunctionsResult {
  fileCount: number;
  totalSizeBytes: number;
  /** Per-step timing data for structured output. */
  steps: Record<string, DeployFunctionsStepResult>;
}

/**
 * Run all four deploy phases (build, package, upload, poll) in sequence
 * with mode-aware progress.
 *
 * When `showProgress` is supplied (e.g. from `rayfin up`), each phase is
 * wrapped in its own progress indicator (spinner in interactive mode).
 * Otherwise, falls back to `modeLog`-based messages (standalone subcommand).
 *
 * Throws on any phase failure. The on-disk functions folder is never
 * mutated.
 */
export async function deployFunctions(
  options: DeployFunctionsOptions
): Promise<DeployFunctionsResult> {
  const mode = options.mode ?? 'interactive';
  const verbose = (...args: unknown[]): void => {
    options.diagnostics?.debug({
      area: 'functions',
      message: args.map(String).join(' '),
    });
    options.verbose?.(...args);
  };
  const progress =
    options.showProgress ??
    ((message: string, _emoji: string) =>
      createProgress(mode, message, { prefix: '[rayfin up]' }));

  const steps: Record<string, DeployFunctionsStepResult> = {};
  const recordStep = (
    name: string,
    indicator: ProgressIndicator,
    status: 'success' | 'error' = 'success',
    error?: string
  ) => {
    steps[name] = {
      duration: indicator.getDurationStr(),
      status,
      ...(error ? { error } : {}),
    };
  };

  // ── Build phase ─────────────────────────────────────────────────
  if (options.functionsConfig.buildCommand) {
    if (options.skipBuild) {
      modeLog(mode, '⏭️  Skipping functions build (--skip-build)');
    } else {
      modeLog(
        mode,
        `🔨 Running functions build command: ${options.functionsConfig.buildCommand}`
      );
      const buildSpinner = progress('Building functions', '🔨');
      // Stop spinner so the build command's stdio (inherited) is not
      // garbled by spinner repaints.
      buildSpinner.stop();
      try {
        await buildFunctionsForDeploy(
          options.serviceRoot,
          options.functionsConfig,
          { output: options.buildOutput, diagnostics: options.diagnostics }
        );
      } catch (buildError) {
        recordStep(
          'functionsBuild',
          buildSpinner,
          'error',
          (buildError as Error).message
        );
        modeError(
          mode,
          `❌ Functions build failed: ${(buildError as Error).message}`
        );
        throw buildError;
      }
      modeLog(mode, '✔ Functions build completed');
      recordStep('functionsBuild', buildSpinner);
    }
  }

  // ── Package phase ───────────────────────────────────────────────
  const packageSpinner = progress('Packaging functions', '📦');
  let prepared: PreparedFunctionsDeployPackage;
  try {
    prepared = await prepareFunctionsDeployPackage(options.serviceRoot, {
      verbose,
      isCompiledZip: options.isCompiledZip,
      logger: (msg) => modeLog(mode, msg),
    });
  } catch (packError) {
    recordStep(
      'functionsPackage',
      packageSpinner,
      'error',
      (packError as Error).message
    );
    packageSpinner.fail(
      `Failed to package functions: ${(packError as Error).message}`
    );
    throw packError;
  }
  packageSpinner.succeed(
    `Functions packaged (${prepared.fileCount} files, ${formatBytes(prepared.totalSizeBytes)} source, ${formatBytes(prepared.zip.byteLength)} compressed)`
  );
  recordStep('functionsPackage', packageSpinner);

  // The packaged zip lives in a temp dir until the upload consumes it. A
  // normal return, throw, or the try/finally below all release it — but a
  // Ctrl-C mid-upload bypasses try/finally and would orphan the temp dir
  // (never auto-reclaimed on Windows %TEMP%). Guard that window with a signal
  // handler that runs the same idempotent release, then exits with the
  // conventional 128 + signal-number code (130 for SIGINT, 143 for SIGTERM) so
  // a process manager observes the correct signal outcome. `releaseZip` also
  // detaches the handlers so repeated deploys don't leak listeners.
  //
  // Exit-code note (deliberate): this uses POSIX signal semantics (128 +
  // signal → 130/143) rather than the CLI's EXIT_CODE_CANCELLED (2, see
  // scripts/main). A signal-terminated deploy is an external kill, not the
  // "user declined a prompt" cancellation that exit code 2 denotes, so a
  // process manager should see the conventional signal outcome. Consequently
  // the hard process.exit() below intentionally bypasses the
  // shutdownTelemetry() flush in scripts/main's finally: on a signal we
  // prioritize a prompt exit and the reclaimed temp dir over flushing a
  // single in-flight telemetry event.
  let zipReleased = false;
  function releaseZip(): void {
    if (zipReleased) return;
    zipReleased = true;
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
    prepared.zip.cleanup();
  }
  function onInterrupt(signal: string): void {
    releaseZip();
    const signalNumber =
      osConstants.signals[signal as keyof typeof osConstants.signals] ??
      osConstants.signals.SIGINT;
    process.exit(128 + signalNumber);
  }
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  // ── Auth (if needed) ────────────────────────────────────────────
  let authorizationHeader = options.authorizationHeader;
  if (!authorizationHeader) {
    modeLog(mode, '🔐 Authenticating...');
    const fabricToken = await ensureAuthenticated().catch((err) => {
      releaseZip();
      throw new Error(
        "Failed to acquire Fabric authentication token. Sign in with 'rayfin login'.",
        { cause: err }
      );
    });
    authorizationHeader = `Bearer ${fabricToken.token}`;
    modeLog(mode, '✔ Authenticated');
  }

  // ── Upload phase ────────────────────────────────────────────────
  const deploySpinner = progress('Deploying functions', '🚀');
  let accepted: DeployAcceptedResponse;
  try {
    accepted = await uploadFunctionsDeployPackage(
      prepared,
      options.deployUrl,
      options.rayfinItemId,
      authorizationHeader,
      {
        verbose: options.verbose,
        diagnostics: options.diagnostics,
        // A bundle needs no remote build, so signal a pre-compiled zip
        // even when the caller did not explicitly ask for one.
        isCompiledZip: options.isCompiledZip || prepared.isBundled,
        onRetry: (attempt, delay, error) => {
          const status =
            error instanceof HttpError ? error.statusCode : 'error';
          deploySpinner.stop();
          modeLog(
            mode,
            `⏳ Deploy endpoint not ready (${status}), retrying in ${delay / 1000}s... (${attempt}/${RETRY_CONFIG.maxAttempts})`
          );
          deploySpinner.start();
        },
      }
    );
  } catch (deployError) {
    recordStep(
      'functionsDeploy',
      deploySpinner,
      'error',
      (deployError as Error).message
    );
    deploySpinner.fail(
      `Functions deploy failed: ${(deployError as Error).message}`
    );
    throw deployError;
  } finally {
    // The temp zip is fully consumed by the upload (including retries); remove
    // its backing dir and detach the interrupt handlers whether the upload
    // succeeded or threw. Idempotent.
    releaseZip();
  }
  deploySpinner.succeed('Functions upload accepted');
  recordStep('functionsDeploy', deploySpinner);

  // ── Poll for deployment completion ──────────────────────────────
  // Each error path records its step before throwing, so the caller's
  // catch handler doesn't need to distinguish "already recorded" from
  // "fresh exception".
  const pollSpinner = progress('Checking deployment status', '⏳');

  const metadataUrl = getUdfMetadataUrl(accepted.udfArtifactId);
  if (!metadataUrl) {
    const msg =
      'Could not resolve workspace ID to poll deployment status. ' +
      'Ensure a deployment is configured.';
    pollSpinner.fail('Could not resolve workspace to poll deployment status');
    recordStep('functionsPoll', pollSpinner, 'error', msg);
    throw new Error(msg);
  }

  options.verbose?.('[functions] UDF metadata URL:', metadataUrl);
  // While the poll spinner is active, route verbose lines through the
  // spinner's log channel so they don't garble the spinner repaint.
  // `pollSpinner.log(...)` always prints, so we have to gate on
  // whether the caller actually requested verbose output — a no-op
  // `verbose` is not enough to suppress the spinner's own output.
  const spinnerVerbose = options.verbose
    ? (...args: unknown[]) =>
        pollSpinner.log(`[verbose] ${args.map(String).join(' ')}`)
    : undefined;

  let deploy;
  try {
    deploy = await pollDeployStatus(
      metadataUrl,
      { Authorization: authorizationHeader },
      {
        verbose: spinnerVerbose,
        diagnostics: options.diagnostics,
        onPoll: (attempt, maxPolls) =>
          pollSpinner.log(
            `  Checking deployment status ${attempt}/${maxPolls}`
          ),
      }
    );
  } catch (pollError) {
    const msg = (pollError as Error).message;
    pollSpinner.fail(`Deployment status check failed: ${msg}`);
    recordStep('functionsPoll', pollSpinner, 'error', msg);
    throw pollError;
  }

  handleDeployResult(deploy, pollSpinner, (msg) => pollSpinner.log(msg));
  recordStep(
    'functionsPoll',
    pollSpinner,
    deploy.status === DeployState.Complete ? 'success' : 'error',
    deploy.status === DeployState.Fail ? deploy.error : undefined
  );
  if (deploy.status === DeployState.Fail) {
    throw new Error(deploy.error ?? 'Functions deployment failed');
  }

  return {
    fileCount: prepared.fileCount,
    totalSizeBytes: prepared.totalSizeBytes,
    steps,
  };
}

/**
 * Functions subcommand for remote deployment.
 * Provides 'rayfin up functions deploy' functionality as an escape hatch
 * when the full `rayfin up` flow is not needed.
 */
export const upFunctionsCommand = new Command('functions')
  .description('Functions operations for remote Rayfin item deployment')
  .addCommand(
    new Command('deploy')
      .description('Build, package, and deploy functions to remote Rayfin item')
      .option('-v, --verbose', 'Enable verbose output', false)
      .option(
        '--skip-build',
        'Skip the build command and deploy existing content',
        false
      )
      .option('--json', 'Output result as JSON', false)
      .action(
        async (
          options: {
            verbose?: boolean;
            skipBuild?: boolean;
            json?: boolean;
          },
          command: Command
        ) => {
          // Merge with parent command options so global flags
          // (e.g. --verbose, --json) are visible.
          options = { ...options, ...command.optsWithGlobals() };

          const resolvedVerbose =
            Boolean(options.verbose) || resolveRootOutputFlags(command).verbose;
          const jsonFlag =
            Boolean(options.json) || resolveRootOutputFlags(command).json;
          const mode = resolveOutputMode({ json: jsonFlag });
          const verbose = resolvedVerbose
            ? (...args: unknown[]) => modeLog(mode, '[verbose]', ...args)
            : (..._args: unknown[]) => {};

          // Verify remote endpoint exists
          if (!hasRemoteEndpoint()) {
            if (mode === 'json') {
              emitJsonError(
                mode,
                'No remote endpoint configured. Run "rayfin up" first.'
              );
            }
            modeError(mode, '❌ No remote endpoint configured');
            modeError(
              mode,
              "💡 Run 'rayfin up' first to deploy and configure the remote endpoint"
            );
            throw new CliHandledError(
              new Error('No remote endpoint configured')
            );
          }

          const deployUrl = getRemoteFunctionsDeployUrl();
          if (!deployUrl) {
            if (mode === 'json') {
              emitJsonError(mode, 'Could not construct functions deploy URL');
            }
            modeError(mode, '❌ Could not construct functions deploy URL');
            throw new CliHandledError(
              new Error('Could not construct functions deploy URL')
            );
          }

          // Load config
          const rayfinConfig = loadRayfinConfig(process.cwd(), {
            silent: true,
          });
          if (!rayfinConfig) {
            if (mode === 'json') {
              emitJsonError(mode, 'Could not load rayfin.yml configuration');
            }
            modeError(mode, '❌ Could not load rayfin.yml configuration');
            throw new CliHandledError(
              new Error('Could not load rayfin.yml configuration')
            );
          }

          const functionsConfig = rayfinConfig.services.functions;
          if (!functionsConfig?.enabled) {
            if (mode === 'json') {
              emitJsonError(mode, 'Functions are not enabled in rayfin.yml');
            }
            modeError(mode, '❌ Functions are not enabled in rayfin.yml');
            modeError(
              mode,
              "💡 Set 'services.functions.enabled: true' and re-run"
            );
            throw new CliHandledError(
              new Error('Functions are not enabled in rayfin.yml')
            );
          }

          const projectRoot = findRayfinProjectRoot(process.cwd(), {
            verbose: false,
            silent: true,
          });
          const functionsServiceRoot = resolveServiceRoot(
            projectRoot,
            'functions',
            functionsConfig.path ?? 'rayfin/functions'
          );

          // Read rayfinItemId and workspaceName from the deployment registry
          const resolved = await resolveDeploymentEnvFile({ projectRoot });
          const rayfinItemId = resolved?.deployment.rayfinItemId;
          const workspaceId = resolved?.deployment.fabricWorkspaceId;

          if (!rayfinItemId || !workspaceId) {
            if (mode === 'json') {
              emitJsonError(
                mode,
                'Missing deployment metadata (rayfinItemId or fabricWorkspaceId). Run "rayfin up" first.'
              );
            }
            modeError(
              mode,
              '❌ Missing deployment metadata (rayfinItemId or fabricWorkspaceId)'
            );
            modeError(
              mode,
              "💡 Run 'rayfin up' first to deploy and configure the remote endpoint"
            );
            throw new CliHandledError(new Error('Missing deployment metadata'));
          }

          modeLog(mode, '⚡ Functions Deploy (Remote Mode)\n');
          modeLog(mode, '🎯 Target: Remote Rayfin item workload endpoint');
          modeLog(mode, `📍 Endpoint: ${deployUrl}`);

          const startTime = Date.now();

          try {
            const result = await deployFunctions({
              serviceRoot: functionsServiceRoot,
              deployUrl,
              rayfinItemId,
              functionsConfig,
              skipBuild: options.skipBuild,
              isCompiledZip: true,
              verbose: resolvedVerbose ? verbose : undefined,
              mode,
            });
            modeLog(
              mode,
              `✅ Functions deployed (${result.fileCount} files, ${formatBytes(result.totalSizeBytes)})`
            );

            if (mode === 'json') {
              const duration = Date.now() - startTime;
              emitJson({
                status: 'success',
                fileCount: result.fileCount,
                totalSizeBytes: result.totalSizeBytes,
                duration: formatDuration(duration),
              });
            }
          } catch (error) {
            if (mode === 'json') {
              const duration = Date.now() - startTime;
              emitJsonError(mode, (error as Error).message, {
                duration: formatDuration(duration),
              });
            }
            modeError(
              mode,
              `\n❌ Functions deploy failed: ${(error as Error).message}`
            );
            modeError(mode, '\n💡 Troubleshooting tips:');
            modeError(
              mode,
              '   • Verify the Rayfin item workload is running and healthy'
            );
            modeError(mode, "   • Check if 'rayfin up' completed successfully");
            modeError(
              mode,
              '   • Ensure your network can reach the remote endpoint'
            );
            modeError(
              mode,
              '   • Use --skip-build to deploy existing content without rebuilding'
            );
            throw new CliHandledError(error);
          }
        }
      )
  );
