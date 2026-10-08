/**
 * System entities for \@microsoft/rayfin-core
 *
 * These represent built-in entities managed by the Rayfin platform backend.
 * They are readonly and can be referenced for foreign keys and querying,
 * but cannot be created, updated, or deleted through DAB.
 */

/**
 * Built-in User entity representing the system's user table.
 * This is a readonly entity managed by the Rayfin platform backend.
 * Only safe fields are exposed - no passwords or sensitive data.
 */
export class User {
  /** The unique identifier of the user. */
  readonly Id!: string;
  /** The user's email address. */
  readonly Email!: string;
}

/**
 * Set of system entity names that are always valid relationship targets.
 * These entities are managed by the Rayfin platform and do not need to be
 * included in user schema arrays.
 */
export const SystemEntityNames = new Set([User.name]);
