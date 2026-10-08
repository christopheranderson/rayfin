import fs from 'fs';
import { join } from 'path';

import ts from 'typescript';

import {
  RUNTIME_METADATA_FILENAME,
  generateFunctionsMetadataFiles,
} from './functions-metadata-generator.js';
import {
  createFunctionsProgram,
  type FunctionsProgram,
} from './functions-ts-program.js';
import {
  generateSecretsTypes,
  SECRETS_TYPES_FILENAME,
} from './secrets-types-generator.js';

/**
 * Parameter types injected by the function runtime, not supplied by the
 * caller. These are filtered out of the public input shape so the
 * frontend `RayfinClient.functions.<name>.invoke(...)` signature only
 * exposes parameters the caller actually provides.
 *
 * Keep in sync with the runtime filter in
 * `@microsoft/fabric-user-data-functions/dist/userDataFunctions.js`
 * (`rayfinParamNames` / `param.type === 'RayfinContext'`).
 */
const RUNTIME_INJECTED_PARAM_TYPES = new Set([
  'RayfinContext',
  'FabricItem',
  'DataConnection',
  'Connection',
  'FabricContext',
  'FabricSqlConnection',
  'FabricConnection',
  'FabricUdf',
  'FabricLogger',
]);

/**
 * Strip the leading type identifier from a parameter's type annotation.
 *
 * Handles bare identifiers (`RayfinContext`), generics
 * (`RayfinContext<MySchema>`), and namespaced forms
 * (`udf.RayfinContext`) so the filter matches regardless of how the
 * builder wrote the annotation.
 */
function parameterBaseTypeName(dataType: string): string {
  // Strip generic arguments: `RayfinContext<MySchema>` -> `RayfinContext`.
  const withoutGenerics = dataType.replace(/<.*$/s, '');
  // Strip namespace prefix: `udf.RayfinContext` -> `RayfinContext`.
  const lastSegment = withoutGenerics.trim().split('.').pop() ?? '';
  return lastSegment.trim();
}

/**
 * Unwrap `Promise<T>` to `T` for output type annotations.
 *
 * UDF return types are typically declared as
 * `Promise<{ … }>` because handlers are async, but the public schema
 * should show the awaited shape (which is what `invoke()` resolves to).
 * Bare types, `Awaited<T>` wrappers, and arbitrary other generics are
 * returned unchanged.
 */
function unwrapPromise(returnType: string): string {
  const match = returnType.trim().match(/^Promise<([\s\S]+)>$/);
  if (!match) {
    return returnType;
  }
  // Balance check: the regex above grabs everything between the first `<`
  // and the LAST `>`. That is correct for the common case where the entire
  // type is `Promise<...>` because TypeScript signatures terminate at the
  // outer `>`. Trim whitespace from the inner type for cleaner output.
  return match[1].trim();
}

// ---------------------------------------------------------------------------
// Type-checker–based resolution
// ---------------------------------------------------------------------------

/** Resolved input/output strings for a single function. */
interface ResolvedFunctionTypes {
  input: string;
  output: string;
}

/**
 * Recursively serialize a TypeScript type to a self-contained inline string.
 *
 * User-defined interfaces and type aliases are expanded structurally so the
 * generated `types.ts` never references names that aren't defined in it.
 * Built-in types (`Date`, `RegExp`, …) and primitives are kept as-is.
 */
function serializeType(
  type: ts.Type,
  checker: ts.TypeChecker,
  depth = 0
): string {
  // Hard depth limit — fall back to the checker's default representation.
  if (depth > 8) return checker.typeToString(type);

  const flags = type.getFlags();

  // Primitives
  if (flags & ts.TypeFlags.String) return 'string';
  if (flags & ts.TypeFlags.Number) return 'number';
  if (flags & ts.TypeFlags.Boolean) return 'boolean';
  if (flags & ts.TypeFlags.Void) return 'void';
  if (flags & ts.TypeFlags.Null) return 'null';
  if (flags & ts.TypeFlags.Undefined) return 'undefined';
  if (flags & ts.TypeFlags.Any) return 'any';
  if (flags & ts.TypeFlags.Unknown) return 'unknown';
  if (flags & ts.TypeFlags.Never) return 'never';

  // Literal types
  if (flags & ts.TypeFlags.StringLiteral)
    return `'${(type as ts.StringLiteralType).value}'`;
  if (flags & ts.TypeFlags.NumberLiteral)
    return `${(type as ts.NumberLiteralType).value}`;

  // Union (includes boolean = true | false)
  if (type.isUnion()) {
    const allBoolean =
      type.types.length === 2 &&
      type.types.every((t) => !!(t.getFlags() & ts.TypeFlags.BooleanLiteral));
    if (allBoolean) return 'boolean';
    return type.types
      .map((t) => serializeType(t, checker, depth + 1))
      .join(' | ');
  }

  // Intersection
  if (type.isIntersection()) {
    return type.types
      .map((t) => serializeType(t, checker, depth + 1))
      .join(' & ');
  }

  // Object types (arrays, tuples, interfaces, inline objects)
  if (flags & ts.TypeFlags.Object) {
    const objFlags = (type as ts.ObjectType).objectFlags;
    const sym = type.getSymbol();

    // Tuple (check before array — tuples are also references)
    if (objFlags & ts.ObjectFlags.Tuple) {
      const elems =
        (type as ts.TypeReference).typeArguments?.map((t) =>
          serializeType(t, checker, depth + 1)
        ) ?? [];
      return `[${elems.join(', ')}]`;
    }

    // Array<T> / T[]
    if (objFlags & ts.ObjectFlags.Reference) {
      const targetName = (type as ts.TypeReference).target?.getSymbol()?.name;
      if (targetName === 'Array' || targetName === 'ReadonlyArray') {
        const elemType = (type as ts.TypeReference).typeArguments?.[0];
        if (elemType) {
          const inner = serializeType(elemType, checker, depth + 1);
          return elemType.isUnion() || elemType.isIntersection()
            ? `(${inner})[]`
            : `${inner}[]`;
        }
        return 'any[]';
      }
    }

    // Promise<T> — unwrap
    if (sym?.name === 'Promise') {
      const inner = (type as ts.TypeReference).typeArguments?.[0];
      if (inner) return serializeType(inner, checker, depth + 1);
    }

    // Library-declared types (lib.*.d.ts, @types, node_modules) —
    // emit as a named reference, preserving type arguments. This keeps
    // `Date`, `RegExp`, `Map<K, V>`, `Set<T>`, `URL`, `Buffer`, etc.
    // intact without a hardcoded allowlist; user-defined types are
    // expanded structurally because their declarations live in .ts files.
    //
    // Synthetic symbols (names starting with `__`) and anonymous object
    // types are excluded — these arise from anonymous object literals
    // and from instantiated utility/mapped types like `Record<K, V>`,
    // and must always be expanded structurally rather than emitted as
    // their internal symbol name (e.g. `__type`).
    const isAnonymous = !!(
      (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Anonymous
    );
    if (
      !isAnonymous &&
      sym &&
      !sym.name.startsWith('__') &&
      sym.declarations &&
      sym.declarations.length > 0 &&
      sym.declarations.every((d) => d.getSourceFile().isDeclarationFile)
    ) {
      const typeArgs = (type as ts.TypeReference).typeArguments;
      if (typeArgs && typeArgs.length > 0) {
        const args = typeArgs.map((t) => serializeType(t, checker, depth + 1));
        return `${sym.name}<${args.join(', ')}>`;
      }
      return sym.name;
    }

    // Object type with properties and/or index signatures — expand inline
    const properties = type.getProperties();
    const indexInfos = checker.getIndexInfosOfType(type);
    if (properties.length > 0 || indexInfos.length > 0) {
      const members: string[] = [];
      for (const info of indexInfos) {
        const keyType = serializeType(info.keyType, checker, depth + 1);
        const valueType = serializeType(info.type, checker, depth + 1);
        const readonly = info.isReadonly ? 'readonly ' : '';
        members.push(`${readonly}[k: ${keyType}]: ${valueType}`);
      }
      for (const prop of properties) {
        const propType = checker.getTypeOfSymbol(prop);
        const opt = prop.flags & ts.SymbolFlags.Optional ? '?' : '';
        const propertyName = /^[$A-Z_a-z][$\w]*$/.test(prop.name)
          ? prop.name
          : JSON.stringify(prop.name);
        members.push(
          `${propertyName}${opt}: ${serializeType(propType, checker, depth + 1)}`
        );
      }
      return `{ ${members.join('; ')} }`;
    }

    // Function signatures — use checker's string
    if (type.getCallSignatures().length > 0) {
      return checker.typeToString(type);
    }

    return '{}';
  }

  // Fallback
  return checker.typeToString(type);
}

/**
 * Build a map of function-name → resolved `{ input, output }` type strings
 * by creating a full TypeScript program from the functions project's
 * `tsconfig.json` and using the type checker to structurally expand every
 * user-defined type.
 *
 * Returns an empty map when the program cannot be created (e.g. missing
 * tsconfig), letting the caller fall back to raw-text types.
 */
function resolveTypeMap(
  functionsDir: string,
  functionsProgram: FunctionsProgram | null = createFunctionsProgram(
    functionsDir
  )
): Map<string, ResolvedFunctionTypes> {
  const result = new Map<string, ResolvedFunctionTypes>();

  if (!functionsProgram) return result;
  const { program, checker } = functionsProgram;

  const srcDir = join(functionsDir, 'src').replace(/\\/g, '/');

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (!sourceFile.fileName.replace(/\\/g, '/').startsWith(srcDir)) continue;

    visit(sourceFile);

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        tryResolve(node, checker, result);
      }
      ts.forEachChild(node, visit);
    }
  }

  return result;
}

/**
 * If `node` is a `<var>.func(name, handler, deps)` call, resolve the
 * handler's parameter and return types via the checker and store them.
 */
function tryResolve(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  out: Map<string, ResolvedFunctionTypes>
): void {
  const expr = node.expression;
  if (!ts.isPropertyAccessExpression(expr) || expr.name.text !== 'func') return;
  if (node.arguments.length < 2) return;

  const nameArg = node.arguments[0];
  if (!ts.isStringLiteral(nameArg)) return;

  const handler = node.arguments[1];
  if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) return;

  // Resolve caller-visible parameters (filter runtime-injected ones).
  // Destructured patterns (e.g. `({ a, b }: Args)`) get a synthesized
  // positional name (`arg0`, `arg1`, ...) so the input schema stays
  // valid TS and matches the wire format the runtime expects.
  const callerParams: { name: string; type: string }[] = [];
  let positionalIndex = 0;
  for (const param of handler.parameters) {
    const paramType = checker.getTypeAtLocation(param);
    const typeName = paramType.getSymbol()?.name ?? '';
    if (RUNTIME_INJECTED_PARAM_TYPES.has(typeName)) continue;

    const paramName = ts.isIdentifier(param.name)
      ? param.name.text
      : `arg${positionalIndex}`;
    positionalIndex++;
    callerParams.push({
      name: paramName,
      type: serializeType(paramType, checker),
    });
  }

  // Resolve return type (unwrap Promise)
  const signature = checker.getSignatureFromDeclaration(handler);
  let outputType = 'any';
  if (signature) {
    let returnType = checker.getReturnTypeOfSignature(signature);
    // Unwrap Promise<T>
    if (returnType.getSymbol()?.name === 'Promise') {
      const typeArgs = (returnType as ts.TypeReference).typeArguments;
      if (typeArgs?.length === 1) {
        returnType = typeArgs[0];
      }
    }
    outputType = serializeType(returnType, checker);
  }

  const inputFields = callerParams
    .map((p) => `${p.name}: ${p.type}`)
    .join('; ');
  const input =
    callerParams.length > 0 ? `{ ${inputFields} }` : 'Record<string, never>';

  out.set(nameArg.text, { input, output: outputType });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate the `src/types.ts` schema file for a Rayfin functions project by
 * parsing `udf.func()` registrations from the TypeScript source files.
 *
 * The generated file exports an `AppFunctionsSchema` type that maps each
 * function name to its `{ input; output }` type pair, enabling fully
 * type-checked invocations from the frontend via `RayfinClient`.
 *
 * Runtime-injected parameters (e.g. `RayfinContext`) are filtered out of
 * `input` so the public invoke signature only lists caller-supplied
 * arguments. Output types declared as `Promise<T>` are unwrapped to `T`
 * because `invoke()` always returns the awaited value.
 *
 * Type resolution uses the TypeScript type checker to structurally expand
 * user-defined types so the generated file is fully self-contained.  If the
 * checker is unavailable (e.g. missing `tsconfig.json`) the generator falls
 * back to raw type-annotation text.
 *
 * Also writes `runtimemetadata.json` next to the project's `src/` directory.
 * The worker extension reads that file at startup to recover delegate
 * parameters, which keeps the TypeScript compiler out of the function
 * runtime — locally as well as in deployments.
 */
export async function generateFunctionsTypes(
  functionsDir: string
): Promise<void> {
  // Secret names come from rayfin.yml, not from function source, but they are
  // part of the same generated-types contract — regenerating here keeps
  // rayfin/data/secrets.ts current on every `rayfin dev functions apply` and
  // functions scaffold, not just when a secret is added or removed.
  generateSecretsTypes(functionsDir);

  const functionsProgram = createFunctionsProgram(functionsDir);
  const { deployMetadata: metadata, runtimeMetadataJson } =
    await generateFunctionsMetadataFiles(functionsDir, {
      functionsProgram,
    });
  const resolvedTypes = resolveTypeMap(functionsDir, functionsProgram);

  const entries = metadata.functionsMetadata.map((fn) => {
    // Prefer checker-resolved types; fall back to raw text.
    const resolved = resolvedTypes.get(fn.name);
    if (resolved) {
      return `  ${fn.name}: {\n    input: ${resolved.input};\n    output: ${resolved.output};\n  };`;
    }

    // Fallback: use raw annotation text (original behaviour).
    const callerParams = fn.fabricProperties.fabricFunctionParameters.filter(
      (p) =>
        !RUNTIME_INJECTED_PARAM_TYPES.has(parameterBaseTypeName(p.dataType))
    );
    const inputFields = callerParams
      .map((p) => `${p.name}: ${p.dataType}`)
      .join('; ');
    const input =
      callerParams.length > 0 ? `{ ${inputFields} }` : 'Record<string, never>';
    const output = unwrapPromise(fn.fabricProperties.fabricFunctionReturnType);
    return `  ${fn.name}: {\n    input: ${input};\n    output: ${output};\n  };`;
  });

  const content =
    `/**\n` +
    ` * Function schema types for RayfinClient.\n` +
    ` *\n` +
    ` * AUTO-GENERATED — do not edit manually.\n` +
    ` * Re-generated automatically when function source files change.\n` +
    ` *\n` +
    ` * If this file is not updating automatically, run:\n` +
    ` *   rayfin dev functions apply\n` +
    ` *\n` +
    ` * The schema is a closed object type: only the function names listed\n` +
    ` * below are accepted by RayfinClient.functions.<name>.invoke(...).\n` +
    ` * Adding, renaming, or changing the signature of a udf.func() call\n` +
    ` * regenerates this file and surfaces type errors at every consumer.\n` +
    ` *\n` +
    ` * IMPORTANT: This file must NOT import any Node.js packages — it is\n` +
    ` * resolved by the frontend app's TypeScript compiler.\n` +
    ` */\n` +
    `\n` +
    `export type AppFunctionsSchema = {\n` +
    entries.join('\n') +
    `\n};\n`;

  // Write the runtime metadata before the `types.ts` early return below.
  // The two files go stale independently: metadata-only edits (parameter
  // order, defaults, optionality) leave the schema untouched, and an
  // upgraded project already has a current `types.ts` but no metadata at
  // all. Returning early would skip the write in both cases, and since
  // runtime metadata is the worker's only metadata path, the app would
  // then start into the metadata error state and fail every invocation.
  const metadataPath = join(functionsDir, RUNTIME_METADATA_FILENAME);
  if (
    !fs.existsSync(metadataPath) ||
    fs.readFileSync(metadataPath, 'utf8') !== runtimeMetadataJson
  ) {
    fs.writeFileSync(metadataPath, runtimeMetadataJson);
  }

  const outputPath = join(functionsDir, 'src', 'types.ts');
  // The compiler watches this file too; unchanged schemas must not trigger a second build.
  if (
    fs.existsSync(outputPath) &&
    fs.readFileSync(outputPath, 'utf8') === content
  ) {
    return;
  }
  fs.writeFileSync(outputPath, content);
}

/**
 * Watch the functions `src/` directory and regenerate `types.ts` whenever a
 * `.ts` source file changes (excluding `types.ts` itself).
 *
 * Returns the `fs.FSWatcher` handle so the caller can close it if needed.
 *
 * `options.onRegenerate` fires after each successful regeneration; the
 * filename is the path that triggered the rebuild (relative to `src/`).
 * `options.onError` fires when regeneration throws. Both callbacks are
 * optional — when omitted the watcher stays silent on success and falls
 * back to `console.error` on failure (legacy behaviour).
 */
export function watchAndGenerateTypes(
  functionsDir: string,
  options: {
    onRegenerate?: (filename: string) => void;
    onError?: (err: Error) => void;
  } = {}
): fs.FSWatcher {
  const srcDir = join(functionsDir, 'src');

  const watcher = fs.watch(srcDir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    // Only react to .ts files. Skip the generated outputs themselves —
    // types.ts and secrets.generated.ts both live under src/, so regenerating
    // them would re-trigger this watcher.
    if (!filename.endsWith('.ts')) return;
    if (filename === 'types.ts' || filename === SECRETS_TYPES_FILENAME) return;

    generateFunctionsTypes(functionsDir)
      .then(() => {
        options.onRegenerate?.(String(filename));
      })
      .catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (options.onError) {
          options.onError(error);
        } else {
          console.error('⚠️  Failed to regenerate types.ts:', error.message);
        }
      });
  });

  return watcher;
}
