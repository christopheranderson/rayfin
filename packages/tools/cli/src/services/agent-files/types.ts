/**
 * Type definitions for the `rayfin init ai-files` subsystem.
 *
 * The CLI tracks a small set of "managed items" — currently the Rayfin platform skill at
 * `.agents/skills/rayfin/SKILL.md` and the Rayfin MCP server entry at `.mcp.json` —
 * recording each in `rayfin/.lockfile.json` so subsequent CLI versions can update them.
 *
 * The lockfile shape and ID scheme are deliberately namespace-extensible: items are keyed
 * by `${namespace}:${name}` so future concerns (deployments, generated SDKs, registry
 * artifacts) can adopt the same shape without colliding with ai-files items.
 *
 * AGENTS.md is intentionally not tracked: it is one-time install (template-provided or
 * default), never updated by the CLI after scaffold.
 */

/** Categories of CLI-managed agent-file items. */
export type ItemKind = 'skill' | 'mcp';

/**
 * Namespaced identifier for any item recorded in the lockfile.
 *
 * Format: `${namespace}:${name}` where namespace is alphanumeric (plus `_-`)
 * and name is the same. The lockfile is namespace-extensible per spec —
 * future CLI concerns (e.g. `deployment:prod`) can record their own items
 * under fresh namespaces without breaking existing readers.
 *
 * `ManagedItemId` is the narrower type that the ai-files subsystem actually
 * manages today (`skill:` or `mcp:` only).
 */
export type ItemId = `${string}:${string}`;
export type ManagedItemId = `${ItemKind}:${string}`;

/**
 * Minimal reference to a managed item — kind + name. Used by strategies for
 * read/delete operations and by orphan cleanup, which has no descriptor (the
 * CLI no longer ships the asset). Descriptor extends this with the bundled
 * asset path for install/update.
 */
export interface ItemRef {
  /** Item kind. Determines which strategy handles this descriptor. */
  readonly kind: ItemKind;

  /**
   * Item name. Used in the lockfile and to construct the on-disk path:
   * - skill: `.agents/skills/<name>/SKILL.md`
   * - mcp:   key `mcpServers.<name>` inside `.mcp.json`
   */
  readonly name: string;
}

/**
 * Describes a single Rayfin-managed item the CLI ships.
 *
 * The descriptor table is the source of truth for "what does this CLI version manage?".
 * Adding a new managed item is a one-line append plus a new bundled asset file.
 */
export interface Descriptor extends ItemRef {
  /**
   * Path to the bundled asset relative to the CLI package's
   * `assets/agent-files/` directory.
   *
   * For skill: a SKILL.md file (frontmatter is overwritten at write time).
   * For mcp:   a JSON file containing the value placed at `mcpServers.<name>`.
   */
  readonly bundledAsset: string;
}

/**
 * Validates the on-disk shape of a lockfile item id. Permissive — accepts any
 * `<namespace>:<name>` pair so future namespaces don't break readers.
 *
 * Use `isManagedItemId` instead at the CLI argument boundary to reject
 * unknown namespaces with a clear error.
 */
const LOCKFILE_ITEM_ID_REGEX = /^[A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9_-]+$/;
const MANAGED_ITEM_ID_REGEX = /^(skill|mcp):[A-Za-z0-9_-]+$/;

export function isItemId(value: string): value is ItemId {
  return LOCKFILE_ITEM_ID_REGEX.test(value);
}

/**
 * Stricter check: only ai-files-managed `skill:` or `mcp:` ids. Used by the
 * CLI argument parser so `--enable deployment:prod` is rejected at the
 * boundary instead of silently accepted (the manager only iterates its
 * own descriptors and would no-op).
 */
export function isManagedItemId(value: string): value is ManagedItemId {
  return MANAGED_ITEM_ID_REGEX.test(value);
}

/**
 * Provenance — identifies which producer installed an item, so future
 * multi-producer scenarios (template-shipped extensions, registry-fetched
 * artifacts) can gate updates and orphan cleanup on producer authority.
 *
 * Phase 1 ships only one producer (the CLI itself), so the source field
 * is recorded but doesn't drive behavior yet. Legacy lockfile records
 * without a source field are normalized to the CLI producer on read.
 *
 * Full Phase 2 design is captured in `openspec/specs/rayfin-skills/spec.md`
 * Future Work § "Provenance and producer authority".
 */
export interface ItemSource {
  /** Producer kind. Phase 1 only emits 'cli'; 'template' lands in Phase 2. */
  readonly kind: 'cli' | 'template';
  /**
   * Producer identifier — for `cli`, the package name (e.g. `@microsoft/rayfin-cli`).
   * For `template`, the template id from `rayfin-template.yml`.
   */
  readonly id: string;
  /**
   * Producer version or content sha at install time. Diagnostic only —
   * decision gating still uses `sha256` for content drift.
   */
  readonly versionOrSha?: string;
}

/** Per-item lockfile record. */
export interface ItemRecord {
  /** sha256 of the canonical content as written. `null` when disabled-at-install (no file ever written). */
  readonly sha256: string | null;
  /**
   * User has explicitly disabled this item. The CLI does not manage the
   * on-disk file (if any) until the item is re-enabled.
   */
  readonly disabled?: boolean;
  /**
   * Producer that wrote this item. Optional in the on-disk schema for
   * forward compatibility with legacy records — readers normalize missing
   * sources to `{ kind: 'cli', id: '@microsoft/rayfin-cli' }`. Writers
   * always populate it.
   */
  readonly source?: ItemSource;
}

/**
 * Schema version 1 of `rayfin/.lockfile.json`.
 *
 * The shape is concern-agnostic: items are namespaced via the `ItemId` prefix
 * (`skill:rayfin`, `mcp:rayfin`, ...) so future concerns can extend the same
 * lockfile (or adopt this shape in their own file) without colliding.
 */
export interface Lockfile {
  readonly version: 1;
  /** CLI version that last installed/updated. Diagnostic only — not a decision gate. */
  readonly cliVersion: string;
  /** All managed items, keyed by namespaced id (`skill:rayfin`, `mcp:rayfin`, ...). */
  readonly items: Readonly<Record<ItemId, ItemRecord>>;
}

/**
 * Per-item state computed by `status()`. Drives all command behavior.
 */
export type ItemState =
  /** Item is on disk; sha matches lockfile and bundled content. */
  | { readonly kind: 'up-to-date' }

  /** Item is on disk; sha matches lockfile but bundled content has changed. */
  | { readonly kind: 'update-available' }

  /** Item is on disk but content has been modified since last CLI write. */
  | {
      readonly kind: 'user-modified';
      readonly recordedSha: string | null;
    }

  /** Item was previously installed but is missing from disk now. */
  | { readonly kind: 'missing' }

  /** Descriptor exists but item is not in the lockfile. */
  | { readonly kind: 'not-installed' }

  /** User has explicitly disabled this item via `--disable <id>` or by removing the rayfin-managed sigil. */
  | { readonly kind: 'disabled' }

  /** Item exists in the lockfile but the current CLI no longer ships a descriptor for it. */
  | { readonly kind: 'orphaned' }

  /**
   * On-disk content could not be read or parsed (e.g., malformed JSON). Surfaced
   * per-item so unrelated items remain operable.
   */
  | {
      readonly kind: 'unreadable';
      readonly message: string;
    };

export interface ItemStatus {
  readonly id: ItemId;
  readonly state: ItemState;
}

/** Options for `install()` / `update()`. */
export interface UpdateOptions {
  /**
   * Overwrite user-modified items, re-create missing items, force orphan cleanup.
   * - `true` / `false`: applies to every managed item (legacy global force).
   * - `ReadonlySet<ItemId>`: per-item scope — force is applied only to the listed
   *   ids; other items use default behavior (warn instead of overwrite).
   *   An empty set is equivalent to `false` (no force).
   */
  readonly force?: boolean | ReadonlySet<ItemId>;
  /** Scope the operation to specific items. If omitted, all items are considered. */
  readonly ids?: readonly ItemId[];
  /**
   * Per-item enable/disable transitions. `enable[id] === true` enables the item;
   * `enable[id] === false` disables it. Items not in the map keep their current
   * disabled state.
   */
  readonly enable?: Readonly<Record<ItemId, boolean>>;
  /**
   * When transitioning an item to disabled, also remove its on-disk content.
   * Without this flag, disable preserves on-disk content (just stops managing).
   */
  readonly removeFiles?: boolean;
  /**
   * For `install` only: when true (default when stdin is a TTY and no per-item
   * flags are provided), present an interactive prompt for item selection and
   * conflict resolution.
   */
  readonly interactive?: boolean;
  /**
   * When true, classify items and produce an `UpdateReport` describing what
   * `install` would do — but skip every disk write (no atomic file writes,
   * no lockfile flush, no orphan deletion). Pairs with the CLI's `--dry-run`
   * flag for previewability. The full plan/apply separation that this flag
   * partially fulfills is captured in `openspec/specs/rayfin-skills/spec.md`
   * Future Work § "Plan / apply separation".
   */
  readonly dryRun?: boolean;
}

/** Summary of changes from `install()` / `update()`. */
export interface UpdateReport {
  /** Items that were re-written from bundled content (sha or version differed). */
  readonly updated: readonly ItemId[];
  /** Items written for the first time (or restored). */
  readonly installed: readonly ItemId[];
  /** Items removed (orphaned cleanup, --disable --remove-files). */
  readonly removed: readonly ItemId[];
  /** Items transitioned to or from disabled. */
  readonly disabled: readonly ItemId[];
  readonly enabled: readonly ItemId[];
  /** Items that need user attention. */
  readonly warnings: readonly {
    readonly id: ItemId;
    readonly reason: 'user-modified' | 'missing' | 'unreadable';
    readonly message?: string;
  }[];
  /** Items skipped because they are disabled. */
  readonly skipped: readonly {
    readonly id: ItemId;
    readonly reason: 'disabled';
  }[];
}
