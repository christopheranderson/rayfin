import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  generateFunctionsMetadataFiles,
  type FabricItemBindingModel,
} from '../functions-metadata-generator';

/**
 * Producer half of the CLI-to-worker metadata contract.
 *
 * The worker reads connection audiences from `functions[].contextAudiences`,
 * falling back to parsing `delegateParameters[].type` for metadata that
 * predates that field — so both are a real interface, not incidental strings.
 * A type alias in the annotation used to resolve to a `Sql` deploy binding
 * while the worker saw only `SqlAccess` and registered nothing — the deployed
 * function had a connection its handler could not read.
 *
 * These goldens live next to the worker's own test that consumes them
 * (`packages/udf/udf-worker-extension/src/__tests__/fixtures`). Regenerating one
 * side without the other fails the other side's test.
 */
function findRepoRoot(): string {
  let current = __dirname;
  while (!existsSync(join(current, 'rush.json'))) {
    const parent = dirname(current);
    if (parent === current) {
      throw new Error('Could not find rush.json');
    }
    current = parent;
  }
  return current;
}

const FIXTURE_DIR = join(
  findRepoRoot(),
  'packages',
  'udf',
  'udf-worker-extension',
  'src',
  '__tests__',
  'fixtures'
);

function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

describe('runtime metadata parity with the worker', () => {
  let functionsDir: string;

  beforeEach(() => {
    functionsDir = join(
      tmpdir(),
      `rayfin-parity-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    );
    mkdirSync(join(functionsDir, 'src'), { recursive: true });
    writeFileSync(
      join(functionsDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'Node16',
          moduleResolution: 'Node16',
          strict: true,
          esModuleInterop: true,
          outDir: 'dist',
          declaration: true,
          skipLibCheck: true,
        },
        include: ['src/**/*.ts'],
      }),
      'utf8'
    );
    writeFileSync(
      join(functionsDir, 'package.json'),
      JSON.stringify({ name: 'parity-fixture', version: '1.0.0' }),
      'utf8'
    );
    writeFileSync(
      join(functionsDir, 'src', 'function_app.ts'),
      readFixture('parity-function-app.ts.txt'),
      'utf8'
    );
  });

  afterEach(() => {
    try {
      rmSync(functionsDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('emits exactly the runtime metadata the worker test consumes', async () => {
    const artifacts = await generateFunctionsMetadataFiles(functionsDir);

    expect(artifacts.runtimeMetadata).toEqual(
      JSON.parse(readFixture('parity-runtimemetadata.json'))
    );
  });

  it('emits exactly the deploy bindings the worker test asserts against', async () => {
    const artifacts = await generateFunctionsMetadataFiles(functionsDir);

    const audiences: Record<string, string[]> = {};
    const aliases: Record<string, string[]> = {};
    for (const fn of artifacts.deployMetadata.functionsMetadata) {
      audiences[fn.name] = fn.bindings
        .map((binding) => (binding as FabricItemBindingModel).audienceType)
        .filter((audience): audience is string => Boolean(audience));
      aliases[fn.name] = fn.bindings
        .map((binding) => (binding as FabricItemBindingModel).alias)
        .filter((alias): alias is string => Boolean(alias));
    }

    expect({ audiences, aliases }).toEqual(
      JSON.parse(readFixture('parity-deploy-bindings.json'))
    );
  });

  it('rewrites an aliased audience into its resolved literal', async () => {
    const artifacts = await generateFunctionsMetadataFiles(functionsDir);

    const aliased = artifacts.runtimeMetadata.functions.find(
      (fn) => fn.functionName === 'aliasedAudience'
    );

    // Written `RayfinContext<DataModel, SqlAccess>`. Left as-is, the worker
    // reads `SqlAccess`, fails to match it against AudienceType, and binds
    // nothing — while the deploy metadata declares a Sql connection.
    expect(aliased?.delegateParameters[0].type).toBe(
      'RayfinContext<DataModel, AudienceType.Sql>'
    );
  });

  it('collapses an alias that resolves to no audiences', async () => {
    const artifacts = await generateFunctionsMetadataFiles(functionsDir);

    const neverAlias = artifacts.runtimeMetadata.functions.find(
      (fn) => fn.functionName === 'aliasedNever'
    );

    expect(neverAlias?.delegateParameters[0].type).toBe(
      'RayfinContext<DataModel, never>'
    );
  });

  it('preserves the schema and secret-name type arguments', async () => {
    const artifacts = await generateFunctionsMetadataFiles(functionsDir);

    const narrowed = artifacts.runtimeMetadata.functions.find(
      (fn) => fn.functionName === 'narrowedSecrets'
    );

    expect(narrowed?.delegateParameters[0].type).toBe(
      "RayfinContext<DataModel, AudienceType.Sql, 'STRIPE_KEY'>"
    );
  });

  it('leaves an annotation that declares no audiences untouched', async () => {
    const artifacts = await generateFunctionsMetadataFiles(functionsDir);

    const plain = artifacts.runtimeMetadata.functions.find(
      (fn) => fn.functionName === 'noAudiences'
    );

    expect(plain?.delegateParameters[0].type).toBe('RayfinContext<DataModel>');
  });

  it('warns that syntactically-read audiences could not be verified', async () => {
    rmSync(join(functionsDir, 'tsconfig.json'));
    const diagnostics: string[] = [];

    await generateFunctionsMetadataFiles(functionsDir, {
      onDiagnostic: (diagnostic) => {
        if (diagnostic.code === 'unverified-context-audience') {
          diagnostics.push(diagnostic.functionName);
        }
      },
    });

    // Without a program there is no checker, so `SqlAccess` cannot be resolved
    // and the emitted binding may name a type alias rather than an audience.
    expect(diagnostics).toContain('aliasedAudience');
    // Functions whose annotations declare nothing are not reported.
    expect(diagnostics).not.toContain('noAudiences');
    expect(diagnostics).not.toContain('businessOnly');
  });
});
