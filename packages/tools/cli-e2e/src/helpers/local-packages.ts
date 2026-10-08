/**
 * Shared helpers for rewriting scaffolded project dependencies to use
 * local `file:` protocol references. This module is vitest-free so it
 * can be imported from both Vitest tests and Playwright browser specs.
 */
import { execFile as execFileCb } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/** Repo root, resolved from packages/tools/cli-e2e/src/helpers/ */
export const REPO_ROOT = resolve(__dirname, '../../../../..');

/**
 * Strip JSON comments (// line and /* block) while preserving string contents.
 */
export function stripJsonComments(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      result += '"';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') {
          result += text[i] + text[i + 1];
          i += 2;
        } else {
          result += text[i];
          i++;
        }
      }
      if (i < text.length) {
        result += '"';
        i++;
      }
    } else if (text[i] === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') i++;
    } else if (text[i] === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
    } else {
      result += text[i];
      i++;
    }
  }
  return result;
}

/**
 * Derives a map of `@microsoft/*` package names to their repo-relative
 * directories by reading the projects list from `rush.json`. This avoids
 * maintaining a hardcoded list that drifts when packages are added or moved.
 */
export function getRayfinPackageDirs(): Record<string, string> {
  const rushJsonPath = join(REPO_ROOT, 'rush.json');
  const content = readFileSync(rushJsonPath, 'utf8');
  const stripped = stripJsonComments(content);
  const rushJson = JSON.parse(stripped) as {
    projects: { packageName: string; projectFolder: string }[];
  };

  const dirs: Record<string, string> = {};
  for (const project of rushJson.projects) {
    if (
      project.packageName.startsWith('@microsoft/rayfin-') ||
      project.packageName === '@microsoft/fabric-user-data-functions'
    ) {
      dirs[project.packageName] = project.projectFolder;
    }
  }
  return dirs;
}

/** Cached result so we only read rush.json once per process. */
let _packageDirs: Record<string, string> | undefined;
function getPackageDirs(): Record<string, string> {
  if (!_packageDirs) {
    _packageDirs = getRayfinPackageDirs();
  }
  return _packageDirs;
}

/**
 * Adds `preserveSymlinks: true` to the vite.config.ts `resolve` section.
 */
function patchViteConfig(projectDir: string): void {
  const vitePath = join(projectDir, 'vite.config.ts');
  if (!existsSync(vitePath)) return;

  const content = readFileSync(vitePath, 'utf8');

  // If already patched, skip
  if (content.includes('preserveSymlinks')) return;

  // Insert preserveSymlinks into the existing resolve block
  const patched = content.replace(
    /resolve:\s*\{/,
    'resolve: {\n    preserveSymlinks: true,'
  );

  if (patched === content) {
    throw new Error(
      `Failed to patch vite.config.ts: could not find 'resolve: {' block in ${vitePath}`
    );
  }

  writeFileSync(vitePath, patched, 'utf8');
}

/**
 * Adds `"preserveSymlinks": true` to tsconfig.json compilerOptions.
 */
function patchTsConfig(projectDir: string): void {
  const tsconfigPath = join(projectDir, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) return;

  const content = readFileSync(tsconfigPath, 'utf8');

  // If already patched, skip
  if (content.includes('preserveSymlinks')) return;

  // Insert preserveSymlinks into compilerOptions
  const patched = content.replace(
    /"compilerOptions"\s*:\s*\{/,
    '"compilerOptions": {\n    "preserveSymlinks": true,'
  );

  if (patched === content) {
    throw new Error(
      `Failed to patch tsconfig.json: could not find '"compilerOptions": {' block in ${tsconfigPath}`
    );
  }

  writeFileSync(tsconfigPath, patched, 'utf8');
}

/**
 * Rewrites Rayfin SDK and Functions worker dependencies in a scaffolded
 * project's `package.json` to point at the local repo packages via `file:`.
 *
 * Also adds npm `overrides` so that transitive `workspace:*` references inside
 * the local packages are resolved to their local paths as well.
 * For an npm workspace member, pass `workspaceRoot` so overrides are written
 * in the root manifest, where npm actually reads them.
 *
 * Additionally patches `vite.config.ts` and `tsconfig.json` to set
 * `preserveSymlinks: true` so that `tsc -b && vite build` resolves modules
 * from the symlink locations (inside the project's node_modules) rather than
 * following symlinks back into the monorepo's pnpm-managed layout.
 *
 * This allows E2E tests to validate against locally-built SDK code instead of
 * published npm versions.
 */
export function rewriteToLocalPackages(
  projectDir: string,
  options: { workspaceRoot?: string } = {}
): void {
  const pkgPath = join(projectDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  const packageDirs = getPackageDirs();

  const toFileRef = (name: string): string | undefined => {
    const localDir = packageDirs[name];
    if (!localDir) return undefined;
    // npm resolves relative overrides from each requesting workspace, not
    // consistently from the root. Absolute URLs also work across drives.
    return pathToFileURL(join(REPO_ROOT, localDir)).href;
  };

  const rewrite = (deps: Record<string, string> | undefined) => {
    if (!deps) return;
    for (const name of Object.keys(deps)) {
      const ref = toFileRef(name);
      if (ref) deps[name] = ref;
    }
  };

  rewrite(pkg.dependencies);
  rewrite(pkg.devDependencies);

  // Add overrides so npm resolves transitive workspace:* deps to local paths
  const overridesDir = options.workspaceRoot ?? projectDir;
  const overridesPath = join(overridesDir, 'package.json');
  const overridesPkg =
    overridesPath === pkgPath
      ? pkg
      : JSON.parse(readFileSync(overridesPath, 'utf8'));
  const overrides: Record<string, string> = {};
  for (const name of Object.keys(packageDirs)) {
    const ref = toFileRef(name);
    if (ref) overrides[name] = ref;
  }
  overridesPkg.overrides = {
    ...overrides,
    ...(overridesPkg.overrides ?? {}),
  };

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  if (overridesPath !== pkgPath) {
    writeFileSync(
      overridesPath,
      JSON.stringify(overridesPkg, null, 2) + '\n',
      'utf8'
    );
  }

  const exampleDep = pkg.dependencies?.['@microsoft/rayfin-core'];
  if (exampleDep) {
    console.log(
      `\n📦 [LOCAL PACKAGES] Resolving @microsoft/rayfin-core from: ${exampleDep}\n`
    );
  }

  // Patch vite.config.ts to preserve symlinks so Vite resolves transitive
  // deps from node_modules/ instead of following symlinks into the monorepo.
  patchViteConfig(projectDir);

  // Patch tsconfig.json so TypeScript also preserves symlinks during resolution.
  patchTsConfig(projectDir);
}

/**
 * Writes a modified Todo entity file into a scaffolded project's
 * `rayfin/data/` directory. Used by E2E tests that verify deploy
 * after modifying the data model.
 */
export function writeTodoEntity(projectDir: string): void {
  const todoPath = join(projectDir, 'rayfin', 'data', 'Todo.ts');
  writeFileSync(
    todoPath,
    `import {
  entity,
  role,
  text,
  boolean,
  date,
  uuid,
} from '@microsoft/rayfin-core';

@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class Todo {
  @uuid() id!: string;
  @text({ min: 1, max: 200 }) title!: string;
  @boolean() isCompleted!: boolean;
  @date() createdAt!: Date;
  @text() user_id!: string;
}
`,
    'utf8'
  );
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
}

/**
 * Default budget for a scaffolded project's `npm install`.
 *
 * The first install of a CI run downloads the whole template dependency tree
 * (React, Vite, Tailwind, TypeScript, ESLint, Vitest) into a cold npm cache and
 * can take several minutes on a 2-core hosted runner. Later installs in the
 * same run reuse that cache and finish in ~20s, so this ceiling is only ever
 * approached once per run.
 */
const NPM_INSTALL_TIMEOUT_MS = 300_000;

export async function runNpmInstall(
  projectDir: string,
  opts?: { timeoutMs?: number }
): Promise<CliResult> {
  const timeoutMs = opts?.timeoutMs ?? NPM_INSTALL_TIMEOUT_MS;
  try {
    const { stdout, stderr } = await execFile('npm', ['install'], {
      cwd: projectDir,
      env: process.env,
      timeout: timeoutMs,
      // npm is a .cmd shim on Windows; execFile needs shell to run it.
      shell: process.platform === 'win32',
    });
    return { exitCode: 0, stdout, stderr, output: stdout + stderr };
  } catch (err) {
    const e = err as {
      code?: number;
      killed?: boolean;
      signal?: string;
      stdout?: string;
      stderr?: string;
    };
    const stdout = e.stdout ?? '';
    const stderr = e.stderr ?? '';
    // A timeout kill leaves stdout/stderr empty, which otherwise surfaces as a
    // bare "npm install failed:" with no cause. Label it explicitly.
    const timedOut = e.killed === true || typeof e.signal === 'string';
    const output = timedOut
      ? `npm install timed out after ${timeoutMs}ms in ${projectDir}` +
        `${stdout || stderr ? `\n${stdout}${stderr}` : ' (no output captured)'}`
      : stdout + stderr;
    return {
      exitCode: typeof e.code === 'number' ? e.code : 1,
      stdout,
      stderr,
      output,
    };
  }
}
