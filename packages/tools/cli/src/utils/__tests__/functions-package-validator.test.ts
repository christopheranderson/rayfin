import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  formatViolation,
  validateFunctionsForDeploy,
  type ValidationViolation,
} from '../functions-package-validator';

describe('functions-package-validator', () => {
  let functionsDir: string;

  beforeEach(() => {
    functionsDir = join(
      tmpdir(),
      `rayfin-validator-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    );
    mkdirSync(functionsDir, { recursive: true });
    mkdirSync(join(functionsDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(functionsDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  function writePackageJson(pkg: Record<string, unknown>): void {
    writeFileSync(
      join(functionsDir, 'package.json'),
      JSON.stringify(pkg, null, 2),
      'utf8'
    );
  }

  function scaffoldHappyPath(): void {
    writePackageJson({
      name: 'sample',
      version: '1.0.0',
      dependencies: { lodash: '^4.17.21' },
    });
    writeFileSync(join(functionsDir, 'host.json'), '{}', 'utf8');
    writeFileSync(
      join(functionsDir, 'src', 'function_app.ts'),
      'export {};',
      'utf8'
    );
  }

  function violationsByKind(
    violations: ValidationViolation[]
  ): Record<string, ValidationViolation[]> {
    const grouped: Record<string, ValidationViolation[]> = {};
    for (const v of violations) {
      (grouped[v.kind] ??= []).push(v);
    }
    return grouped;
  }

  describe('happy path', () => {
    it('returns valid=true when all required files are present and deps are clean', () => {
      scaffoldHappyPath();

      const result = validateFunctionsForDeploy(functionsDir);

      expect(result.valid).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it('accepts file:./<tarball>.tgz when the tarball is present in the folder', () => {
      writeFileSync(
        join(functionsDir, 'fabric-0.1.0.tgz'),
        'fake-tarball-bytes',
        'utf8'
      );
      writePackageJson({
        name: 'sample',
        version: '1.0.0',
        dependencies: {
          '@microsoft/fabric-user-data-functions': 'file:./fabric-0.1.0.tgz',
        },
      });
      writeFileSync(join(functionsDir, 'host.json'), '{}', 'utf8');
      writeFileSync(
        join(functionsDir, 'src', 'function_app.ts'),
        'export {};',
        'utf8'
      );

      const result = validateFunctionsForDeploy(functionsDir);

      expect(result.valid).toBe(true);
    });

    it('accepts file:./<subdir> when the directory exists in the folder', () => {
      mkdirSync(join(functionsDir, 'vendor', 'lib'), { recursive: true });
      writeFileSync(
        join(functionsDir, 'vendor', 'lib', 'package.json'),
        '{"name":"lib","version":"1.0.0"}',
        'utf8'
      );
      writePackageJson({
        name: 'sample',
        version: '1.0.0',
        dependencies: { lib: 'file:./vendor/lib' },
      });
      writeFileSync(join(functionsDir, 'host.json'), '{}', 'utf8');
      writeFileSync(
        join(functionsDir, 'src', 'function_app.ts'),
        'export {};',
        'utf8'
      );

      const result = validateFunctionsForDeploy(functionsDir);

      expect(result.valid).toBe(true);
    });
  });

  describe('structural violations', () => {
    it('reports missing package.json', () => {
      // Only host.json + function_app.ts written, no package.json.
      writeFileSync(join(functionsDir, 'host.json'), '{}', 'utf8');
      writeFileSync(
        join(functionsDir, 'src', 'function_app.ts'),
        'export {};',
        'utf8'
      );

      const result = validateFunctionsForDeploy(functionsDir);

      expect(result.valid).toBe(false);
      const grouped = violationsByKind(result.violations);
      expect(grouped['missing-file']).toBeDefined();
      expect(
        grouped['missing-file'].some((v) => v.message.includes('package.json'))
      ).toBe(true);
    });

    it('reports missing host.json', () => {
      writePackageJson({ name: 'sample', version: '1.0.0' });
      writeFileSync(
        join(functionsDir, 'src', 'function_app.ts'),
        'export {};',
        'utf8'
      );

      const result = validateFunctionsForDeploy(functionsDir);

      expect(result.valid).toBe(false);
      expect(
        result.violations.some(
          (v) => v.kind === 'missing-file' && v.message.includes('host.json')
        )
      ).toBe(true);
    });

    it('reports missing src/function_app.ts', () => {
      writePackageJson({ name: 'sample', version: '1.0.0' });
      writeFileSync(join(functionsDir, 'host.json'), '{}', 'utf8');
      // No function_app.ts written.

      const result = validateFunctionsForDeploy(functionsDir);

      expect(result.valid).toBe(false);
      expect(
        result.violations.some(
          (v) =>
            v.kind === 'missing-file' && v.message.includes('function_app.ts')
        )
      ).toBe(true);
    });

    it('aggregates all missing-file violations rather than failing on the first', () => {
      // Empty folder — all three required files missing.
      const result = validateFunctionsForDeploy(functionsDir);

      const missing = result.violations.filter(
        (v) => v.kind === 'missing-file'
      );
      expect(missing.length).toBe(3);
    });

    it('reports invalid JSON in package.json', () => {
      writeFileSync(join(functionsDir, 'package.json'), '{ not json', 'utf8');
      writeFileSync(join(functionsDir, 'host.json'), '{}', 'utf8');
      writeFileSync(
        join(functionsDir, 'src', 'function_app.ts'),
        'export {};',
        'utf8'
      );

      const result = validateFunctionsForDeploy(functionsDir);

      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.kind === 'invalid-json')).toBe(
        true
      );
    });
  });

  describe('dependency portability violations', () => {
    it('rejects file:<absolute-path> dependencies', () => {
      writePackageJson({
        name: 'sample',
        version: '1.0.0',
        dependencies: {
          'private-pkg': 'file:C:/Users/me/work/private-pkg',
        },
      });
      writeFileSync(join(functionsDir, 'host.json'), '{}', 'utf8');
      writeFileSync(
        join(functionsDir, 'src', 'function_app.ts'),
        'export {};',
        'utf8'
      );

      const result = validateFunctionsForDeploy(functionsDir);

      expect(result.valid).toBe(false);
      const external = result.violations.filter(
        (v) => v.kind === 'external-file-dep'
      );
      expect(external).toHaveLength(1);
      expect(external[0].context?.name).toBe('private-pkg');
      expect(external[0].suggestion).toMatch(/npm pack/);
    });

    it('rejects file:../<rel-path> dependencies that traverse outside the folder', () => {
      writePackageJson({
        name: 'sample',
        version: '1.0.0',
        dependencies: {
          shared: 'file:../../shared',
        },
      });
      writeFileSync(join(functionsDir, 'host.json'), '{}', 'utf8');
      writeFileSync(
        join(functionsDir, 'src', 'function_app.ts'),
        'export {};',
        'utf8'
      );

      const result = validateFunctionsForDeploy(functionsDir);

      expect(result.valid).toBe(false);
      const external = result.violations.filter(
        (v) => v.kind === 'external-file-dep'
      );
      expect(external).toHaveLength(1);
      expect(external[0].context?.name).toBe('shared');
    });

    it('rejects file:./<missing>.tgz when the tarball does not exist on disk', () => {
      writePackageJson({
        name: 'sample',
        version: '1.0.0',
        dependencies: {
          ghost: 'file:./does-not-exist.tgz',
        },
      });
      writeFileSync(join(functionsDir, 'host.json'), '{}', 'utf8');
      writeFileSync(
        join(functionsDir, 'src', 'function_app.ts'),
        'export {};',
        'utf8'
      );

      const result = validateFunctionsForDeploy(functionsDir);

      expect(result.valid).toBe(false);
      expect(
        result.violations.some(
          (v) =>
            v.kind === 'missing-file-dep-target' && v.context?.name === 'ghost'
        )
      ).toBe(true);
    });

    it('reports violations across all four dependency sections', () => {
      writePackageJson({
        name: 'sample',
        version: '1.0.0',
        dependencies: { a: 'file:C:/abs/a' },
        devDependencies: { b: 'file:/abs/b' },
        peerDependencies: { c: 'file:../c' },
        optionalDependencies: { d: 'file:C:/abs/d' },
      });
      writeFileSync(join(functionsDir, 'host.json'), '{}', 'utf8');
      writeFileSync(
        join(functionsDir, 'src', 'function_app.ts'),
        'export {};',
        'utf8'
      );

      const result = validateFunctionsForDeploy(functionsDir);

      expect(result.valid).toBe(false);
      const sections = result.violations
        .filter((v) => v.kind === 'external-file-dep')
        .map((v) => v.context?.section);
      expect(sections).toContain('dependencies');
      expect(sections).toContain('devDependencies');
      expect(sections).toContain('peerDependencies');
      expect(sections).toContain('optionalDependencies');
    });

    it('produces a tailored suggestion for tarball paths', () => {
      writePackageJson({
        name: 'sample',
        version: '1.0.0',
        dependencies: {
          'pkg-a': 'file:C:/path/to/pkg-a-1.2.3.tgz',
        },
      });
      writeFileSync(join(functionsDir, 'host.json'), '{}', 'utf8');
      writeFileSync(
        join(functionsDir, 'src', 'function_app.ts'),
        'export {};',
        'utf8'
      );

      const result = validateFunctionsForDeploy(functionsDir);

      const violation = result.violations.find(
        (v) => v.kind === 'external-file-dep'
      );
      expect(violation).toBeDefined();
      expect(violation!.suggestion).toMatch(/file:\.\/pkg-a-1\.2\.3\.tgz/);
      expect(violation!.suggestion).not.toMatch(/npm pack/);
    });

    it('ignores non-file: dependency specs', () => {
      writePackageJson({
        name: 'sample',
        version: '1.0.0',
        dependencies: {
          lodash: '^4.17.21',
          react: '18.3.1',
          'some-git': 'git+https://github.com/owner/repo.git',
        },
      });
      writeFileSync(join(functionsDir, 'host.json'), '{}', 'utf8');
      writeFileSync(
        join(functionsDir, 'src', 'function_app.ts'),
        'export {};',
        'utf8'
      );

      const result = validateFunctionsForDeploy(functionsDir);

      expect(result.valid).toBe(true);
    });
  });

  describe('worker compatibility', () => {
    function installWorker(dist?: string): void {
      const packageRoot = join(
        functionsDir,
        'node_modules',
        '@microsoft',
        'fabric-user-data-functions'
      );
      mkdirSync(join(packageRoot, 'dist'), { recursive: true });
      writeFileSync(
        join(packageRoot, 'package.json'),
        JSON.stringify({
          name: '@microsoft/fabric-user-data-functions',
          version: '1.36.0-alpha.1756',
          main: 'dist/index.js',
        }),
        'utf8'
      );
      if (dist !== undefined) {
        writeFileSync(
          join(packageRoot, 'dist', 'runtimeMetadata.js'),
          dist,
          'utf8'
        );
      }
    }

    it('blocks the deploy when the installed worker cannot read the schema', () => {
      // Without this the deploy succeeds and the app never starts, which is
      // the exact failure the bundler change was meant to eliminate.
      scaffoldHappyPath();
      installWorker("export const RUNTIME_METADATA_SCHEMA_VERSION = '1.0';\n");

      const result = validateFunctionsForDeploy(functionsDir, {
        runtimeMetadataSchemaVersion: '2.0',
      });

      expect(result.valid).toBe(false);
      const [violation] = violationsByKind(result.violations)[
        'incompatible-worker'
      ];
      expect(violation.message).toContain('1.36.0-alpha.1756');
      expect(violation.suggestion).toContain('npm install');
      expect(violation.context).toMatchObject({
        workerSchemaVersion: '1.0',
        cliSchemaVersion: '2.0',
      });
    });

    it('allows the deploy when the worker reads the schema', () => {
      scaffoldHappyPath();
      installWorker(
        "export const RUNTIME_METADATA_SCHEMA_VERSION = '2.0';\n" +
          "export const MINIMUM_RUNTIME_METADATA_SCHEMA_VERSION = '2.0';\n"
      );

      const result = validateFunctionsForDeploy(functionsDir, {
        runtimeMetadataSchemaVersion: '2.0',
      });

      expect(result.valid).toBe(true);
    });

    it('skips the check when no schema version is supplied', () => {
      // Callers that are not writing metadata have nothing to be compatible
      // with, so an old worker is not their problem.
      scaffoldHappyPath();
      installWorker("export const RUNTIME_METADATA_SCHEMA_VERSION = '1.0';\n");

      expect(validateFunctionsForDeploy(functionsDir).valid).toBe(true);
    });

    it('does not block when the worker is not installed', () => {
      scaffoldHappyPath();

      const result = validateFunctionsForDeploy(functionsDir, {
        runtimeMetadataSchemaVersion: '2.0',
      });

      expect(result.valid).toBe(true);
    });
  });

  describe('formatViolation', () => {
    it('renders message and suggestion in a multi-line block', () => {
      const violation: ValidationViolation = {
        kind: 'missing-file',
        message: 'Required file missing: host.json',
        suggestion: 'Run rayfin functions init',
      };

      const rendered = formatViolation(violation);

      expect(rendered).toContain('host.json');
      expect(rendered).toContain('Run rayfin functions init');
      expect(rendered.split('\n').length).toBeGreaterThanOrEqual(2);
    });
  });
});
