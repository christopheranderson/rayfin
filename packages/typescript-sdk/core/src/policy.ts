/**
 * Typed policy builder DSL for Rayfin permissions.
 *
 * Used inside `@role()`/`@authenticated()` policy callbacks to express
 * row-level security rules with `claims` and `item`. The same DSL serves two
 * targets: data `@entity` classes (serialized to DAB predicates) and storage
 * `@blob` classes (serialized to the JSON check AST via
 * {@link serializeCheckToAst}).
 *
 * @example
 * ```typescript
 * @authenticated('*', {
 *   policy: (claims, item) => claims.sub.eq(item.user_id),
 * })
 * export class Todo {}
 * ```
 */

/**
 * The names of claims available on the authenticated user's token.
 *
 * - `sub` — the user's unique identifier.
 * - `email` — the user's email address.
 * - `role` — the user's role.
 */
export type ClaimName = 'sub' | 'email' | 'role';

/**
 * A composable policy expression that serializes to a DAB policy predicate.
 */
export interface PolicyExpression {
  /** Serializes the expression to its DAB policy string form. */
  toString(): string;
  /**
   * Combines this expression with another using logical AND.
   *
   * @param expr - The expression to AND with this one.
   * @returns A new combined expression.
   */
  and(expr: PolicyExpression): PolicyExpression;
  /**
   * Combines this expression with another using logical OR.
   *
   * @param expr - The expression to OR with this one.
   * @returns A new combined expression.
   */
  or(expr: PolicyExpression): PolicyExpression;
}

/** Supported comparison operators in policy expressions. */
export type ComparisonOperator = 'eq' | 'ne';
/** Supported logical operators in policy expressions. */
export type LogicalOperator = 'and' | 'or';

/**
 * Base class for policy expressions, providing the `and`/`or` combinators.
 */
export abstract class BaseExpression implements PolicyExpression {
  /** Serializes the expression to its DAB policy string form. */
  abstract toString(): string;

  /**
   * Combines this expression with another using logical AND.
   *
   * @param expr - The expression to AND with this one.
   * @returns A new combined expression.
   */
  and(expr: PolicyExpression): PolicyExpression {
    return new LogicalExpression('and', this, expr);
  }

  /**
   * Combines this expression with another using logical OR.
   *
   * @param expr - The expression to OR with this one.
   * @returns A new combined expression.
   */
  or(expr: PolicyExpression): PolicyExpression {
    return new LogicalExpression('or', this, expr);
  }
}

/**
 * A reference to a claim on the authenticated user's token (for example, `claims.sub`).
 *
 * @typeParam T - The claim name this reference points to.
 */
export class ClaimRef<T extends ClaimName = ClaimName> extends BaseExpression {
  /**
   * @param name - The claim name this reference points to.
   */
  constructor(public readonly name: T) {
    super();
  }

  /**
   * Builds an equality comparison against the given value.
   *
   * @param value - The value or expression to compare against.
   * @returns A comparison expression (`claim eq value`).
   */
  eq(value: Operand): PolicyExpression {
    return new ComparisonExpression(this, 'eq', value);
  }

  /**
   * Builds an inequality comparison against the given value.
   *
   * @param value - The value or expression to compare against.
   * @returns A comparison expression (`claim ne value`).
   */
  neq(value: Operand): PolicyExpression {
    return new ComparisonExpression(this, 'ne', value);
  }

  /** Serializes the claim reference (for example, `@claims.sub`). */
  toString(): string {
    return `@claims.${this.name}`;
  }
}

/**
 * A reference to a field on the target item (for example, `item.user_id`).
 */
export class FieldRef extends BaseExpression {
  /**
   * @param name - The field name this reference points to.
   */
  constructor(public readonly name: string) {
    super();
  }

  /**
   * Builds an equality comparison against the given value.
   *
   * @param value - The value or expression to compare against.
   * @returns A comparison expression (`field eq value`).
   */
  eq(value: Operand): PolicyExpression {
    return new ComparisonExpression(this, 'eq', value);
  }

  /**
   * Builds an inequality comparison against the given value.
   *
   * @param value - The value or expression to compare against.
   * @returns A comparison expression (`field ne value`).
   */
  neq(value: Operand): PolicyExpression {
    return new ComparisonExpression(this, 'ne', value);
  }

  /** Serializes the field reference (for example, `@item.user_id`). */
  toString(): string {
    return `@item.${this.name}`;
  }
}

/**
 * A value that can appear on either side of a comparison: an expression,
 * primitive, `Date`, or `null`.
 */
export type Operand = BaseExpression | string | number | boolean | Date | null;

/**
 * A comparison between two operands (for example, `@claims.sub eq @item.user_id`).
 */
export class ComparisonExpression extends BaseExpression {
  /**
   * @param left - The left-hand operand.
   * @param operator - The comparison operator.
   * @param right - The right-hand operand.
   */
  constructor(
    public readonly left: Operand,
    public readonly operator: ComparisonOperator,
    public readonly right: Operand
  ) {
    super();
  }

  /** Serializes the comparison to its DAB policy string form. */
  toString(): string {
    return `${serializeOperand(this.left)} ${this.operator} ${serializeOperand(this.right)}`;
  }
}

/**
 * A logical combination of two expressions (for example, `(...) and (...)`).
 */
export class LogicalExpression extends BaseExpression {
  /**
   * @param operator - The logical operator (`and` or `or`).
   * @param left - The left-hand expression.
   * @param right - The right-hand expression.
   */
  constructor(
    public readonly operator: LogicalOperator,
    public readonly left: PolicyExpression,
    public readonly right: PolicyExpression
  ) {
    super();
  }

  /** Serializes the logical expression to its DAB policy string form. */
  toString(): string {
    return `(${this.left.toString()}) ${this.operator} (${this.right.toString()})`;
  }
}

function serializeOperand(value: Operand): string {
  if (value instanceof BaseExpression) {
    return value.toString();
  }

  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string') {
    // Escape single quotes by doubling them per OData/DAB conventions
    const escaped = value.replace(/'/g, "''");
    return `'${escaped}'`;
  }

  if (value instanceof Date) {
    // DAB filter/policy grammar requires UNQUOTED ISO-8601 UTC literals for
    // date/datetime operands (e.g. `2020-01-01T00:00:00.000Z`). A quoted value
    // is parsed as an Edm.String and rejected. Callers must pass a Date — not an
    // ISO string — for date/datetime comparisons, since strings stay quoted.
    // https://learn.microsoft.com/azure/data-api-builder/keywords/filter-rest
    return value.toISOString();
  }

  return String(value);
}

/**
 * A typed proxy over the target type's fields, exposing each field as a
 * {@link FieldRef} for use in policy expressions. `T` is whatever class the
 * policy targets — a data `@entity` or a storage `@blob` class — so each
 * property name on `T` (and only those) becomes referenceable as
 * `item.<field>`.
 *
 * @typeParam T - The target type whose fields are exposed (a data entity or a
 *   storage `@blob` class).
 */
export type ItemProxy<T = unknown> = (T extends object
  ? {
      [K in keyof T]-?: FieldRef;
    }
  : {}) & {
  readonly [Symbol.toStringTag]?: 'ItemProxy';
};

/**
 * The DSL for referencing the authenticated user's claims in a policy expression.
 */
export type ClaimsDsl = {
  /** Reference to the `sub` (subject/user id) claim. */
  sub: ClaimRef<'sub'>;
  /** Reference to the `email` claim. */
  email: ClaimRef<'email'>;
  /** Reference to the `role` claim. */
  role: ClaimRef<'role'>;
};

/**
 * Creates an {@link ItemProxy} that resolves any accessed property to a {@link FieldRef}.
 *
 * @typeParam T - The target type whose fields are exposed (a data entity or a
 *   storage `@blob` class).
 * @returns A proxy where each field access yields a field reference.
 */
export function createItemProxy<T = unknown>(): ItemProxy<T> {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === Symbol.toStringTag) {
          return 'ItemProxy';
        }
        if (typeof prop === 'string') {
          return new FieldRef(prop);
        }
        return undefined;
      },
    }
  ) as ItemProxy<T>;
}

/**
 * The root claims DSL used inside policy callbacks (for example, `claims.sub.eq(...)`).
 */
export const claims: ClaimsDsl = {
  sub: new ClaimRef('sub'),
  email: new ClaimRef('email'),
  role: new ClaimRef('role'),
};

/**
 * A generic, untyped item proxy for convenience where a typed entity is not available.
 */
export const item: ItemProxy<Record<string, unknown>> =
  createItemProxy<Record<string, unknown>>();

// ---------------------------------------------------------------------------
// JSON DSL AST (emitted in storage rules so the storage service can
// interpret rules without a TypeScript runtime).
// ---------------------------------------------------------------------------

/** A reference to a JWT claim or a typed item field, as it appears in the JSON DSL. */
export type CheckRef = { claim: ClaimName } | { field: string };

/** A literal RHS value supported by the JSON DSL. */
export type CheckLiteral = string | number | boolean | null;

/** A leaf comparison node: `<lhs> <op> <rhs>` with `op ∈ {eq, neq}`. */
export interface CheckLeaf {
  op: 'eq' | 'neq';
  lhs: CheckRef;
  rhs: CheckRef | CheckLiteral;
}

/** A boolean combinator node with two or more operands. */
export interface CheckBranch {
  op: 'and' | 'or';
  args: [CheckNode, CheckNode, ...CheckNode[]];
}

/** A node in the JSON DSL check tree. */
export type CheckNode = CheckLeaf | CheckBranch;

/**
 * Serialize a {@link PolicyExpression} tree built by the policy DSL into the
 * JSON-AST shape consumed by the storage service. This is the wire format
 * emitted into `StorageFolderRule.check`.
 *
 * The expression tree is the *same* object returned by a policy lambda — there
 * is no re-parsing of the `.toString()` form. v1 supports comparison operators
 * (`eq`, `neq`) and boolean combinators (`and`, `or`) over scalar `claims.*`
 * and `item.<field>` references.
 *
 * @param expr - The policy expression to serialize.
 * @returns The JSON DSL check node.
 * @throws If the expression contains a node kind not supported in v1
 *   (for example, subquery primitives or unbound references).
 */
export function serializeCheckToAst(expr: PolicyExpression): CheckNode {
  if (expr instanceof LogicalExpression) {
    return {
      op: expr.operator,
      args: [serializeCheckToAst(expr.left), serializeCheckToAst(expr.right)],
    };
  }
  if (expr instanceof ComparisonExpression) {
    return {
      op: comparisonOperatorToCheckOp(expr.operator),
      lhs: operandToCheckRef(expr.left, 'lhs'),
      rhs: operandToCheckRhs(expr.right),
    };
  }
  throw new Error(
    `Unsupported policy expression for storage check AST: ` +
      `${
        (expr as { constructor?: { name?: string } } | null | undefined)
          ?.constructor?.name ?? typeof expr
      }. ` +
      `v1 storage policies support only flat boolean expressions over ` +
      `claims.{sub,email,role} and item.<field> using eq, neq, and, and or ` +
      `(subquery primitives such as Entity.where(...) or ` +
      `.in(...) are deferred to a future DSL extension).`
  );
}

function comparisonOperatorToCheckOp(
  operator: ComparisonOperator
): CheckLeaf['op'] {
  switch (operator) {
    case 'eq':
      return 'eq';
    case 'ne':
      return 'neq';
    default:
      return assertUnsupportedComparisonOperator(operator);
  }
}

function assertUnsupportedComparisonOperator(operator: never): never {
  throw new Error(
    `Unsupported comparison operator for storage check AST: ${String(operator)}`
  );
}

/** Convert an operand to a {@link CheckRef}. Used for the LHS of a comparison. */
function operandToCheckRef(value: Operand, side: 'lhs' | 'rhs'): CheckRef {
  if (value instanceof ClaimRef) {
    return { claim: value.name };
  }
  if (value instanceof FieldRef) {
    return { field: value.name };
  }
  throw new Error(
    `Policy comparison ${side} must be a claim or field reference; ` +
      `got ${typeof value === 'object' && value !== null ? value.constructor.name : typeof value}`
  );
}

/** Convert an operand to a {@link CheckRef} or a {@link CheckLiteral}. */
function operandToCheckRhs(value: Operand): CheckRef | CheckLiteral {
  if (value instanceof ClaimRef || value instanceof FieldRef) {
    return operandToCheckRef(value, 'rhs');
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (value instanceof Date) {
    // Dates serialize to ISO-8601 strings in the JSON DSL; the storage
    // service binds them as DATETIME2 parameters.
    return value.toISOString();
  }
  throw new Error(
    `Unsupported policy comparison rhs for storage check AST: ${typeof value}`
  );
}
