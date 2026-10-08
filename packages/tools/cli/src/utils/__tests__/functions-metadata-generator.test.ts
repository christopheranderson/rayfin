import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  analyzeFunctionsProject,
  generateAndWriteMetadata,
  generateFunctionsMetadata,
  generateFunctionsMetadataFiles,
  toRuntimeMetadata,
  type FabricItemBindingModel,
  type FunctionsMetadataDiagnostic,
} from '../functions-metadata-generator';

/**
 * Scaffold a minimal functions project in a temp directory.
 */
function scaffold(dir: string, source: string): void {
  const srcDir = join(dir, 'src');
  mkdirSync(srcDir, { recursive: true });

  writeFileSync(
    join(dir, 'tsconfig.json'),
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
    join(dir, 'package.json'),
    JSON.stringify({ name: 'test-functions', version: '1.0.0' }),
    'utf8'
  );

  writeFileSync(join(srcDir, 'function_app.ts'), source, 'utf8');
}

describe('functions-metadata-generator', () => {
  let functionsDir: string;

  beforeEach(() => {
    functionsDir = join(
      tmpdir(),
      `rayfin-metagen-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    );
    mkdirSync(functionsDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(functionsDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('extracts a basic function with no connections', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions { func(name: string, handler: any, deps?: any[]): void {} }
      const udf = new UserDataFunctions();

      udf.func('hello', async (name: string): Promise<string> => {
        return 'hi ' + name;
      });
      `
    );

    const result = await generateFunctionsMetadata(functionsDir);
    expect(result.functionsMetadata).toHaveLength(1);

    const fn = result.functionsMetadata[0];
    expect(fn.name).toBe('hello');
    // Only HTTP trigger + output bindings
    expect(fn.bindings).toHaveLength(2);
    expect(fn.bindings[0].type).toBe('httpTrigger');
    expect(fn.bindings[1].type).toBe('http');
  });

  it('excludes src-prefixed sibling directories from both metadata artifacts', async () => {
    const registration = (name: string) => `
      export {};
      class UserDataFunctions { func(name: string, handler: any): void {} }
      const udf = new UserDataFunctions();
      udf.func('${name}', async (): Promise<string> => 'ok');
    `;
    scaffold(functionsDir, registration('inside'));
    for (const sibling of ['src-gen', 'srcfoo']) {
      mkdirSync(join(functionsDir, sibling));
      writeFileSync(
        join(functionsDir, sibling, 'handler.ts'),
        registration(sibling),
        'utf8'
      );
    }
    writeFileSync(
      join(functionsDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'Node16' },
        include: ['src/**/*.ts', 'src-gen/**/*.ts', 'srcfoo/**/*.ts'],
      }),
      'utf8'
    );

    const artifacts = await generateFunctionsMetadataFiles(functionsDir);
    expect(
      artifacts.deployMetadata.functionsMetadata.map((fn) => fn.name)
    ).toEqual(['inside']);
    expect(
      artifacts.runtimeMetadata.functions.map((fn) => fn.functionName)
    ).toEqual(['inside']);
  });

  it('captures deploy and runtime parameter semantics in one analysis', async () => {
    const functionCode = `udf.func(
  'analyze',
  async (
    { id }: { id: string },
    value,
    lakehouseConnection: FabricSqlConnection,
    fabricValue: string,
    count = 2,
    label?: string
  ): Promise<string> => id,
  []
)`;
    scaffold(
      functionsDir,
      `
class UserDataFunctions { func(name: string, handler: any, deps?: any[]): void {} }
interface FabricSqlConnection {}
const udf = new UserDataFunctions();
${functionCode};
`
    );

    const analysis = await analyzeFunctionsProject(functionsDir);

    expect(analysis).toEqual({
      functions: [
        {
          functionName: 'analyze',
          scriptFile: join('src', 'function_app.ts'),
          sourceText: functionCode,
          returnTypeText: 'Promise<string>',
          parameters: [
            {
              sourceName: '{ id }',
              deployName: 'arg0',
              typeText: '{ id: string }',
              optional: false,
              hasDefault: false,
              defaultValue: undefined,
              position: 0,
              isFabricParameter: false,
              fabricParameterType: undefined,
            },
            {
              sourceName: 'value',
              deployName: 'value',
              typeText: undefined,
              optional: false,
              hasDefault: false,
              defaultValue: undefined,
              position: 1,
              isFabricParameter: false,
              fabricParameterType: undefined,
            },
            {
              sourceName: 'lakehouseConnection',
              deployName: 'lakehouseConnection',
              typeText: 'FabricSqlConnection',
              optional: false,
              hasDefault: false,
              defaultValue: undefined,
              position: 2,
              isFabricParameter: true,
              fabricParameterType: 'FabricSqlConnection',
            },
            {
              sourceName: 'fabricValue',
              deployName: 'fabricValue',
              typeText: 'string',
              optional: false,
              hasDefault: false,
              defaultValue: undefined,
              position: 3,
              isFabricParameter: true,
              fabricParameterType: 'string',
            },
            {
              sourceName: 'count',
              deployName: 'count',
              typeText: undefined,
              optional: false,
              hasDefault: true,
              defaultValue: '2',
              position: 4,
              isFabricParameter: false,
              fabricParameterType: undefined,
            },
            {
              sourceName: 'label',
              deployName: 'label',
              typeText: 'string',
              optional: true,
              hasDefault: false,
              defaultValue: undefined,
              position: 5,
              isFabricParameter: false,
              fabricParameterType: undefined,
            },
          ],
          connectionBindings: [],
          contextAudiences: [],
        },
      ],
    });

    expect(toRuntimeMetadata(analysis)).toEqual({
      schemaVersion: '2.0',
      functions: [
        {
          functionName: 'analyze',
          delegateParameters: [
            {
              name: '{ id }',
              type: '{ id: string }',
              optional: false,
              hasDefault: false,
              position: 0,
              isFabricParameter: false,
            },
            {
              name: 'value',
              optional: false,
              hasDefault: false,
              position: 1,
              isFabricParameter: false,
            },
            {
              name: 'lakehouseConnection',
              type: 'FabricSqlConnection',
              optional: false,
              hasDefault: false,
              position: 2,
              isFabricParameter: true,
              fabricParameterType: 'FabricSqlConnection',
            },
            {
              name: 'fabricValue',
              type: 'string',
              optional: false,
              hasDefault: false,
              position: 3,
              isFabricParameter: true,
              fabricParameterType: 'string',
            },
            {
              name: 'count',
              optional: false,
              hasDefault: true,
              position: 4,
              isFabricParameter: false,
            },
            {
              name: 'label',
              type: 'string',
              optional: true,
              hasDefault: false,
              position: 5,
              isFabricParameter: false,
            },
          ],
          contextAudiences: [],
        },
      ],
    });
  });

  it('generates both artifacts from one diagnostic pass', async () => {
    scaffold(
      functionsDir,
      `
class UserDataFunctions {
  func(name: string, handler: any, deps?: any[]): void {}
  connection(opts: any) { return opts; }
}
const udf = new UserDataFunctions();
const audience = getAudience();

udf.func('both', async (ctx: any): Promise<string> => 'ok', [
  udf.connection({ audienceType: audience }),
]);
`
    );
    const diagnostics: FunctionsMetadataDiagnostic[] = [];

    const artifacts = await generateFunctionsMetadataFiles(functionsDir, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'unresolved-connection-property',
        functionName: 'both',
      }),
    ]);
    expect(artifacts.deployMetadata.functionsMetadata).toHaveLength(1);
    expect(artifacts.deployMetadata.functionsMetadata[0].bindings).toHaveLength(
      2
    );
    expect(artifacts.runtimeMetadata).toEqual({
      schemaVersion: '2.0',
      functions: [
        {
          functionName: 'both',
          delegateParameters: [
            {
              name: 'ctx',
              type: 'any',
              optional: false,
              hasDefault: false,
              position: 0,
              isFabricParameter: false,
            },
          ],
          contextAudiences: [],
        },
      ],
    });
    expect(artifacts.deployMetadataJson).toBe(
      JSON.stringify(artifacts.deployMetadata, null, 2)
    );
    expect(artifacts.runtimeMetadataJson).toBe(
      JSON.stringify(artifacts.runtimeMetadata, null, 2)
    );
  });

  it('derives generic connection bindings from the context annotation', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions { func(name: string, handler: any, deps?: any[]): void {} }
      const udf = new UserDataFunctions();
      enum AudienceType { Fabric = "Fabric", ADO = "ADO", Sql = "Sql" }
      class RayfinContext<TSchema = any, TokenTypes extends AudienceType = never> {
        getToken(a: TokenTypes): string { return String(a); }
      }
      type DataModel = { Todo: { id: string } };

      udf.func('myFunc', async (ctx: RayfinContext<DataModel, AudienceType.Sql | AudienceType.ADO>): Promise<string> => {
        return ctx.getToken(AudienceType.Sql);
      }, []);
      `
    );

    const artifacts = await generateFunctionsMetadataFiles(functionsDir);
    const fn = artifacts.deployMetadata.functionsMetadata[0];

    // HTTP trigger + output + one FabricItem binding per annotated audience.
    // Audiences are sorted for deterministic metadata.
    expect(fn.bindings).toHaveLength(4);
    expect(fn.bindings.slice(2)).toEqual([
      {
        name: '__generic_ADO',
        direction: 'in',
        type: 'FabricItem',
        alias: '',
        audienceType: 'ADO',
      },
      {
        name: '__generic_Sql',
        direction: 'in',
        type: 'FabricItem',
        alias: '',
        audienceType: 'Sql',
      },
    ]);

    // The worker reads the resolved audiences straight from contextAudiences,
    // so it never needs the TypeScript compiler at runtime.
    expect(Object.keys(artifacts.runtimeMetadata.functions[0]).sort()).toEqual([
      'contextAudiences',
      'delegateParameters',
      'functionName',
    ]);
    expect(artifacts.runtimeMetadata.functions[0].contextAudiences).toEqual([
      'ADO',
      'Sql',
    ]);
    // The annotation is still normalised on the way out, for workers reading
    // metadata that predates contextAudiences: the audience argument is
    // replaced with the resolved union, sorted to match the binding order. See
    // functions-metadata-parity.test.ts for why that substitution is required.
    expect(
      artifacts.runtimeMetadata.functions[0].delegateParameters[0].type
    ).toBe('RayfinContext<DataModel, AudienceType.ADO | AudienceType.Sql>');
  });

  it('adds no FabricItem bindings when the context declares no audiences', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions { func(name: string, handler: any, deps?: any[]): void {} }
      const udf = new UserDataFunctions();
      enum AudienceType { Sql = "Sql" }
      class RayfinContext<TSchema = any, TokenTypes extends AudienceType = never> {}
      type DataModel = { Todo: { id: string } };

      udf.func('plain', async (ctx: RayfinContext<DataModel>): Promise<string> => 'ok', []);
      `
    );

    const artifacts = await generateFunctionsMetadataFiles(functionsDir);

    expect(Object.keys(artifacts.runtimeMetadata.functions[0]).sort()).toEqual([
      'contextAudiences',
      'delegateParameters',
      'functionName',
    ]);
    // Written even when empty, so the worker can tell "declares none" from
    // "metadata predates the field".
    expect(artifacts.runtimeMetadata.functions[0].contextAudiences).toEqual([]);
    // HTTP trigger + output only
    expect(artifacts.deployMetadata.functionsMetadata[0].bindings).toHaveLength(
      2
    );
  });

  it('unions annotated audiences with the connections array without duplicating', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions {
        func(name: string, handler: any, deps?: any[]): void {}
        connection(opts: any) { return opts; }
      }
      const udf = new UserDataFunctions();
      enum AudienceType { Sql = "Sql", Fabric = "Fabric" }
      class RayfinContext<TSchema = any, TokenTypes extends AudienceType = never> {}
      type DataModel = { Todo: { id: string } };

      udf.func('mixed', async (ctx: RayfinContext<DataModel, AudienceType.Sql>): Promise<string> => 'ok', [
        udf.connection({ audienceType: AudienceType.Sql }),
        udf.connection({ audienceType: AudienceType.Fabric }),
        udf.connection({ alias: 'myLakehouse' }),
      ]);
      `
    );

    const artifacts = await generateFunctionsMetadataFiles(functionsDir);
    const fn = artifacts.deployMetadata.functionsMetadata[0];

    // Sql appears once even though it is declared in both places.
    const audiences = fn.bindings
      .map((b) => (b as FabricItemBindingModel).audienceType)
      .filter((audienceType): audienceType is string => Boolean(audienceType));
    expect(audiences).toEqual(['Sql', 'Fabric']);

    // The alias connection still produces its own binding.
    expect(
      fn.bindings.some(
        (b) => (b as FabricItemBindingModel).alias === 'myLakehouse'
      )
    ).toBe(true);
  });

  it('extracts generic connection bindings from new Connection()', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions { func(name: string, handler: any, deps?: any[]): void {} }
      const udf = new UserDataFunctions();
      enum AudienceType { Fabric = "Fabric", ADO = "ADO" }
      class Connection { constructor(opts: any) {} }

      udf.func('getSecret', async (ctx: any): Promise<string> => {
        return 'secret';
      }, [
        new Connection({ audienceType: AudienceType.Fabric }),
      ]);
      `
    );

    const result = await generateFunctionsMetadata(functionsDir);
    const fn = result.functionsMetadata[0];

    // HTTP trigger + output + 1 FabricItem binding
    expect(fn.bindings).toHaveLength(3);

    const fabricBinding = fn.bindings[2];
    expect(fabricBinding).toEqual({
      name: '__generic_Fabric',
      direction: 'in',
      type: 'FabricItem',
      alias: '',
      audienceType: 'Fabric',
    });
  });

  it('resolves audienceType from a const identifier', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions {
        func(name: string, handler: any, deps?: any[]): void {}
        connection(opts: any) { return opts; }
      }
      const udf = new UserDataFunctions();
      enum AudienceType { AzureAI = "AzureAI" }
      const AZURE_AI_AUDIENCE = AudienceType.AzureAI;

      udf.func('searchWork', async (ctx: any): Promise<string> => 'ok', [
        udf.connection({ audienceType: AZURE_AI_AUDIENCE }),
      ]);
      `
    );

    const result = await generateFunctionsMetadata(functionsDir);
    const binding = result.functionsMetadata[0].bindings.find(
      (candidate) => candidate.type === 'FabricItem'
    );

    expect(binding).toMatchObject({
      name: '__generic_AzureAI',
      audienceType: 'AzureAI',
    });
  });

  it('resolves imported and wrapped const audience identifiers', async () => {
    scaffold(
      functionsDir,
      `
      import { AZURE_AI_AUDIENCE } from './audiences';

      class UserDataFunctions {
        func(name: string, handler: any, deps?: any[]): void {}
        connection(opts: any) { return opts; }
      }
      const udf = new UserDataFunctions();
      const SELECTED_AUDIENCE = (AZURE_AI_AUDIENCE satisfies string);

      udf.func('searchImportedWork', async (ctx: any): Promise<string> => 'ok', [
        udf.connection({ audienceType: SELECTED_AUDIENCE }),
      ]);
      `
    );
    writeFileSync(
      join(functionsDir, 'src', 'audiences.ts'),
      `
      enum AudienceType { AzureAI = "AzureAI" }
      export const AZURE_AI_AUDIENCE = AudienceType.AzureAI as AudienceType;
      `,
      'utf8'
    );

    const result = await generateFunctionsMetadata(functionsDir);
    const binding = result.functionsMetadata[0].bindings.find(
      (candidate) => candidate.type === 'FabricItem'
    );

    expect(binding).toMatchObject({
      name: '__generic_AzureAI',
      audienceType: 'AzureAI',
    });
  });

  it('resolves audience constants through namespace imports', async () => {
    scaffold(
      functionsDir,
      `
      import * as audiences from './audiences';

      class UserDataFunctions {
        func(name: string, handler: any, deps?: any[]): void {}
        connection(opts: any) { return opts; }
      }
      const udf = new UserDataFunctions();

      udf.func('searchNamespacedWork', async (ctx: any): Promise<string> => 'ok', [
        udf.connection({ audienceType: audiences.AZURE_AI_AUDIENCE }),
      ]);
      `
    );
    writeFileSync(
      join(functionsDir, 'src', 'audiences.ts'),
      `
      enum AudienceType { AzureAI = "AzureAI" }
      export const AZURE_AI_AUDIENCE = AudienceType.AzureAI;
      `,
      'utf8'
    );

    const result = await generateFunctionsMetadata(functionsDir);
    const binding = result.functionsMetadata[0].bindings.find(
      (candidate) => candidate.type === 'FabricItem'
    );

    expect(binding).toMatchObject({
      name: '__generic_AzureAI',
      audienceType: 'AzureAI',
    });
  });

  it('resolves a connection stored in a const identifier', async () => {
    scaffold(
      functionsDir,
      `
      import { AZURE_AI_AUDIENCE } from './audiences';

      class UserDataFunctions {
        func(name: string, handler: any, deps?: any[]): void {}
        connection(opts: any) { return opts; }
      }
      const udf = new UserDataFunctions();
      const AZURE_AI_CONNECTION = udf.connection({
        audienceType: AZURE_AI_AUDIENCE,
      });

      udf.func(
        'searchImportedWork',
        async (ctx: any): Promise<string> => 'ok',
        [AZURE_AI_CONNECTION]
      );
      `
    );
    writeFileSync(
      join(functionsDir, 'src', 'audiences.ts'),
      `
      enum AudienceType { AzureAI = "AzureAI" }
      export const AZURE_AI_AUDIENCE = AudienceType.AzureAI;
      `,
      'utf8'
    );

    const result = await generateFunctionsMetadata(functionsDir);
    const binding = result.functionsMetadata[0].bindings.find(
      (candidate) => candidate.type === 'FabricItem'
    );

    expect(binding).toMatchObject({
      name: '__generic_AzureAI',
      audienceType: 'AzureAI',
    });
  });

  it('resolves a connections array stored in a const identifier', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions {
        func(name: string, handler: any, deps?: any[]): void {}
        connection(opts: any) { return opts; }
      }
      const udf = new UserDataFunctions();
      enum AudienceType { AzureAI = "AzureAI" }
      const AZURE_AI_AUDIENCE = AudienceType.AzureAI;
      const CONNECTIONS = [
        udf.connection({ audienceType: AZURE_AI_AUDIENCE }),
      ];

      udf.func(
        'searchWork',
        async (ctx: any): Promise<string> => 'ok',
        CONNECTIONS
      );
      `
    );

    const result = await generateFunctionsMetadata(functionsDir);
    const binding = result.functionsMetadata[0].bindings.find(
      (candidate) => candidate.type === 'FabricItem'
    );

    expect(binding).toMatchObject({
      name: '__generic_AzureAI',
      audienceType: 'AzureAI',
    });
  });

  it('flattens spread connection arrays and resolves const aliases', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions {
        func(name: string, handler: any, deps?: any[]): void {}
        connection(opts: any) { return opts; }
      }
      const udf = new UserDataFunctions();
      enum AudienceType { AzureAI = "AzureAI" }
      const LAKEHOUSE_ALIAS = "myLakehouse";
      const COMMON_CONNECTIONS = [
        udf.connection({ audienceType: AudienceType.AzureAI }),
      ];
      const CONNECTIONS = [
        ...COMMON_CONNECTIONS,
        udf.connection({ alias: LAKEHOUSE_ALIAS, argName: "lake" }),
      ];

      udf.func(
        'searchAndStore',
        async (ctx: any): Promise<string> => 'ok',
        CONNECTIONS
      );
      `
    );

    const result = await generateFunctionsMetadata(functionsDir);
    const bindings = result.functionsMetadata[0].bindings.filter(
      (candidate) => candidate.type === 'FabricItem'
    );

    expect(bindings).toEqual([
      {
        name: '__generic_AzureAI',
        direction: 'in',
        type: 'FabricItem',
        alias: '',
        audienceType: 'AzureAI',
      },
      {
        name: 'lake',
        direction: 'in',
        type: 'FabricItem',
        alias: 'myLakehouse',
      },
    ]);
  });

  it('extracts multiple generic connections', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions { func(name: string, handler: any, deps?: any[]): void {} }
      const udf = new UserDataFunctions();
      enum AudienceType { Fabric = "Fabric", ADO = "ADO" }
      class Connection { constructor(opts: any) {} }

      udf.func('multi', async (ctx: any): Promise<string> => 'ok', [
        new Connection({ audienceType: AudienceType.Fabric }),
        new Connection({ audienceType: AudienceType.ADO }),
      ]);
      `
    );

    const result = await generateFunctionsMetadata(functionsDir);
    const fn = result.functionsMetadata[0];

    expect(fn.bindings).toHaveLength(4); // HTTP(2) + 2 FabricItem
    expect(fn.bindings[2]).toMatchObject({
      name: '__generic_Fabric',
      type: 'FabricItem',
      audienceType: 'Fabric',
    });
    expect(fn.bindings[3]).toMatchObject({
      name: '__generic_ADO',
      type: 'FabricItem',
      audienceType: 'ADO',
    });
  });

  it('deduplicates same audienceType in connections array', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions { func(name: string, handler: any, deps?: any[]): void {} }
      const udf = new UserDataFunctions();
      enum AudienceType { Fabric = "Fabric" }
      class Connection { constructor(opts: any) {} }

      udf.func('dup', async (ctx: any): Promise<string> => 'ok', [
        new Connection({ audienceType: AudienceType.Fabric }),
        new Connection({ audienceType: AudienceType.Fabric }),
      ]);
      `
    );

    const result = await generateFunctionsMetadata(functionsDir);
    const fn = result.functionsMetadata[0];

    // Only 1 FabricItem binding despite 2 declarations
    const fabricBindings = fn.bindings.filter((b) => b.type === 'FabricItem');
    expect(fabricBindings).toHaveLength(1);
  });

  it('extracts alias connection bindings', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions { func(name: string, handler: any, deps?: any[]): void {} }
      const udf = new UserDataFunctions();
      class Connection { constructor(opts: any) {} }

      udf.func('withAlias', async (lake: any): Promise<string> => 'ok', [
        new Connection({ alias: "myLakehouse", argName: "lake" }),
      ]);
      `
    );

    const result = await generateFunctionsMetadata(functionsDir);
    const fn = result.functionsMetadata[0];

    const fabricBinding = fn.bindings.find((b) => b.type === 'FabricItem');
    expect(fabricBinding).toEqual({
      name: 'lake',
      direction: 'in',
      type: 'FabricItem',
      alias: 'myLakehouse',
    });
  });

  it('alias connection defaults argName to alias when omitted', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions { func(name: string, handler: any, deps?: any[]): void {} }
      const udf = new UserDataFunctions();
      class Connection { constructor(opts: any) {} }

      udf.func('defaultArg', async (myLakehouse: any): Promise<string> => 'ok', [
        new Connection({ alias: "myLakehouse" }),
      ]);
      `
    );

    const result = await generateFunctionsMetadata(functionsDir);
    const fn = result.functionsMetadata[0];

    const fabricBinding = fn.bindings.find((b) => b.type === 'FabricItem');
    expect(fabricBinding).toMatchObject({
      name: 'myLakehouse',
      alias: 'myLakehouse',
    });
  });

  it('handles mixed generic and alias connections', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions { func(name: string, handler: any, deps?: any[]): void {} }
      const udf = new UserDataFunctions();
      enum AudienceType { Fabric = "Fabric" }
      class Connection { constructor(opts: any) {} }

      udf.func('mixed', async (ctx: any, lake: any): Promise<string> => 'ok', [
        new Connection({ audienceType: AudienceType.Fabric }),
        new Connection({ alias: "myLakehouse", argName: "lake" }),
      ]);
      `
    );

    const result = await generateFunctionsMetadata(functionsDir);
    const fn = result.functionsMetadata[0];

    const fabricBindings = fn.bindings.filter((b) => b.type === 'FabricItem');
    expect(fabricBindings).toHaveLength(2);
    expect(fabricBindings[0]).toMatchObject({
      audienceType: 'Fabric',
      alias: '',
    });
    expect(fabricBindings[1]).toMatchObject({
      alias: 'myLakehouse',
      name: 'lake',
    });
  });

  it('supports udf.connection() factory syntax', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions {
        func(name: string, handler: any, deps?: any[]): void {}
        connection(opts: any) { return opts; }
      }
      const udf = new UserDataFunctions();
      enum AudienceType { Fabric = "Fabric" }

      udf.func('factory', async (ctx: any): Promise<string> => 'ok', [
        udf.connection({ audienceType: AudienceType.Fabric }),
      ]);
      `
    );

    const result = await generateFunctionsMetadata(functionsDir);
    const fn = result.functionsMetadata[0];

    const fabricBinding = fn.bindings.find((b) => b.type === 'FabricItem');
    expect(fabricBinding).toMatchObject({
      name: '__generic_Fabric',
      type: 'FabricItem',
      audienceType: 'Fabric',
    });
  });

  it('handles audienceType as string literal (no enum)', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions { func(name: string, handler: any, deps?: any[]): void {} }
      const udf = new UserDataFunctions();
      class Connection { constructor(opts: any) {} }

      udf.func('stringAudience', async (ctx: any): Promise<string> => 'ok', [
        new Connection({ audienceType: "Sql" }),
      ]);
      `
    );

    const result = await generateFunctionsMetadata(functionsDir);
    const fn = result.functionsMetadata[0];

    const fabricBinding = fn.bindings.find((b) => b.type === 'FabricItem');
    expect(fabricBinding).toMatchObject({
      name: '__generic_Sql',
      audienceType: 'Sql',
    });
  });

  it('reports an unresolved connection property without changing metadata', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions {
        func(name: string, handler: any, deps?: any[]): void {}
        connection(opts: any) { return opts; }
      }
      const udf = new UserDataFunctions();
      enum AudienceType { AzureAI = "AzureAI" }
      function getAudience(): AudienceType {
        return AudienceType.AzureAI;
      }

      udf.func('dynamicAudience', async (): Promise<string> => 'ok', [
        udf.connection({ audienceType: getAudience() }),
      ]);
      `
    );
    const diagnostics: FunctionsMetadataDiagnostic[] = [];

    const result = await generateFunctionsMetadata(functionsDir, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'unresolved-connection-property',
        severity: 'warning',
        functionName: 'dynamicAudience',
        filePath: expect.stringContaining('function_app.ts'),
        message: expect.stringContaining("option 'audienceType'"),
      }),
    ]);
    expect(Object.keys(result)).toEqual(['runtime', 'functionsMetadata']);
    expect(result.functionsMetadata[0].bindings).toHaveLength(2);
  });

  it('reports a connections argument that is not statically resolvable', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions {
        func(name: string, handler: any, deps?: any[]): void {}
      }
      const udf = new UserDataFunctions();
      function getConnections(): any[] {
        return [];
      }

      udf.func(
        'dynamicConnections',
        async (): Promise<string> => 'ok',
        getConnections()
      );
      `
    );
    const diagnostics: FunctionsMetadataDiagnostic[] = [];

    const result = await generateFunctionsMetadata(functionsDir, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'unresolved-connections-array',
        functionName: 'dynamicConnections',
        message: expect.stringContaining('immutable const array'),
      }),
    ]);
    expect(result.functionsMetadata[0].bindings).toHaveLength(2);
  });

  it('falls back to syntactic parsing when tsconfig is missing', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions {
        func(name: string, handler: any, deps?: any[]): void {}
        connection(opts: any) { return opts; }
      }
      const udf = new UserDataFunctions();

      udf.func('fallbackInline', async (): Promise<string> => 'ok', [
        udf.connection({ audienceType: "AzureAI" }),
      ]);
      `
    );
    rmSync(join(functionsDir, 'tsconfig.json'));
    const diagnostics: FunctionsMetadataDiagnostic[] = [];

    const result = await generateFunctionsMetadata(functionsDir, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(result.functionsMetadata[0].bindings).toContainEqual({
      name: '__generic_AzureAI',
      direction: 'in',
      type: 'FabricItem',
      alias: '',
      audienceType: 'AzureAI',
    });
    expect(diagnostics).toEqual([]);
  });

  it('warns for identifiers when an invalid tsconfig forces fallback', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions {
        func(name: string, handler: any, deps?: any[]): void {}
        connection(opts: any) { return opts; }
      }
      const udf = new UserDataFunctions();
      enum AudienceType { AzureAI = "AzureAI" }
      const AZURE_AI_AUDIENCE = AudienceType.AzureAI;

      udf.func('fallbackIdentifier', async (): Promise<string> => 'ok', [
        udf.connection({ audienceType: AZURE_AI_AUDIENCE }),
      ]);
      `
    );
    writeFileSync(
      join(functionsDir, 'tsconfig.json'),
      JSON.stringify({
        extends: './missing-tsconfig.json',
        include: ['src/**/*.ts'],
      }),
      'utf8'
    );
    const diagnostics: FunctionsMetadataDiagnostic[] = [];

    const result = await generateFunctionsMetadata(functionsDir, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(result.functionsMetadata[0].bindings).toHaveLength(2);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'unresolved-connection-property',
        functionName: 'fallbackIdentifier',
        message: expect.stringContaining("option 'audienceType'"),
      }),
    ]);
  });

  it('does not resolve mutable connection option identifiers', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions {
        func(name: string, handler: any, deps?: any[]): void {}
        connection(opts: any) { return opts; }
      }
      const udf = new UserDataFunctions();
      enum AudienceType { AzureAI = "AzureAI" }
      let audience = AudienceType.AzureAI;

      udf.func('mutableAudience', async (): Promise<string> => 'ok', [
        udf.connection({ audienceType: audience }),
      ]);
      `
    );
    const diagnostics: FunctionsMetadataDiagnostic[] = [];

    const result = await generateFunctionsMetadata(functionsDir, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(result.functionsMetadata[0].bindings).toHaveLength(2);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'unresolved-connection-property',
        functionName: 'mutableAudience',
      }),
    ]);
  });

  it('reports cyclic connection array spreads', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions {
        func(name: string, handler: any, deps?: any[]): void {}
      }
      const udf = new UserDataFunctions();
      const FIRST_CONNECTIONS = [...SECOND_CONNECTIONS];
      const SECOND_CONNECTIONS = [...FIRST_CONNECTIONS];

      udf.func(
        'cyclicConnections',
        async (): Promise<string> => 'ok',
        FIRST_CONNECTIONS
      );
      `
    );
    const diagnostics: FunctionsMetadataDiagnostic[] = [];

    const result = await generateFunctionsMetadata(functionsDir, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(result.functionsMetadata[0].bindings).toHaveLength(2);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'cyclic-connection-array',
        functionName: 'cyclicConnections',
      }),
    ]);
  });

  it('reports connection spreads that are not statically resolvable', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions {
        func(name: string, handler: any, deps?: any[]): void {}
      }
      const udf = new UserDataFunctions();
      function getConnections(): any[] {
        return [];
      }
      const CONNECTIONS = [...getConnections()];

      udf.func(
        'dynamicSpread',
        async (): Promise<string> => 'ok',
        CONNECTIONS
      );
      `
    );
    const diagnostics: FunctionsMetadataDiagnostic[] = [];

    const result = await generateFunctionsMetadata(functionsDir, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(result.functionsMetadata[0].bindings).toHaveLength(2);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'unresolved-connection-spread',
        functionName: 'dynamicSpread',
      }),
    ]);
  });

  it('preserves the complete deploy metadata object and serialized file', async () => {
    const primaryFunctionCode = `udf.func(
  'primary',
  async (
    query: string,
    untyped,
    { id }: { id: string },
    count = 2,
    label?: string
  ): Promise<string> =>
    \`\${query}-\${String(untyped)}-\${id}-\${count}-\${label ?? ''}\`,
  CONNECTIONS
)`;
    scaffold(
      functionsDir,
      `
class UserDataFunctions {
  func(name: string, handler: any, deps?: any[]): void {}
  connection(opts: any) { return opts; }
}
const udf = new UserDataFunctions();
enum AudienceType { AzureAI = "AzureAI" }
const AZURE_AI_AUDIENCE = AudienceType.AzureAI;
const AZURE_AI_CONNECTION = udf.connection({
  audienceType: AZURE_AI_AUDIENCE,
});
const CONNECTIONS = [
  AZURE_AI_CONNECTION,
  udf.connection({ alias: "myLake", argName: "lake" }),
];

${primaryFunctionCode};
`
    );
    const srcDir = join(functionsDir, 'src');
    mkdirSync(join(srcDir, 'nested'), { recursive: true });
    const secondaryFunctionCode = `udf.func('secondary', function () {
  return 42;
}, [])`;
    writeFileSync(
      join(srcDir, 'nested', 'more.ts'),
      `const udf: any = {};
${secondaryFunctionCode};
`,
      'utf8'
    );
    for (const ignoredFile of [
      'types.ts',
      'ignored.test.ts',
      'ignored.spec.ts',
    ]) {
      writeFileSync(
        join(srcDir, ignoredFile),
        `
        const udf: any = {};
        udf.func('ignored', async (): Promise<void> => {}, []);
        `,
        'utf8'
      );
    }
    writeFileSync(
      join(srcDir, 'ambient.d.ts'),
      'declare const x: number;',
      'utf8'
    );

    const result = await generateFunctionsMetadata(functionsDir);
    const expected = {
      runtime: 'TypeScript',
      functionsMetadata: [
        {
          name: 'primary',
          scriptFile: join('src', 'function_app.ts'),
          bindings: [
            {
              name: 'req',
              type: 'httpTrigger',
              direction: 'in',
              authLevel: 'anonymous',
              methods: ['post'],
              route: 'primary',
            },
            { name: '$return', type: 'http', direction: 'out' },
            {
              name: '__generic_AzureAI',
              direction: 'in',
              type: 'FabricItem',
              alias: '',
              audienceType: 'AzureAI',
            },
            {
              name: 'lake',
              direction: 'in',
              type: 'FabricItem',
              alias: 'myLake',
            },
          ],
          fabricProperties: {
            fabricMetadataSchemaVersion: '1.0',
            fabricFunctionReturnType: 'Promise<string>',
            fabricFunctionParameters: [
              {
                name: 'query',
                dataType: 'string',
                hasDefaultValue: false,
                defaultValue: undefined,
              },
              {
                name: 'untyped',
                dataType: 'any',
                hasDefaultValue: false,
                defaultValue: undefined,
              },
              {
                name: 'arg2',
                dataType: '{ id: string }',
                hasDefaultValue: false,
                defaultValue: undefined,
              },
              {
                name: 'count',
                dataType: 'any',
                hasDefaultValue: true,
                defaultValue: '2',
              },
              {
                name: 'label',
                dataType: 'string',
                hasDefaultValue: false,
                defaultValue: undefined,
              },
            ],
          },
          functionCode: primaryFunctionCode,
        },
        {
          name: 'secondary',
          scriptFile: join('src', 'nested', 'more.ts'),
          bindings: [
            {
              name: 'req',
              type: 'httpTrigger',
              direction: 'in',
              authLevel: 'anonymous',
              methods: ['post'],
              route: 'secondary',
            },
            { name: '$return', type: 'http', direction: 'out' },
          ],
          fabricProperties: {
            fabricMetadataSchemaVersion: '1.0',
            fabricFunctionReturnType: 'any',
            fabricFunctionParameters: [],
          },
          functionCode: secondaryFunctionCode,
        },
      ],
    };

    expect(result).toEqual(expected);

    const expectedJson = JSON.stringify(expected, null, 2);
    const outputFilename = 'deploymetadata.json';
    const written = await generateAndWriteMetadata(
      functionsDir,
      outputFilename
    );
    expect(written).toEqual({
      json: expectedJson,
      outputPath: join(functionsDir, outputFilename),
    });
    expect(readFileSync(written.outputPath, 'utf8')).toBe(expectedJson);
  });

  it('empty connections array produces no FabricItem bindings', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions { func(name: string, handler: any, deps?: any[]): void {} }
      const udf = new UserDataFunctions();

      udf.func('noConn', async (): Promise<string> => 'ok', []);
      `
    );

    const result = await generateFunctionsMetadata(functionsDir);
    const fn = result.functionsMetadata[0];

    const fabricBindings = fn.bindings.filter((b) => b.type === 'FabricItem');
    expect(fabricBindings).toHaveLength(0);
  });
});
