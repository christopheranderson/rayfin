import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, relative } from 'path';

import { glob } from 'glob';
import ts from 'typescript';

import {
  extractHandlerAudiences,
  isRayfinContextTypeText,
  normalizeContextAnnotation,
} from './functions-context-audiences.js';
import {
  createFunctionsProgram,
  isFunctionSourceFile,
} from './functions-ts-program.js';
import type { FunctionsProgram } from './functions-ts-program.js';

// ---------------------------------------------------------------------------
// Types matching the Fabric FuncSet C# deploy metadata models
// ---------------------------------------------------------------------------

export interface FabricFunctionParameter {
  name: string;
  dataType: string;
  hasDefaultValue: boolean;
  defaultValue?: string;
}

export interface FunctionFabricProperties {
  fabricMetadataSchemaVersion: string;
  fabricFunctionReturnType: string;
  fabricFunctionParameters: FabricFunctionParameter[];
}

export interface BindingModel {
  name: string;
  type: string;
  direction: string;
}

export interface HttpBindingModel extends BindingModel {
  authLevel: string;
  methods: string[];
  route: string;
}

export interface FabricItemBindingModel extends BindingModel {
  alias?: string;
  audienceType?: string;
}

export interface FunctionModel {
  name: string;
  scriptFile: string;
  bindings: (BindingModel | HttpBindingModel)[];
  fabricProperties: FunctionFabricProperties;
  maxBatchSize?: number;
  functionCode?: string;
}

export interface DeployMetaData {
  runtime: string;
  functionsMetadata: FunctionModel[];
}

/**
 * Schema version written into `runtimemetadata.json`.
 *
 * Must stay in lockstep with the worker's
 * `MINIMUM_RUNTIME_METADATA_SCHEMA_VERSION`, which rejects anything older.
 * Bumped to `2.0` when `contextAudiences` became a guaranteed field: the
 * worker no longer parses source, so a `1.0` file that omits it would leave
 * connections resolving to no audiences.
 */
export const RUNTIME_METADATA_SCHEMA_VERSION = '2.0';

/** Filename of the generated worker runtime metadata, read by the UDF worker extension. */
export const RUNTIME_METADATA_FILENAME = 'runtimemetadata.json';

export interface RuntimeDelegateParameterMetadata {
  name: string;
  type?: string;
  optional: boolean;
  hasDefault: boolean;
  position: number;
  isFabricParameter: boolean;
  fabricParameterType?: string;
}

export interface RuntimeFunctionMetadata {
  functionName: string;
  delegateParameters: RuntimeDelegateParameterMetadata[];
  /**
   * Audiences declared on the handler's `RayfinContext` annotation, resolved
   * by the type checker. The worker reads these directly so it never needs the
   * TypeScript compiler at runtime. Always written, even when empty, so the
   * worker can tell "declares none" from "metadata predates the field".
   */
  contextAudiences: string[];
}

export interface RuntimeMetadataFile {
  schemaVersion: typeof RUNTIME_METADATA_SCHEMA_VERSION;
  functions: RuntimeFunctionMetadata[];
}

/**
 * Superset parameter analysis used to project deploy and worker metadata.
 *
 * @internal
 */
export interface AnalyzedParameter {
  sourceName: string;
  deployName: string;
  typeText?: string;
  optional: boolean;
  hasDefault: boolean;
  defaultValue?: string;
  position: number;
  isFabricParameter: boolean;
  fabricParameterType?: string;
}

/**
 * Plain-data analysis for one `udf.func()` registration.
 *
 * @internal
 */
export interface AnalyzedFunction {
  functionName: string;
  scriptFile: string;
  sourceText: string;
  returnTypeText?: string;
  parameters: AnalyzedParameter[];
  connectionBindings: FabricItemBindingModel[];
  /**
   * Audiences declared on the handler's `RayfinContext` annotation. Projected
   * into both the deploy bindings and the worker runtime metadata.
   */
  contextAudiences: string[];
}

/**
 * Serializable analysis shared by metadata projectors.
 *
 * @internal
 */
export interface FunctionsProjectAnalysis {
  functions: AnalyzedFunction[];
}

export interface GeneratedFunctionsArtifacts {
  deployMetadata: DeployMetaData;
  deployMetadataJson: string;
  runtimeMetadata: RuntimeMetadataFile;
  runtimeMetadataJson: string;
}

/**
 * A warning produced while statically analyzing function metadata.
 *
 * @internal
 */
export interface FunctionsMetadataDiagnostic {
  code:
    | 'unresolved-connections-array'
    | 'unresolved-connection-spread'
    | 'cyclic-connection-array'
    | 'unresolved-connection'
    | 'unresolved-connection-property'
    | 'unverified-context-audience';
  severity: 'warning';
  message: string;
  filePath: string;
  line: number;
  column: number;
  functionName: string;
}

/**
 * Options for functions metadata generation.
 *
 * @internal
 */
export interface GenerateFunctionsMetadataOptions {
  verbose?: (...args: unknown[]) => void;
  functionsProgram?: FunctionsProgram | null;
  onDiagnostic?: (diagnostic: FunctionsMetadataDiagnostic) => void;
}

type MetadataDiagnosticReporter = (
  code: FunctionsMetadataDiagnostic['code'],
  node: ts.Node,
  message: string
) => void;

const METADATA_SCHEMA_VERSION = '1.0';
const MAX_STATIC_VALUE_RESOLUTION_DEPTH = 10;
const FABRIC_PARAMETER_TYPES: ReadonlySet<string> = new Set([
  'FabricContext',
  'FabricSqlConnection',
  'FabricConnection',
  'DataConnection',
  'FabricUdf',
  'FabricLogger',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze TypeScript source files once into a plain-data representation that
 * can feed multiple metadata formats.
 *
 * @internal
 */
export async function analyzeFunctionsProject(
  functionsDir: string,
  options?: GenerateFunctionsMetadataOptions
): Promise<FunctionsProjectAnalysis> {
  const verbose = options?.verbose ?? (() => {});

  const srcDir = join(functionsDir, 'src');
  if (!existsSync(srcDir)) {
    throw new Error(`Functions source directory not found: ${srcDir}`);
  }

  const functionsProgram =
    options?.functionsProgram === undefined
      ? createFunctionsProgram(functionsDir)
      : options.functionsProgram;
  const sources = await collectFunctionSources(
    functionsDir,
    srcDir,
    functionsProgram
  );

  if (sources.length === 0) {
    throw new Error(`No TypeScript source files found in: ${srcDir}`);
  }

  verbose(`Found ${sources.length} source file(s) to analyze`);

  const functions: AnalyzedFunction[] = [];

  for (const { sourceFile, scriptFile } of sources) {
    const extracted = analyzeFunctionsFromSource(
      sourceFile,
      scriptFile,
      functionsProgram?.checker,
      options?.onDiagnostic
    );
    verbose(`  ${scriptFile}: ${extracted.length} function(s)`);
    functions.push(...extracted);
  }

  if (functions.length === 0) {
    throw new Error(
      'No udf.func() registrations found in source files.\n' +
        "💡 Register functions with: udf.func('name', handler, [])"
    );
  }

  verbose(`Total functions extracted: ${functions.length}`);
  return { functions };
}

/**
 * Generate deploy metadata by analyzing TypeScript `udf.func()`
 * registrations and projecting them into the Fabric deploy contract.
 */
export async function generateFunctionsMetadata(
  functionsDir: string,
  options?: GenerateFunctionsMetadataOptions
): Promise<DeployMetaData> {
  const analysis = await analyzeFunctionsProject(functionsDir, options);
  return toDeployMetadata(analysis);
}

/**
 * Analyze a functions project once and produce both deploy and worker
 * metadata artifacts from the same source snapshot.
 */
export async function generateFunctionsMetadataFiles(
  functionsDir: string,
  options?: GenerateFunctionsMetadataOptions
): Promise<GeneratedFunctionsArtifacts> {
  const analysis = await analyzeFunctionsProject(functionsDir, options);
  const deployMetadata = toDeployMetadata(analysis);
  const runtimeMetadata = toRuntimeMetadata(analysis);

  return {
    deployMetadata,
    deployMetadataJson: JSON.stringify(deployMetadata, null, 2),
    runtimeMetadata,
    runtimeMetadataJson: JSON.stringify(runtimeMetadata, null, 2),
  };
}

/**
 * Project a functions analysis into the existing deploy metadata contract.
 *
 * @internal
 */
export function toDeployMetadata(
  analysis: FunctionsProjectAnalysis
): DeployMetaData {
  return {
    runtime: 'TypeScript',
    functionsMetadata: analysis.functions.map((fn) => ({
      name: fn.functionName,
      scriptFile: fn.scriptFile,
      bindings: [
        ...buildHttpBindings(fn.functionName),
        ...fn.connectionBindings,
      ],
      fabricProperties: {
        fabricMetadataSchemaVersion: METADATA_SCHEMA_VERSION,
        fabricFunctionReturnType: fn.returnTypeText ?? 'any',
        fabricFunctionParameters: fn.parameters.map((param) => ({
          name: param.deployName,
          dataType: param.typeText ?? 'any',
          hasDefaultValue: param.hasDefault,
          defaultValue: param.defaultValue,
        })),
      },
      functionCode: fn.sourceText,
    })),
  };
}

/**
 * Project a functions analysis into the worker runtime metadata contract.
 *
 * `contextAudiences` carries the audiences the type checker resolved, so the
 * worker reads them as data and never needs the compiler at runtime.
 *
 * The context parameter's annotation is still normalised on the way out so its
 * audience argument is always spelled literally. Workers reading metadata that
 * predates `contextAudiences` recover audiences by parsing this text, and the
 * text as written may name a type alias they cannot resolve — see
 * `normalizeContextAnnotation`.
 *
 * `fabricParameterType` mirrors `type` and must be normalised with it. A
 * context parameter literally named `context` is classified as a Fabric
 * parameter by name, and `validateRuntimeMetadata` rejects the **whole file**
 * when the two strings disagree — so leaving one un-normalised would send the
 * worker back to full source parsing on metadata the CLI had just generated.
 *
 * @internal
 */
export function toRuntimeMetadata(
  analysis: FunctionsProjectAnalysis
): RuntimeMetadataFile {
  return {
    schemaVersion: RUNTIME_METADATA_SCHEMA_VERSION,
    functions: analysis.functions.map((fn) => ({
      functionName: fn.functionName,
      delegateParameters: fn.parameters.map((param) => {
        const typeText = isRayfinContextTypeText(param.typeText)
          ? normalizeContextAnnotation(param.typeText!, fn.contextAudiences)
          : param.typeText;
        // Only rewrite when it was a copy of the annotation, which is how
        // `analyzeParameters` fills it; anything else is passed through rather
        // than silently replaced.
        const fabricParameterType =
          param.fabricParameterType !== undefined &&
          param.fabricParameterType === param.typeText
            ? typeText
            : param.fabricParameterType;
        return {
          name: param.sourceName,
          ...(typeText === undefined ? {} : { type: typeText }),
          optional: param.optional,
          hasDefault: param.hasDefault,
          position: param.position,
          isFabricParameter: param.isFabricParameter,
          ...(fabricParameterType === undefined ? {} : { fabricParameterType }),
        };
      }),
      contextAudiences: [...fn.contextAudiences],
    })),
  };
}

/**
 * A user-authored source file plus its project-relative script path.
 *
 * @internal
 */
interface FunctionSource {
  sourceFile: ts.SourceFile;
  scriptFile: string;
}

/**
 * Collect the source files to scan for `udf.func()` registrations.
 *
 * Prefers a {@link ts.Program} built from the project's `tsconfig.json` so
 * later passes can resolve symbols (e.g. connection option identifiers) via
 * the type checker. Falls back to per-file `ts.createSourceFile` parsing when
 * the project has no usable `tsconfig.json`, preserving the original glob
 * behavior on minimal projects.
 *
 * File selection is identical across both paths: user-authored `.ts` files
 * under `src/`, excluding `.d.ts`, `*.test.ts`, `*.spec.ts`, and `types.ts`.
 * Results are sorted by script path so metadata output is deterministic
 * regardless of program vs. glob enumeration order.
 */
async function collectFunctionSources(
  functionsDir: string,
  srcDir: string,
  functionsProgram: FunctionsProgram | null
): Promise<FunctionSource[]> {
  const sources: FunctionSource[] = [];

  if (functionsProgram) {
    const srcDirNormalized = srcDir.replace(/\\/g, '/');
    for (const sourceFile of functionsProgram.program.getSourceFiles()) {
      if (!isFunctionSourceFile(sourceFile, srcDirNormalized)) continue;
      sources.push({
        sourceFile,
        scriptFile: relative(functionsDir, sourceFile.fileName),
      });
    }
  } else {
    // Fallback: no/invalid tsconfig — parse each file syntactically.
    const tsFiles = await glob('**/*.ts', {
      cwd: srcDir,
      absolute: true,
      ignore: ['**/*.d.ts', '**/*.test.ts', '**/*.spec.ts', '**/types.ts'],
    });
    for (const filePath of tsFiles) {
      const sourceText = readFileSync(filePath, 'utf-8');
      const sourceFile = ts.createSourceFile(
        filePath,
        sourceText,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
        ts.ScriptKind.TS
      );
      sources.push({
        sourceFile,
        scriptFile: relative(functionsDir, filePath),
      });
    }
  }

  sources.sort((a, b) => a.scriptFile.localeCompare(b.scriptFile));
  return sources;
}

/**
 * Generate deploy metadata, write it to the functions directory, and return
 * the serialized JSON string so callers don't need to re-read from disk.
 *
 * @returns The serialized metadata JSON string and the output file path.
 */
export async function generateAndWriteMetadata(
  functionsDir: string,
  outputFilename: string,
  options?: GenerateFunctionsMetadataOptions
): Promise<{ json: string; outputPath: string }> {
  const metadata = await generateFunctionsMetadata(functionsDir, options);
  const json = JSON.stringify(metadata, null, 2);
  const outputPath = join(functionsDir, outputFilename);
  writeFileSync(outputPath, json);
  return { json, outputPath };
}

// ---------------------------------------------------------------------------
// AST extraction helpers
// ---------------------------------------------------------------------------

/**
 * Walk the AST of a single source file and extract all `udf.func()`
 * registrations.
 */
function analyzeFunctionsFromSource(
  sourceFile: ts.SourceFile,
  scriptFile: string,
  checker?: ts.TypeChecker,
  onDiagnostic?: (diagnostic: FunctionsMetadataDiagnostic) => void
): AnalyzedFunction[] {
  const functions: AnalyzedFunction[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const analysis = tryAnalyzeFuncCall(
        node,
        sourceFile,
        scriptFile,
        checker,
        onDiagnostic
      );
      if (analysis) {
        functions.push(analysis);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return functions;
}

/**
 * Attempt to interpret a call expression as a `<variable>.func(name, handler, deps)` registration.
 *
 * Returns a plain-data analysis on success, or `null` if the node does not
 * match the expected pattern.
 */
function tryAnalyzeFuncCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  scriptFile: string,
  checker?: ts.TypeChecker,
  onDiagnostic?: (diagnostic: FunctionsMetadataDiagnostic) => void
): AnalyzedFunction | null {
  const expr = node.expression;

  // Match <expr>.func(...)
  if (!ts.isPropertyAccessExpression(expr) || expr.name.text !== 'func') {
    return null;
  }

  const args = node.arguments;
  if (args.length < 2) {
    return null;
  }

  // First argument: function name (string literal)
  const nameArg = args[0];
  if (!ts.isStringLiteral(nameArg)) {
    return null;
  }
  const functionName = nameArg.text;
  const reportDiagnostic: MetadataDiagnosticReporter | undefined = onDiagnostic
    ? (code, diagnosticNode, message) => {
        const location = sourceFile.getLineAndCharacterOfPosition(
          diagnosticNode.getStart(sourceFile)
        );
        onDiagnostic({
          code,
          severity: 'warning',
          message,
          filePath: scriptFile,
          line: location.line + 1,
          column: location.character + 1,
          functionName,
        });
      }
    : undefined;

  // Second argument: handler (arrow function or function expression)
  const handlerArg = args[1];
  if (!ts.isArrowFunction(handlerArg) && !ts.isFunctionExpression(handlerArg)) {
    return null;
  }

  const parameters = analyzeParameters(handlerArg, sourceFile);

  // Generic connections declared on the handler's RayfinContext annotation.
  const contextAudiences = extractHandlerAudiences(handlerArg, checker);

  // Without a checker the audiences were read straight off the annotation's
  // syntax, so a type alias comes through as its own name rather than the
  // audience it stands for. Both the deploy binding and the normalised runtime
  // annotation would then carry that name, and the worker would reject it.
  if (!checker && contextAudiences.length > 0) {
    reportDiagnostic?.(
      'unverified-context-audience',
      handlerArg,
      `Function '${functionName}': context audiences [${contextAudiences.join(', ')}] were read syntactically because no TypeScript program was available. ` +
        `If the annotation uses a type alias the resolved audience may be wrong. Add a tsconfig.json to the functions project, or declare audiences literally, e.g. RayfinContext<Schema, AudienceType.Sql>.`
    );
  }

  // Third argument (optional): connections array
  const arrayBindings =
    args.length >= 3
      ? extractConnectionBindings(
          args[2],
          sourceFile,
          checker,
          reportDiagnostic
        )
      : [];

  // Annotation-declared audiences come first, then anything the array adds,
  // deduplicated by audience. This mirrors the binding order the worker builds
  // at registration time so deploy and runtime metadata stay aligned.
  const connectionBindings: FabricItemBindingModel[] = [];
  const seenAudiences = new Set<string>();
  for (const audienceType of contextAudiences) {
    seenAudiences.add(audienceType);
    connectionBindings.push({
      name: `__generic_${audienceType}`,
      direction: 'in',
      type: 'FabricItem',
      alias: '',
      audienceType,
    });
  }
  for (const binding of arrayBindings) {
    if (binding.audienceType) {
      if (seenAudiences.has(binding.audienceType)) continue;
      seenAudiences.add(binding.audienceType);
    }
    connectionBindings.push(binding);
  }

  return {
    functionName,
    scriptFile,
    sourceText: node.getText(sourceFile),
    returnTypeText: handlerArg.type?.getText(sourceFile),
    parameters,
    connectionBindings,
    contextAudiences,
  };
}

/**
 * Capture the source and deploy semantics for each function parameter.
 */
function analyzeParameters(
  handler: ts.ArrowFunction | ts.FunctionExpression,
  sourceFile: ts.SourceFile
): AnalyzedParameter[] {
  return handler.parameters.map((param, index) => {
    const sourceName = param.name.getText(sourceFile);
    const deployName = ts.isIdentifier(param.name)
      ? param.name.text
      : `arg${index}`;
    const typeText = param.type?.getText(sourceFile);
    const hasDefault = param.initializer !== undefined;
    const defaultValue = hasDefault
      ? param.initializer!.getText(sourceFile)
      : undefined;
    const isFabricParameter = isFabricParameterType(typeText, sourceName);

    return {
      sourceName,
      deployName,
      typeText,
      optional: param.questionToken !== undefined,
      hasDefault,
      defaultValue,
      position: index,
      isFabricParameter,
      fabricParameterType: isFabricParameter ? typeText : undefined,
    };
  });
}

function isFabricParameterType(type?: string, name?: string): boolean {
  if (type && FABRIC_PARAMETER_TYPES.has(type)) {
    return true;
  }

  if (!name) return false;
  const lowerName = name.toLowerCase();
  return (
    lowerName === 'context' ||
    lowerName.includes('connection') ||
    lowerName.includes('fabric')
  );
}

/**
 * Extract connection bindings from the third argument of `udf.func()`.
 *
 * Supports two forms:
 * - `new Connection({ audienceType: AudienceType.Fabric })` → generic
 * - `new Connection({ alias: "myAlias" })` or `new Connection({ alias: "myAlias", argName: "lake" })` → alias
 *
 * Also supports the `udf.connection(...)` factory shorthand.
 */
function extractConnectionBindings(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  checker?: ts.TypeChecker,
  reportDiagnostic?: MetadataDiagnosticReporter
): FabricItemBindingModel[] {
  const bindings: FabricItemBindingModel[] = [];
  const seenAudiences = new Set<string>();
  const activeArrays = new Set<ts.ArrayLiteralExpression>();

  function visitArray(
    expression: ts.Expression,
    source: 'argument' | 'spread'
  ): void {
    const resolvedArray = resolveConstExpression(expression, checker);
    if (!resolvedArray || !ts.isArrayLiteralExpression(resolvedArray)) {
      reportDiagnostic?.(
        source === 'argument'
          ? 'unresolved-connections-array'
          : 'unresolved-connection-spread',
        expression,
        source === 'argument'
          ? 'Connections must be an inline array or an immutable const array.'
          : 'A connection spread must reference an immutable const array.'
      );
      return;
    }
    if (activeArrays.has(resolvedArray)) {
      reportDiagnostic?.(
        'cyclic-connection-array',
        expression,
        'Connection arrays cannot contain cyclic spreads.'
      );
      return;
    }

    activeArrays.add(resolvedArray);
    for (const element of resolvedArray.elements) {
      if (ts.isSpreadElement(element)) {
        visitArray(element.expression, 'spread');
        continue;
      }

      const opts = extractConnectionOptions(
        element,
        sourceFile,
        checker,
        reportDiagnostic
      );
      if (!opts) continue;

      if (opts.audienceType) {
        // Generic connection — deduplicate by audienceType
        if (seenAudiences.has(opts.audienceType)) continue;
        seenAudiences.add(opts.audienceType);
        bindings.push({
          name: `__generic_${opts.audienceType}`,
          direction: 'in',
          type: 'FabricItem',
          alias: '',
          audienceType: opts.audienceType,
        });
      } else if (opts.alias) {
        // Alias connection
        bindings.push({
          name: opts.argName ?? opts.alias,
          direction: 'in',
          type: 'FabricItem',
          alias: opts.alias,
        });
      }
    }
    activeArrays.delete(resolvedArray);
  }

  visitArray(node, 'argument');
  return bindings;
}

/**
 * Parse a single connection expression (either `new Connection({...})` or
 * `udf.connection({...})`) and return its options.
 */
function extractConnectionOptions(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  checker?: ts.TypeChecker,
  reportDiagnostic?: MetadataDiagnosticReporter
): { alias?: string; argName?: string; audienceType?: string } | null {
  const resolvedNode = resolveConstExpression(node, checker);
  if (!resolvedNode) {
    reportDiagnostic?.(
      'unresolved-connection',
      node,
      'Connection entries must be inline or assigned to an immutable const.'
    );
    return null;
  }

  let optionsArg: ts.Expression | undefined;

  // Form 1: `new Connection({ ... })`
  if (ts.isNewExpression(resolvedNode) && resolvedNode.arguments?.length) {
    optionsArg = resolvedNode.arguments[0];
  }
  // Form 2: `udf.connection({ ... })` or `connection({ ... })`
  else if (ts.isCallExpression(resolvedNode)) {
    const expr = resolvedNode.expression;
    const isConnectionCall =
      (ts.isIdentifier(expr) && expr.text === 'connection') ||
      (ts.isPropertyAccessExpression(expr) && expr.name.text === 'connection');
    if (isConnectionCall && resolvedNode.arguments.length) {
      optionsArg = resolvedNode.arguments[0];
    }
  }

  if (!optionsArg) {
    reportDiagnostic?.(
      'unresolved-connection',
      node,
      'Expected new Connection({...}) or udf.connection({...}).'
    );
    return null;
  }

  const resolvedOptions = resolveConstExpression(optionsArg, checker);
  if (!resolvedOptions || !ts.isObjectLiteralExpression(resolvedOptions)) {
    reportDiagnostic?.(
      'unresolved-connection',
      optionsArg,
      'Connection options must be an inline object or an immutable const object.'
    );
    return null;
  }

  const options = extractObjectProperties(
    resolvedOptions,
    sourceFile,
    checker,
    reportDiagnostic
  );
  const hasSelector = resolvedOptions.properties.some((property) => {
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isShorthandPropertyAssignment(property)
    ) {
      return false;
    }
    const name = getPropertyName(property.name);
    return name === 'audienceType' || name === 'alias';
  });
  if (!options.audienceType && !options.alias && !hasSelector) {
    reportDiagnostic?.(
      'unresolved-connection',
      resolvedOptions,
      "Connection options must define either 'audienceType' or 'alias'."
    );
  }

  return options;
}

/**
 * Extract string-valued properties from an object literal.
 */
function extractObjectProperties(
  obj: ts.ObjectLiteralExpression,
  _sourceFile: ts.SourceFile,
  checker?: ts.TypeChecker,
  reportDiagnostic?: MetadataDiagnosticReporter
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const prop of obj.properties) {
    if (
      !ts.isPropertyAssignment(prop) &&
      !ts.isShorthandPropertyAssignment(prop)
    ) {
      continue;
    }

    const key = getPropertyName(prop.name);
    if (!key) continue;

    const initializer = ts.isPropertyAssignment(prop)
      ? prop.initializer
      : prop.name;
    const value = extractStaticStringValue(initializer, checker);
    if (value !== undefined) {
      result[key] = value;
    } else if (key === 'audienceType' || key === 'alias' || key === 'argName') {
      reportDiagnostic?.(
        'unresolved-connection-property',
        initializer,
        `Connection option '${key}' must be a string, enum member, or immutable const.`
      );
    }
  }

  return result;
}

function getPropertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name)
    ? name.text
    : undefined;
}

/**
 * Resolve the static string represented by a connection option expression.
 */
function extractStaticStringValue(
  expression: ts.Expression,
  checker?: ts.TypeChecker
): string | undefined {
  const resolvedExpression = resolveConstExpression(expression, checker);
  if (!resolvedExpression) return undefined;

  if (ts.isStringLiteral(resolvedExpression)) return resolvedExpression.text;

  // AudienceType.Fabric → "Fabric"
  if (ts.isPropertyAccessExpression(resolvedExpression)) {
    return resolvedExpression.name.text;
  }

  return undefined;
}

/**
 * Follow immutable const identifiers to the expression they initialize.
 */
function resolveConstExpression(
  expression: ts.Expression,
  checker?: ts.TypeChecker,
  visitedSymbols: Set<ts.Symbol> = new Set(),
  depth = 0
): ts.Expression | undefined {
  if (depth > MAX_STATIC_VALUE_RESOLUTION_DEPTH) return undefined;

  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    return resolveConstExpression(
      expression.expression,
      checker,
      visitedSymbols,
      depth + 1
    );
  }

  if (
    !ts.isIdentifier(expression) &&
    !ts.isPropertyAccessExpression(expression)
  ) {
    return expression;
  }
  if (!checker) return undefined;

  let symbol = checker.getSymbolAtLocation(
    ts.isPropertyAccessExpression(expression) ? expression.name : expression
  );
  if (!symbol) return undefined;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  if (visitedSymbols.has(symbol)) return undefined;
  visitedSymbols.add(symbol);

  const declaration = symbol.valueDeclaration;
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    !(declaration.parent.flags & ts.NodeFlags.Const)
  ) {
    return ts.isPropertyAccessExpression(expression) ? expression : undefined;
  }

  return resolveConstExpression(
    declaration.initializer,
    checker,
    visitedSymbols,
    depth + 1
  );
}

/**
 * Build the standard HTTP trigger + output bindings that Fabric UDF
 * functions use.
 */
function buildHttpBindings(
  functionName: string
): (BindingModel | HttpBindingModel)[] {
  return [
    {
      name: 'req',
      type: 'httpTrigger',
      direction: 'in',
      authLevel: 'anonymous',
      methods: ['post'],
      route: functionName,
    } as HttpBindingModel,
    {
      name: '$return',
      type: 'http',
      direction: 'out',
    },
  ];
}
