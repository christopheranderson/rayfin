import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

import {
  SchemaAnalyzer,
  ConfigGenerator,
  Dialect,
  isDialectSupported,
} from '@microsoft/rayfin-core/analysis';
import { isRayfinEntity } from '@microsoft/rayfin-core/schema';
import type { Diagnostics } from '@microsoft/rayfin-tools-common/_internal/adapters';
import { glob } from 'glob';

import {
  runServiceBuildCommand,
  type ServiceBuildOptions,
} from './config-utils.js';
import type { OutputMode } from './output-mode.js';
import { findRayfinProjectRoot } from './project-utils.js';
import {
  compileRayfinDirectory,
  RAYFIN_COMPILED_DIR,
} from './typescript-compiler.js';

export interface DabGenerationOptions {
  inputDir?: string;
  distDir?: string;
  dialect?: Dialect;
  verbose?: boolean;
  diagnostics?: Diagnostics;
  buildOutput?: ServiceBuildOptions['output'];
  compileMode?: OutputMode;
  /** Pre-resolved Rayfin project root. Avoids rediscovery and its CLI output. */
  projectRoot?: string;
  /**
   * Root directory of the data service package (e.g. `<projectRoot>/packages/data`).
   * Used for TypeScript compilation and entity file discovery.
   * Defaults to the Rayfin project root when omitted (single-package behaviour).
   */
  serviceRoot?: string;
  /** Build command to execute before entity compilation. */
  buildCommand?: string;
  /**
   * Capture the build command's stdout/stderr instead of streaming it live,
   * surfacing it only on failure. Set by the v2 `up` data service so build
   * output does not interleave with the Layer 1 spinner; legacy callers omit
   * it and keep the inherited (live) streaming.
   */
  silentBuild?: boolean;
  /**
   * Receives a failed build's captured output (used with `silentBuild`). The
   * v2 data service passes a spinner-aware writer; defaults to `stderr`.
   */
  writeBuildOutput?: (text: string) => void;
}

export interface DabGenerationResult {
  configPath: string;
  entities: any[];
  duration: number;
  dialect: Dialect;
}

/**
 * Generate DAB configuration from TypeScript decorators
 * @param options - Generation options
 * @returns Generation result with config path and metadata
 */
export async function generateDabConfig(
  options: DabGenerationOptions = {}
): Promise<DabGenerationResult> {
  const startTime = Date.now();
  const dialect = options.dialect || 'mssql';
  const verbose = options.verbose ?? false;
  const log = (message = ''): void => {
    if (message.trim())
      options.diagnostics?.debug({ area: 'data.generate', message });
    if (verbose) console.log(message);
  };

  // Find the Rayfin project root first (for temp dir, DAB output, and feature flags)
  const rayfinRoot =
    options.projectRoot ?? findRayfinProjectRoot(process.cwd());

  // The data service root may differ from the Rayfin project root in a workspace
  // layout. It is used for TypeScript compilation and entity file discovery.
  const dataServiceRoot = options.serviceRoot ?? rayfinRoot;

  // Run the data service build command if configured (e.g. for workspace
  // setups where cross-package dependencies must be compiled before the
  // CLI's own rayfin/ TypeScript compilation can resolve imports).
  if (options.buildCommand) {
    log('Running configured data build command');
    const buildSuccess = await runServiceBuildCommand(
      dataServiceRoot,
      options.buildCommand,
      {
        silent: options.silentBuild,
        writeOutput: options.writeBuildOutput,
        diagnostics: options.diagnostics,
        output: options.buildOutput,
      }
    );
    if (!buildSuccess) {
      throw new Error(
        'Data build command failed. Fix the errors above and try again.'
      );
    }
  }

  // Validate dialect
  if (!isDialectSupported(dialect)) {
    throw new Error(`Dialect '${dialect}' is not supported`);
  }

  const tmpDir = join(rayfinRoot, 'rayfin', '.temp');

  // Create .temp directory
  if (!existsSync(tmpDir)) {
    mkdirSync(tmpDir, { recursive: true });
    log(`📂 Created temporary directory: ${tmpDir}`);
  }

  // --- Entity discovery ---
  // Strategy 1: If the data service root has a package.json with an exports
  // entry, import directly from the built package output. This is the
  // preferred path for workspace layouts where each service is its own
  // npm package — no rayfin/data/ re-export layer is needed.
  //
  // Strategy 2 (fallback): Compile the rayfin/ directory with tsc and glob
  // for rayfin/.temp/compiled/data/*.js. This is the traditional single-
  // package path used by samples like todo-app.

  const foundEntities: Record<string, any> = {};
  const packageEntries = resolvePackageExports(dataServiceRoot);

  if (packageEntries) {
    log(
      `📦 Loading entities from package exports: ${packageEntries.join(', ')}`
    );

    for (const entryPath of packageEntries) {
      const absoluteEntry = resolve(dataServiceRoot, entryPath);
      if (!existsSync(absoluteEntry)) {
        throw new Error(
          `Package exports entry not found: ${absoluteEntry}\n💡 Run the build command first (e.g. npm run build)`
        );
      }
      const mod = await import(pathToFileURL(absoluteEntry).href);
      collectEntities(mod, foundEntities);
    }

    log('🔬 Scanned package exports for entities');
  } else {
    // Fallback: compile rayfin/ directory and glob for compiled entity files
    const compileResult = await compileRayfinDirectory(
      dataServiceRoot,
      {
        verbose,
        diagnostics: options.diagnostics,
      },
      options.compileMode
    );
    if (!compileResult.success) {
      throw new Error(
        'TypeScript compilation failed. Fix the errors above and try again.'
      );
    }

    const absoluteRootDir = resolve(dataServiceRoot);
    const defaultInputDir = join(dataServiceRoot, 'rayfin', 'data');
    const targetInputDir = options.inputDir || defaultInputDir;
    const absoluteInputDir = resolve(targetInputDir);

    if (!existsSync(absoluteInputDir)) {
      const message = options.inputDir
        ? `Input directory does not exist: ${absoluteInputDir}`
        : `Default input directory does not exist: ${absoluteInputDir}\n💡 Create the directory or specify a custom input directory`;
      throw new Error(message);
    }

    log(`📁 Scanning directory: ${absoluteInputDir}`);

    const schemaFiles = await glob(
      `**/rayfin/${RAYFIN_COMPILED_DIR}/data/*.js`,
      {
        cwd: absoluteRootDir,
        absolute: true,
        ignore: [
          '**/node_modules/**',
          '**/*.d.ts',
          '**/*.test.ts',
          '**/*.spec.ts',
        ],
      }
    );

    if (schemaFiles.length === 0) {
      throw new Error(
        `No rayfin/${RAYFIN_COMPILED_DIR}/data/*.js files found in: ${absoluteRootDir}\n💡 - you may need to build your project`
      );
    }

    log(
      `🔍 Found ${schemaFiles.length} *.js file${schemaFiles.length === 1 ? '' : 's'}`
    );
    if (schemaFiles.length <= 10) {
      schemaFiles.forEach((file) => log(`   └── ${file}`));
    } else {
      schemaFiles.slice(0, 5).forEach((file) => log(`   └── ${file}`));
      log(`   └── ... and ${schemaFiles.length - 5} more files`);
    }
    log();
    log('🔬 Starting export analysis...');
    for (const schemaFile of schemaFiles) {
      const schema = await import(pathToFileURL(schemaFile).href);
      collectEntities(schema, foundEntities);
    }
  }

  log('🛠️  Starting schema analysis...');
  const analyzer = new SchemaAnalyzer(Object.values(foundEntities), dialect, {
    log,
  });
  const entities = analyzer.analyzeEntities();

  if (entities.length === 0) {
    return {
      configPath: '',
      entities: [],
      duration: Date.now() - startTime,
      dialect,
    };
  }

  log(
    `\n✅ Analysis complete: ${entities.length} entit${entities.length === 1 ? 'y' : 'ies'} found`
  );

  // Generate DAB configuration
  log('🏗️  Generating DAB configuration...');
  const configGenerator = new ConfigGenerator(dialect);
  const dabConfig = configGenerator.generateConfig(entities);

  // Write output file to temp directory: <project-root>/rayfin/.temp/dab-config.json
  const outputPath = join(tmpDir, 'dab-config.json');
  writeFileSync(outputPath, JSON.stringify(dabConfig, null, 2));

  const duration = Date.now() - startTime;

  return {
    configPath: outputPath,
    entities,
    duration,
    dialect,
  };
}

/**
 * Resolve the entry point(s) from a package.json exports or main field.
 * Returns an array of relative paths to JS entry files, or null if the
 * service root has no package.json or no resolvable exports.
 */
export function resolvePackageExports(serviceRoot: string): string[] | null {
  const pkgPath = join(serviceRoot, 'package.json');
  if (!existsSync(pkgPath)) return null;

  let pkg: Record<string, any>;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    return null;
  }

  // Try the "exports" field first (supports "." shorthand and conditional)
  const exp = pkg.exports;
  if (exp) {
    const resolved = resolveExportsEntry(exp);
    if (resolved.length > 0) return resolved;
  }

  // Fall back to "main"
  if (typeof pkg.main === 'string') {
    return [pkg.main];
  }

  return null;
}

/** Walk an exports value and collect the JS entry paths. */
function resolveExportsEntry(entry: unknown): string[] {
  if (typeof entry === 'string') {
    return entry.endsWith('.js') ? [entry] : [];
  }
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const obj = entry as Record<string, unknown>;
    // { ".": "./dist/index.js" } or { ".": { "import": "...", "types": "..." } }
    if ('.' in obj) {
      return resolveExportsEntry(obj['.']);
    }
    // Conditional exports: prefer "import" > "require" > "default"
    for (const key of ['import', 'require', 'default']) {
      if (key in obj && typeof obj[key] === 'string') {
        const val = obj[key] as string;
        if (val.endsWith('.js')) return [val];
      }
    }
  }
  return [];
}

/** Scan a module's exports for Rayfin entities and collect them. */
function collectEntities(
  mod: Record<string, any>,
  target: Record<string, any>
): void {
  for (const [key, value] of Object.entries(mod)) {
    if (value && isRayfinEntity(value)) {
      target[key] = value;
    } else if (value && Array.isArray(value)) {
      for (const item of value) {
        if (isRayfinEntity(item)) {
          target[item.name] = item;
        }
      }
    }
  }
}
