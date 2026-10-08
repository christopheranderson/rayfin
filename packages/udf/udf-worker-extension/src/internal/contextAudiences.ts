import ts from 'typescript';

/** The context class whose second type argument declares generic connections. */
export const RAYFIN_CONTEXT_TYPE_NAME = 'RayfinContext';

/**
 * Extracting the audience union declared on a handler's context annotation.
 *
 * `RayfinContext<Model, AudienceType.Sql | AudienceType.ADO>` declares two
 * generic connections, but type arguments are erased before the worker runs.
 * The only way those audiences can reach `func()` — which must register the
 * matching `FabricItem` input bindings — is for a build-time pass to read them
 * off the AST and write them into runtime metadata.
 *
 * Two strategies, in order:
 *
 * 1. **Type checker** (preferred). Resolves through aliases and computed types,
 *    so `AppCtx<AudienceType.Sql>` and
 *    `RayfinContext<Model, AudiencesOf<typeof CONNS>>` both collapse to a
 *    concrete union. Also handles handlers with no annotation at all, where the
 *    contextual type supplies the audiences.
 * 2. **Syntax** (fallback, no checker available). Only understands an
 *    annotation written literally as `RayfinContext<Schema, A | B>`.
 */

/** Find the `RayfinContext` type behind a resolved type, looking through unions. */
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

/** Flatten an audience union type into enum member names such as `Sql`. */
function audienceNamesFromType(type: ts.Type): string[] {
  const names: string[] = [];
  const visit = (current: ts.Type): void => {
    if (current.flags & ts.TypeFlags.Never) return;
    if (current.isUnion()) {
      current.types.forEach(visit);
      return;
    }
    // String enum members surface as string-literal types; `.value` is the
    // literal ("Sql"), which is what the binding pipeline keys on.
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

/** Read `AudienceType.Sql` / `Sql` / `'Sql'` out of a type node, syntactically. */
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
      if (!names.includes(current.literal.text))
        names.push(current.literal.text);
      return;
    }
    if (ts.isTypeReferenceNode(current)) {
      const { typeName } = current;
      // `AudienceType.Sql` -> Sql; a bare `Sql` -> Sql.
      const name = ts.isQualifiedName(typeName)
        ? typeName.right.text
        : typeName.text;
      if (name && name !== 'never' && !names.includes(name)) names.push(name);
    }
  };
  visit(node);
  return names;
}

/** True when a type node is written literally as `RayfinContext<...>`. */
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
 * Recover audiences from a context annotation captured as source text.
 *
 * Runtime metadata stores each parameter's annotation in
 * `delegateParameters[].type`, so this is how the worker learns which generic
 * connections to bind **without adding anything to the metadata contract** —
 * the information is already there, and the deploy metadata already carries the
 * matching `FabricItem` bindings.
 *
 * Parsing the text as a type alias reuses the same node walk as the build-time
 * path, so the two agree on unions, qualified names and string literals.
 *
 * Only annotations that spell their audiences out literally can be resolved
 * this way, which is why the CLI normalises the text before writing it —
 * substituting the union its type checker resolved, so an alias arrives here as
 * `AudienceType.Sql` rather than `SqlAccess`. Callers are still expected to
 * validate the names against `AudienceType` and reject anything unrecognised.
 */
export function extractAudiencesFromTypeText(typeText?: string): string[] {
  if (!typeText || !typeText.includes('<')) return [];
  if (!typeText.trimStart().startsWith(RAYFIN_CONTEXT_TYPE_NAME)) {
    // Also allow a namespaced form such as `udf.RayfinContext<...>`.
    if (!typeText.includes(`.${RAYFIN_CONTEXT_TYPE_NAME}`)) return [];
  }

  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(
      '__annotation__.ts',
      `type __A = ${typeText};`,
      ts.ScriptTarget.ES2022,
      true
    );
  } catch {
    return [];
  }

  const alias = sourceFile.statements.find(ts.isTypeAliasDeclaration);
  if (!alias || !isLiteralRayfinContextNode(alias.type)) return [];

  const typeArguments = alias.type.typeArguments;
  if (!typeArguments || typeArguments.length < 2) return [];
  return audienceNamesFromTypeNode(typeArguments[1]).sort();
}

/**
 * Audiences declared by a handler parameter, or `null` when the parameter is
 * not a `RayfinContext` at all.
 *
 * An empty array means "is a context, declares no generic connections" — which
 * is meaningfully different from `null` and must not be collapsed into it.
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
    // The checker is authoritative: if it resolved the parameter and did not
    // find a context, fall through to syntax only when there is an annotation
    // we can still recognise by name (e.g. an unresolved import).
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
 * Handlers take at most one context, but scanning all parameters keeps this
 * independent of the context's position in the signature.
 *
 * Sorted, deliberately: the checker returns a union in its own normalised
 * order while the syntactic fallback returns source order. Sorting makes the
 * two agree, keeps this in parity with the CLI generator, and stops
 * `runtimemetadata.json` from churning between builds.
 */
export function extractHandlerAudiences(
  handler: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
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
