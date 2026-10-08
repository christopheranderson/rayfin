/**
 * Shared post-scaffold pipeline used by bundled, external, and local
 * template scaffolding flows. Steps run sequentially: project-name
 * customization → dependency install (guarded on package.json) →
 * `rayfin init --from-template` → optional Fabric env persistence →
 * best-effort Rayfin agent file installation.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { shellEscape } from '@microsoft/rayfin-tools-common/_internal';
import { validateServiceDependencies } from '@microsoft/rayfin-tools-common/_internal/config';
import {
  PROJECT_SLUG_REGEX,
  applyTemplateFeatures,
  type ResolvedTemplate,
  generateProjectSlug,
  instantiateTemplate,
  isValidProjectName,
} from '@microsoft/rayfin-tools-common/_internal/templates';
import { parse } from 'yaml';

import { installAgentFilesAfterScaffold } from '../commands/ai-files/install-after-scaffold.js';
import { CliHandledError, ScaffoldCancelledError } from '../errors.js';

import { upsertEnvVariables } from './env-file-utils.js';
import { FEATURE_FLAGS_ENV_VAR, parseFeatureFlags } from './feature-flags.js';
import { hydrateDeploymentFromFabric } from './hydrate-deployment.js';
import {
  emitJsonError,
  modeError,
  modeLog,
  modeWarn,
  type OutputMode,
} from './output-mode.js';
import {
  checkDirectoryConflict,
  customizeTemplate,
  installDependencies,
  isTargetMissingOrEmpty,
  promptProjectName,
  runRayfinInitFromTemplate,
} from './template-scaffold.js';

function validateTemplateServiceDependencies(
  targetPath: string,
  requestedServices: string | undefined,
  mode: OutputMode
): void {
  const configPath = join(targetPath, 'rayfin', 'rayfin.yml');
  if (!existsSync(configPath)) return;

  let config: {
    services?: {
      data?: { enabled?: boolean };
      storage?: { enabled?: boolean };
    };
  };
  try {
    config = parse(readFileSync(configPath, 'utf8')) ?? {};
  } catch {
    return;
  }

  const requested = new Set(
    (requestedServices ?? '')
      .split(',')
      .map((service) => service.trim())
      .filter(Boolean)
  );
  const dataEnabled =
    config.services?.data?.enabled === true || requested.has('data');
  const storageEnabled =
    config.services?.storage?.enabled === true || requested.has('storage');
  const [error] = validateServiceDependencies({
    dataEnabled,
    storageEnabled,
  });
  if (!error) return;

  const message = error.message;
  const hint = 'Include both "data" and "storage" in --services.';
  if (mode === 'json') {
    emitJsonError(mode, message, { hint });
  }
  modeError(mode, `❌ ${message}`);
  modeError(mode, `   ${hint}`);
  throw new CliHandledError(new Error(message));
}

/**
 * Outcome of a scaffold attempt — shared by external, local, and bundled
 * handlers. Handlers signal success by resolving with the completed target
 * path and signal cancellation/failure by throwing (ScaffoldCancelledError
 * or CliHandledError respectively).
 */
export interface ScaffoldResult {
  targetPath: string;
}

export interface ScaffoldTarget {
  /** True when the final scaffold target is the current working directory. */
  inPlace: boolean;
  /** Relative directory name used for filesystem writes and next-step output. */
  directoryForFilesystem: string;
  /** Absolute path to the final scaffold target. */
  targetPath: string;
}

export interface ScaffoldPipelineOptions {
  /** Absolute path to the directory where scaffolded files live. */
  targetPath: string;
  /** Display form of the project name (e.g. "My Cool App"). Required. */
  projectName: string;
  /** Explicit service selection forwarded to the from-template sync. */
  services?: string;
  dialect?: string;
  workspaceId?: string;
  itemId?: string;
  baseApiUrl?: string;
  skipInstall?: boolean;
  /**
   * Preserve dependency versions from the authored template package.json when
   * running the hidden `rayfin init --from-template` sync.
   */
  preserveTemplatePackageVersions?: boolean;
  /**
   * Allows the parent-process Fabric hydration pass to fall back to
   * browser / device-code auth. Callers should pass their existing
   * command-level interactivity decision so --yes, CI, and stdin guards
   * are honored consistently.
   */
  allowInteractiveFabricAuth?: boolean;
  /**
   * Fabric env-var overrides (e.g. RAYFIN_FABRIC_API_URL) to persist into
   * `rayfin/.env`. Callers that persist overrides themselves should pass
   * `undefined` to avoid duplicate writes.
   */
  fabricEnvOverrides?: Array<{ key: string; value: string }>;
}

/**
 * Run the shared post-scaffold pipeline (project-name customization, install,
 * `rayfin init --from-template` sync, optional Fabric env persistence, and
 * best-effort Rayfin agent file installation).
 *
 * @param options - Pipeline configuration. `targetPath` and `projectName` are
 *   required; the rest tune behavior.
 * @param scaffold - Caller-supplied callback that lays down template files.
 *   The caller is responsible for:
 *   1. Ensuring `options.targetPath` exists (e.g. via `mkdir(..., { recursive: true })`).
 *   2. Writing all template files into `options.targetPath` (via `cpSync`,
 *      `instantiateTemplate`, or whatever is appropriate for the source).
 *   3. Optionally emitting per-file created/skipped feedback.
 *   This helper owns the shared post-scaffold work after the callback returns;
 *   callers still own command-specific success handling such as
 *   `printNextStepsBanner`.
 * @param mode - Output mode for log/warn/error routing (preserves JSON-mode
 *   cleanliness when set).
 */
export async function runScaffoldPipeline(
  options: ScaffoldPipelineOptions,
  scaffold: () => Promise<void>,
  mode: OutputMode
): Promise<void> {
  await scaffold();

  applyTemplateFeatures(
    options.targetPath,
    parseFeatureFlags(
      new Map([
        [FEATURE_FLAGS_ENV_VAR, process.env[FEATURE_FLAGS_ENV_VAR] ?? ''],
      ])
    )
  );
  customizeTemplate(options.targetPath, options.projectName);
  validateTemplateServiceDependencies(
    options.targetPath,
    options.services,
    mode
  );

  // External templates may be plain-asset repos with no package.json, in
  // which case `npm install` would warn and exit non-zero for no benefit.
  const hasPackageJson = existsSync(join(options.targetPath, 'package.json'));
  if (!options.skipInstall && hasPackageJson) {
    await installDependencies(options.targetPath);
  }

  // Templates that ship a rayfin/functions/ directory need their own
  // `npm install` because the functions subdirectory has an independent
  // package.json that the root install does not cover.
  const functionsPackageJson = join(
    options.targetPath,
    'rayfin',
    'functions',
    'package.json'
  );
  if (!options.skipInstall && existsSync(functionsPackageJson)) {
    await installDependencies(
      join(options.targetPath, 'rayfin', 'functions'),
      'functions'
    );
  }

  // item-id is only meaningful when scoped to a workspace.
  const itemId =
    options.itemId && !options.workspaceId ? undefined : options.itemId;
  if (options.itemId && !options.workspaceId) {
    modeWarn(
      mode,
      '⚠️  --item-id requires --workspace-id. Ignoring --item-id.'
    );
  }

  await runRayfinInitFromTemplate(
    options.targetPath,
    options.projectName,
    options.dialect,
    {
      workspaceId: options.workspaceId,
      itemId,
      baseApiUrl: options.baseApiUrl,
    },
    {
      skipInstall: options.skipInstall,
      skipRayfinPackageInstall: options.preserveTemplatePackageVersions,
      services: options.services,
    }
  );

  // Interactive Fabric hydration (parent-process side).
  //
  // The child `rayfin init --from-template` invoked above also attempts
  // hydration, but it runs with stdio piped/ignored so its auth path is
  // silent-only. That is fine for CI/agent contexts with a cached token,
  // but it silently fails for first-run users who paste the portal-emitted
  // `npm create @microsoft/rayfin@latest …` command without a prior
  // `rayfin login` — leaving `rayfin/.env` populated with only
  // `RAYFIN_FABRIC_API_URL` and the frontend pointing at a non-existent
  // local backend.
  //
  // To make the portal command work as-is we run hydrate again here in
  // the parent process, opting in to interactive auth only when the
  // caller's command-level interactivity decision allows it. When silent
  // succeeds (e.g. cached token), this is a cheap re-hydrate that
  // overwrites with the same data; when the user has no cached session it
  // triggers a one-time browser / device-code prompt. In non-interactive
  // contexts we skip the interactive attempt and rely on whatever the
  // child already wrote (full state if a cached token existed, minimal
  // pre-seed otherwise).
  if (options.workspaceId && itemId) {
    try {
      const result = await hydrateDeploymentFromFabric({
        projectRoot: options.targetPath,
        workspaceId: options.workspaceId,
        itemId,
        interactive: options.allowInteractiveFabricAuth === true,
      });
      modeLog(
        mode,
        `📡 Hydrated deployment from workspace "${result.workspaceDisplayName}"`
      );
      modeLog(mode, `   └─ BaaS endpoint: ${result.baasEndpoint}`);
    } catch (err) {
      modeWarn(
        mode,
        `⚠️  Could not hydrate deployment from Fabric: ${err instanceof Error ? err.message : String(err)}`
      );
      modeWarn(
        mode,
        "   The project will use the locally pre-seeded workspace + item ID; run 'rayfin dev' to resolve the backend endpoint and publishable key."
      );
    }
  }

  if (options.fabricEnvOverrides && options.fabricEnvOverrides.length > 0) {
    try {
      await upsertEnvVariables(
        join(options.targetPath, 'rayfin'),
        options.fabricEnvOverrides
      );
    } catch (err) {
      modeWarn(
        mode,
        `⚠️  Could not persist Fabric environment overrides: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Install the Rayfin AGENTS.md / .mcp.json / .agents/skills/rayfin scaffold.
  // Best-effort: a failure here only emits a warning and does not abort the
  // init flow because the project itself is already on disk.
  installAgentFilesAfterScaffold(options.targetPath, mode);
}

/**
 * Resolve the project name for a scaffold operation. Shared between the
 * bundled and external flows so both honor `--project-name`, in-place
 * cwd-basename fallback, positional-basename fallback, and interactive
 * prompts identically.
 *
 * Throws on validation errors so callers can map to their preferred exit
 * convention (process.exit vs. error path).
 */
export async function resolveProjectName(params: {
  explicitProjectName?: string;
  directory: string;
  inPlace: boolean;
  nonInteractive?: boolean;
}): Promise<string> {
  if (params.explicitProjectName) {
    if (!isValidProjectName(params.explicitProjectName)) {
      throw new Error(
        '❌ Invalid project name. Use letters, numbers, spaces, hyphens, or underscores and include at least one alphanumeric character'
      );
    }
    return params.explicitProjectName;
  }

  const fallback = params.inPlace
    ? basename(resolve(params.directory))
    : basename(params.directory);

  if (params.inPlace && !fallback) {
    throw new Error(
      '❌ Cannot scaffold into the filesystem root. Please create a project directory first.'
    );
  }

  // Non-interactive: derive a usable name without ever blocking on a
  // prompt. Try the basename as-is, then a sanitized form, then a sane
  // default. This keeps automation paths (CI/agents, `npm create`
  // invocations from cache directories whose basenames contain `@` or
  // `+`) flowing instead of erroring with "--project-name is required",
  // which is unrecoverable without modifying the invoking command.
  if (params.nonInteractive) {
    if (fallback && isValidProjectName(fallback)) {
      return fallback;
    }
    const sanitized = sanitizeForProjectName(fallback);
    if (sanitized && isValidProjectName(sanitized)) {
      return sanitized;
    }
    return DEFAULT_NON_INTERACTIVE_PROJECT_NAME;
  }

  // Explicit positional directory ("create-rayfin My App") doubles as the
  // project name — skip the prompt and use it directly. Matches the
  // standard npm-create convention (vite, next-app, etc.). In-place
  // ("create-rayfin .") still prompts so the user can confirm/override.
  if (!params.inPlace && fallback && isValidProjectName(fallback)) {
    return fallback;
  }

  // In-place or invalid basename: prompt so the user can confirm/override.
  // Use the basename as the prompt default ONLY when it's a valid project
  // name — otherwise fall back to a safe placeholder so the user can hit
  // Enter without immediately tripping validation.
  const promptDefault =
    fallback && isValidProjectName(fallback) ? fallback : 'My Rayfin App';
  return promptProjectName(promptDefault);
}

/**
 * Test whether a positional directory arg refers to the current working
 * directory ("scaffold in-place"). Uses resolution-based comparison so
 * any path-form that points to cwd counts:
 *
 *   - `.`, `./`, `.\`, `.\\` (Windows backslash form is the load-bearing
 *     case — `rayfin init .\` is the standard Windows spelling)
 *   - any absolute path that equals cwd (case-insensitively on win32)
 *   - relative paths like `./.` or `foo/..` that resolve to cwd
 *
 * Critical: the dispatchers' "non-in-place" branch can wipe the target
 * directory if the user consents to overwrite. A literal-string check
 * that misses `.\` would treat the cwd as a normal target on Windows
 * and wipe it. Always use this helper instead.
 *
 * On win32, the comparison is case-insensitive because NTFS / ReFS file
 * paths are case-insensitive by default — `process.cwd()` may return
 * `C:\Work` while a user-supplied absolute path is `c:\work`. A strict
 * equality check would treat those as different and route into the
 * non-in-place wipe path, destroying the user's data on overwrite.
 *
 * **Known gaps** — the comparison is a string-level fold of `path.resolve`
 * output. It does NOT handle:
 *   - 8.3 short names: `C:\PROGRA~1` vs `C:\Program Files`
 *   - junctions / symlinks: would need `realpathSync` to resolve
 *   - UNC server-name casing or DFS aliases
 *   - `subst` drive aliases: `subst Z: C:\Work` then passing `Z:\` while
 *     cwd is `C:\Work`
 *
 * If a user supplies a path that points to cwd via any of these
 * mechanisms, this helper returns false and the dispatcher treats it as
 * a child target. The realistic data-loss vector (drive-letter casing +
 * segment casing for ASCII paths) IS covered. The unsupported cases are
 * documented in `openspec/changes/positional-name-and-slugification/design.md`.
 *
 * The lowercase fold uses `toLocaleLowerCase('en-US')` to pin the case
 * mapping to ASCII-locale ICU rules. This avoids the Turkish-locale
 * dotted/dotless-i edge case that `String.prototype.toLowerCase()`
 * exhibits on tr-TR system locales.
 */
export function isInPlaceDirectory(directory: string): boolean {
  const resolvedTarget = resolve(process.cwd(), directory);
  const resolvedCwd = resolve(process.cwd());
  if (process.platform === 'win32') {
    return (
      resolvedTarget.toLocaleLowerCase('en-US') ===
      resolvedCwd.toLocaleLowerCase('en-US')
    );
  }
  return resolvedTarget === resolvedCwd;
}

/**
 * Resolve the final scaffold target after the project name is known.
 *
 * `inputInPlace` describes the user's raw directory input before create-project
 * semantics are applied: omitted, `.`, `./`, or any path resolving to cwd.
 * `inPlace` describes the final target returned to callers. When the caller sets
 * `useProjectNameAsDirectory` (the bare `create-rayfin` flow with no positional
 * directory), an in-place-looking input becomes a child directory named from
 * `projectName` instead of scaffolding into cwd. The caller is responsible for
 * leaving `useProjectNameAsDirectory` unset when the user explicitly typed an
 * in-place directory (e.g. `create-rayfin .`), so that explicit `.` scaffolds
 * into cwd rather than nesting under `<projectName>/`.
 *
 * Explicit child paths still win. In that case `useProjectNameAsDirectory` can
 * be true while `inputInPlace` is false, and the returned target uses
 * `directory`.
 */
export function resolveScaffoldTarget(options: {
  directory: string;
  projectName: string;
  inputInPlace: boolean;
  useProjectNameAsDirectory?: boolean;
}): ScaffoldTarget {
  const shouldCreateProjectDirectory =
    options.useProjectNameAsDirectory && options.inputInPlace;
  const inPlace = options.inputInPlace && !shouldCreateProjectDirectory;
  const directoryForFilesystem = slugifyDirectoryArg(
    shouldCreateProjectDirectory ? options.projectName : options.directory
  );

  return {
    inPlace,
    directoryForFilesystem,
    targetPath: resolve(process.cwd(), directoryForFilesystem),
  };
}

/**
 * Slugify a positional directory argument so the on-disk directory uses a
 * filesystem-friendly form when the user supplied a name with whitespace
 * like `"My App"`. Whitespace in directory paths is shell-hostile
 * (`cd My App` without quotes breaks; build tools and CI paths choke).
 *
 * Only fires when:
 * - the positional is a single bare name (no path separators, not absolute)
 * - it contains whitespace
 * - it is not in-place (`.` or `./`)
 *
 * Other cases pass through literally — `MyApp`, `App_2`, `my_app`, etc.
 * work as directory names without any shell-hostility, so we respect the
 * user's typed form for them and only normalize at the project-identity
 * layer (`rayfin.yml.id`, `package.json.name`).
 *
 * Path-like positionals (`./projects/my-app`, `/tmp/foo`, `../foo`,
 * `./My App`) are the escape hatch: a user who genuinely wants a
 * directory with whitespace passes `./My App` to disambiguate "this is
 * a path" from "this is a name."
 *
 * Examples:
 *   "My App"             → "my-app"   (whitespace — slugified)
 *   "My  App"            → "my-app"   (whitespace — slugified)
 *   "MyApp"              → "MyApp"    (no whitespace — passthrough)
 *   "App_2"              → "App_2"    (no whitespace — passthrough)
 *   "my-app"             → "my-app"   (no whitespace — passthrough)
 *   "."                  → "."        (in-place — return as-is)
 *   "./"                 → "./"       (in-place — return as-is)
 *   ".\\"                → ".\\"      (in-place on Windows — passthrough via separator check)
 *   "./projects/my-app"  → unchanged  (path-like — user explicit)
 *   "/tmp/my-app"        → unchanged  (absolute — user explicit)
 *   "../my-app"          → unchanged  (relative path — user explicit)
 *   "./My App"           → unchanged  (escape hatch for literal whitespace dirs)
 */
export function slugifyDirectoryArg(directory: string): string {
  if (directory === '.' || directory === './') return directory;
  if (isAbsolute(directory)) return directory;
  // Path separator (`/` or `\`) → user explicitly typed a path; don't slugify.
  // This branch is ALSO load-bearing for non-`.` / `./` in-place forms
  // (`.\` and `.\\` on Windows): they reach this check and return as-is,
  // preventing the slugifier from collapsing a Windows in-place path into
  // an empty string. Don't refactor away the literal early-return above
  // and rely solely on `isInPlaceDirectory` here without preserving this
  // check — Copilot's review #3 caught the data-loss bug that would
  // recur if these branches collapse.
  if (directory.includes('/') || directory.includes('\\')) return directory;
  if (!/\s/.test(directory)) return directory;
  const slug = generateProjectSlug(directory);
  // Reject slug outputs that would normalize back to path metasegments
  // (`.`, `..`) or any non-[a-z0-9-] shape. `generateProjectSlug` preserves
  // dots, so `" . "` slugifies to `"."` and `" .. "` to `".."` — paths
  // that `path.resolve` would collapse to cwd or its parent and that the
  // raw-input `isInPlaceDirectory` check (run before slugify) won't catch
  // because the raw input has whitespace and resolves to a literal child.
  // Without this allow list, the dispatchers' non-in-place branch could
  // silently route into the cwd or parent and trigger wipe on overwrite.
  // Council B caught this in pre-push round 2 deep-review.
  return PROJECT_SLUG_REGEX.test(slug) ? slug : directory;
}

/**
 * Format a directory path for use in a copy-pasteable `cd <path>` next-step
 * hint. Quotes the path when it contains shell-significant characters
 * (whitespace, parens, semicolons, ampersands, `$`, `*`, `?`, etc.);
 * passes through unquoted when the path is in the safe shell charset
 * (alphanumerics, `.`, `_`, `-`, `/`, `\`, `:`).
 *
 * Cross-shell quoting is best-effort, not universal:
 *   - On `win32`, emits PowerShell single-quoted form (apostrophes escaped
 *     by doubling: `'Bob''s app'`). PowerShell is the assumed default.
 *   - On POSIX (Linux/macOS), emits POSIX single-quoted form with the
 *     standard close-then-reopen escape for embedded apostrophes
 *     (`'Bob'\''s app'`).
 *
 * Users on cmd.exe or Git Bash on Windows will get a sub-optimal escape
 * for apostrophe-containing paths — accepted tradeoff for the common case.
 *
 * Known limitation: `\` is in the safe charset because it's a legitimate
 * path separator on Windows. On POSIX, `\` outside quotes escapes the
 * next character, so a literal `foo\bar` directory prints `cd foo\bar`
 * which bash parses as `cd foobar`. Genuinely rare in practice (literal
 * backslashes in POSIX directory names are unusual; `slugifyDirectoryArg`
 * never emits one unless the user typed it as part of a path), so an
 * inline platform branch isn't worth the complexity.
 *
 * Examples:
 *   "my-app"                → "my-app"
 *   "MyApp"                 → "MyApp"
 *   "App_2"                 → "App_2"
 *   "v1.0.0-rc1"            → "v1.0.0-rc1"
 *   "My App"  (POSIX/win32) → "'My App'"
 *   "App(v2)"               → "'App(v2)'"
 *   "./foo;bar"             → "'./foo;bar'"
 *   "it's mine" (POSIX)     → "'it'\\''s mine'"
 *   "it's mine" (win32)     → "'it''s mine'"
 */
export function formatCdTarget(path: string): string {
  // Quote anything outside the safe shell charset. Whitespace is the
  // common case but parens, semicolons, ampersands, `$`, `*`, `?`, etc.
  // are equally shell-hostile and just as plausible in directory names
  // (e.g., `App(v2)`, `v1.0.0-rc1+build`). Pasting `cd App(v2)` into
  // bash/zsh produces a syntax error.
  if (!/[^A-Za-z0-9._\-/\\:]/.test(path)) return path;
  return shellEscape(path);
}

/**
 * Print the final "🎉 Project created successfully! / Next steps:" banner.
 *
 * Shared by all three dispatch paths (bundled, external, local) so users
 * see consistent next-step guidance regardless of which template source
 * they used. Routes through `modeLog` so the banner is suppressed in
 * JSON output mode and uses the same stream as other CLI logs.
 *
 * The `cd` line is omitted when `scaffoldInPlace` is true (the user is
 * already in the project). Callers should derive `scaffoldInPlace` from
 * `isInPlaceDirectory(directory)` so any path that resolves to cwd
 * (`.`, `./`, `.\`, `.\\`, absolute-cwd, `./.`, `foo/..`) is treated
 * consistently — see the `isInPlaceDirectory` JSDoc.
 *
 * Steps:
 *   1. `cd <directoryForFilesystem>` — relative to cwd, POSIX-quoted if it
 *      contains whitespace. Matches what landed on disk.
 *   2. `npx rayfin dev` — provisions or reuses the selected backend, applies
 *      declared state, and starts the local frontend and Functions runtime.
 */
export function printNextStepsBanner(
  mode: OutputMode,
  directoryForFilesystem: string,
  scaffoldInPlace: boolean
): void {
  modeLog(mode, '\n🎉 Project created successfully!\n');
  modeLog(mode, 'Next steps:\n');
  if (!scaffoldInPlace) {
    modeLog(mode, `  cd ${formatCdTarget(directoryForFilesystem)}`);
  }
  modeLog(mode, '  npx rayfin dev\n');
}

/**
 * Default project name used in non-interactive mode when neither the
 * positional directory basename nor a sanitized form yields a valid
 * project name. Picked to be obviously a placeholder so users notice it
 * in `package.json` and rename if needed.
 */
export const DEFAULT_NON_INTERACTIVE_PROJECT_NAME = 'rayfin-app';

/**
 * Coerce an arbitrary string into a project-name-shaped value by
 * replacing every disallowed character with `-`, collapsing runs of
 * `-`, and trimming leading/trailing `-`. Returns `''` if nothing
 * survives sanitization.
 *
 * Mirrors {@link PROJECT_NAME_REGEX} (which `isValidProjectName` enforces):
 * letters, digits, whitespace, `-`, and `_` are kept; everything else
 * (notably `@`, `+`, `.`) becomes `-`.
 */
function sanitizeForProjectName(input: string | undefined | null): string {
  if (!input) return '';
  return input
    .replace(/[^a-zA-Z0-9\s\-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Wipe the contents of `targetDirectory` so a fresh scaffold doesn't merge
 * with a pre-existing project. Used by the conflict-prompt flow after the
 * user consents to overwrite a non-empty target.
 *
 * Wraps `rmSync` so filesystem errors (Windows EPERM/EBUSY when files are
 * locked, EACCES, partial-failure mid-recursion) surface as the consistent
 * `modeError + process.exit(1)` UX instead of raw Node stack traces.
 */
export function wipeTargetDirectory(
  targetDirectory: string,
  mode: OutputMode
): void {
  try {
    rmSync(targetDirectory, { recursive: true, force: true });
  } catch (wipeError) {
    modeError(
      mode,
      `❌ Failed to clear target directory '${targetDirectory}': ${
        wipeError instanceof Error ? wipeError.message : String(wipeError)
      }`
    );
    process.exit(1);
  }
}

/**
 * Lower-level pre-scaffold conflict check returning a disposition object.
 * Most CLI callers should use {@link assertTargetConflictOrThrow} instead,
 * which wraps this helper with the cancellation throw all three handlers
 * (`init`, `init-bundled-template`, `init-external-template`) need
 * uniformly. Direct callers are tests, preflight checks, and any future
 * non-CLI consumer that wants the raw disposition without typed-throw
 * cancellation semantics.
 *
 * If the target is empty (or doesn't exist), proceeds silently. If non-empty,
 * prompts (or honors `--overwrite`). Returns whether to proceed, whether
 * the user consented to overwrite, and whether the target was empty when
 * we started (the latter so callers can correctly attribute cleanup
 * ownership on scaffold failure: an empty pre-existing dir contained
 * nothing to preserve, so a partial scaffold is ours to clean up).
 *
 * **Does not wipe** — callers are expected to defer the wipe until just
 * before laying down new files, so a clone / manifest / fetch failure
 * between prompt and scaffold preserves the user's pre-existing data.
 *
 * Emptiness is delegated to `isTargetMissingOrEmpty` so the inner
 * `checkDirectoryConflict` and this wrapper share one source of truth for
 * what counts as a safe target.
 */
export async function checkTargetConflict(
  targetDirectory: string,
  opts: { nonInteractive?: boolean; overwrite?: boolean },
  mode: OutputMode
): Promise<{
  shouldProceed: boolean;
  consentedOverwrite: boolean;
  targetWasEmpty: boolean;
}> {
  if (isTargetMissingOrEmpty(targetDirectory)) {
    return {
      shouldProceed: true,
      consentedOverwrite: false,
      targetWasEmpty: true,
    };
  }

  // We've verified non-emptiness above. Pass `knownNonEmpty: true` so the
  // inner helper skips its own emptiness check — both saves one
  // `readdirSync` syscall and closes a TOCTOU race where an external
  // process emptying the dir between the two checks would cause the inner
  // to falsely return `true` and the wrapper to interpret it as consent.
  const shouldProceed = await checkDirectoryConflict(targetDirectory, {
    ...opts,
    knownNonEmpty: true,
  });
  if (!shouldProceed) {
    modeLog(
      mode,
      // SPEC-ANCHORED MESSAGE — the substring "is not empty and overwrite
      // was declined" is asserted in openspec/specs/rayfin-cli-init/spec.md
      // (the "Empty pre-existing target directory proceeds without
      // prompting" scenario). If you reword this message, update both.
      `ℹ️  Operation cancelled — target directory '${targetDirectory}' is not empty and overwrite was declined. Pass --overwrite to allow scaffolding over existing contents, or pick a different target.`
    );
    return {
      shouldProceed: false,
      consentedOverwrite: false,
      targetWasEmpty: false,
    };
  }
  return {
    shouldProceed: true,
    consentedOverwrite: true,
    targetWasEmpty: false,
  };
}

/**
 * Command-handler convenience wrapper around {@link checkTargetConflict}.
 *
 * Combines the conflict check and the cancellation throw that all three
 * scaffold handlers (`init`, `init-bundled-template`, `init-external-template`)
 * do uniformly: when the user declines overwrite (or `--overwrite` is not
 * set in non-interactive mode against a non-empty target), throws
 * `ScaffoldCancelledError` so the dispatcher can attribute the failure
 * to telemetry and exit with code 2.
 *
 * Returns only the post-decision metadata callers need to gate cleanup
 * ownership: whether the user consented to overwrite (we wiped non-empty
 * content with permission) and whether the target was empty when we
 * started (we own a partial scaffold's cleanup either way).
 *
 * Use this from CLI command handlers. Direct callers that need the lower-
 * level disposition (preflight checks, unit tests, non-CLI consumers)
 * should keep using {@link checkTargetConflict} and decide their own
 * cancellation semantics.
 */
export async function assertTargetConflictOrThrow(
  targetDirectory: string,
  opts: { nonInteractive?: boolean; overwrite?: boolean },
  mode: OutputMode
): Promise<{ consentedOverwrite: boolean; targetWasEmpty: boolean }> {
  const result = await checkTargetConflict(targetDirectory, opts, mode);
  if (!result.shouldProceed) {
    throw new ScaffoldCancelledError();
  }
  return {
    consentedOverwrite: result.consentedOverwrite,
    targetWasEmpty: result.targetWasEmpty,
  };
}

/**
 * Run `instantiateTemplate` and report created/skipped counts in a consistent
 * format. Used as the `scaffold` callback in {@link runScaffoldPipeline} for
 * both external and local handlers.
 */
export async function instantiateAndReport(
  template: ResolvedTemplate,
  opts: {
    targetDir: string;
    presets: Record<string, unknown>;
    overwrite?: boolean;
  },
  mode: OutputMode
): Promise<void> {
  const result = await instantiateTemplate(template, opts);
  modeLog(mode, '');
  if (result.createdFiles.length > 0) {
    modeLog(mode, `✅ Created ${result.createdFiles.length} file(s):`);
    for (const f of result.createdFiles) {
      modeLog(mode, `   ${f}`);
    }
  }
  if (result.skippedFiles.length > 0) {
    modeLog(mode, `⏭️  Skipped ${result.skippedFiles.length} file(s)`);
  }
}

/**
 * On scaffold failure, remove the target directory if we own it (we either
 * created it or the user consented to overwriting an existing one). Uses
 * `rm({ force: true })` so missing-target cases short-circuit silently —
 * no `existsSync` pre-check needed (TOCTOU).
 */
export async function cleanupPartialScaffold(
  targetDirectory: string,
  ownsTarget: boolean,
  mode: OutputMode
): Promise<void> {
  if (!ownsTarget) return;
  try {
    await rm(targetDirectory, { recursive: true, force: true });
    modeLog(mode, 'ℹ️  Cleaned up partial project');
  } catch (cleanupError) {
    modeWarn(
      mode,
      `⚠️  Failed to clean up: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
    );
  }
}
