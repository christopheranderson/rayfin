import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { isFunctionSourceFile } from '../functions-ts-program.js';

function sourceFile(fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, '', ts.ScriptTarget.Latest);
}

describe.each(['/app/functions/src', 'C:/app/functions/src'])(
  'isFunctionSourceFile with source root %s',
  (srcDir) => {
    it.each(['', '/'])(
      'accepts source files with root suffix "%s"',
      (suffix) => {
        expect(
          isFunctionSourceFile(
            sourceFile(`${srcDir}/function_app.ts`),
            srcDir + suffix
          )
        ).toBe(true);
        expect(
          isFunctionSourceFile(
            sourceFile(`${srcDir}/nested/handler.ts`),
            srcDir + suffix
          )
        ).toBe(true);
      }
    );

    it.each(['-gen', 'foo'])(
      'rejects a source-prefixed sibling "%s"',
      (suffix) => {
        expect(
          isFunctionSourceFile(
            sourceFile(`${srcDir}${suffix}/handler.ts`),
            srcDir
          )
        ).toBe(false);
      }
    );

    it('rejects files outside the source directory', () => {
      expect(
        isFunctionSourceFile(
          sourceFile(`${srcDir.slice(0, -3)}other/handler.ts`),
          srcDir
        )
      ).toBe(false);
    });

    it.each(['types.ts', 'handler.d.ts', 'handler.test.ts', 'handler.spec.ts'])(
      'preserves the exclusion for %s',
      (name) => {
        expect(
          isFunctionSourceFile(sourceFile(`${srcDir}/${name}`), srcDir)
        ).toBe(false);
      }
    );
  }
);

it('normalizes Windows source-file separators before applying the boundary', () => {
  expect(
    isFunctionSourceFile(
      sourceFile('C:\\app\\functions\\src\\handler.ts'),
      'C:/app/functions/src'
    )
  ).toBe(true);
  expect(
    isFunctionSourceFile(
      sourceFile('C:\\app\\functions\\src-gen\\handler.ts'),
      'C:/app/functions/src'
    )
  ).toBe(false);
});
