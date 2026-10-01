import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  compileRayfinDirectory,
  getTscPath,
  getTsConfigPath,
  runTscCommand,
} from '../typescript-compiler.js';

describe('typescript-compiler', () => {
  let testProjectDir: string;

  beforeEach(() => {
    // Create a unique temporary directory for each test
    testProjectDir = join(
      tmpdir(),
      `rayfin-test-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
    );
    mkdirSync(join(testProjectDir, 'rayfin', 'data'), { recursive: true });
  });

  afterEach(() => {
    // Clean up the test directory
    try {
      rmSync(testProjectDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('getTscPath', () => {
    it('should return an existing tsc.js path resolved from the CLI dependencies', () => {
      const tscPath = getTscPath();

      expect(tscPath).toBeTruthy();
      expect(tscPath).toMatch(/tsc\.js$/);
      expect(existsSync(tscPath)).toBe(true);
    });
  });

  describe('hasTsConfig', () => {
    it('should return path if tsconfig.json exists in rayfin directory', () => {
      const rayfinDir = join(testProjectDir, 'rayfin');
      const tsconfigPath = join(rayfinDir, 'tsconfig.json');

      // Create a tsconfig
      const config = {
        extends: '../../packages/tsconfig.base.json',
        compilerOptions: { outDir: '.temp/compiled' },
      };
      writeFileSync(tsconfigPath, JSON.stringify(config, null, 2));

      expect(getTsConfigPath(testProjectDir)).toBe(tsconfigPath);
    });

    it('should return path if tsconfig.json exists in project root', () => {
      const rootTsconfigPath = join(testProjectDir, 'tsconfig.json');

      // Create a tsconfig at root
      const config = {
        compilerOptions: { target: 'ES2020' },
      };
      writeFileSync(rootTsconfigPath, JSON.stringify(config, null, 2));

      expect(getTsConfigPath(testProjectDir)).toBe(rootTsconfigPath);
    });
  });

  describe('compileRayfinDirectory', () => {
    it.each([true, false])(
      'records compilation detail without verbose or terminal output (valid=%s)',
      async (valid) => {
        const rayfinDir = join(testProjectDir, 'rayfin');
        writeFileSync(
          join(rayfinDir, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: { outDir: '.temp/compiled', rootDir: '.' },
            include: ['**/*.ts'],
          })
        );
        writeFileSync(
          join(rayfinDir, 'data', 'input.ts'),
          valid ? 'export const value = 1;' : 'export const =;'
        );
        const diagnostics = { debug: vi.fn() };
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          const result = await compileRayfinDirectory(
            testProjectDir,
            { diagnostics, verbose: false },
            'silent'
          );
          expect(result.success).toBe(valid);
          expect(diagnostics.debug).toHaveBeenCalledWith({
            area: 'typescript',
            message: expect.stringContaining(
              valid ? 'Compiled output' : 'TypeScript Errors'
            ),
          });
          expect(log).not.toHaveBeenCalled();
          expect(error).not.toHaveBeenCalled();
        } finally {
          log.mockRestore();
          error.mockRestore();
        }
      }
    );

    it('should return error if rayfin directory does not exist', async () => {
      const nonExistentDir = join(testProjectDir, 'nonexistent');
      const result = await compileRayfinDirectory(nonExistentDir);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0]).toContain('Rayfin directory not found');
    });

    it('should compile valid TypeScript successfully', async () => {
      const rayfinDir = join(testProjectDir, 'rayfin');

      // Create tsconfig.json in rayfin directory
      const tsconfigPath = join(rayfinDir, 'tsconfig.json');
      const tsconfig = {
        compilerOptions: {
          outDir: '.temp/compiled',
          rootDir: '.',
          declaration: true,
          composite: true,
        },
        include: ['**/*.ts'],
      };
      writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));

      // Create a valid TypeScript file
      const validTs = `
export class Example {
  name: string;

  constructor(name: string) {
    this.name = name;
  }

  greet(): string {
    return \`Hello, \${this.name}\`;
  }
}
`;
      writeFileSync(join(rayfinDir, 'data', 'Example.ts'), validTs);

      const result = await compileRayfinDirectory(testProjectDir);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);

      // Check that compiled output exists
      const compiledPath = join(
        rayfinDir,
        '.temp',
        'compiled',
        'data',
        'Example.js'
      );
      expect(existsSync(compiledPath)).toBe(true);
    }, 30_000);

    it('re-emits every entity when incremental build info is outside the cleaned output', async () => {
      const rayfinDir = join(testProjectDir, 'rayfin');
      const dataDir = join(rayfinDir, 'data');
      const compiledDataDir = join(rayfinDir, '.temp', 'compiled', 'data');
      writeFileSync(
        join(rayfinDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            outDir: '.temp/compiled',
            rootDir: '.',
            declaration: true,
            composite: true,
            tsBuildInfoFile: '.temp/rayfin.tsbuildinfo',
            skipLibCheck: true,
            types: [],
          },
          include: ['data/**/*.ts'],
        })
      );
      writeFileSync(join(dataDir, 'Asset.ts'), 'export class Asset {}');
      writeFileSync(join(dataDir, 'Liability.ts'), 'export class Liability {}');

      const compile = () =>
        compileRayfinDirectory(testProjectDir, {}, 'silent');
      const compiledEntities = () =>
        existsSync(compiledDataDir)
          ? readdirSync(compiledDataDir)
              .filter((file) => file.endsWith('.js'))
              .sort()
          : [];

      expect((await compile()).success).toBe(true);
      expect(compiledEntities()).toEqual(['Asset.js', 'Liability.js']);
      expect((await compile()).success).toBe(true);
      expect(compiledEntities()).toEqual(['Asset.js', 'Liability.js']);

      rmSync(join(dataDir, 'Liability.ts'));
      writeFileSync(join(dataDir, 'Category.ts'), 'export class Category {}');
      writeFileSync(
        join(dataDir, 'Transaction.ts'),
        'export class Transaction {}'
      );

      expect((await compile()).success).toBe(true);
      expect(compiledEntities()).toEqual([
        'Asset.js',
        'Category.js',
        'Transaction.js',
      ]);
    }, 30_000);

    it('re-emits with inherited root config and external build info', async () => {
      const rayfinDir = join(testProjectDir, 'rayfin');
      const configDir = join(testProjectDir, 'config');
      mkdirSync(configDir, { recursive: true });

      writeFileSync(
        join(configDir, 'base.json'),
        JSON.stringify({
          compilerOptions: {
            outDir: '../rayfin/.temp/compiled',
            rootDir: '../rayfin',
            declaration: true,
            composite: true,
            tsBuildInfoFile: '../build-cache/root.tsbuildinfo',
          },
        })
      );
      writeFileSync(
        join(testProjectDir, 'tsconfig.json'),
        JSON.stringify({
          extends: './config/base.json',
          include: ['rayfin/**/*.ts'],
        })
      );
      writeFileSync(
        join(rayfinDir, 'data', 'Example.ts'),
        'export class Example {}\n'
      );

      const compiledPath = join(
        rayfinDir,
        '.temp',
        'compiled',
        'data',
        'Example.js'
      );
      const buildInfoPath = join(
        testProjectDir,
        'build-cache',
        'root.tsbuildinfo'
      );

      const first = await compileRayfinDirectory(testProjectDir);
      expect(first.success).toBe(true);
      expect(existsSync(compiledPath)).toBe(true);
      expect(existsSync(buildInfoPath)).toBe(true);

      const second = await compileRayfinDirectory(testProjectDir);
      expect(second.success).toBe(true);
      expect(existsSync(compiledPath)).toBe(true);
    }, 60_000);

    it('should return errors for invalid TypeScript', async () => {
      const rayfinDir = join(testProjectDir, 'rayfin');

      // Create tsconfig.json in rayfin directory
      const tsconfigPath = join(rayfinDir, 'tsconfig.json');
      const tsconfig = {
        compilerOptions: {
          outDir: '.temp/compiled',
          rootDir: '.',
          declaration: true,
          composite: true,
        },
        include: ['**/*.ts'],
      };
      writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));

      // Create invalid TypeScript file
      const invalidTs = `
export class Example {
  name: string // Missing semicolon and assignment
  invalidSyntax{{ // Invalid syntax
}
`;
      writeFileSync(join(rayfinDir, 'data', 'Example.ts'), invalidTs);

      const result = await compileRayfinDirectory(testProjectDir);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.join('')).toContain('Example.ts');
    });

    it('routes verbose success diagnostics through the supplied writer', async () => {
      const rayfinDir = join(testProjectDir, 'rayfin');
      writeFileSync(
        join(rayfinDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { outDir: '.temp/compiled', rootDir: '.' },
          include: ['**/*.ts'],
        })
      );
      writeFileSync(join(rayfinDir, 'data', 'valid.ts'), 'export const x = 1;');
      const writeDiagnostic = vi.fn();

      const result = await compileRayfinDirectory(
        testProjectDir,
        { verbose: true, writeDiagnostic },
        'silent'
      );

      expect(result.success).toBe(true);
      expect(writeDiagnostic).toHaveBeenCalledWith(
        expect.stringContaining('Compiled output')
      );
    });

    it('routes compiler failures through the supplied writer', async () => {
      const rayfinDir = join(testProjectDir, 'rayfin');
      writeFileSync(
        join(rayfinDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { outDir: '.temp/compiled', rootDir: '.' },
          include: ['**/*.ts'],
        })
      );
      writeFileSync(join(rayfinDir, 'data', 'invalid.ts'), 'export const =;');
      const writeDiagnostic = vi.fn();

      const result = await compileRayfinDirectory(
        testProjectDir,
        { writeDiagnostic },
        'silent'
      );

      expect(result.success).toBe(false);
      expect(writeDiagnostic.mock.calls.flat().join('')).toContain(
        'TypeScript Errors'
      );
    });

    it('should not throw error if tsconfig.json is missing', async () => {
      const rayfinDir = join(testProjectDir, 'rayfin');
      const tsconfigPath = join(rayfinDir, 'tsconfig.json');

      expect(existsSync(tsconfigPath)).toBe(false);

      // Create a simple TypeScript file
      const simpleTs = `export const test = 'hello';`;
      writeFileSync(join(rayfinDir, 'data', 'test.ts'), simpleTs);

      const result = await compileRayfinDirectory(testProjectDir);

      expect(result.success).toBe(false);
      expect(result.errors[0]).toBe(
        'Unexpected error during compilation: tsconfig.json not found'
      );
    });
  });

  describe('runTscCommand', () => {
    it('should execute tsc and return success for valid code', async () => {
      const rayfinDir = join(testProjectDir, 'rayfin');

      // Create tsconfig.json
      const tsconfigPath = join(rayfinDir, 'tsconfig.json');
      const tsconfig = {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          outDir: '.temp/compiled',
          rootDir: '.',
          declaration: true,
          composite: true,
        },
        include: ['**/*.ts'],
      };
      writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));

      // Create valid TypeScript
      const validTs = `export const greeting = 'Hello, world!';`;
      writeFileSync(join(rayfinDir, 'data', 'greeting.ts'), validTs);

      const result = await runTscCommand(testProjectDir);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    }, 30_000);

    it('should return errors for invalid code', async () => {
      const rayfinDir = join(testProjectDir, 'rayfin');

      // Create tsconfig.json
      const tsconfigPath = join(rayfinDir, 'tsconfig.json');
      const tsconfig = {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          outDir: '.temp/compiled',
          rootDir: '.',
          declaration: true,
          composite: true,
        },
        include: ['**/*.ts'],
      };
      writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));

      // Create invalid TypeScript
      const invalidTs = `const x: number = "not a number";`;
      writeFileSync(join(rayfinDir, 'data', 'invalid.ts'), invalidTs);

      const result = await runTscCommand(testProjectDir);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('paths with spaces', () => {
    let spacedProjectDir: string;

    beforeEach(() => {
      // Create a temp directory with spaces in the path to verify that
      // spawn calls handle unquoted path arguments correctly (no shell: true).
      spacedProjectDir = join(tmpdir(), `rayfin test spaces ${Date.now()}`);
      mkdirSync(join(spacedProjectDir, 'rayfin', 'data'), { recursive: true });
    });

    afterEach(() => {
      try {
        rmSync(spacedProjectDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should compile valid TypeScript in a directory with spaces', async () => {
      const rayfinDir = join(spacedProjectDir, 'rayfin');

      const tsconfig = {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          outDir: '.temp/compiled',
          rootDir: '.',
          declaration: true,
          composite: true,
        },
        include: ['**/*.ts'],
      };
      writeFileSync(
        join(rayfinDir, 'tsconfig.json'),
        JSON.stringify(tsconfig, null, 2)
      );

      const validTs = `export const greeting = 'Hello from a spaced path!';`;
      writeFileSync(join(rayfinDir, 'data', 'greeting.ts'), validTs);

      const result = await runTscCommand(spacedProjectDir);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);

      const compiledPath = join(
        rayfinDir,
        '.temp',
        'compiled',
        'data',
        'greeting.js'
      );
      expect(existsSync(compiledPath)).toBe(true);
    });

    it('should return errors for invalid TypeScript in a directory with spaces', async () => {
      const rayfinDir = join(spacedProjectDir, 'rayfin');

      const tsconfig = {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          outDir: '.temp/compiled',
          rootDir: '.',
          declaration: true,
          composite: true,
        },
        include: ['**/*.ts'],
      };
      writeFileSync(
        join(rayfinDir, 'tsconfig.json'),
        JSON.stringify(tsconfig, null, 2)
      );

      const invalidTs = `const x: number = "not a number";`;
      writeFileSync(join(rayfinDir, 'data', 'invalid.ts'), invalidTs);

      const result = await runTscCommand(spacedProjectDir);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should compile a full rayfin directory with spaces in the path', async () => {
      const rayfinDir = join(spacedProjectDir, 'rayfin');

      const tsconfig = {
        compilerOptions: {
          outDir: '.temp/compiled',
          rootDir: '.',
          declaration: true,
          composite: true,
        },
        include: ['**/*.ts'],
      };
      writeFileSync(
        join(rayfinDir, 'tsconfig.json'),
        JSON.stringify(tsconfig, null, 2)
      );

      const validTs = `
export class SpacedPathEntity {
  id: number;
  constructor(id: number) {
    this.id = id;
  }
}
`;
      writeFileSync(join(rayfinDir, 'data', 'SpacedPathEntity.ts'), validTs);

      const result = await compileRayfinDirectory(spacedProjectDir);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);

      const compiledPath = join(
        rayfinDir,
        '.temp',
        'compiled',
        'data',
        'SpacedPathEntity.js'
      );
      expect(existsSync(compiledPath)).toBe(true);
    });
  });
});
