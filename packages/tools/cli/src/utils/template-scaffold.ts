/**
 * Bundled template discovery, selection, and scaffolding utilities.
 *
 * Ported from create-rayfin so that `rayfin init` can handle the full
 * template lifecycle without deferring to `npx @microsoft/create-rayfin`.
 */
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  addBundledTemplateAliases,
  customizeTemplateFiles,
  isValidProjectName,
  readTemplatesFromDirectory,
  visibleTemplates,
  type TemplateFs,
  type TemplateInfo,
} from '@microsoft/rayfin-tools-common/_internal/templates';
import inquirer from 'inquirer';
import ora from 'ora';

import { spawnSafe } from './platform-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Utilities ───────────────────────────────────────────────────────────

/** Extract a human-readable message from an unknown error value. */
function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Node.js TemplateFs implementation ───────────────────────────────────

const nodeFs: TemplateFs = {
  readDir: (path) => readdirSync(path),
  readFile: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, content) => writeFileSync(path, content, 'utf8'),
  exists: (path) => existsSync(path),
  isDirectory: (path) => statSync(path).isDirectory(),
  joinPath: (...segments) => join(...segments),
  copyDir: (src, dest) => cpSync(src, dest, { recursive: true }),
};

// ── Template Discovery ──────────────────────────────────────────────────

/**
 * Walk up from `startDir` looking for a `samples/` directory,
 * which is the monorepo development fallback for bundled templates.
 */
function findSamplesDir(startDir: string): string | undefined {
  let current = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = join(current, 'samples');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

export function filterDiscoverableTemplates(
  templates: TemplateInfo[]
): TemplateInfo[] {
  return templates.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Discover bundled templates.
 *
 * Looks for a `templates/` directory next to the CLI package root first
 * (production), then falls back to `samples/` in the monorepo root (dev).
 */
export function discoverBundledTemplates(): TemplateInfo[] {
  // CLI package root: dist/utils/ → ../../
  const packageRoot = resolve(__dirname, '../..');
  const bundledTemplatesDir = join(packageRoot, 'templates');

  let templates: TemplateInfo[];

  if (existsSync(bundledTemplatesDir)) {
    templates = readTemplatesFromDirectory(bundledTemplatesDir, false, nodeFs);
  } else {
    // Development fallback — walk up to find samples/
    const samplesDir = findSamplesDir(packageRoot);
    if (samplesDir) {
      templates = readTemplatesFromDirectory(samplesDir, true, nodeFs);
    } else {
      templates = [];
    }
  }

  return filterDiscoverableTemplates(addBundledTemplateAliases(templates));
}

// ── Template Selection ──────────────────────────────────────────────────

/** Interactive template selection via rawlist prompt. */
export async function selectBundledTemplate(
  templates: TemplateInfo[]
): Promise<TemplateInfo> {
  const choices = visibleTemplates(templates).map((template) => ({
    name: `${template.displayName} - ${template.description}`,
    value: template,
  }));

  const answer = await inquirer.prompt<{ template: TemplateInfo }>({
    type: 'rawlist',
    name: 'template',
    message: 'Select a template:',
    choices,
  });

  return answer.template;
}

/** Print available templates as JSON (for agent/machine consumption). */
export function listBundledTemplates(templates: TemplateInfo[]): void {
  const output = visibleTemplates(templates).map((t) => ({
    name: t.name,
    displayName: t.displayName,
    description: t.description,
  }));
  console.log(JSON.stringify(output, null, 2));
}

// ── Project Name ────────────────────────────────────────────────────────

/** Prompt for project name with validation. */
export async function promptProjectName(defaultName?: string): Promise<string> {
  const answer = await inquirer.prompt<{ projectName: string }>({
    type: 'input',
    name: 'projectName',
    message: 'Project name:',
    default: defaultName,
    validate: (val: string) => {
      const name = val.trim() || defaultName || '';
      if (!name) return 'Project name is required';
      if (!isValidProjectName(name)) {
        return 'Project name can only contain letters, numbers, spaces, hyphens, or underscores and must include at least one alphanumeric character';
      }
      return true;
    },
  });

  return answer.projectName.trim() || defaultName || '';
}

// ── Directory Conflict ──────────────────────────────────────────────────

/**
 * Return true if the target is missing OR is an empty directory — i.e.,
 * there is nothing to overwrite and it is safe to scaffold into. ENOENT
 * is treated as "safe to proceed"; any other read error (ENOTDIR, EACCES,
 * EPERM, …) returns false so callers fall through to the conflict prompt
 * rather than silently scaffolding when state is unclear.
 *
 * Shallow check: any single entry under `targetPath` (including dotfiles
 * like `.git/`, `.gitkeep`, `.DS_Store`) makes the target non-empty.
 *
 * Shared by `checkDirectoryConflict` (this module) and `checkTargetConflict`
 * (scaffold-pipeline.ts) so the two layers keep one canonical check and
 * cannot drift. Callers that proceed on `true` must still
 * `mkdirSync(..., { recursive: true })` before writing — `true` means
 * "no conflict", not "directory exists".
 */
export function isTargetMissingOrEmpty(targetPath: string): boolean {
  try {
    return readdirSync(targetPath).length === 0;
  } catch (err) {
    return (err as { code?: string }).code === 'ENOENT';
  }
}

/**
 * Check if directory exists and contains contents, prompting for overwrite
 * when needed. Returns true (proceed) for non-existent or empty directories.
 *
 * Wrappers that have already verified non-emptiness (e.g.,
 * `checkTargetConflict`) can pass `knownNonEmpty: true` to skip the
 * redundant `isTargetMissingOrEmpty` syscall and close a TOCTOU race
 * where an external process empties the dir between the wrapper's check
 * and this one — without the flag, the inner call would short-circuit
 * to `true`, and the wrapper would interpret that as user consent.
 *
 * Direct callers (and tests) that don't pre-check should leave the flag
 * unset so the defense-in-depth check still runs.
 */
export async function checkDirectoryConflict(
  targetPath: string,
  options?: {
    nonInteractive?: boolean;
    overwrite?: boolean;
    knownNonEmpty?: boolean;
  }
): Promise<boolean> {
  // Missing or empty target has nothing to overwrite — proceed silently.
  // Avoids a confusing prompt (and non-interactive cancellation) when the
  // user pre-created an empty project folder before running rayfin init.
  if (!options?.knownNonEmpty && isTargetMissingOrEmpty(targetPath)) {
    return true;
  }

  // Non-interactive mode: explicit --overwrite flag is the only way through.
  if (options?.nonInteractive) {
    return options.overwrite === true;
  }

  // Interactive mode: --overwrite flag short-circuits the prompt.
  if (options?.overwrite === true) {
    return true;
  }

  const { overwrite } = await inquirer.prompt<{ overwrite: boolean }>({
    type: 'confirm',
    name: 'overwrite',
    message: `⚠️  Directory ${basename(targetPath)} already exists. Overwrite?`,
    default: false,
  });

  return overwrite;
}

// ── File Copy + Customize ───────────────────────────────────────────────

/** Copy template files with a spinner. */
export function copyTemplateFiles(
  sourcePath: string,
  targetPath: string
): void {
  const spinner = ora({
    text: '📁 Copying template files...',
    color: 'blue',
  }).start();

  try {
    cpSync(sourcePath, targetPath, { recursive: true });
    restoreGitignoreTemplates(targetPath);
    spinner.succeed('✅ Template files copied');
  } catch (error) {
    spinner.fail('❌ Failed to copy template files');
    const message = getErrorMessage(error);
    throw new Error(`Failed to copy template files: ${message}`);
  }

  /** Restore pack-safe ignore assets after npm extraction. */
  function restoreGitignoreTemplates(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        restoreGitignoreTemplates(entryPath);
      } else if (entry.name === '.gitignore.template') {
        renameSync(entryPath, join(directory, '.gitignore'));
      }
    }
  }
}

/** Customize template files (package.json name, README placeholders). */
export function customizeTemplate(
  targetPath: string,
  projectName: string
): void {
  const spinner = ora({
    text: '🔧 Customizing template...',
    color: 'blue',
  }).start();

  customizeTemplateFiles(targetPath, projectName, nodeFs);

  spinner.succeed('✅ Template customized');
}

// ── Package Manager Detection + Install ─────────────────────────────────

/** Detect package manager based on lock files. */
function detectPackageManager(targetPath: string): 'npm' | 'pnpm' | 'yarn' {
  if (existsSync(join(targetPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(targetPath, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/**
 * Install dependencies using the detected package manager.
 * Non-fatal — warns but does not throw on failure.
 */
export async function installDependencies(
  targetPath: string,
  label?: string
): Promise<void> {
  const packageManager = detectPackageManager(targetPath);
  const subject = label ? `${label} dependencies` : 'dependencies';
  const spinner = ora({
    text: `📦 Installing ${subject} with ${packageManager}...`,
    color: 'blue',
  }).start();

  return new Promise((resolvePromise, rejectPromise) => {
    let stderrOutput = '';

    const installProcess = spawnSafe(packageManager, ['install'], {
      cwd: targetPath,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    installProcess.stderr?.on('data', (data: Buffer) => {
      stderrOutput += data.toString();
    });

    const handleCancel = () => {
      spinner.stop();
      installProcess.kill('SIGTERM');
      rejectPromise(new Error('Installation cancelled'));
    };

    process.on('SIGINT', handleCancel);
    process.on('SIGTERM', handleCancel);

    installProcess.on('close', (code) => {
      process.off('SIGINT', handleCancel);
      process.off('SIGTERM', handleCancel);

      if (code === 0) {
        spinner.succeed(
          `✅ ${subject.charAt(0).toUpperCase() + subject.slice(1)} installed`
        );
      } else {
        spinner.fail(`❌ ${packageManager} install failed with code ${code}`);
        if (stderrOutput.trim()) {
          console.error('\nError details:');
          console.error(stderrOutput);
        }
        console.log(
          `\n💡 Template files have been copied but ${packageManager} install failed with code ${code}. You can try running '${packageManager} install' manually.\n`
        );
      }
      resolvePromise();
    });

    installProcess.on('error', (error) => {
      process.off('SIGINT', handleCancel);
      process.off('SIGTERM', handleCancel);

      spinner.fail(`❌ Failed to run ${packageManager} install`);
      console.error(`Error: ${error.message}`);
      console.log(
        `\n💡 Template files have been copied but ${packageManager} install failed. You can try running '${packageManager} install' manually.\n`
      );
      resolvePromise();
    });
  });
}

// ── Run rayfin init --from-template ─────────────────────────────────────

/**
 * Spawn `rayfin init --from-template` in the target directory to synchronize
 * scaffolding files (.gitignore, docker-compose, etc.) and update rayfin.yml.
 */
export async function runRayfinInitFromTemplate(
  targetPath: string,
  projectName: string,
  dialect?: string,
  artifactContext?: {
    workspaceId?: string;
    itemId?: string;
    baseApiUrl?: string;
  },
  options?: {
    skipInstall?: boolean;
    skipRayfinPackageInstall?: boolean;
    services?: string;
  }
): Promise<void> {
  const spinner = ora({
    text: '🔄 Synchronizing with latest rayfin scaffolding...',
    color: 'blue',
  }).start();

  return new Promise((resolvePromise) => {
    let stderrOutput = '';

    try {
      // Resolve the CLI bin from this package's root
      const packageRoot = resolve(__dirname, '../..');
      const rayfinBin = join(packageRoot, 'scripts', 'main');

      const args = [
        rayfinBin,
        'init',
        '--from-template',
        `--project-name=${projectName}`,
        '.',
      ];

      if (dialect) {
        args.push(`--dialect=${dialect}`);
      }
      if (artifactContext?.workspaceId) {
        args.push(`--workspace-id=${artifactContext.workspaceId}`);
      }
      if (artifactContext?.itemId) {
        args.push(`--item-id=${artifactContext.itemId}`);
      }
      if (artifactContext?.baseApiUrl) {
        args.push(`--base-api-url=${artifactContext.baseApiUrl}`);
      }
      if (options?.skipInstall) {
        args.push('--skip-install');
      }
      if (options?.skipRayfinPackageInstall) {
        args.push('--skip-rayfin-package-install');
      }
      if (options?.services) {
        args.push(`--services=${options.services}`);
      }

      const rayfinProcess = spawn(process.execPath, args, {
        cwd: targetPath,
        stdio: ['ignore', 'ignore', 'pipe'],
        shell: false,
      });

      rayfinProcess.stderr?.on('data', (data: Buffer) => {
        stderrOutput += data.toString();
      });

      rayfinProcess.on('close', (code) => {
        if (code === 0) {
          spinner.succeed('✅ Scaffolding files synchronized');
        } else {
          spinner.warn(
            `⚠️  rayfin init completed with code ${code} (project is still usable)`
          );
          if (stderrOutput.trim()) {
            console.warn('\nWarning details:');
            console.warn(stderrOutput);
          }
        }
        resolvePromise();
      });

      rayfinProcess.on('error', (error) => {
        spinner.warn('⚠️  Could not run rayfin init (project is still usable)');
        console.warn(`Warning: Failed to run rayfin init: ${error.message}`);
        resolvePromise();
      });
    } catch (error) {
      spinner.warn('⚠️  Could not find rayfin CLI (project is still usable)');
      console.warn(`Warning: ${getErrorMessage(error)}`);
      resolvePromise();
    }
  });
}
