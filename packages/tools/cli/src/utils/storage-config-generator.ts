import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

import {
  SchemaAnalyzer,
  STORAGE_CONFIG_SCHEMA_VERSION,
  StorageConfigGenerator,
} from '@microsoft/rayfin-core/analysis';
import type {
  StorageConfig,
  StorageFolder,
} from '@microsoft/rayfin-core/analysis';
import { isRayfinStorageFolder } from '@microsoft/rayfin-core/schema';
import type { Diagnostics } from '@microsoft/rayfin-tools-common/_internal/adapters';
import { glob } from 'glob';
// import ts from 'typescript';

import { resolveServicePath, loadRayfinConfig } from './config-utils.js';
import { modeLog, resolveOutputMode, type OutputMode } from './output-mode.js';
import { findRayfinProjectRoot } from './project-utils.js';
import {
  compileRayfinDirectory,
  RAYFIN_COMPILED_DIR,
} from './typescript-compiler.js';

export interface StorageGenerationOptions {
  diagnostics?: Diagnostics;
  inputDir?: string;
  projectRoot?: string;
  serviceRoot?: string;
  verbose?: boolean;
  mode?: OutputMode;
  writeDiagnostic?: (text: string) => void;
}

export interface StorageGenerationResult {
  configPath: string;
  folders: StorageFolder[];
  duration: number;
}

/**
 * Generate storage configuration from TypeScript decorators
 * @param options - Generation options
 * @returns Generation result with config path and metadata
 */
export async function generateStorageConfig(
  options: StorageGenerationOptions = {}
): Promise<StorageGenerationResult> {
  const startTime = Date.now();
  const verbose = options.verbose || false;
  const mode = options.mode ?? resolveOutputMode({ json: false });
  const verboseLog = (text = ''): void => {
    if (text.trim())
      options.diagnostics?.debug({ area: 'storage.generate', message: text });
    if (!verbose) {
      return;
    }
    if (options.writeDiagnostic) {
      options.writeDiagnostic(text + '\n');
      return;
    }
    modeLog(mode, text);
  };

  // Find the Rayfin project root first (needed for compilation)
  const rayfinRoot = options.projectRoot ?? findRayfinProjectRoot();

  // Resolve storage service root from config when not explicitly provided
  let storageServiceRoot = options.serviceRoot;
  if (!storageServiceRoot) {
    const config = loadRayfinConfig(rayfinRoot, {
      silent: mode === 'silent' || mode === 'json',
    });
    storageServiceRoot = resolveServicePath(
      rayfinRoot,
      config?.services?.storage?.path
    );
  }

  // Compile TypeScript before generating configuration.
  //
  // Compilation is rooted at the *storage service* root, not the project root:
  // in a workspace layout (`services.storage.path: packages/storage`) the
  // schema sources live at `packages/storage/rayfin/storage/`, so compiling the
  // project root would emit nothing and the glob below would fail with
  // "no *.js files found". This mirrors how the data generator compiles
  // `dataServiceRoot`.
  const compileResult = await compileRayfinDirectory(
    storageServiceRoot,
    {
      verbose,
      writeDiagnostic: options.writeDiagnostic,
      diagnostics: options.diagnostics,
    },
    mode
  );
  if (!compileResult.success) {
    throw new Error(
      'TypeScript compilation failed. Fix the errors above and try again.'
    );
  }

  // `.temp/compiled` is emitted next to the sources that were compiled, so it
  // must be rooted at the storage service root too.
  const tmpDir = join(storageServiceRoot, 'rayfin', '.temp');

  // Use default input directory if not provided (storage instead of data)
  const defaultInputDir = join(storageServiceRoot, 'rayfin', 'storage');
  const targetInputDir = options.inputDir || defaultInputDir;

  // Resolve input directory
  const absoluteInputDir = resolve(targetInputDir);

  if (!existsSync(absoluteInputDir)) {
    const message = options.inputDir
      ? `Storage input directory does not exist: ${absoluteInputDir}`
      : `Default storage directory does not exist: ${absoluteInputDir}\n💡 Create the directory or specify a custom input directory`;
    throw new Error(message);
  }

  verboseLog(`📁 Scanning storage directory: ${absoluteInputDir}`);

  // Create .temp directory
  if (!existsSync(tmpDir)) {
    mkdirSync(tmpDir, { recursive: true });
    verboseLog(`📂 Created temporary directory: ${tmpDir}`);
  }

  // Find all TypeScript files in storage directory
  const absoluteRootDir = resolve(storageServiceRoot);

  try {
    modeLog(mode, '🗂️  Generating storage configuration...');

    // Find built storage schema files in .temp/compiled/storage (consistent with DAB generator)
    const schemaFiles = await glob(
      `**/rayfin/${RAYFIN_COMPILED_DIR}/storage/*.js`,
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
        `No rayfin/${RAYFIN_COMPILED_DIR}/storage/*.js files found in: ${absoluteRootDir}\n💡 - you may need to build your project`
      );
    }

    verboseLog(
      `🔍 Found ${schemaFiles.length} *.js file${schemaFiles.length === 1 ? '' : 's'}`
    );
    if (schemaFiles.length <= 10) {
      schemaFiles.forEach((file) => verboseLog(`   └── ${file}`));
    } else {
      schemaFiles.slice(0, 5).forEach((file) => verboseLog(`   └── ${file}`));
      verboseLog(`   └── ... and ${schemaFiles.length - 5} more files`);
    }
    verboseLog();

    const foundFolders: Record<string, any> = {};
    for (const schemaFile of schemaFiles) {
      // Convert Windows paths to file:// URLs for ESM dynamic imports
      const schema = await import(pathToFileURL(schemaFile).href);

      for (const [key, value] of Object.entries(schema)) {
        if (value && isRayfinStorageFolder(value)) {
          foundFolders[key] = value;
        } else if (value && Array.isArray(value)) {
          for (const item of value) {
            if (isRayfinStorageFolder(item)) {
              foundFolders[item.name] = item;
            }
          }
        }
      }
    }

    const analyzer = new SchemaAnalyzer(Object.values(foundFolders), 'mssql', {
      log: verboseLog,
    });
    const storageFolders = analyzer.analyzeStorageFolders();

    if (storageFolders.length === 0) {
      modeLog(mode, '   ⚠️  No storage folders found with @blob decorator');
      const config: StorageConfig = {
        schemaVersion: STORAGE_CONFIG_SCHEMA_VERSION,
        folders: [],
      };
      const configPath = join(tmpDir, 'storage-config.json');
      writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

      return {
        configPath,
        folders: [],
        duration: Date.now() - startTime,
      };
    }

    // Generate config using the core StorageConfigGenerator
    const generator = new StorageConfigGenerator();
    const config = generator.generateConfig(storageFolders);

    // 4. Write to rayfin/.temp/storage-config.json with proper structure
    const configPath = join(tmpDir, 'storage-config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    const duration = Date.now() - startTime;

    verboseLog(`⏱️  Storage generation completed in ${duration}ms`);

    modeLog(mode, `   ✅ Storage configuration written to ${configPath}`);
    modeLog(mode, `   📊 Generated ${config.folders.length} storage folders`);

    return {
      configPath,
      folders: config.folders,
      duration,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    verboseLog(`❌ Storage generation failed after ${duration}ms`);

    throw error;
  }
}
