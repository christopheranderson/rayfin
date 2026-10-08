import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock collaborators so the test exercises the real schema-discovery logic in
// generateStorageConfig (directory glob + dynamic import + SchemaAnalyzer +
// StorageConfigGenerator) while isolating it from the project root lookup and
// the TypeScript compile step.
vi.mock('../project-utils.js', () => ({
  findRayfinProjectRoot: vi.fn(),
}));

vi.mock('../typescript-compiler.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../typescript-compiler.js')>();
  return {
    ...actual,
    compileRayfinDirectory: vi.fn(async () => ({ success: true, errors: [] })),
  };
});

import { findRayfinProjectRoot } from '../project-utils.js';
import { generateStorageConfig } from '../storage-config-generator';
import {
  compileRayfinDirectory,
  RAYFIN_COMPILED_DIR,
} from '../typescript-compiler.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Write a compiled (ESM .js) Rayfin storage folder fixture to disk that
 * mirrors what the TypeScript compiler emits for an `@blob()` class: a class
 * whose `Symbol.metadata` carries the storage folder metadata under the
 * `microsoft.rayfin.storage.folder` symbol key (matching `isRayfinStorageFolder`).
 */
function writeStorageFixture(
  compiledStorageDir: string,
  className: string,
  metadata: Record<string, unknown>
): void {
  const content = `(Symbol).metadata ??= Symbol('Symbol.metadata');
const RAYFIN_STORAGE_FOLDER = Symbol.for('microsoft.rayfin.storage.folder');

export class ${className} {}
${className}[Symbol.metadata] = {
  [RAYFIN_STORAGE_FOLDER]: ${JSON.stringify(metadata)},
};
`;
  writeFileSync(join(compiledStorageDir, `${className}.js`), content, 'utf-8');
}

describe('generateStorageConfig', () => {
  let projectRoot: string;
  let compiledStorageDir: string;
  let storageSourceDir: string;

  beforeEach(() => {
    // Keep the temp project inside the package tree so Vite/vitest allows the
    // dynamic import() of the freshly written fixture files.
    projectRoot = mkdtempSync(join(here, 'tmp-storage-'));

    // generateStorageConfig requires rayfin/storage to exist on disk.
    storageSourceDir = join(projectRoot, 'rayfin', 'storage');
    mkdirSync(storageSourceDir, { recursive: true });

    // Compiled folders are discovered from rayfin/<RAYFIN_COMPILED_DIR>/storage.
    compiledStorageDir = join(
      projectRoot,
      'rayfin',
      RAYFIN_COMPILED_DIR,
      'storage'
    );
    mkdirSync(compiledStorageDir, { recursive: true });

    vi.mocked(findRayfinProjectRoot).mockReturnValue(projectRoot);
    vi.mocked(compileRayfinDirectory).mockResolvedValue({
      success: true,
      errors: [],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('writes a storage-config.json with discovered @blob folders to rayfin/.temp', async () => {
    writeStorageFixture(compiledStorageDir, 'Documents', {
      name: 'Documents',
      folderName: 'documents',
      onConflict: 'error',
      permissions: { authenticated: ['read'] },
    });

    const result = await generateStorageConfig();

    expect(result.configPath).toBe(
      join(projectRoot, 'rayfin', '.temp', 'storage-config.json')
    );
    expect(result.folders).toHaveLength(1);
    expect(result.folders[0]).toMatchObject({
      name: 'documents',
      onConflict: 'error',
    });

    const onDisk = JSON.parse(readFileSync(result.configPath, 'utf-8'));
    expect(onDisk.schemaVersion).toBeDefined();
    expect(onDisk.folders).toHaveLength(1);
    expect(onDisk.folders[0].name).toBe('documents');
  });

  it('does not write status output in silent mode', async () => {
    writeStorageFixture(compiledStorageDir, 'Documents', {
      name: 'Documents',
      folderName: 'documents',
      onConflict: 'error',
      permissions: { authenticated: ['read'] },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await generateStorageConfig({ mode: 'silent' });
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('emits one folder entry per @blob class across multiple fixture files', async () => {
    writeStorageFixture(compiledStorageDir, 'Documents', {
      name: 'Documents',
      folderName: 'documents',
      onConflict: 'error',
      permissions: { authenticated: ['read'] },
    });
    writeStorageFixture(compiledStorageDir, 'Images', {
      name: 'Images',
      folderName: 'images',
      onConflict: 'error',
      permissions: { authenticated: ['read'] },
    });

    const result = await generateStorageConfig();

    const folderNames = result.folders.map((f) => f.name).sort();
    expect(folderNames).toEqual(['documents', 'images']);
  });

  it('propagates @blob app-specific typed fields to the emitted config', async () => {
    writeStorageFixture(compiledStorageDir, 'Documents', {
      name: 'Documents',
      folderName: 'documents',
      onConflict: 'error',
      permissions: { authenticated: ['read'] },
      fields: {
        team_id: { format: 'string', jsType: 'string' },
        category: { format: 'string', jsType: 'string', isOptional: true },
      },
    });

    const result = await generateStorageConfig();

    expect(result.folders).toHaveLength(1);
    const folder = result.folders[0];
    expect(folder.fields).toBeDefined();
    const fieldsByName = Object.fromEntries(
      (folder.fields ?? []).map((f) => [f.name, f])
    );
    expect(fieldsByName.team_id).toMatchObject({
      type: 'string',
      storage: 'user_metadata',
    });
    expect(fieldsByName.category).toMatchObject({
      type: 'string',
      nullable: true,
      storage: 'user_metadata',
    });
  });

  it('writes an empty folders array when the compiled file exports no @blob classes', async () => {
    // Compiled file exists in the glob path but exports nothing storage-shaped.
    writeFileSync(
      join(compiledStorageDir, 'empty.js'),
      'export const notAFolder = 42;\n',
      'utf-8'
    );

    const result = await generateStorageConfig();

    expect(result.folders).toEqual([]);
    const onDisk = JSON.parse(readFileSync(result.configPath, 'utf-8'));
    expect(onDisk.folders).toEqual([]);
    expect(onDisk.schemaVersion).toBeDefined();
  });

  it('throws when no compiled storage/*.js files are found (project not built)', async () => {
    // rayfin/storage exists, but the compiled output directory is empty.
    await expect(generateStorageConfig()).rejects.toThrow(
      /No rayfin\/.*\/storage\/\*\.js files found/
    );
  });

  it('throws a guidance message when the default rayfin/storage directory does not exist', async () => {
    rmSync(storageSourceDir, { recursive: true, force: true });

    await expect(generateStorageConfig()).rejects.toThrow(
      /Default storage directory does not exist/
    );
  });

  it('forwards the diagnostic writer to TypeScript compilation', async () => {
    const writeDiagnostic = vi.fn();
    writeStorageFixture(compiledStorageDir, 'Documents', {
      name: 'Documents',
      folderName: 'documents',
      onConflict: 'error',
      permissions: { authenticated: ['read'] },
    });

    await generateStorageConfig({
      verbose: true,
      mode: 'silent',
      writeDiagnostic,
    });

    expect(compileRayfinDirectory).toHaveBeenCalledWith(
      projectRoot,
      { verbose: true, writeDiagnostic },
      'silent'
    );
  });

  it('throws a different message when an explicit inputDir does not exist', async () => {
    const missing = join(projectRoot, 'does-not-exist');

    await expect(generateStorageConfig({ inputDir: missing })).rejects.toThrow(
      /Storage input directory does not exist/
    );
  });

  it('rethrows when the TypeScript compile step fails', async () => {
    vi.mocked(compileRayfinDirectory).mockResolvedValueOnce({
      success: false,
      errors: ['boom'],
    });

    await expect(generateStorageConfig()).rejects.toThrow(
      /TypeScript compilation failed/
    );
  });
});
