import { constants, existsSync, readFileSync } from 'fs';
import { access } from 'fs/promises';
import { resolve, join, relative, sep } from 'path';
import path from 'path';
import { fileURLToPath } from 'url';

import { Command, Option } from 'commander';

import {
  updateRayfinConfig,
  loadRayfinConfig,
  validateServicePath,
} from '../../utils/config-utils.js';
import { generateFunctionsTypes } from '../../utils/functions-types-generator.js';
import { createFunctionsAuthConfig } from '../../utils/init-functions-settings-helper.js';
import {
  emitJsonError,
  modeLog,
  resolveOutputMode,
  resolveRootOutputFlags,
} from '../../utils/output-mode.js';
import { spawnSafe } from '../../utils/platform-utils.js';
import { findRayfinProjectRoot } from '../../utils/project-utils.js';
import { ensureSecretsTypes } from '../../utils/secrets-types-generator.js';
import { installAgentFilesAfterScaffold } from '../ai-files/install-after-scaffold.js';

import { scaffoldFunctionsDirectory } from './functions-scaffold.js';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface FunctionsInitOptions {
  directory?: string;
  skipInstall?: boolean;
  /**
   * When `true` and the functions package already exists, re-scaffold the
   * directory from the template, overwriting any in-flight user edits
   * to `function_app.ts`, `local.settings.json`, etc.
   *
   * Default is `false`: re-running `functions init` on an existing
   * functions project is treated as "refresh deps and regenerate
   * types.ts" rather than "reset to template". This matches how
   * `rayfin init` behaves on an already-initialised project and avoids
   * the common trap of losing UDF code when re-running the command.
   */
  force?: boolean;
  /**
   * Explicit location for the functions package, relative to the project
   * root (e.g. `packages/functions`). Overrides both
   * `services.functions.path` and workspace auto-detection, and is written
   * back to `rayfin.yml` so every other command resolves the same location.
   */
  path?: string;
}

/**
 * Default location of the functions package, used when `rayfin.yml` does not
 * pin one. Kept in sync with every other functions consumer
 * (`up functions deploy`, `dev functions apply`, `rayfin-services/functions`).
 */
const DEFAULT_FUNCTIONS_PATH = 'rayfin/functions';

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/**
 * Strip trailing `/` characters.
 *
 * Deliberately not `replace(/\/+$/, '')`: that pattern is quadratic on input
 * consisting of many slashes, because the engine retries the `+` match from
 * every offset (CodeQL `js/polynomial-redos`). Both callers take strings from
 * outside this module — a `--path` argument and the root `package.json`
 * manifest — so the linear reverse scan is the safer construction even though
 * neither is attacker-controlled in practice.
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* '/' */) {
    end--;
  }
  return value.slice(0, end);
}

/**
 * Normalize `services.functions.path` read from `rayfin.yml`.
 *
 * YAML is untyped, so this value arrives as whatever the author wrote:
 * `path: 123` parses to a number and `path: {a: b}` to an object. Passing
 * either straight to `validateServicePath` throws Node's raw
 * `ERR_INVALID_ARG_TYPE` from `isAbsolute`, which the caller renders as an
 * opaque `Error scaffolding functions project: ...` with an internals stack
 * trace. Fail with a message that names the offending key instead.
 *
 * Normalizing here also keeps the three path sources symmetric: `--path` and
 * the workspace-derived value are both run through
 * `stripTrailingSlashes(toPosix(...))`, so a config value of
 * `packages/functions/` would otherwise compare unequal to a resolved
 * `packages/functions` and make `persist` and the log label drift.
 *
 * `undefined`, `null`, and `''` are not errors — they mean "unset" and fall
 * through to detection.
 */
function normalizeConfiguredPath(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new Error(
      `Service 'functions' path in rayfin.yml must be a relative path string, ` +
        `but got ${typeof value} (${JSON.stringify(value)}). ` +
        `Set services.functions.path to a path such as '${DEFAULT_FUNCTIONS_PATH}'.`
    );
  }
  const normalized = stripTrailingSlashes(toPosix(value.trim()));
  return normalized === '' ? undefined : normalized;
}

/**
 * Read the npm workspace globs declared by the project's root `package.json`.
 *
 * Supports both supported manifest shapes: the array form
 * (`"workspaces": ["packages/*"]`) and the object form
 * (`"workspaces": { "packages": ["packages/*"] }`, used by Yarn).
 *
 * Returns an empty array when the manifest is missing, unparseable, or
 * declares no workspaces — callers treat that as "not a workspace project".
 */
function readWorkspaceGlobs(projectRoot: string): string[] {
  try {
    const manifest = JSON.parse(
      readFileSync(join(projectRoot, 'package.json'), 'utf8')
    );
    const workspaces: unknown = manifest?.workspaces;
    const globs: unknown = Array.isArray(workspaces)
      ? workspaces
      : (workspaces as { packages?: unknown })?.packages;
    if (!Array.isArray(globs)) return [];
    return globs.filter((g): g is string => typeof g === 'string');
  } catch {
    return [];
  }
}

/**
 * Derive the conventional functions-package location for an npm-workspace
 * project, or `null` when this is not a workspace project.
 *
 * The container directory is taken from the first `<dir>/*` glob the root
 * manifest declares, so a project using `apps/*` gets `apps/functions` rather
 * than a hardcoded `packages/functions`. Globs that are not a simple
 * single-level wildcard (e.g. `packages/**`, or an exact path) are skipped —
 * there is no unambiguous container to place a new package in.
 */
export function detectWorkspaceFunctionsPath(
  projectRoot: string
): string | null {
  for (const glob of readWorkspaceGlobs(projectRoot)) {
    const normalized = stripTrailingSlashes(toPosix(glob));
    if (!normalized.endsWith('/*')) continue;
    const container = normalized.slice(0, -2);
    if (container === '' || container.includes('*')) continue;
    return `${container}/functions`;
  }
  return null;
}

/**
 * Resolve where the functions package should live for this project.
 *
 * Precedence, highest first:
 *  1. `--path` — an explicit operator override always wins.
 *  2. `services.functions.path` in `rayfin.yml` — the single source of truth
 *     that `up functions deploy` and `dev functions apply` also resolve
 *     against. Honouring it is what makes `rayfin functions init` work in
 *     workspace layouts that place the package at e.g. `packages/functions`.
 *  3. An existing `rayfin/functions/` directory — a project scaffolded before
 *     workspace detection existed keeps its current location, so re-running
 *     `functions init` refreshes that package instead of orphaning it and
 *     scaffolding a second one somewhere else.
 *  4. The npm workspace convention (`packages/functions` for `packages/*`) —
 *     without this, a fresh workspace project lands a package outside the
 *     workspace globs where npm will not link it.
 *  5. `rayfin/functions` — the historical single-package default.
 *
 * `persist` is true whenever the resolved location differs from the config,
 * which tells the caller to write `services.functions.path` back to
 * `rayfin.yml`. Skipping that write is what produced the original bug: files
 * in one place, config pointing at another, and no warning.
 *
 * The directory does not need to exist yet — this runs before scaffolding —
 * so only the absolute-path and traversal guards apply.
 */
export function resolveFunctionsTargetDir(
  projectRoot: string,
  overridePath?: string
): { dir: string; servicePath: string; persist: boolean; source: string } {
  const config = loadRayfinConfig(projectRoot, { silent: true });
  const configuredPath = normalizeConfiguredPath(
    config?.services?.functions?.path
  );

  let servicePath: string;
  let source: string;

  if (overridePath) {
    servicePath = stripTrailingSlashes(toPosix(overridePath));
    source = '--path';
  } else if (configuredPath) {
    servicePath = configuredPath;
    source = 'services.functions.path';
  } else if (existsSync(join(projectRoot, DEFAULT_FUNCTIONS_PATH))) {
    servicePath = DEFAULT_FUNCTIONS_PATH;
    source = 'existing rayfin/functions/';
  } else {
    const workspacePath = detectWorkspaceFunctionsPath(projectRoot);
    servicePath = workspacePath ?? DEFAULT_FUNCTIONS_PATH;
    source = workspacePath ? 'npm workspaces' : 'default';
  }

  // Use the validator's resolved path rather than re-resolving `servicePath`:
  // it normalises both slash styles, so a Windows-authored
  // `path: 'packages\functions'` resolves to the same directory on POSIX
  // instead of a literal `packages\functions` entry the validation never saw.
  const dir = validateServicePath(projectRoot, 'functions', servicePath, {
    requireExists: false,
  });

  // `validateServicePath` deliberately allows a service root equal to the
  // project root — `staticHosting` legitimately builds from `.`. The functions
  // scaffold is different: it writes a `package.json` and a composite
  // `tsconfig.json` unconditionally, so resolving here would overwrite the
  // project's own manifest (including its `workspaces` globs) and its root
  // tsconfig with the functions template. Refuse instead of destroying them.
  if (resolve(dir) === resolve(projectRoot)) {
    throw new Error(
      `Service 'functions' path '${servicePath}' resolves to the project root. ` +
        'The functions package needs its own directory — scaffolding into the ' +
        'project root would overwrite its package.json and tsconfig.json. ' +
        `Use a subdirectory such as '${DEFAULT_FUNCTIONS_PATH}'.`
    );
  }

  return {
    dir,
    servicePath,
    // Only persist a non-default location; writing `rayfin/functions`
    // explicitly would add noise to every single-package project's config.
    persist:
      servicePath !== configuredPath && servicePath !== DEFAULT_FUNCTIONS_PATH,
    source,
  };
}

function runNpm(
  args: string[],
  cwd: string,
  description: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnSafe('npm', args, { cwd, stdio: 'inherit' });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${description} failed with exit code ${code}`));
        return;
      }
      resolve();
    });
    child.on('error', (err) => {
      reject(
        new Error(`Failed to spawn npm for ${description}: ${err.message}`)
      );
    });
  });
}

export const functionsInit = () =>
  new Command('init')
    .description(
      'Scaffold a Rayfin functions project (services.functions.path in rayfin.yml; ' +
        'auto-detects npm workspaces, else rayfin/functions/)'
    )
    .argument(
      '[directory]',
      'Project root directory (defaults to current directory)',
      '.'
    )
    .option(
      '--force',
      'Overwrite an existing functions scaffold (default: skip scaffolding when the directory exists)',
      false
    )
    .option(
      '--path <relative-path>',
      'Location for the functions package, relative to the project root (e.g. packages/functions). ' +
        'Overrides rayfin.yml and workspace detection, and is saved to rayfin.yml'
    )
    .addOption(
      new Option(
        '--skip-install',
        'Skip dependency installation, build, and type generation'
      ).hideHelp()
    )
    .action(async function (
      this: Command,
      directory: string,
      options: FunctionsInitOptions
    ) {
      const mode = resolveOutputMode(resolveRootOutputFlags(this));
      try {
        const currentDirectory = process.cwd();

        // Seed the project-root search from the explicitly supplied (or
        // current) directory, so an explicit `[directory]` is always honored.
        // Fall back to that directory if no enclosing project is found.
        const startDirectory = resolve(currentDirectory, directory);
        let targetDirectory: string;
        try {
          targetDirectory = findRayfinProjectRoot(startDirectory, {
            verbose: false,
            silent: true,
          });
        } catch {
          targetDirectory = startDirectory;
        }

        const rayfinDir = join(targetDirectory, 'rayfin');

        // Verify rayfin/ exists — the project must already be initialised.
        try {
          await access(rayfinDir, constants.F_OK);
        } catch {
          console.error(
            '❌ No rayfin/ directory found. Run `rayfin init` first to initialise the project.'
          );
          process.exit(1);
        }

        const functionsTarget = resolveFunctionsTargetDir(
          targetDirectory,
          options.path
        );
        const functionsDir = functionsTarget.dir;
        const functionsLabel = toPosix(relative(targetDirectory, functionsDir));

        if (
          functionsTarget.source === 'npm workspaces' ||
          functionsTarget.source === '--path'
        ) {
          modeLog(
            mode,
            `📦 Using ${functionsLabel}/ for the functions package (from ${functionsTarget.source}).`
          );
        }

        // Decide whether to (re-)scaffold.
        //
        // - Fresh project (no functions package yet): always scaffold.
        // - Existing project + `--force`: re-scaffold, overwriting any
        //   user edits to template files. The user opted in explicitly.
        // - Existing project + no `--force`: skip scaffolding, keep the
        //   user's UDF code intact, and continue to install/build/typegen
        //   so a re-run still refreshes deps and regenerates types.ts.
        let functionsExists = false;
        try {
          await access(functionsDir, constants.F_OK);
          functionsExists = true;
        } catch {
          // Does not exist — fresh scaffold.
        }

        const shouldScaffold = !functionsExists || options.force === true;
        const functionsAuth = createFunctionsAuthConfig(
          loadRayfinConfig(targetDirectory, { silent: true })?.services
            ?.functions
        );
        const assetsDir = resolve(__dirname, '..', '..', '..', 'assets');
        const createdFiles: string[] = [];

        // Persist a non-default location to rayfin.yml before anything else,
        // independently of whether we scaffold. `up functions deploy`,
        // `dev functions apply` and the runtime provisioner all resolve
        // `services.functions.path`; leaving it unset while the package lives
        // elsewhere is the silent config/disk divergence that made the
        // original workspace bug so hard to spot.
        if (functionsTarget.persist) {
          updateRayfinConfig(
            {
              services: {
                functions: { path: functionsTarget.servicePath },
              },
            } as Parameters<typeof updateRayfinConfig>[0],
            targetDirectory
          );
          console.log(
            `📝 Set services.functions.path: ${functionsTarget.servicePath} in rayfin.yml`
          );
        }

        if (shouldScaffold) {
          if (functionsExists) {
            console.warn(
              `⚠️  --force specified — ${functionsLabel}/ files will be overwritten.`
            );
          }
          console.log('⚡ Scaffolding Rayfin functions project...\n');
          await scaffoldFunctionsDirectory(
            targetDirectory,
            functionsDir,
            createdFiles,
            assetsDir
          );

          // Enable functions in rayfin.yml (only on fresh / forced
          // scaffolds; otherwise the user's existing config wins).
          // Seed `buildCommand` with `npm run build` so `rayfin up` and
          // `rayfin dev functions apply` both rebuild dist/ before they
          // package or hand off to `func start`. Builders can override
          // (or clear) it in `rayfin.yml` without re-scaffolding.
          const configUpdated = updateRayfinConfig(
            {
              services: {
                functions: {
                  enabled: true,
                  buildCommand: 'npm run build',
                  auth: functionsAuth,
                },
              },
            } as Parameters<typeof updateRayfinConfig>[0],
            targetDirectory
          );
          if (!configUpdated) {
            throw new Error(
              'Could not save application authentication to rayfin.yml. ' +
                'Set services.functions.auth.type to "application" before using Functions.'
            );
          }

          console.log('\n✅ Functions project scaffolded successfully!');
          console.log(`📁 Directory: ${functionsDir}`);
          if (createdFiles.length > 0) {
            console.log('📝 Created files:');
            createdFiles.forEach((f) => console.log(`   └── ${f}`));
          }
        } else {
          console.log(
            `ℹ️  ${functionsLabel}/ already exists — skipping scaffold to preserve your code.`
          );
          console.log(
            '   Pass --force to overwrite the scaffold with the template defaults.'
          );
        }

        if (!options.skipInstall) {
          // Install dependencies and build
          console.log('\n📦 Installing dependencies...');
          await runNpm(['install'], functionsDir, 'npm install');
          console.log('✅ Dependencies installed.');

          console.log('\n🔨 Building functions project...');
          // The build compiles the user's handlers, which may already
          // reference `ctx.Secrets.<NAME>` for a secret declared in
          // rayfin.yml. Without the generated registry those are TS2339
          // errors and the command exits before the generator below ever
          // runs.
          ensureSecretsTypes(functionsDir, (message) =>
            console.log(`⚠️  ${message}`)
          );
          await runNpm(['run', 'build'], functionsDir, 'npm run build');
          console.log('✅ Build complete.');

          // Generate types.ts from function source files. This is a
          // one-shot pass; ongoing regeneration on source edits is owned
          // by `rayfin dev functions apply`, which runs the watcher
          // visibly in the same terminal as `func start`.
          console.log('\n📝 Generating types.ts...');
          await generateFunctionsTypes(functionsDir);
          console.log('✅ types.ts generated.');
        }

        // Install AI agent files (AGENTS.md, .mcp.json, skills) so the
        // project is ready for Copilot-assisted development out of the box.
        // This is the same step as `rayfin init ai-files install` but run
        // automatically for convenience.
        console.log('\n🤖 Installing AI agent files...');
        installAgentFilesAfterScaffold(targetDirectory, 'interactive');
        console.log('✅ AI agent files installed.');

        if (options.skipInstall) {
          modeLog(
            mode,
            `\nFunctions scaffold ${shouldScaffold ? 'created' : 'preserved'}. ` +
              'Dependency installation, build, and type generation were skipped.'
          );
          modeLog(
            mode,
            '   From the project root, rerun `rayfin functions init` without --skip-install or --force ' +
              'to install dependencies, build, and generate types.ts while preserving your code and dependency versions.'
          );
          return;
        }

        console.log(
          '\nℹ️  Run `rayfin dev functions apply` to start the local function host. ' +
            'It will keep types.ts in sync with your UDF source as you edit.'
        );

        console.log('\n🎉 Functions project is ready!');
      } catch (error) {
        if (mode === 'json') {
          emitJsonError(
            mode,
            error instanceof Error ? error.message : String(error),
            undefined,
            error
          );
        }
        console.error('❌ Error scaffolding functions project:', error);
        process.exit(1);
      }
    });

export const functionsInitCommand = functionsInit();
