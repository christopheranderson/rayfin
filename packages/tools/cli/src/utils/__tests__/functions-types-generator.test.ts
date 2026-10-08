import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';

import ts from 'typescript';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { generateFunctionsTypes } from '../functions-types-generator.js';

/**
 * Helper: scaffold a minimal functions project in a temp directory.
 *
 * Creates `tsconfig.json`, `package.json`, and writes the given source
 * string to `src/function_app.ts`.  Returns the functions directory path.
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

/** Read the generated `src/types.ts` and return its content. */
function readGeneratedTypes(dir: string): string {
  return readFileSync(join(dir, 'src', 'types.ts'), 'utf8');
}

describe('functions-types-generator', () => {
  let functionsDir: string;

  beforeEach(() => {
    functionsDir = join(
      process.cwd(),
      `.rayfin-typegen-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
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

  it('leaves types.ts untouched on repeat generation and body-only edits', async () => {
    const source = `
      class UserDataFunctions { func(name: string, handler: any, deps: any[]): void {} }
      const udf = new UserDataFunctions();
      udf.func('greet', (name: string): string => 'before ' + name, []);
    `;
    scaffold(functionsDir, source);
    await generateFunctionsTypes(functionsDir);
    const outputPath = join(functionsDir, 'src', 'types.ts');
    const output = readGeneratedTypes(functionsDir);
    const unchangedTime = new Date('2000-01-01T00:00:00Z');
    utimesSync(outputPath, unchangedTime, unchangedTime);

    await generateFunctionsTypes(functionsDir);
    expect(statSync(outputPath).mtimeMs).toBe(unchangedTime.getTime());
    writeFileSync(
      join(functionsDir, 'src', 'function_app.ts'),
      source.replace("'before '", "'after '")
    );
    await generateFunctionsTypes(functionsDir);

    expect(readGeneratedTypes(functionsDir)).toBe(output);
    expect(statSync(outputPath).mtimeMs).toBe(unchangedTime.getTime());
  });

  it('writes runtimemetadata.json even when types.ts is already current', async () => {
    // The upgrade path: a project committed `types.ts` before the worker
    // required runtime metadata, so the schema is current but the metadata
    // file is absent. The `types.ts` early return must not skip it.
    const source = `
      class UserDataFunctions { func(name: string, handler: any, deps: any[]): void {} }
      const udf = new UserDataFunctions();
      udf.func('greet', (name: string): string => 'hello ' + name, []);
    `;
    scaffold(functionsDir, source);
    await generateFunctionsTypes(functionsDir);

    const metadataPath = join(functionsDir, 'runtimemetadata.json');
    const generated = readFileSync(metadataPath, 'utf8');
    rmSync(metadataPath);
    const typesBefore = readGeneratedTypes(functionsDir);

    await generateFunctionsTypes(functionsDir);

    expect(existsSync(metadataPath)).toBe(true);
    expect(readFileSync(metadataPath, 'utf8')).toBe(generated);
    // The schema was already current, so it must still not be rewritten.
    expect(readGeneratedTypes(functionsDir)).toBe(typesBefore);
  });

  it('leaves runtimemetadata.json untouched when it is unchanged', async () => {
    const source = `
      class UserDataFunctions { func(name: string, handler: any, deps: any[]): void {} }
      const udf = new UserDataFunctions();
      udf.func('greet', (name: string): string => 'hello ' + name, []);
    `;
    scaffold(functionsDir, source);
    await generateFunctionsTypes(functionsDir);

    const metadataPath = join(functionsDir, 'runtimemetadata.json');
    const unchangedTime = new Date('2000-01-01T00:00:00Z');
    utimesSync(metadataPath, unchangedTime, unchangedTime);

    await generateFunctionsTypes(functionsDir);

    expect(statSync(metadataPath).mtimeMs).toBe(unchangedTime.getTime());
  });

  it('still rewrites types.ts when a function signature changes', async () => {
    const source = `
      class UserDataFunctions { func(name: string, handler: any, deps: any[]): void {} }
      const udf = new UserDataFunctions();
      udf.func('greet', (name: string): string => name, []);
    `;
    scaffold(functionsDir, source);
    await generateFunctionsTypes(functionsDir);
    expect(readGeneratedTypes(functionsDir)).toContain('name: string');

    writeFileSync(
      join(functionsDir, 'src', 'function_app.ts'),
      source.replace(
        '(name: string): string => name',
        '(count: number): number => count'
      )
    );
    await generateFunctionsTypes(functionsDir);

    expect(readGeneratedTypes(functionsDir)).toContain('count: number');
    expect(readGeneratedTypes(functionsDir)).toContain('output: number');
    expect(readGeneratedTypes(functionsDir)).not.toContain(
      'input: { name: string }'
    );
  });

  it('flattens user-defined interface types into inline objects', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions { func(name: string, handler: any, deps: any[]): void {} }
      const udf = new UserDataFunctions();

      interface CartItem { shoeId: string; quantity: number; }
      interface OrderResult { orderId: string; items: { name: string; price: number }[]; total: number; }

      udf.func('placeOrder', (cart: CartItem[], note: string): OrderResult => {
        return {} as any;
      }, []);
      `
    );

    await generateFunctionsTypes(functionsDir);
    const output = readGeneratedTypes(functionsDir);

    // Input: CartItem[] should be flattened, note kept as string
    expect(output).toContain('shoeId: string');
    expect(output).toContain('quantity: number');
    expect(output).toContain('note: string');
    // Should NOT contain the named type reference
    expect(output).not.toContain('CartItem');

    // Output: OrderResult should be flattened
    expect(output).toContain('orderId: string');
    expect(output).toContain('total: number');
    expect(output).not.toContain('OrderResult');
  });

  it('quotes property names that are not valid identifiers', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions { func(name: string, handler: any, deps: any[]): void {} }
      const udf = new UserDataFunctions();

      interface Order { "order-id": string; }

      udf.func('readOrder', (order: Order): Order => order, []);
      `
    );

    await generateFunctionsTypes(functionsDir);
    const output = readGeneratedTypes(functionsDir);
    const transpiled = ts.transpileModule(output, {
      reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.Node16 },
    });

    expect(output).toContain('"order-id": string');
    expect(
      transpiled.diagnostics?.filter(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
      )
    ).toEqual([]);
  });

  it('filters out RayfinContext and keeps caller params', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions { func(name: string, handler: any, deps: any[]): void {} }
      const udf = new UserDataFunctions();

      // Simulate RayfinContext as a local class (no real import needed)
      class RayfinContext<T = any> { log = { info: (..._a: any[]) => {} }; }

      udf.func('getTotal', async (items: { id: string }[], ctx: RayfinContext): Promise<number> => {
        return 42;
      }, []);
      `
    );

    await generateFunctionsTypes(functionsDir);
    const output = readGeneratedTypes(functionsDir);

    // RayfinContext should be stripped — only items remains
    expect(output).toContain('items:');
    expect(output).not.toContain('ctx');
    expect(output).not.toContain('RayfinContext');

    // Return type should be unwrapped from Promise<number> to number
    expect(output).toContain('output: number');
  });

  it('emits Record<string, never> for context-only functions', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions { func(name: string, handler: any, deps: any[]): void {} }
      const udf = new UserDataFunctions();
      class RayfinContext<T = any> {}

      udf.func('health', (ctx: RayfinContext): string => 'ok', []);
      `
    );

    await generateFunctionsTypes(functionsDir);
    const output = readGeneratedTypes(functionsDir);

    expect(output).toContain('input: Record<string, never>');
    expect(output).toContain('output: string');
  });

  it('handles optional properties and union types', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions { func(name: string, handler: any, deps: any[]): void {} }
      const udf = new UserDataFunctions();

      interface Filter { category?: string; minPrice: number | null; }

      udf.func('search', (filter: Filter): string[] => [], []);
      `
    );

    await generateFunctionsTypes(functionsDir);
    const output = readGeneratedTypes(functionsDir);

    expect(output).toContain('category?:');
    // TypeScript serializes union members alphabetically: null | number
    expect(output).toMatch(/minPrice: null \| number/);
    expect(output).not.toContain('Filter');
    expect(output).toContain('output: string[]');
  });

  it('preserves Date as a named type', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions { func(name: string, handler: any, deps: any[]): void {} }
      const udf = new UserDataFunctions();

      interface Event { name: string; startsAt: Date; }

      udf.func('create', (e: Event): Date => new Date(), []);
      `
    );

    await generateFunctionsTypes(functionsDir);
    const output = readGeneratedTypes(functionsDir);

    expect(output).toContain('startsAt: Date');
    expect(output).toContain('output: Date');
    expect(output).not.toContain('Event');
  });

  it('preserves type arguments on built-in generic types (Map, Set)', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions { func(name: string, handler: any, deps: any[]): void {} }
      const udf = new UserDataFunctions();

      interface Item { id: string; }

      udf.func('byId', (
        lookup: Map<string, number>,
        tags: Set<string>,
        items: Set<Item>,
      ): Map<string, Item> => new Map(), []);
      `
    );

    await generateFunctionsTypes(functionsDir);
    const output = readGeneratedTypes(functionsDir);

    expect(output).toContain('lookup: Map<string, number>');
    expect(output).toContain('tags: Set<string>');
    // Item should be flattened structurally inside Set<...>
    expect(output).toMatch(/items: Set<\{ id: string \}>/);
    expect(output).toMatch(/output: Map<string, \{ id: string \}>/);
    expect(output).not.toContain(': Map;');
    expect(output).not.toContain(': Set;');
  });

  it('serializes index signatures (Record / { [k: string]: T })', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions { func(name: string, handler: any, deps: any[]): void {} }
      const udf = new UserDataFunctions();

      interface Score { value: number; }

      udf.func('record', (
        scores: Record<string, number>,
        named: { [k: string]: Score },
      ): Record<string, string> => ({}), []);
      `
    );

    await generateFunctionsTypes(functionsDir);
    const output = readGeneratedTypes(functionsDir);

    // Index signature should be emitted, not collapsed to {}
    expect(output).toMatch(/scores: \{\s*\[[^\]]+\]: number\s*\}/);
    expect(output).toMatch(/named: \{\s*\[[^\]]+\]: \{ value: number \}\s*\}/);
    expect(output).toMatch(/output: \{\s*\[[^\]]+\]: string\s*\}/);
    // Bug indicator: input/output collapsed to bare `{}`
    expect(output).not.toMatch(/scores: \{\s*\}/);
    expect(output).not.toMatch(/output: \{\s*\}/);
  });

  it('synthesizes positional names for destructured handler parameters', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions { func(name: string, handler: any, deps: any[]): void {} }
      const udf = new UserDataFunctions();

      interface Args { a: string; b: number; }

      udf.func('destructured', ({ a, b }: Args): string => a + b, []);
      udf.func('mixed', (name: string, { x, y }: { x: number; y: number }): number => x + y, []);
      `
    );

    await generateFunctionsTypes(functionsDir);
    const output = readGeneratedTypes(functionsDir);

    // The raw destructuring pattern must NOT appear as a property name.
    expect(output).not.toMatch(/\{\s*a,\s*b\s*\}\s*:/);
    expect(output).not.toMatch(/\{\s*x,\s*y\s*\}\s*:/);

    // Single destructured param -> `arg0` carrying the structural shape.
    expect(output).toMatch(/arg0: \{ a: string; b: number \}/);

    // Mixed: named param keeps its name, destructured one becomes `arg1`.
    expect(output).toMatch(/name: string/);
    expect(output).toMatch(/arg1: \{ x: number; y: number \}/);
  });

  it('handles multiple functions in one file', async () => {
    scaffold(
      functionsDir,
      `
      class UserDataFunctions { func(name: string, handler: any, deps: any[]): void {} }
      const udf = new UserDataFunctions();

      udf.func('add', (a: number, b: number): number => a + b, []);
      udf.func('greet', (name: string): string => name, []);
      `
    );

    await generateFunctionsTypes(functionsDir);
    const output = readGeneratedTypes(functionsDir);

    expect(output).toContain('add:');
    expect(output).toContain('greet:');
    expect(output).toContain('a: number; b: number');
    expect(output).toContain('name: string');
  });
});
