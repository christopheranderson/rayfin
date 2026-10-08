/**
 * Type definitions for decorator options and configurations
 *
 * These types define the shape of configuration objects passed to decorators
 * and are used for static analysis and DAB configuration generation.
 */

import type {
  CheckNode,
  ClaimName,
  ClaimsDsl,
  ItemProxy,
  PolicyExpression,
} from './policy.js';

/**
 * The set of actions that a role can be granted on an entity.
 *
 * `'*'` grants all actions. Used by the `@role()` and `@authenticated()` decorators.
 */
export type SimpleAction =
  | 'create'
  | 'read'
  | 'update'
  | 'delete'
  | 'execute'
  | '*';

// Typed policy DSL integration

/**
 * Field-level visibility for a role, restricting which fields the role can access.
 */
export interface FieldPermissions {
  /** Field names the role is allowed to access. When set, all other fields are excluded. */
  include?: string[];
  /** Field names the role is not allowed to access. */
  exclude?: string[];
}

/**
 * A row-level security policy expressed as a database predicate.
 */
export interface DatabasePolicy {
  /** The database policy expression applied to filter rows. */
  database: string;
}

/**
 * A row-level security policy applied to storage (blob) access.
 */
export interface StoragePolicy {
  /**
   * The storage policy expression rendered as a DAB-style string, used for
   * diagnostics and human-readable surfaces. The wire format consumed by the
   * storage service is {@link StoragePolicy.check}.
   */
  storage: string;
  /**
   * Structured JSON-AST representation of the same expression.
   * When present, this is the authoritative form emitted into
   * `StorageFolderRule.check` in the generated storage config.
   */
  check?: CheckNode;
}

/**
 * A row-level security policy, either a {@link DatabasePolicy} or a {@link StoragePolicy}.
 */
export type ActionPolicy = DatabasePolicy | StoragePolicy;

/**
 * A permission entry that pairs an action with optional field visibility and policy.
 */
export interface ComplexAction {
  /** The action being granted. */
  action: SimpleAction;
  /** Optional field-level visibility for this action. */
  fields?: FieldPermissions;
  /** Optional row-level security policy for this action. */
  policy?: ActionPolicy;
}

/**
 * A permission entry: either a bare {@link SimpleAction} or a {@link ComplexAction}
 * with field visibility and policy.
 */
export type PermissionAction = SimpleAction | ComplexAction;

/**
 * A map of role name to the permissions granted to that role.
 */
export interface PermissionConfig {
  [role: string]: PermissionAction[];
}

/**
 * Options for declaring a typed row-level security policy.
 *
 * @typeParam TEntity - The entity type the policy applies to.
 */
export interface PolicyOptions<TEntity extends object = object> {
  /**
   * Builds a policy expression from the request claims and the target item.
   *
   * @param claims - DSL for referencing the authenticated user's claims.
   * @param item - DSL for referencing the target item's fields.
   * @returns The policy expression evaluated to authorize the action.
   */
  check(claims: ClaimsDsl, item: ItemProxy<TEntity>): PolicyExpression;
}

/**
 * Options passed to the `@role()` and `@authenticated()` decorators.
 *
 * @typeParam TEntity - The entity type the role applies to.
 */
export interface RoleDeclarationOptions<TEntity extends object = object> {
  /**
   * Builds a typed row-level security policy from the request claims and target item.
   *
   * @param claims - DSL for referencing the authenticated user's claims.
   * @param item - DSL for referencing the target item's fields.
   * @returns The policy expression evaluated to authorize the action.
   */
  policy?(claims: ClaimsDsl, item: ItemProxy<TEntity>): PolicyExpression;
  /** Field names the role is allowed to access. When set, all other fields are excluded. */
  include?: (keyof TEntity)[];
  /** Field names the role is not allowed to access. */
  exclude?: (keyof TEntity)[];
}

/**
 * A fully-resolved role declaration stored in entity metadata.
 */
export interface RoleDeclaration {
  /** The role name (for example, `'authenticated'` or `'anonymous'`). */
  role: string;
  /** The actions granted to the role. */
  actions: SimpleAction[];
  /** Optional row-level security policy for the role. */
  policy?: PolicyOptions;
  /** Field names the role is allowed to access. */
  includedFields?: string[];
  /** Field names the role is not allowed to access. */
  excludedFields?: string[];
}

/**
 * A human-readable byte size accepted by `@blob({ maxSize })`: a number
 * followed by a unit (`'2mb'`, `'500kb'`, `'1gb'`). The template-literal type
 * rejects malformed strings (e.g. `'2megs'`) at compile time; the CLI
 * normalizes the value to a byte count. Prefer the `bytes`/`kb`/`mb`/`gb`
 * helpers for fully type-checked numeric values.
 */
export type ByteSize = `${number}${'b' | 'kb' | 'mb' | 'gb'}`;

/**
 * A MIME glob for `@blob({ allowedContentTypes })`: `type/subtype`, e.g.
 * `'image/*'` or `'application/pdf'`. The template-literal type enforces the
 * `type/subtype` shape at compile time (catching a missing slash); the
 * `ContentTypes` constants provide autocomplete for common values.
 */
export type MimeGlob = `${string}/${string}`;

/**
 * Options passed to the `@blob()` decorator.
 *
 * Carries folder-level configuration that the Rayfin control plane uses when
 * authorizing requests and minting OneLake SAS URLs.
 */
export interface BlobFolderOptions {
  /**
   * Folder name on disk. Defaults to the normalized class name when omitted.
   *
   * Must be 3-63 characters of `[a-z0-9-]`; the decorator normalizes the
   * value (lowercases, collapses hyphens, etc.).
   */
  name?: string;

  /**
   * What the server does when an object already exists at the resolved path.
   * Defaults to `'error'`.
   *
   * - `'error'`: the server returns a `Conflict` response and never
   *   touches the existing object.
   * - `'overwrite'`: the existing object is replaced. The decorator
   *   generator rejects `'overwrite'` unless at least one non-anonymous
   *   role on the folder is granted `update`, so the requirement is
   *   verified at build time rather than per request.
   *
   * This is the folder default applied when a call omits `onConflict`.
   * A per-call `UploadOptions.onConflict` may supply either value
   * regardless of this default; the server honors `'overwrite'` only when
   * the caller's role grants `update` on the folder, otherwise it returns
   * `PermissionDenied`.
   */
  onConflict?: 'error' | 'overwrite';

  /**
   * Maximum object size accepted by this folder. A bare number is bytes; a
   * string carries a unit (`'2mb'`, `'500kb'`, `'1gb'`). Omit to fall back to
   * the global service limit. Enforced server-side at upload-init (declared
   * size) and at commit (actual size); violations return `TooLarge`. Prefer
   * the `mb`/`kb`/`gb` helpers for type-checked values.
   */
  maxSize?: number | ByteSize;

  /**
   * Allowed content types as MIME globs (for example `'image/*'` or
   * `'application/pdf'`). Omit to allow any content type. Enforced
   * server-side; violations return `UnsupportedContentType`. The
   * `ContentTypes` constants provide typo-safe values for common types.
   */
  allowedContentTypes?: MimeGlob[];
}

export type { ClaimName };
