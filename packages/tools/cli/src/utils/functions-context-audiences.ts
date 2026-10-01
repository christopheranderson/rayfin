import ts from 'typescript';

/** The context class whose second type argument declares generic connections. */
export const RAYFIN_CONTEXT_TYPE_NAME = 'RayfinContext';

/**
 * Extracting the audience union declared on a handler's context annotation.
 *
 * `RayfinContext<Model, AudienceType.Sql | AudienceType.ADO>` declares two
 * generic connections. Type arguments are erased before the worker runs, so
 * this build-time pass is the only way those audiences can reach the deploy
 * bindings and `runtimemetadata.json`.
 *
 * Keep in sync with `contextAudiences.ts` in
 * `@microsoft/fabric-user-data-functions` — the worker applies the same rules
 * when it falls back to analysing source directly.
 *
 * Two strategies, in order:
 *
 * 1. **Type checker** (preferred). Resolves through aliases and computed types,
 *    so `AppCtx<AudienceType.Sql>` and
 *    `RayfinContext<Model, AudiencesOf<typeof CONNS>>` both collapse to a
 *    concrete union.
 * 2. **Syntax** (fallback, no checker available). Only understands an
 *    annotation written literally as `RayfinContext<Schema, A | B>`.
 */

function resolveContextType(type: ts.Type): ts.Type | null {
  const candidates = type.isUnionOrIntersection() ? type.types : [type];
  for (const candidate of candidates) {
    if (candidate.getSymbol()?.getName() === RAYFIN_CONTEXT_TYPE_NAME) {
      return candidate;
    }
    if (candidate.aliasSymbol?.getName() === RAYFIN_CONTEXT_TYPE_NAME) {
      return candidate;
    }
  }
  return null;
}

function audienceNamesFromType(type: ts.Type): string[] {
  const names: string[] = [];
  const visit = (current: ts.Type): void => {
    if (current.flags & ts.TypeFlags.Never) return;
    if (current.isUnion()) {
      current.types.forEach(visit);
      return;
    }
    if (current.isStringLiteral()) {
      if (!names.includes(current.value)) names.push(current.value);
      return;
    }
    const symbolName = current.getSymbol()?.getName();
    if (symbolName && !names.includes(symbolName)) names.push(symbolName);
  };
  visit(type);
  return names;
}

function audienceNamesFromTypeNode(node: ts.TypeNode): string[] {
  const names: string[] = [];
  const visit = (current: ts.TypeNode): void => {
    if (ts.isUnionTypeNode(current)) {
      current.types.forEach(visit);
      return;
    }
    if (ts.isParenthesizedTypeNode(current)) {
      visit(current.type);
      return;
    }
    if (
      ts.isLiteralTypeNode(current) &&
      ts.isStringLiteral(current.literal) &&
      current.literal.text.length > 0
    ) {
      if (!names.includes(current.literal.text)) {
        names.push(current.literal.text);
      }
      return;
    }
    if (ts.isTypeReferenceNode(current)) {
      const { typeName } = current;
      const name = ts.isQualifiedName(typeName)
        ? typeName.right.text
        : typeName.text;
      if (name && name !== 'never' && !names.includes(name)) names.push(name);
    }
  };
  visit(node);
  return names;
}

function isLiteralRayfinContextNode(
  node: ts.TypeNode
): node is ts.TypeReferenceNode {
  if (!ts.isTypeReferenceNode(node)) return false;
  const { typeName } = node;
  const base = ts.isQualifiedName(typeName)
    ? typeName.right.text
    : typeName.text;
  return base === RAYFIN_CONTEXT_TYPE_NAME;
}

/**
 * Audiences declared by a handler parameter, or `null` when the parameter is
 * not a `RayfinContext`.
 *
 * An empty array means "is a context, declares no generic connections", which
 * is distinct from `null` and must not be collapsed into it.
 */
export function extractContextAudiences(
  parameter: ts.ParameterDeclaration,
  checker?: ts.TypeChecker
): string[] | null {
  if (checker) {
    const parameterType = checker.getTypeAtLocation(parameter);
    const contextType = resolveContextType(parameterType);
    if (contextType) {
      const typeArguments = checker.getTypeArguments(
        contextType as ts.TypeReference
      );
      // [0] is the data schema, [1] is the audience union.
      if (typeArguments.length < 2) return [];
      return audienceNamesFromType(typeArguments[1]);
    }
  }

  const typeNode = parameter.type;
  if (!typeNode || !isLiteralRayfinContextNode(typeNode)) return null;

  const typeArguments = typeNode.typeArguments;
  if (!typeArguments || typeArguments.length < 2) return [];
  return audienceNamesFromTypeNode(typeArguments[1]);
}

/**
 * Audiences declared across every parameter of a handler.
 *
 * Sorted, deliberately: the checker returns a union in its own normalised
 * order while the syntactic fallback returns source order. Sorting makes the
 * two agree, keeps this in parity with the worker's own analysis, and stops
 * the generated metadata from churning between builds.
 */
export function extractHandlerAudiences(
  handler: ts.ArrowFunction | ts.FunctionExpression,
  checker?: ts.TypeChecker
): string[] {
  const audiences: string[] = [];
  for (const parameter of handler.parameters) {
    const parameterAudiences = extractContextAudiences(parameter, checker);
    if (!parameterAudiences) continue;
    for (const audience of parameterAudiences) {
      if (!audiences.includes(audience)) audiences.push(audience);
    }
  }
  return audiences.sort();
}

/**
 * True when a captured annotation string is one the worker will recognise as a
 * context parameter.
 *
 * Deliberately identical to `isRayfinContextType` in
 * `@microsoft/fabric-user-data-functions`. Normalisation has to apply to
 * exactly the parameters the worker inspects — no more, no less — or the two
 * ends stop agreeing about which parameter carries the audiences.
 */
export function isRayfinContextTypeText(typeText?: string): boolean {
  if (!typeText) return false;
  return (
    typeText === RAYFIN_CONTEXT_TYPE_NAME ||
    typeText.startsWith(`${RAYFIN_CONTEXT_TYPE_NAME}<`)
  );
}

/** Render an audience list as the literal union the worker can parse back. */
function renderAudienceUnion(audiences: readonly string[]): string {
  if (audiences.length === 0) return 'never';
  return audiences.map((audience) => `AudienceType.${audience}`).join(' | ');
}

/**
 * Rewrite a context annotation so its audience argument is spelled literally.
 *
 * The worker recovers audiences from this text, but the text is whatever the
 * user wrote. `RayfinContext<Model, SqlAccess>` type-checks and yields a `Sql`
 * deploy binding — the checker resolves the alias — while the worker sees only
 * `SqlAccess`, fails to match it against `AudienceType`, and registers nothing.
 * The deployed function then has a connection its handler cannot read.
 *
 * Substituting the resolved union closes that gap without touching the runtime
 * metadata schema: `delegateParameters[].type` is still a string, still an
 * annotation, and still parsed by exactly the same code on both sides. That
 * matters because the worker's `validateRuntimeMetadata` rejects unknown keys,
 * so an extra field would make new metadata *invalid* for already-deployed
 * workers rather than being ignored by them.
 *
 * ```text
 * RayfinContext<Model, SqlAccess>  ->  RayfinContext<Model, AudienceType.Sql>
 * RayfinContext<Model, NeverAlias> ->  RayfinContext<Model, never>
 * ```
 *
 * Only type argument 1 is replaced. Argument 0 (the data schema) and any
 * trailing arguments are preserved verbatim by splicing the original text, so
 * a narrowed secret-name argument survives.
 *
 * @param typeText - The annotation exactly as written in source.
 * @param audiences - Resolved audience names, sorted, from
 *   {@link extractHandlerAudiences}.
 * @returns The normalised annotation, or `typeText` unchanged when there is
 *   nothing to rewrite or the text cannot be parsed.
 */
export function normalizeContextAnnotation(
  typeText: string,
  audiences: readonly string[]
): string {
  if (!isRayfinContextTypeText(typeText)) return typeText;

  const prefix = 'type __A = ';
  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(
      '__annotation__.ts',
      `${prefix}${typeText};`,
      ts.ScriptTarget.ES2022,
      true
    );
  } catch {
    return typeText;
  }

  const alias = sourceFile.statements.find(ts.isTypeAliasDeclaration);
  if (!alias || !isLiteralRayfinContextNode(alias.type)) return typeText;

  const typeArguments = alias.type.typeArguments;
  const union = renderAudienceUnion(audiences);

  // `RayfinContext` / `RayfinContext<>` — nothing to preserve. Only worth
  // rewriting when audiences were resolved from somewhere other than the text.
  if (!typeArguments || typeArguments.length === 0) {
    if (audiences.length === 0) return typeText;
    return `${RAYFIN_CONTEXT_TYPE_NAME}<Record<string, any>, ${union}>`;
  }

  const toLocal = (position: number): number => position - prefix.length;

  // `RayfinContext<Model>` — append the audience argument only when there is
  // one, so the common no-connection annotation is left exactly as written.
  if (typeArguments.length === 1) {
    if (audiences.length === 0) return typeText;
    const schemaEnd = toLocal(typeArguments[0].getEnd());
    return `${typeText.slice(0, schemaEnd)}, ${union}${typeText.slice(schemaEnd)}`;
  }

  const start = toLocal(typeArguments[1].getStart(sourceFile));
  const end = toLocal(typeArguments[1].getEnd());
  return `${typeText.slice(0, start)}${union}${typeText.slice(end)}`;
}
