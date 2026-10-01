/**
 * Storage configuration generator
 *
 * Converts analyzed storage folder metadata into the JSON DSL document the
 * Rayfin storage service loads.
 */

import { ComplexAction, PermissionAction, SimpleAction } from '../options.js';
import { CheckNode } from '../policy.js';

import { StorageFolderInfo } from './schema-analyzer.js';

/** @internal Current JSON DSL schema version emitted by the CLI. */
export const STORAGE_CONFIG_SCHEMA_VERSION = 1;

/**
 * @internal Built-in `StorageObject` columns exposed to policy lambdas as
 * `item.<field>`. Used by validation rule 2 to reject `@role`
 * policies that reference fields outside this set and outside the app's own
 * declared `fields[]`.
 */
const INTRINSIC_OBJECT_FIELDS: ReadonlySet<string> = new Set<string>([
  'id',
  'owner_id',
  'folder',
  'path',
  'name',
  'size',
  'content_type',
  'cache_control',
  'content_disposition',
  'etag',
  'created_at',
  'updated_at',
  'last_accessed_at',
  'user_metadata',
]);

/** @internal A single rule entry inside a folder. */
export interface StorageFolderRule {
  /** Path glob the rule applies to. Always `'**'` in v1 (root-level only). */
  pathPattern: '**';
  /** Role name the rule grants permissions to. */
  role: string;
  /** Actions granted to the role on matching paths. */
  actions: SimpleAction[];
  /**
   * Optional row-level check predicate. When present, the storage
   * service must evaluate it against the caller's claims and the resolved
   * object metadata before granting any listed action.
   */
  check?: CheckNode;
}

/**
 * @internal An app-declared field on a `@blob` class, serialized into
 * `storage.objects.user_metadata` at upload time and exposed to the policy
 * DSL as `item.<name>`.
 */
export interface StorageFolderField {
  /** Field name as declared on the class. */
  name: string;
  /** JavaScript-level type: `'string' | 'number' | 'boolean' | 'Date'`. */
  type: string;
  /** `true` when the field was declared with `{ optional: true }`. */
  nullable: boolean;
  /** Physical storage location. Always `'user_metadata'` in v1. */
  storage: 'user_metadata';
}

/** @internal A storage folder entry in the emitted JSON DSL. */
export interface StorageFolder {
  /** Normalized folder name (also the on-disk container name). */
  name: string;
  /** Original `@blob` class name, used for display in tooling. */
  displayName: string;
  /** Server behavior when an object already exists at the resolved path. */
  onConflict: 'error' | 'overwrite';
  /**
   * Maximum object size in bytes. Omitted when the folder declares no cap
   * (the global service limit applies). Enforced server-side at upload-init
   * and at commit.
   */
  maxSize?: number;
  /**
   * Allowed content types as MIME globs (`'image/*'`, `'application/pdf'`).
   * Omitted when any content type is allowed. Enforced server-side.
   */
  allowedContentTypes?: string[];
  /**
   * App-specific typed fields declared on the `@blob` class. Omitted when
   * the folder declares no app fields.
   */
  fields?: StorageFolderField[];
  /** Authorization rules evaluated by the service before minting a SAS. */
  rules: StorageFolderRule[];
}

/** @internal Top-level JSON DSL document emitted by `rayfin storage apply`. */
export interface StorageConfig {
  schemaVersion: typeof STORAGE_CONFIG_SCHEMA_VERSION;
  folders: StorageFolder[];
}

/** @internal Byte multipliers for the `maxSize` size-string units. */
const BYTE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
};

/**
 * @internal Maximum object size a single upload can store. Uploads are
 * single-request SAS `Put Blob` PUTs from the browser/CLI (no block staging),
 * so the ceiling is Azure's single-`Put Blob` limit of 5,000 MiB. A larger
 * `maxSize` could never be honored at upload time, so rule 8 rejects it.
 */
const MAX_OBJECT_SIZE_BYTES = 5_000 * 1024 * 1024; // 5,000 MiB

/**
 * @internal Parse a `maxSize` option into a byte count. Accepts a raw byte
 * number or a unit string (`'2mb'`, `'500kb'`). Returns `NaN` for malformed
 * strings so the caller can raise a folder-scoped validation error.
 */
const parseByteSize = (value: number | string): number => {
  if (typeof value === 'number') return value;
  // Manual, fully bounded tokenization — no regex, so this security-sensitive
  // path (size strings can be attacker-influenced) is inherently linear and
  // cannot regress into ReDoS territory. Consume a leading numeric run (digits
  // with at most one dot), then match the trailing unit against BYTE_UNITS.
  const s = value.trim().toLowerCase();
  let i = 0;
  let dotSeen = false;
  while (i < s.length) {
    const code = s.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      i++;
    } else if (s[i] === '.' && !dotSeen) {
      dotSeen = true;
      i++;
    } else {
      break;
    }
  }
  const numPart = s.slice(0, i);
  const unitPart = s.slice(i).trim();
  if (numPart === '' || numPart === '.' || numPart.endsWith('.')) {
    return Number.NaN;
  }
  const multiplier = unitPart === '' ? 1 : BYTE_UNITS[unitPart];
  if (multiplier === undefined) return Number.NaN;
  return Math.round(Number.parseFloat(numPart) * multiplier);
};

/**
 * @internal Whether `t` is a valid MIME glob: `type/subtype`, `type/*`, or the
 * `*` + `*` full wildcard. Used by validation rule 8.
 *
 * Implemented as a manual single-pass scan (no regex) so this
 * security-sensitive path (content-type strings can be attacker-influenced) is
 * inherently linear and cannot regress into ReDoS territory, matching the
 * regex-free approach used by {@link parseByteSize}.
 */
const isMimeTokenChar = (code: number): boolean =>
  (code >= 48 && code <= 57) || // 0-9
  (code >= 65 && code <= 90) || // A-Z
  (code >= 97 && code <= 122) || // a-z
  code === 95 || // _
  code === 46 || // .
  code === 43 || // +
  code === 45; // -

const isMimeTokenRun = (s: string): boolean => {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    if (!isMimeTokenChar(s.charCodeAt(i))) return false;
  }
  return true;
};

const isMimeGlob = (t: string): boolean => {
  if (t === '*/*') return true;
  const slash = t.indexOf('/');
  // Require exactly one '/', with a non-empty type before it.
  if (slash <= 0 || t.indexOf('/', slash + 1) !== -1) return false;
  const subtype = t.slice(slash + 1);
  if (!isMimeTokenRun(t.slice(0, slash))) return false;
  return subtype === '*' || isMimeTokenRun(subtype);
};

const toSimpleAction = (action: PermissionAction): SimpleAction =>
  typeof action === 'string' ? action : (action as ComplexAction).action;

/**
 * Extract the storage-flavored `check` AST from a {@link PermissionAction},
 * if any. Returns `undefined` for simple-string actions and for complex
 * actions whose policy is database-flavored (those route through the DAB
 * config generator and never reach storage rules).
 */
const extractStorageCheck = (
  action: PermissionAction
): CheckNode | undefined => {
  if (typeof action === 'string') return undefined;
  const policy = (action as ComplexAction).policy;
  if (!policy || !('storage' in policy)) return undefined;
  return policy.check;
};

/**
 * Generates the storage JSON DSL from analyzed storage folders.
 */
/** @internal */
export class StorageConfigGenerator {
  /**
   * Generate the JSON DSL document. Enforces compile-time validation rules
   * 2, 3, 6, 7, 8, and 9. Rule 5 (no subquery primitives) is
   * enforced upstream when {@link CheckNode} is built by
   * `serializeCheckToAst`; rule 4 (path patterns) is deferred until
   * `@pathRole` lands.
   */
  generateConfig(folders: StorageFolderInfo[]): StorageConfig {
    const entries: StorageFolder[] = [];
    // Maps the normalized container name -> the display/class name that
    // produced it, so a collision can name both offending classes
    // unambiguously (see validateFolderNameUniqueness).
    const seenFolderNames = new Map<string, string>();

    for (const folder of folders) {
      this.validateFolder(folder);
      this.validateFolderNameUniqueness(folder, seenFolderNames);
      this.validatePolicyRefs(folder);
      this.validateFieldNames(folder);

      const entry: StorageFolder = {
        name: folder.folderName,
        displayName: folder.name,
        onConflict: folder.onConflict,
        rules: this.buildRules(folder.permissions),
      };

      if (folder.fields.length > 0) {
        entry.fields = folder.fields.map((f) => ({
          name: f.name,
          type: f.type,
          nullable: f.nullable,
          storage: 'user_metadata' as const,
        }));
      }

      if (folder.maxSize !== undefined) {
        entry.maxSize = parseByteSize(folder.maxSize);
      }

      if (folder.allowedContentTypes && folder.allowedContentTypes.length > 0) {
        entry.allowedContentTypes = [...folder.allowedContentTypes];
      }

      entries.push(entry);
    }

    // Emit folders in a stable order (by normalized container name) so the
    // JSON DSL is deterministic regardless of class-discovery order. Names
    // are unique per rule 3, so the ordering is total.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    return {
      schemaVersion: STORAGE_CONFIG_SCHEMA_VERSION,
      folders: entries,
    };
  }

  /**
   * Convert decorator permissions into the rule array shape required by the
   * service. Roles are emitted in alphabetical order to keep output stable
   * across runs; within a role, actions with the same `check` predicate are
   * grouped into a single rule and actions with distinct predicates split into
   * separate rules.
   */
  private buildRules(permissions: {
    [role: string]: PermissionAction[];
  }): StorageFolderRule[] {
    const out: StorageFolderRule[] = [];
    for (const role of Object.keys(permissions).sort()) {
      // Group this role's actions by the JSON-serialized shape of their
      // `check` predicate. Actions with no predicate share the synthetic
      // "__none__" bucket so they collapse into a single check-less rule.
      const groups = new Map<
        string,
        { check?: CheckNode; actions: SimpleAction[] }
      >();
      for (const entry of permissions[role]) {
        const action = toSimpleAction(entry);
        const check = extractStorageCheck(entry);
        const key = check ? JSON.stringify(check) : '__none__';
        let bucket = groups.get(key);
        if (!bucket) {
          bucket = { check, actions: [] };
          groups.set(key, bucket);
        }
        bucket.actions.push(action);
      }
      // Sort the rule groups by key for deterministic output; "__none__"
      // sorts ahead of any concrete JSON object. Actions inside each group
      // are emitted in the order the analyzer produced them (CRUD order,
      // because `SchemaAnalyzer.sortActions` runs before this).
      for (const key of [...groups.keys()].sort()) {
        const bucket = groups.get(key)!;
        const rule: StorageFolderRule = {
          pathPattern: '**' as const,
          role,
          actions: bucket.actions,
        };
        if (bucket.check) {
          rule.check = bucket.check;
        }
        out.push(rule);
      }
    }
    return out;
  }

  /**
   * Enforce compile-time validation rules 6, 7, and 8.
   *
   * - Rule 6: storage folders reject anonymous permissions because the storage
   *   data plane requires an authenticated caller.
   * - Rule 7: `onConflict: 'overwrite'` requires at least one role to grant
   *   the `update` action.
   * - Rule 8: `maxSize` must be a positive byte count and
   *   `allowedContentTypes` entries must be well-formed MIME globs.
   */
  private validateFolder(folder: StorageFolderInfo): void {
    if ((folder.permissions.anonymous?.length ?? 0) > 0) {
      throw new Error(
        `@blob('${folder.name}'): anonymous permissions are not supported ` +
          `for storage folders. Remove the anonymous role and grant access ` +
          `to the authenticated role instead.`
      );
    }

    if (folder.onConflict === 'overwrite') {
      // `'*'` grants every action, so a wildcard role satisfies the
      // update requirement just as an explicit `'update'` does.
      const grantsUpdate = Object.entries(folder.permissions).some(
        ([role, actions]) =>
          role !== 'anonymous' &&
          actions.map(toSimpleAction).some((a) => a === 'update' || a === '*')
      );
      if (!grantsUpdate) {
        throw new Error(
          `@blob('${folder.name}'): onConflict: 'overwrite' requires at ` +
            `least one authenticated role to grant the 'update' action. ` +
            `Add 'update' to a role or set onConflict: 'error'.`
        );
      }
    }

    if (folder.maxSize !== undefined) {
      const bytes = parseByteSize(folder.maxSize);
      if (!Number.isInteger(bytes) || bytes <= 0) {
        throw new Error(
          `@blob('${folder.name}'): maxSize must be a positive whole byte ` +
            `count or size string (e.g. '2mb'); got ` +
            `${JSON.stringify(folder.maxSize)}.`
        );
      }
      if (bytes > MAX_OBJECT_SIZE_BYTES) {
        throw new Error(
          `@blob('${folder.name}'): maxSize (${bytes} bytes) exceeds the ` +
            `maximum supported object size of ${MAX_OBJECT_SIZE_BYTES} bytes ` +
            `(5,000 MiB). Uploads are single-request PUTs and cannot exceed ` +
            `the Azure single-upload limit.`
        );
      }
    }

    if (folder.allowedContentTypes) {
      const malformed = folder.allowedContentTypes.filter(
        (t) => !isMimeGlob(t)
      );
      if (malformed.length > 0) {
        throw new Error(
          `@blob('${folder.name}'): allowedContentTypes contains malformed ` +
            `MIME glob(s): ${malformed.join(', ')}. Use forms like ` +
            `'image/*' or 'application/pdf'.`
        );
      }
    }
  }

  /**
   * Enforce rule 3 — the normalized folder name (which becomes the
   * on-disk container name) must be unique within a project. Two distinct
   * `@blob` classes whose names normalize to the same string would silently
   * share storage and produce undefined behavior, so we fail fast and point
   * the builder at both source classes.
   */
  private validateFolderNameUniqueness(
    folder: StorageFolderInfo,
    seen: Map<string, string>
  ): void {
    const existing = seen.get(folder.folderName);
    if (existing !== undefined) {
      throw new Error(
        `@blob folder name collision: '${folder.folderName}' is produced ` +
          `by both '${existing}' and '${folder.name}'. Rename one of the ` +
          `classes or pass a distinct name to @blob() so the normalized ` +
          `container names differ.`
      );
    }
    seen.set(folder.folderName, folder.name);
  }

  /**
   * Enforce rule 2 — every `item.<field>` reference inside a role
   * policy must resolve to either an intrinsic `StorageObject` column
   * or a field declared on the `@blob` class. Claim references
   * are restricted to {@link ClaimName} at compile time via the policy DSL,
   * so we only need to validate field references here.
   */
  private validatePolicyRefs(folder: StorageFolderInfo): void {
    const declaredFields = new Set(folder.fields.map((f) => f.name));
    for (const [role, actions] of Object.entries(folder.permissions)) {
      for (const action of actions) {
        const check = extractStorageCheck(action);
        if (!check) continue;
        for (const fieldName of collectFieldRefs(check)) {
          if (
            INTRINSIC_OBJECT_FIELDS.has(fieldName) ||
            declaredFields.has(fieldName)
          ) {
            continue;
          }
          throw new Error(
            `@blob('${folder.name}'): role '${role}' policy references ` +
              `unknown field 'item.${fieldName}'. Declare the field on the ` +
              `@blob class (e.g. @text() ${fieldName}!: string) or use ` +
              `one of the intrinsic StorageObject fields ` +
              `(${[...INTRINSIC_OBJECT_FIELDS].sort().join(', ')}).`
          );
        }
      }
    }
  }

  /**
   * Enforce rule 9 — an app-declared `@blob` field must not collide
   * (case-insensitively) with a built-in {@link StorageObjectRef} intrinsic
   * (`id`, `path`, `size`, `owner_id`, ...). A colliding field would silently
   * shadow the server-managed column: the app value would land in
   * `user_metadata` while the intrinsic occupies the typed column, and the
   * SDK's `StorageObjectRef & <class>` intersection would narrow the property
   * to `never` when the declared type differs from the intrinsic's.
   */
  private validateFieldNames(folder: StorageFolderInfo): void {
    const intrinsics = new Set(
      [...INTRINSIC_OBJECT_FIELDS].map((f) => f.toLowerCase())
    );
    for (const field of folder.fields) {
      if (intrinsics.has(field.name.toLowerCase())) {
        throw new Error(
          `@blob('${folder.name}'): field '${field.name}' conflicts with a ` +
            `built-in StorageObject field. Built-in fields ` +
            `(${[...INTRINSIC_OBJECT_FIELDS].sort().join(', ')}) are managed ` +
            `by the service; rename the field on the @blob class.`
        );
      }
    }
  }
}

/**
 * Walk a {@link CheckNode} tree and yield every field name referenced on
 * either side of a comparison. Used by validation rule 2.
 */
function* collectFieldRefs(node: CheckNode): IterableIterator<string> {
  if ('args' in node) {
    for (const arg of node.args) {
      yield* collectFieldRefs(arg);
    }
    return;
  }
  if ('field' in node.lhs) {
    yield node.lhs.field;
  }
  if (
    typeof node.rhs === 'object' &&
    node.rhs !== null &&
    'field' in node.rhs
  ) {
    yield node.rhs.field;
  }
}
