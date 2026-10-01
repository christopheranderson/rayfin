import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, jest, test } from '@jest/globals';

import { TypeScriptProjectParser } from '../astparser.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  jest.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('runtime metadata parser parity', () => {
  test('projects the same delegate parameter semantics as the CLI golden', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'runtime-parity-'));
    temporaryRoots.push(projectRoot);
    const srcRoot = join(projectRoot, 'src');
    mkdirSync(srcRoot);
    writeFileSync(
      join(srcRoot, 'function_app.ts'),
      `
const udf: any = {};
udf.func(
  'analyze',
  async (
    { id }: { id: string },
    value,
    lakehouseConnection: FabricSqlConnection,
    fabricValue: string,
    count = 5,
    label?: string
  ): Promise<string> => id
);
`
    );
    jest.spyOn(console, 'log').mockImplementation(() => {});

    const parser = new TypeScriptProjectParser(srcRoot);
    parser.scanProject();
    const projected = parser.getAllFabricUdfFunctions().map((entry) => ({
      functionName: entry.functionName,
      delegateParameters: entry.delegateParameters,
    }));

    expect(projected).toEqual([
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
      },
    ]);
  });

  test('extracts generic audiences from the context annotation', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'runtime-parity-aud-'));
    temporaryRoots.push(projectRoot);
    const srcRoot = join(projectRoot, 'src');
    mkdirSync(srcRoot);
    // Mirrors the CLI generator fixture in
    // packages/tools/cli/src/utils/__tests__/functions-metadata-generator.test.ts
    // so both analyzers are exercised on the same shape.
    writeFileSync(
      join(srcRoot, 'function_app.ts'),
      `
enum AudienceType { Fabric = "Fabric", ADO = "ADO", Sql = "Sql" }
class RayfinContext<TSchema = any, TokenTypes extends AudienceType = never> {
  getToken(a: TokenTypes): string { return String(a); }
}
type DataModel = { Todo: { id: string } };
const udf: any = {};

udf.func(
  'myFunc',
  async (ctx: RayfinContext<DataModel, AudienceType.Sql | AudienceType.ADO>): Promise<string> =>
    ctx.getToken(AudienceType.Sql),
  []
);

udf.func('plain', async (ctx: RayfinContext<DataModel>): Promise<string> => 'ok', []);

udf.func('business', (firstName: string): string => firstName, []);
`
    );
    jest.spyOn(console, 'log').mockImplementation(() => {});

    const parser = new TypeScriptProjectParser(srcRoot);
    parser.scanProject();
    const projected = parser.getAllFabricUdfFunctions().map((entry) => ({
      functionName: entry.functionName,
      genericAudiences: entry.genericAudiences,
    }));

    expect(projected).toEqual([
      // Sorted, so this matches what the CLI generator emits.
      { functionName: 'myFunc', genericAudiences: ['ADO', 'Sql'] },
      { functionName: 'plain', genericAudiences: [] },
      { functionName: 'business', genericAudiences: [] },
    ]);
  });
});
