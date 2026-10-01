/**
 * Declaration-only base class exposing the intrinsic `StorageObject` fields
 * (the server-managed columns) so that `@blob` classes can reference them in
 * policies with full type-safety.
 *
 * A storage policy may compare a claim to an intrinsic field, e.g.
 * `policy: (claims, item) => claims.sub.eq(item.owner_id)`. Because the policy
 * `item` proxy is typed to the target class's fields, the intrinsic field must
 * appear on the class for the reference to type-check. Extending
 * `StorageObject` makes every intrinsic available without re-declaring it.
 *
 * These properties are `declare`d, so they emit no runtime code and carry no
 * cost. They are also NOT registered as app fields (only `@text`/`@number`/…
 * decorated properties become `user_metadata` fields), so extending this class
 * never adds columns and never triggers the intrinsic-collision rule.
 *
 * Extending this class is the ergonomic option, but not required: you may
 * instead declare only the intrinsic you reference as an undecorated property
 * (e.g. `owner_id!: string;`) — the effect on the policy `item` type is
 * identical. A decorator cannot inject these fields into the class type, so one
 * of the two forms is needed for the reference to type-check.
 *
 * @experimental Part of the preview storage surface; may change before GA
 * (see https://github.com/microsoft/project-rayfin/issues/1523).
 *
 * @example
 * ```ts
 * @blob('team-files')
 * @role('authenticated', '*', {
 *   policy: (claims, item) => claims.sub.eq(item.owner_id),
 * })
 * class TeamFiles extends StorageObject {
 *   @text() team_id!: string;
 * }
 * ```
 */
export abstract class StorageObject {
  /** Server-assigned object identifier. */
  declare readonly id: string;
  /** The authenticated owner's `jwt.sub`. */
  declare readonly owner_id: string;
  /** The folder (container) the object lives in. */
  declare readonly folder: string;
  /** The caller-facing logical path. */
  declare readonly path: string;
  /** The object name (final path segment). */
  declare readonly name: string;
  /** Size in bytes. */
  declare readonly size: number;
  /** MIME content type. */
  declare readonly content_type: string;
  /** `Cache-Control` header value. */
  declare readonly cache_control: string;
  /** `Content-Disposition` header value. */
  declare readonly content_disposition: string;
  /** Entity tag for concurrency/caching. */
  declare readonly etag: string;
  /** Creation timestamp (ISO-8601). */
  declare readonly created_at: string;
  /** Last-modified timestamp (ISO-8601). */
  declare readonly updated_at: string;
  /** Last-accessed timestamp (ISO-8601). */
  declare readonly last_accessed_at: string;
}
