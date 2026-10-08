/**
 * @packageDocumentation Validate a `rayfin/functions/` folder before
 * `rayfin up functions deploy` packages it into a deploy ZIP.
 *
 * Two classes of checks are performed:
 *
 *  1. **Structural** — required files exist and are well-formed:
 *     - `package.json` is present and valid JSON.
 *     - `host.json` is present.  Azure Functions hosts refuse to start
 *       without this file; failing here prevents an unrecoverable
 *       runtime error on the remote build host.
 *     - `src/function_app.ts` is present (the entry point that registers
 *       `udf.func()` calls).
 *
 *  2. **Dependency portability** — every `file:` dependency in
 *     `package.json` must resolve to a target **inside** the functions
 *     folder.  Absolute paths (`file:C:/Users/...`) and parent-traversing
 *     relative paths (`file:../../shared`) cannot be reproduced on a
 *     remote build host, so they are rejected with an actionable
 *     suggestion.
 *
 *  3. **Worker compatibility** — the installed
 *     `@microsoft/fabric-user-data-functions` must be able to read the
 *     runtime metadata schema this CLI writes. An older worker rejects it
 *     and falls back to source analysis, which the deploy bundle cannot
 *     support; the deploy would appear to succeed and the app would never
 *     start. See `functions-worker-compat.ts`.
 *
 * The validator never mutates the on-disk folder; it only inspects.
 * Callers handle reporting and exit codes.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';

import {
  checkWorkerSchemaCompatibility,
  describeIncompatibleWorker,
  WORKER_PACKAGE_NAME,
} from './functions-worker-compat.js';

export type ViolationKind =
  | 'missing-file'
  | 'invalid-json'
  | 'external-file-dep'
  | 'missing-file-dep-target'
  | 'incompatible-worker';

export interface ValidationViolation {
  /** Machine-readable category. */
  kind: ViolationKind;
  /** Human-readable message describing what's wrong. */
  message: string;
  /** Suggested fix the user can act on. */
  suggestion: string;
  /** Optional context such as the offending dependency name. */
  context?: Record<string, string>;
}

export interface FunctionsValidationResult {
  /** True iff `violations` is empty. */
  valid: boolean;
  /** Every problem detected, in deterministic order. */
  violations: ValidationViolation[];
}

export interface ValidateFunctionsOptions {
  /**
   * Enforce that every `file:` dependency resolves inside the functions
   * folder. Required for the legacy source zip, whose remote install
   * step can only see what the zip contains.
   *
   * Bundled deploys inline every reachable module regardless of where it
   * sits on disk and install nothing remotely, so the restriction does
   * not apply and callers pass `false`.
   *
   * @defaultValue true
   */
  checkDependencyPortability?: boolean;

  /**
   * Runtime metadata schema version the CLI is about to write.
   *
   * When supplied, the installed worker is checked for its ability to read
   * that schema. Passed in rather than imported so this module stays free of
   * the metadata generator's TypeScript dependency.
   */
  runtimeMetadataSchemaVersion?: string;
}

/**
 * Validate the supplied `rayfin/functions/` directory for deploy-readiness.
 * Aggregates all violations rather than failing on the first; callers can
 * surface a complete checklist of fixes to the user in one shot.
 */
export function validateFunctionsForDeploy(
  functionsDir: string,
  options: ValidateFunctionsOptions = {}
): FunctionsValidationResult {
  const violations: ValidationViolation[] = [];

  validateRequiredFiles(functionsDir, violations);
  if (options.checkDependencyPortability ?? true) {
    validatePackageJsonDependencies(functionsDir, violations);
  }
  if (options.runtimeMetadataSchemaVersion) {
    validateWorkerSchemaSupport(
      functionsDir,
      options.runtimeMetadataSchemaVersion,
      violations
    );
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Reject a deploy whose installed worker cannot read the metadata the CLI
 * writes.
 *
 * Only a definitive `incompatible` blocks. An undetermined result is ignored
 * on purpose: the common cause is that dependencies are not installed yet,
 * and blocking on a guess would be worse than the failure being guarded.
 */
function validateWorkerSchemaSupport(
  functionsDir: string,
  schemaVersion: string,
  violations: ValidationViolation[]
): void {
  const compatibility = checkWorkerSchemaCompatibility(
    functionsDir,
    schemaVersion
  );
  if (compatibility.status !== 'incompatible') return;

  violations.push({
    kind: 'incompatible-worker',
    message: describeIncompatibleWorker(compatibility, schemaVersion),
    suggestion:
      `Upgrade ${WORKER_PACKAGE_NAME} in ${join(functionsDir, 'package.json')} ` +
      `to a version matching this CLI, then re-run npm install`,
    context: {
      package: WORKER_PACKAGE_NAME,
      cliSchemaVersion: schemaVersion,
      ...(compatibility.workerFloor
        ? { workerSchemaVersion: compatibility.workerFloor }
        : {}),
      ...(compatibility.workerPackageVersion
        ? { installedVersion: compatibility.workerPackageVersion }
        : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Structural checks
// ---------------------------------------------------------------------------

const REQUIRED_FILES: ReadonlyArray<{
  relPath: string;
  reason: string;
  fix: string;
}> = [
  {
    relPath: 'package.json',
    reason: 'package.json is required for npm install on the remote build host',
    fix: 'Run `rayfin functions init` to scaffold the project, or create package.json manually',
  },
  {
    relPath: 'host.json',
    reason:
      'host.json is required by the Azure Functions host; the worker will not start without it',
    fix: 'Run `rayfin functions init` to scaffold a default host.json',
  },
  {
    relPath: 'src/function_app.ts',
    reason:
      'src/function_app.ts is the entry point where udf.func() registrations live',
    fix: 'Create src/function_app.ts and register at least one function with `udf.func(...)`',
  },
];

function validateRequiredFiles(
  functionsDir: string,
  violations: ValidationViolation[]
): void {
  for (const required of REQUIRED_FILES) {
    const fullPath = join(functionsDir, required.relPath);
    if (!existsSync(fullPath)) {
      violations.push({
        kind: 'missing-file',
        message: `Required file missing: ${required.relPath} — ${required.reason}.`,
        suggestion: required.fix,
        context: { path: required.relPath },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Dependency portability checks
// ---------------------------------------------------------------------------

const DEP_SECTIONS: ReadonlyArray<
  | 'dependencies'
  | 'devDependencies'
  | 'peerDependencies'
  | 'optionalDependencies'
> = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

function validatePackageJsonDependencies(
  functionsDir: string,
  violations: ValidationViolation[]
): void {
  const packageJsonPath = join(functionsDir, 'package.json');
  if (!existsSync(packageJsonPath)) {
    // Already reported by validateRequiredFiles; do not double-report.
    return;
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch (err) {
    violations.push({
      kind: 'invalid-json',
      message: `package.json is not valid JSON: ${(err as Error).message}`,
      suggestion: 'Fix the JSON syntax in rayfin/functions/package.json',
    });
    return;
  }

  const resolvedFunctionsDir = resolve(functionsDir);

  for (const section of DEP_SECTIONS) {
    const deps = pkg[section];
    if (!deps || typeof deps !== 'object') continue;

    for (const [name, spec] of Object.entries(
      deps as Record<string, unknown>
    )) {
      if (typeof spec !== 'string' || !spec.startsWith('file:')) continue;

      const target = spec.slice('file:'.length);
      const isExternal = isExternalFilePath(target, resolvedFunctionsDir);

      if (isExternal) {
        violations.push({
          kind: 'external-file-dep',
          message: `Dependency "${name}" (${section}) points outside rayfin/functions/: ${spec}`,
          suggestion: buildExternalDepSuggestion(name, target),
          context: { name, section, spec },
        });
        continue;
      }

      // Relative target inside the folder — verify it actually exists.
      const resolvedTarget = isAbsolute(target)
        ? target
        : resolve(functionsDir, target);
      if (!existsSync(resolvedTarget)) {
        violations.push({
          kind: 'missing-file-dep-target',
          message: `Dependency "${name}" (${section}) references a missing path: ${spec}`,
          suggestion: `Ensure ${target} exists in rayfin/functions/, or update the dependency spec`,
          context: { name, section, spec },
        });
      }
    }
  }
}

/**
 * `file:` target is external to the functions folder when:
 *  - It is an absolute path (Windows `C:\...` or Unix `/...`).
 *  - It is a relative path that resolves outside `functionsDir`
 *    (e.g. `../../shared`).
 *
 * Targets like `./pkg.tgz` or `./subdir` that resolve under the functions
 * folder are considered internal and acceptable.
 *
 * Windows drive-letter paths (e.g. `C:/Users/...` or `C:\\Users\\...`) are
 * treated as absolute regardless of the host OS the validator is running
 * on, so a Linux CI run still rejects a `package.json` authored on
 * Windows.
 */
function isWindowsDriveAbsolute(target: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(target);
}

function isExternalFilePath(
  target: string,
  resolvedFunctionsDir: string
): boolean {
  if (isAbsolute(target) || isWindowsDriveAbsolute(target)) return true;

  const resolvedTarget = resolve(resolvedFunctionsDir, target);
  const rel = relative(resolvedFunctionsDir, resolvedTarget);
  // Inside the folder iff `relative()` returns a path that does not start
  // with `..` and is not itself absolute.
  return rel === '' ? false : rel.startsWith('..') || isAbsolute(rel);
}

function buildExternalDepSuggestion(name: string, target: string): string {
  if (target.toLowerCase().endsWith('.tgz')) {
    const basename = target.split(/[\\/]/).pop() ?? `${name}.tgz`;
    return (
      `Copy ${target} into rayfin/functions/, then update package.json so ` +
      `"${name}" references it via a relative path: "file:./${basename}".`
    );
  }
  return (
    `Pack the dependency with \`npm pack\` from a temporary directory ` +
    `(\`npm pack ${target}\`), copy the resulting tarball into ` +
    `rayfin/functions/, then update package.json so "${name}" references ` +
    `it via a relative path (e.g. "file:./<package>-<version>.tgz").`
  );
}

// ---------------------------------------------------------------------------
// Helpers exported for callers that want to render violations themselves.
// ---------------------------------------------------------------------------

/**
 * Format a single violation as a multi-line block suitable for printing
 * to a console.  Indents the suggestion under the message.
 */
export function formatViolation(violation: ValidationViolation): string {
  return `  • ${violation.message}\n    ↳ ${violation.suggestion}`;
}

/**
 * Stat helper for tests / call sites that want to confirm a path is a
 * directory inside the functions folder before falling through to the
 * other checks.  Returns `undefined` when the path is missing.
 */
export function statSafe(
  path: string
): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}
