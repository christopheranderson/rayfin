import { existsSync } from 'fs';
import { readdir, rm } from 'fs/promises';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import type { Diagnostics } from '@microsoft/rayfin-tools-common/_internal/adapters';
import ora from 'ora';
import ts from 'typescript';

import {
  createProgress,
  wrapOraSpinner,
  type OutputMode,
  resolveOutputMode,
} from './output-mode.js';
import { getPlatformCommand, spawnSafe } from './platform-utils.js';

/**
 * Path (relative to the rayfin directory) where TypeScript compiled output is written.
 */
export const RAYFIN_COMPILED_DIR = '.temp/compiled';

export interface CompileOptions {
  diagnostics?: Diagnostics;
  verbose?: boolean;
  writeDiagnostic?: (text: string) => void;
}

export interface CompileResult {
  success: boolean;
  errors: string[];
}

/**
 * Delete TypeScript's incremental build info from a directory.
 *
 * Removing the compiled output on its own is not enough: a `composite` or
 * `incremental` project keeps a `.tsbuildinfo` alongside it, and on the next
 * run TypeScript trusts that file, concludes the output is current, and emits
 * nothing — reporting success while leaving the output directory empty.
 */
async function removeBuildInfo(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    return;
  }

  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tsbuildinfo'))
      .map((entry) => rm(join(dir, entry.name), { force: true }))
  );
}

/** Delete the build-info file selected by the fully resolved tsconfig. */
async function removeConfiguredBuildInfo(tsconfigPath: string): Promise<void> {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    tsconfigPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => undefined,
    }
  );
  if (!parsed) {
    return;
  }

  const buildInfoPath = ts.getTsBuildInfoEmitOutputFilePath(parsed.options);
  if (buildInfoPath) {
    await rm(buildInfoPath, { force: true });
  }
}

/**
 * Resolve the path to the TypeScript compiler (tsc.js) available to the CLI.
 *
 * Resolution order:
 * 1. Node module resolution via createRequire – this is ESM-safe and picks up
 *    the TypeScript installation declared as a CLI dependency, including hoisted
 *    installs that may not reside in a package-local node_modules directory.
 *    The specifier 'typescript/lib/tsc.js' uses forward slashes (module-specifier
 *    semantics), which is portable across all platforms.
 * 2. Package-local node_modules path – a best-effort fallback that works when
 *    TypeScript is installed directly under the CLI package root but is not
 *    reachable via the module resolver from this file's context.
 * 3. Returns '' to trigger the npx tsc fallback in the caller.
 *
 * @returns The absolute path to tsc.js, or '' if it could not be resolved.
 */
export function getTscPath(): string {
  // Primary: resolve via Node module resolution from this module's context.
  // createRequire is required here because this file runs as an ES module; bare
  // require.resolve is not available in ESM without it.
  try {
    const esmRequire = createRequire(import.meta.url);
    return esmRequire.resolve('typescript/lib/tsc.js');
  } catch {
    // Module resolution failed (e.g., typescript not on the resolution path).
    // Fall through to the package-local path check.
  }

  // Secondary: check a hardcoded path relative to the CLI package root.
  // This covers edge cases where the Node resolver cannot locate typescript
  // from the CLI module context but the package manager placed it here.
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const cliPackageRoot = join(__dirname, '..', '..');
  const tscJsPath = join(
    cliPackageRoot,
    'node_modules',
    'typescript',
    'lib',
    'tsc.js'
  );

  if (existsSync(tscJsPath)) {
    return tscJsPath;
  }

  // Last resort: return '' to trigger the npx tsc fallback in the caller.
  return '';
}

/**
 * Ensure tsconfig.json exists in the rayfin directory.
 * If it does not exist, use the one at the project root.
 * @param rayfinDir - Path to the rayfin directory
 * @returns string - The path to tsconfig.json if exists in the rayfin folder or the project root, undefined otherwise
 */
export function getTsConfigPath(projectRoot: string): string | undefined {
  const rayfinDir = join(projectRoot, 'rayfin');
  let tsconfigPath = join(rayfinDir, 'tsconfig.json');

  if (!existsSync(tsconfigPath)) {
    // check for tsconfig.json at project root
    const rootTsconfigPath = join(projectRoot, 'tsconfig.json');
    if (existsSync(rootTsconfigPath)) {
      tsconfigPath = rootTsconfigPath;
    } else {
      return undefined;
    }
  }
  return tsconfigPath;
}

/**
 * Run TypeScript compiler on the rayfin directory
 * @param projectRoot - Root directory of the project
 * @throws `Error` if tsconfig.json is not found
 * @returns Promise<CompileResult> - Result of the compilation
 */
export async function runTscCommand(
  projectRoot: string,
  writeDiagnostic?: (text: string) => void
): Promise<CompileResult> {
  // Get tsconfig.json path if exists
  const tsconfigPath = getTsConfigPath(projectRoot);

  if (!tsconfigPath) {
    const message =
      '\nError: tsconfig.json not found in rayfin directory or project root.\n';
    if (writeDiagnostic) {
      writeDiagnostic(message);
    } else {
      console.error(message);
    }
    throw new Error('tsconfig.json not found');
  }

  // Get the tsc path from the CLI package's dependencies
  const tscPath = getTscPath();

  // Use node to execute the TypeScript compiler directly if we found tsc.js
  // Otherwise fall back to npx via spawnSafe (which resolves to npx.cmd on
  // Windows and avoids shell: true so paths with spaces are handled safely).
  const useDirectExec = tscPath && existsSync(tscPath);
  const command = useDirectExec ? process.execPath : getPlatformCommand('npx');
  const args = useDirectExec
    ? [tscPath, '--build', tsconfigPath, '--force']
    : ['tsc', '--build', tsconfigPath, '--force'];

  return new Promise((resolve) => {
    const errors: string[] = [];
    const tsc = spawnSafe(command, args, {
      cwd: projectRoot,
    });

    let stderrData = '';

    tsc.stdout?.on('data', (data) => {
      const output = data.toString();
      if (output.trim()) {
        errors.push(output);
      }
    });

    tsc.stderr?.on('data', (data) => {
      stderrData += data.toString();
    });

    tsc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, errors: [] });
      } else {
        // TypeScript errors come through stdout, not stderr
        if (stderrData.trim()) {
          errors.push(stderrData);
        }
        resolve({ success: false, errors });
      }
    });

    tsc.on('error', (error) => {
      resolve({
        success: false,
        errors: [`Failed to run TypeScript compiler: ${error.message}`],
      });
    });
  });
}

/**
 * Compile the ./rayfin directory using TypeScript
 * @param projectRoot - Root directory of the project
 * @param options - Compilation options
 * @returns Promise<CompileResult> - Result of the compilation
 */
export async function compileRayfinDirectory(
  projectRoot: string,
  options: CompileOptions = {},
  mode?: OutputMode
): Promise<CompileResult> {
  const rayfinDir = join(projectRoot, 'rayfin');
  const verbose = options.verbose || false;
  const writeDiagnostic = options.writeDiagnostic;
  const writeVerboseDiagnostic = (text: string): void => {
    options.diagnostics?.debug({ area: 'typescript', message: text });
    if (!verbose) return;
    if (writeDiagnostic) {
      writeDiagnostic(`${text}\n`);
    } else if (mode !== 'silent' && mode !== 'json') {
      console.log(text);
    }
  };
  const writeErrorDiagnostic = (text: string): void => {
    options.diagnostics?.debug({ area: 'typescript', message: text });
    if (writeDiagnostic) {
      writeDiagnostic(`${text}\n`);
    } else if (mode !== 'silent' && mode !== 'json') {
      console.error(text);
    }
  };

  // Check if rayfin directory exists
  if (!existsSync(rayfinDir)) {
    return {
      success: false,
      errors: [
        `Rayfin directory not found: ${rayfinDir}`,
        'Run "rayfin init" to create the directory structure.',
      ],
    };
  }

  // Clean the compiled output directory before compilation so that files
  // removed from rayfin/data/ or rayfin/storage/ do not leave stale .js
  // artifacts that would otherwise be picked up by the DAB / storage config
  // generators.
  const [tempSegment] = RAYFIN_COMPILED_DIR.split('/');
  const tempDir = join(rayfinDir, tempSegment);
  const compiledDir = join(rayfinDir, ...RAYFIN_COMPILED_DIR.split('/'));
  const tsconfigPath = getTsConfigPath(projectRoot);
  if (existsSync(compiledDir)) {
    await rm(compiledDir, { recursive: true, force: true });
  }

  // Discard the build info too, otherwise this compile skips the emit and the
  // output directory we just deleted is never rebuilt.
  await Promise.all([
    removeBuildInfo(tempDir),
    removeBuildInfo(rayfinDir),
    ...(tsconfigPath ? [removeConfiguredBuildInfo(tsconfigPath)] : []),
  ]);

  // Show compilation spinner
  const resolvedMode = mode ?? resolveOutputMode({ json: false });
  let spinner;
  if (resolvedMode !== 'interactive') {
    spinner = createProgress(resolvedMode, 'Compiling TypeScript', {
      prefix: '[rayfin]',
    });
  } else {
    spinner = wrapOraSpinner(
      ora('Compiling TypeScript...').start(),
      'Compiling TypeScript'
    );
  }

  try {
    const result = await runTscCommand(projectRoot, writeErrorDiagnostic);

    if (result.success) {
      spinner.succeed('TypeScript compilation successful');
      writeVerboseDiagnostic(
        `Compiled output (probably written to ${join(rayfinDir, RAYFIN_COMPILED_DIR)})`
      );
    } else {
      spinner.fail('TypeScript compilation failed');
      writeErrorDiagnostic('\n❌ TypeScript Errors:\n');
      result.errors.forEach((error) => {
        writeErrorDiagnostic(error);
      });
      writeErrorDiagnostic(
        '\n💡 Fix the TypeScript errors above and try again.\n'
      );
    }

    return result;
  } catch (error: any) {
    spinner.fail('TypeScript compilation failed');
    const errorMsg = `Unexpected error during compilation: ${error.message || String(error)}`;
    writeErrorDiagnostic(`\n❌ ${errorMsg}\n`);
    if (error.code === 'EINVAL' || error.message?.includes('EINVAL')) {
      writeErrorDiagnostic(
        '💡 This may be caused by spawning .cmd files without shell on Windows (Node.js v22+).'
      );
      writeErrorDiagnostic(
        '   The CLI failed to locate tsc.js directly. Check that TypeScript is installed.\n'
      );
    }
    return {
      success: false,
      errors: [errorMsg],
    };
  }
}
