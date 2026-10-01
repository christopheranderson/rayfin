import { describe, expect, test } from '@jest/globals';
import ts from 'typescript';

import {
  extractAudiencesFromTypeText,
  extractContextAudiences,
  extractHandlerAudiences,
} from '../internal/contextAudiences.js';

/**
 * These cover the syntax-only path, which runs when no `TypeChecker` is
 * available. The checker path is covered end-to-end in
 * runtimeMetadataParity.test.ts.
 */
function firstHandler(
  source: string
): ts.ArrowFunction | ts.FunctionExpression {
  const sourceFile = ts.createSourceFile(
    'sample.ts',
    source,
    ts.ScriptTarget.ES2022,
    true
  );
  let found: ts.ArrowFunction | ts.FunctionExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (!found && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error('no handler found in sample');
  return found;
}

describe('contextAudiences (syntax fallback)', () => {
  test('reads a union of qualified enum members', () => {
    const handler = firstHandler(
      `udf.func('f', (ctx: RayfinContext<Model, AudienceType.Sql | AudienceType.ADO>) => 1, []);`
    );
    // Sorted for determinism.
    expect(extractHandlerAudiences(handler)).toEqual(['ADO', 'Sql']);
  });

  test('reads a single audience', () => {
    const handler = firstHandler(
      `udf.func('f', (ctx: RayfinContext<Model, AudienceType.Fabric>) => 1, []);`
    );
    expect(extractHandlerAudiences(handler)).toEqual(['Fabric']);
  });

  test('reads bare and string-literal audience forms', () => {
    expect(
      extractHandlerAudiences(
        firstHandler(
          `udf.func('f', (ctx: RayfinContext<Model, Sql>) => 1, []);`
        )
      )
    ).toEqual(['Sql']);
    expect(
      extractHandlerAudiences(
        firstHandler(
          `udf.func('f', (ctx: RayfinContext<Model, 'Sql' | 'Storage'>) => 1, []);`
        )
      )
    ).toEqual(['Sql', 'Storage']);
  });

  test('a context with only a schema declares no audiences', () => {
    const handler = firstHandler(
      `udf.func('f', (ctx: RayfinContext<Model>) => 1, []);`
    );
    expect(extractHandlerAudiences(handler)).toEqual([]);
  });

  test('an unparameterised context declares no audiences', () => {
    const handler = firstHandler(
      `udf.func('f', (ctx: RayfinContext) => 1, []);`
    );
    expect(extractHandlerAudiences(handler)).toEqual([]);
  });

  test('`never` is not treated as an audience', () => {
    const handler = firstHandler(
      `udf.func('f', (ctx: RayfinContext<Model, never>) => 1, []);`
    );
    expect(extractHandlerAudiences(handler)).toEqual([]);
  });

  test('non-context parameters yield null, not an empty array', () => {
    const handler = firstHandler(
      `udf.func('f', (firstName: string, lastName: string) => 1, []);`
    );
    expect(extractContextAudiences(handler.parameters[0])).toBeNull();
    expect(extractHandlerAudiences(handler)).toEqual([]);
  });

  test('an unannotated parameter yields null without a checker', () => {
    const handler = firstHandler(`udf.func('f', (ctx) => 1, []);`);
    expect(extractContextAudiences(handler.parameters[0])).toBeNull();
  });

  test('finds the context even when it is not the first parameter', () => {
    const handler = firstHandler(
      `udf.func('f', (title: string, ctx: RayfinContext<Model, AudienceType.Sql>) => 1, []);`
    );
    expect(extractHandlerAudiences(handler)).toEqual(['Sql']);
  });

  test('deduplicates repeated audiences', () => {
    const handler = firstHandler(
      `udf.func('f', (ctx: RayfinContext<Model, AudienceType.Sql | AudienceType.Sql>) => 1, []);`
    );
    expect(extractHandlerAudiences(handler)).toEqual(['Sql']);
  });

  test('a namespaced context annotation is still recognised', () => {
    const handler = firstHandler(
      `udf.func('f', (ctx: udf.RayfinContext<Model, AudienceType.Sql>) => 1, []);`
    );
    expect(extractHandlerAudiences(handler)).toEqual(['Sql']);
  });
});

describe('extractAudiencesFromTypeText (worker binding derivation)', () => {
  test('recovers a union from stored annotation text', () => {
    expect(
      extractAudiencesFromTypeText(
        'RayfinContext<DataModel, AudienceType.Sql | AudienceType.ADO>'
      )
    ).toEqual(['ADO', 'Sql']);
  });

  test('recovers a single audience', () => {
    expect(
      extractAudiencesFromTypeText('RayfinContext<DataModel, AudienceType.Sql>')
    ).toEqual(['Sql']);
  });

  test('handles nested generics in the schema argument', () => {
    expect(
      extractAudiencesFromTypeText(
        'RayfinContext<{ Todo: Record<string, string> }, AudienceType.Storage>'
      )
    ).toEqual(['Storage']);
  });

  test('handles a namespaced annotation', () => {
    expect(
      extractAudiencesFromTypeText(
        'udf.RayfinContext<DataModel, AudienceType.Fabric>'
      )
    ).toEqual(['Fabric']);
  });

  test('returns nothing for a schema-only or bare context', () => {
    expect(extractAudiencesFromTypeText('RayfinContext<DataModel>')).toEqual(
      []
    );
    expect(extractAudiencesFromTypeText('RayfinContext')).toEqual([]);
    expect(
      extractAudiencesFromTypeText('RayfinContext<DataModel, never>')
    ).toEqual([]);
  });

  test('returns nothing for unrelated or missing annotations', () => {
    expect(extractAudiencesFromTypeText('string')).toEqual([]);
    expect(extractAudiencesFromTypeText('FabricSqlConnection')).toEqual([]);
    expect(extractAudiencesFromTypeText(undefined)).toEqual([]);
    expect(extractAudiencesFromTypeText('')).toEqual([]);
  });

  test('does not throw on malformed annotation text', () => {
    expect(extractAudiencesFromTypeText('RayfinContext<<<')).toEqual([]);
    expect(extractAudiencesFromTypeText('RayfinContext<A,')).toEqual([]);
  });
});
