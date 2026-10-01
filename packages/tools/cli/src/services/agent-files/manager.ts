/**
 * `AgentFilesManager` — orchestrates installation and updates of Rayfin-managed agent
 * files in a project.
 *
 * This is the only public surface of the agent-files service. Commands are thin shells
 * that construct the manager and call one method.
 *
 * Responsibilities:
 * - Maintain the `rayfin/.lockfile.json` lockfile.
 * - Drive each managed item through its lifecycle (install / update / opt-out / restore).
 * - Apply per-file-type behaviour via the strategy registry.
 * - Handle AGENTS.md as a separate one-time install path (never tracked, never updated).
 *
 * Design notes:
 * - Adoption: when the lockfile is missing but on-disk content carries a managed sigil
 *   (skill) or matches the bundled content exactly (mcp), the item is silently adopted
 *   into a fresh lockfile. This recovers cleanly from accidental lockfile deletion.
 * - `update()` does NOT bootstrap a fresh project. If there are no managed items in the
 *   lockfile and nothing to adopt on disk, `update()` returns a hint to run `install`.
 * - Orphan cleanup: if the lockfile records an item the current CLI no longer ships,
 *   and the on-disk content matches what we wrote, the item is silently removed.
 *   If the user has modified it, the item is left alone with a warning.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../../utils/atomic-write.js';
import { getPackageVersion } from '../../utils/version.js';

import {
  getBundledCanonicalAndSha,
  getDefaultAgentsmdAsset,
  getRayfinDescriptors,
  loadBundledAsset,
} from './descriptors.js';
import {
  CLI_PRODUCER_SOURCE,
  emptyLockfile,
  lockfilePath,
  readLockfile,
  withCliVersion,
  withItem,
  withoutItem,
  writeLockfile,
} from './lockfile.js';
import { getStrategy } from './strategies/index.js';
import type { Strategy } from './strategies/index.js';
import type {
  Descriptor,
  ItemId,
  ItemKind,
  ItemRecord,
  ItemRef,
  ItemSource,
  ItemState,
  ItemStatus,
  Lockfile,
  UpdateOptions,
  UpdateReport,
} from './types.js';

const AGENTS_MD_FILENAME = 'AGENTS.md';

/**
 * Get the CLI's package version. Throws if it can't be read (rather than the
 * `'Unknown'` fallback used by the version utility's other consumers — for
 * agent-files we need a real version to stamp into the lockfile).
 */
function getCliVersion(): string {
  const v = getPackageVersion();
  if (v === 'Unknown') {
    throw new Error(
      'Could not read CLI version from package.json. Cannot manage agent files.'
    );
  }
  return v;
}

export class AgentFilesManager {
  private readonly descriptors: readonly Descriptor[];

  /**
   * @param projectRoot - Project root that owns the lockfile and managed files.
   * @param descriptors - The set of items the manager will reconcile. Defaults
   *   to the feature-gated Rayfin table, resolved against `projectRoot` at
   *   construction so a command that enables a feature mid-run still sees it.
   *   Threaded as a constructor parameter so Phase 2 (template-shipped
   *   extensions) can pass a merged list without refactoring every call site.
   */
  constructor(
    private readonly projectRoot: string,
    descriptors: readonly Descriptor[] = getRayfinDescriptors(projectRoot)
  ) {
    this.descriptors = descriptors;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** The feature-gated descriptor set this manager reconciles. */
  get managedDescriptors(): readonly Descriptor[] {
    return this.descriptors;
  }

  /**
   * Returns one status entry per managed item. Combines descriptors + lockfile so
   * never-installed, disabled, and orphaned states are all visible.
   */
  status(): ItemStatus[] {
    const lockfile = this.loadOrAdoptLockfile();

    const seen = new Set<ItemId>();
    const out: ItemStatus[] = [];

    for (const descriptor of this.descriptors) {
      const id = idFor(descriptor);
      seen.add(id);
      out.push({ id, state: this.classify(descriptor, lockfile) });
    }

    // Items in the lockfile that no longer have a descriptor are "orphaned"
    // (or "disabled" if the user explicitly disabled them).
    for (const id of Object.keys(lockfile.items) as ItemId[]) {
      if (seen.has(id)) continue;
      const record = lockfile.items[id];
      out.push({
        id,
        state: record.disabled ? { kind: 'disabled' } : { kind: 'orphaned' },
      });
    }

    return out;
  }

  /**
   * Install (or reconcile) the Rayfin agent files in this project.
   *
   * Idempotent — safe to run repeatedly. Re-runs auto-reconcile to the
   * current bundled content:
   *
   * - First run: bootstraps AGENTS.md (one-time) plus the descriptor table
   *   and creates the lockfile.
   * - Subsequent runs: rewrites items whose bundled content has changed
   *   (`update-available`); installs newly-shipped descriptors; performs
   *   orphan cleanup for descriptors the CLI no longer ships.
   *
   * Conflict policy:
   * - up-to-date            → no-op
   * - update-available      → re-write with bundled
   * - user-modified         → warn (overwrite only with `--force`)
   * - missing               → warn (re-install only with `--force`)
   * - not-installed         → install
   * - disabled              → skip (sigil-removed skill or lockfile flag)
   * - orphaned (clean)      → delete
   * - orphaned (dirty)      → warn (delete with `--force`)
   * - unreadable            → warn (overwrite with `--force`)
   *
   * AGENTS.md is one-time install — `--force` does NOT overwrite it.
   *
   * `enable[id] === false` disables the item (preserves on-disk content
   * unless `removeFiles` is set). `enable[id] === true` re-enables a
   * previously-disabled item. `ids` scopes the loop to specific items.
   */
  install(opts: UpdateOptions = {}): UpdateReport {
    const forceOpt = opts.force ?? false;
    // Per-item force resolver. Boolean form applies to every item (legacy
    // global force); set form scopes force to the listed ids only. An empty
    // set is equivalent to no force (a CLI guard above us collapses the
    // empty-args case, but defensively normalize here too).
    const isForced = (id: ItemId): boolean => {
      if (typeof forceOpt === 'boolean') return forceOpt;
      return forceOpt.has(id);
    };
    const dryRun = opts.dryRun ?? false;
    const scopeIds = opts.ids ? new Set(opts.ids) : undefined;
    const enable = opts.enable ?? {};
    const removeFiles = opts.removeFiles ?? false;
    // B-3: gate the final lockfile rewrite on whether anything actually
    // changed. Capture "did the lockfile exist before we touched it" up
    // front — if not, adoption (or fresh install) made it dirty by virtue
    // of creating it.
    const lockfileExistedBefore = existsSync(lockfilePath(this.projectRoot));
    let lockfile = this.loadOrAdoptLockfile();
    const cliVersion = getCliVersion();

    const installed: ItemId[] = [];
    const updated: ItemId[] = [];
    const removed: ItemId[] = [];
    const disabled: ItemId[] = [];
    const enabled: ItemId[] = [];
    const warnings: UpdateReport['warnings'][number][] = [];
    const skipped: { id: ItemId; reason: 'disabled' }[] = [];

    // Centralize the "should we actually write" check so dry-run consistently
    // skips every persistence step. The decision logic above still runs so the
    // report describes what install WOULD do.
    const persist = (next: Lockfile): void => {
      if (!dryRun) writeLockfile(this.projectRoot, next);
    };

    // 1. AGENTS.md (one-time install; never tracked; never overwritten by --force).
    if (!dryRun) {
      this.installAgentsmdIfMissing();
    }

    // 2. Managed items.
    for (const descriptor of this.descriptors) {
      const id = idFor(descriptor);
      if (scopeIds && !scopeIds.has(id)) continue;

      const enableTransition = enable[id];

      // Apply enable/disable transitions first.
      if (enableTransition === false) {
        try {
          const result = this.disableItem(
            descriptor,
            lockfile,
            removeFiles,
            dryRun
          );
          lockfile = result.lockfile;
          persist(lockfile);
          if (result.fileRemoved) removed.push(id);
          disabled.push(id);
        } catch (err) {
          // strategy.delete refused (e.g. malformed .mcp.json or EPERM).
          // Surface as a warning so the user knows --remove-files did not
          // succeed; do NOT mark the item disabled in the lockfile.
          warnings.push({
            id,
            reason: 'unreadable',
            message: `Could not remove on-disk content: ${(err as Error).message}`,
          });
        }
        continue;
      }

      if (enableTransition === true) {
        // Re-enable: clear disabled flag, then fall through to install logic.
        // Preserve existing provenance — re-enabling doesn't change which
        // producer originally installed the item.
        const existing = lockfile.items[id];
        if (existing?.disabled) {
          lockfile = withItem(lockfile, id, {
            sha256: existing.sha256,
            ...preservedSource(existing),
          });
          enabled.push(id);
        }
      }

      // After explicit enable, check effective disabled state.
      if (lockfile.items[id]?.disabled) {
        skipped.push({ id, reason: 'disabled' });
        continue;
      }

      const state = this.classify(descriptor, lockfile);

      if (state.kind === 'up-to-date') continue;

      if (state.kind === 'disabled') {
        // Sigil-removed skill (state from classify, not from lockfile flag).
        // If --enable was explicitly passed for this item, treat as a
        // re-install request: warn without --force; overwrite with --force
        // (re-stamps the sigil). Without an explicit --enable, just skip.
        if (enableTransition === true) {
          if (!isForced(id)) {
            warnings.push({ id, reason: 'user-modified' });
            continue;
          }
          try {
            lockfile = this.applyItem(
              descriptor,
              lockfile,
              isForced(id),
              dryRun
            );
            persist(lockfile);
            updated.push(id);
          } catch (err) {
            warnings.push({
              id,
              reason: 'unreadable',
              message: (err as Error).message,
            });
          }
          continue;
        }
        skipped.push({ id, reason: 'disabled' });
        continue;
      }

      if (state.kind === 'unreadable') {
        if (!isForced(id)) {
          warnings.push({ id, reason: 'unreadable', message: state.message });
          continue;
        }
        try {
          lockfile = this.applyItem(descriptor, lockfile, isForced(id), dryRun);
          persist(lockfile);
          updated.push(id);
        } catch (err) {
          warnings.push({
            id,
            reason: 'unreadable',
            message: (err as Error).message,
          });
        }
        continue;
      }

      if (state.kind === 'user-modified' && !isForced(id)) {
        warnings.push({ id, reason: 'user-modified' });
        continue;
      }

      if (state.kind === 'missing' && !isForced(id)) {
        warnings.push({ id, reason: 'missing' });
        continue;
      }

      // Install / overwrite / restore / auto-update.
      const wasNew = state.kind === 'not-installed' || state.kind === 'missing';
      try {
        lockfile = this.applyItem(descriptor, lockfile, isForced(id), dryRun);
        persist(lockfile);
        (wasNew ? installed : updated).push(id);
      } catch (err) {
        // strategy.write may refuse to clobber malformed content (e.g. hostile
        // .mcp.json shape). Surface as warning so other items can still proceed.
        warnings.push({
          id,
          reason: 'unreadable',
          message: (err as Error).message,
        });
      }
    }

    // 3. Orphan cleanup — items in the lockfile whose descriptor the CLI no
    // longer ships. Only runs when no scope is set (full-project reconcile).
    if (!scopeIds) {
      const descriptorIds = new Set(this.descriptors.map((d) => idFor(d)));
      for (const id of Object.keys(lockfile.items) as ItemId[]) {
        if (descriptorIds.has(id)) continue;

        // Honor --disable for orphans. validateKnownIds in install.ts
        // explicitly accepts orphan ids on this contract: "stop managing,
        // preserve the file." Without this, --disable falls through to
        // cleanupOrphan and DELETES the file (clean-orphan path), doing
        // the opposite of what the user asked.
        if (enable[id] === false) {
          const existing = lockfile.items[id];
          lockfile = withItem(lockfile, id, {
            sha256: existing?.sha256 ?? null,
            disabled: true,
            ...preservedSource(existing),
          });
          persist(lockfile);
          disabled.push(id);
          continue;
        }
        // --enable on an orphan is a no-op with a warning: the descriptor
        // is gone so we can't rewrite content, but the lockfile record
        // already exists. Tell the user what's going on.
        if (enable[id] === true) {
          warnings.push({
            id,
            reason: 'missing',
            message:
              'Cannot re-enable: this CLI version no longer ships a descriptor for the item. Upgrade the CLI or use --disable to acknowledge it as orphaned.',
          });
          continue;
        }

        // Per-item failure isolation: a malformed sibling file (e.g. corrupt
        // .mcp.json) must not abort cleanup of unrelated items. Same policy
        // as classify() and the descriptor loop above.
        let result: ReturnType<typeof this.cleanupOrphan>;
        try {
          result = this.cleanupOrphan(id, lockfile, isForced(id), dryRun);
        } catch (err) {
          warnings.push({
            id,
            reason: 'unreadable',
            message: (err as Error).message,
          });
          continue;
        }
        lockfile = result.lockfile;
        if (result.deleted) {
          persist(lockfile);
          removed.push(id);
        }
        if (result.warned) warnings.push({ id, reason: 'user-modified' });
      }
    }

    // B-3: only persist + bump cliVersion when there's an actual change.
    // The cliVersion field is diagnostic only (RD-5), so bumping it on
    // every run was pure write churn — and could break in read-only
    // working trees when no reconciliation was needed.
    const reportTouched =
      installed.length > 0 ||
      updated.length > 0 ||
      removed.length > 0 ||
      disabled.length > 0 ||
      enabled.length > 0;
    if (reportTouched || !lockfileExistedBefore) {
      lockfile = withCliVersion(lockfile, cliVersion);
      persist(lockfile);
    }

    return {
      installed,
      updated,
      removed,
      disabled,
      enabled,
      warnings,
      skipped,
    };
  }

  /**
   * One-line drift summary for `rayfin dev` — returns `null` when everything is
   * up-to-date.
   *
   * Hot path: runs on every `rayfin dev` invocation. Reads the lockfile once
   * and short-circuits on the first drift signal instead of building a full
   * `ItemStatus[]`.
   */
  driftLine(): string | null {
    const lockfile = readLockfile(this.projectRoot);
    if (!lockfile) return null;

    let drift = false;
    for (const descriptor of this.descriptors) {
      const state = this.classify(descriptor, lockfile);
      if (
        state.kind === 'update-available' ||
        state.kind === 'user-modified' ||
        state.kind === 'missing' ||
        state.kind === 'unreadable' ||
        // S3-1: a newly-shipped descriptor that the project hasn't installed
        // yet is also drift worth surfacing — install would write it.
        state.kind === 'not-installed'
      ) {
        drift = true;
        break;
      }
    }
    if (!drift) {
      const descriptorIds = new Set(this.descriptors.map((d) => idFor(d)));
      for (const id of Object.keys(lockfile.items) as ItemId[]) {
        if (descriptorIds.has(id)) continue;
        const record = lockfile.items[id];
        if (!record.disabled) {
          drift = true;
          break;
        }
      }
    }

    if (!drift) return null;

    // RD-5: drift is sha-based, not CLI-version-based — the user-facing
    // message should match. The lockfile's cliVersion is a diagnostic
    // field only; mentioning it here teaches a version-based mental
    // model that contradicts the actual decision gate.
    return "Your project's Rayfin agent files have changes available. Run `rayfin init ai-files install` to refresh.";
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /**
   * Read the lockfile if present; otherwise build one and silently adopt any
   * Rayfin-managed content already on disk that we recognize (skill via sigil; mcp
   * via exact bundled content match).
   */
  private loadOrAdoptLockfile(): Lockfile {
    const existing = readLockfile(this.projectRoot);
    if (existing) return existing;

    const cliVersion = getCliVersion();
    let lockfile = emptyLockfile(cliVersion);

    for (const descriptor of this.descriptors) {
      const strategy = getStrategy(descriptor.kind);
      let onDisk: string | null;
      try {
        onDisk = strategy.read(this.projectRoot, descriptor);
      } catch {
        // Adoption is best-effort; an unreadable file (e.g. malformed JSON)
        // should not block lockfile creation. The item will surface as
        // 'unreadable' on the next classify() call.
        continue;
      }
      if (onDisk === null) continue;

      if (this.qualifiesForAdoption(descriptor, strategy, onDisk)) {
        const id = idFor(descriptor);
        lockfile = withItem(lockfile, id, {
          sha256: strategy.hash(onDisk),
          // B-2 / S1-1 / S3-5 round-5 deep-review fix: adopted records must
          // also carry provenance so future producer-authority orphan policy
          // doesn't treat them as legacy. Phase 1 only has one producer.
          source: { ...CLI_PRODUCER_SOURCE, versionOrSha: cliVersion },
        });
      }
    }

    return lockfile;
  }

  /**
   * On-disk content qualifies for adoption when it's unmistakably ours:
   * - skill: carries the `rayfin-managed: true` frontmatter sigil
   * - mcp:   exact byte match against the bundled canonical content
   *
   * Used by both `loadOrAdoptLockfile` (initial bootstrap when the lockfile
   * is missing) and `classify` (recovery from a partial-flush window where the
   * file landed but the lockfile flush was interrupted).
   */
  private qualifiesForAdoption(
    descriptor: Descriptor,
    strategy: Strategy,
    onDisk: string
  ): boolean {
    switch (descriptor.kind) {
      case 'skill':
        return strategy.hasManagedSigil(onDisk);
      case 'mcp':
        return onDisk === getBundledCanonicalAndSha(descriptor).canonical;
      default: {
        // Compile-time exhaustiveness guard: if a new ItemKind is added to
        // types.ts, this assignment becomes a type error so adoption logic
        // for the new kind has to be written explicitly.
        const _exhaustive: never = descriptor.kind;
        return _exhaustive;
      }
    }
  }

  private classify(descriptor: Descriptor, lockfile: Lockfile): ItemState {
    const id = idFor(descriptor);
    const record = lockfile.items[id];

    // Explicit user disable wins.
    if (record?.disabled) return { kind: 'disabled' };

    const strategy = getStrategy(descriptor.kind);
    let onDisk: string | null;
    try {
      onDisk = strategy.read(this.projectRoot, descriptor);
    } catch (err) {
      // A malformed file (e.g. .mcp.json with invalid JSON) does not block
      // unrelated items.
      return {
        kind: 'unreadable',
        message: (err as Error).message,
      };
    }

    if (!record) {
      // Spec: install must not silently overwrite pre-existing user content.
      // If a Rayfin-named skill or mcp entry exists on disk but is not in the
      // lockfile and didn't qualify for adoption, the user owns it.
      //
      // Adoption-window guard: if the on-disk content is unmistakably ours
      // (skill carries the rayfin-managed sigil, or mcp value matches the
      // bundled canonical exactly), this is the partial-flush case — the file
      // was written but the lockfile flush didn't complete (SIGINT, crash).
      // Treat it as not-installed so the next install re-stamps the lockfile
      // record without the user having to "recover" their own scaffold.
      if (onDisk !== null) {
        if (this.qualifiesForAdoption(descriptor, strategy, onDisk)) {
          return { kind: 'not-installed' };
        }
        return {
          kind: 'user-modified',
          recordedSha: null,
        };
      }
      return { kind: 'not-installed' };
    }

    if (onDisk === null) {
      // sha=null means "no recorded content" (e.g. previously --disable
      // --remove-files'd, then --enable'd). Treat as not-installed so the
      // install/update loop installs fresh rather than warning about a
      // missing file we never recorded.
      if (record.sha256 === null) {
        return { kind: 'not-installed' };
      }
      return { kind: 'missing' };
    }

    // Spec: removing `rayfin-managed: true` from a skill is the documented
    // opt-out gesture. Honor it as `disabled` so `update --force` cannot
    // stomp on the user's edits after they relinquished the sigil.
    if (descriptor.kind === 'skill' && !strategy.hasManagedSigil(onDisk)) {
      return { kind: 'disabled' };
    }

    const onDiskHash = strategy.hash(onDisk);
    if (onDiskHash !== record.sha256) {
      return {
        kind: 'user-modified',
        recordedSha: record.sha256,
      };
    }

    // sha matches the recorded value — but does it still match what the
    // bundled asset would produce now? If the bundled content has changed,
    // signal `update-available`.
    const { sha256: bundledSha } = getBundledCanonicalAndSha(descriptor);
    if (bundledSha !== record.sha256) {
      return { kind: 'update-available' };
    }

    return { kind: 'up-to-date' };
  }

  /** Write a single item; returns the updated lockfile. */
  private applyItem(
    descriptor: Descriptor,
    lockfile: Lockfile,
    force = false,
    dryRun = false
  ): Lockfile {
    const strategy = getStrategy(descriptor.kind);
    const bundled = loadBundledAsset(descriptor);
    let canonical: string;
    if (dryRun) {
      // Don't touch disk; the canonical-form helper computes what we WOULD
      // write so the lockfile record + report stay accurate.
      canonical = strategy.canonicalizeBundled(bundled);
    } else {
      canonical = strategy.write(this.projectRoot, descriptor, bundled, force);
    }
    // Preserve disabled flag if the user re-enabled (we want it cleared)
    // — the install/update loop has already cleared it before calling applyItem.
    // Provenance: Phase 1 always writes the CLI as the producer.
    const record: ItemRecord = {
      sha256: strategy.hash(canonical),
      source: { ...CLI_PRODUCER_SOURCE, versionOrSha: getCliVersion() },
    };
    return withItem(lockfile, idFor(descriptor), record);
  }

  /**
   * Transition an item to disabled. By default the on-disk file is preserved;
   * pass `removeFiles: true` to also delete it. Idempotent.
   *
   * If `removeFiles` is set and the on-disk content is malformed/un-deletable
   * (e.g. malformed `.mcp.json`, EPERM on a locked dir), the error is
   * propagated so the caller can surface a warning. Silently swallowing the
   * error would leave the lockfile claiming `disabled: true` while the on-disk
   * content is still in place.
   */
  private disableItem(
    descriptor: Descriptor,
    lockfile: Lockfile,
    removeFiles: boolean,
    dryRun = false
  ): { lockfile: Lockfile; fileRemoved: boolean } {
    const id = idFor(descriptor);
    const existing = lockfile.items[id];
    const strategy = getStrategy(descriptor.kind);
    let fileRemoved = false;

    if (removeFiles) {
      // Detect "is there anything to remove?" before delete so we don't claim
      // we removed a file that was never there.
      let onDisk: string | null;
      try {
        onDisk = strategy.read(this.projectRoot, descriptor);
      } catch {
        // If read fails (malformed JSON, etc.), assume something is on disk
        // and let delete try to handle it. Re-throws below if delete fails.
        onDisk = '';
      }
      if (onDisk !== null) {
        if (dryRun) {
          // Don't touch disk; the report still shows we WOULD remove it.
          fileRemoved = true;
        } else {
          try {
            strategy.delete(this.projectRoot, descriptor);
            fileRemoved = true;
          } catch (err) {
            const code = (err as { code?: string }).code;
            if (code === 'ENOENT') {
              // Already gone between read and delete; not an error.
              fileRemoved = false;
            } else {
              // Strategy refused to clobber malformed content, EPERM on a locked
              // dir, etc. Don't silently mark the item disabled — propagate.
              throw err;
            }
          }
        }
      }
    }

    // When the on-disk file is removed, null out sha so a subsequent re-enable
    // installs fresh from bundled content. When the file is preserved, keep the
    // recorded sha so re-enable can detect user-modified content vs up-to-date.
    const sha256 = fileRemoved ? null : (existing?.sha256 ?? null);
    const record: ItemRecord = {
      sha256,
      disabled: true,
      ...preservedSource(existing),
    };
    return {
      lockfile: withItem(lockfile, id, record),
      fileRemoved,
    };
  }

  private cleanupOrphan(
    id: ItemId,
    lockfile: Lockfile,
    force: boolean,
    dryRun = false
  ): { lockfile: Lockfile; deleted: boolean; warned: boolean } {
    // We can't load a strategy for an orphan because its descriptor is gone.
    // The orphan id itself encodes the kind; use that.
    const [kindRaw, name] = id.split(':');
    if (kindRaw !== 'skill' && kindRaw !== 'mcp') {
      return { lockfile, deleted: false, warned: false };
    }
    const kind = kindRaw as ItemKind;
    const orphan: ItemRef = { kind, name };
    const strategy = getStrategy(kind);
    const onDisk = strategy.read(this.projectRoot, orphan);
    const record = lockfile.items[id];

    // Disabled orphans: keep lockfile entry, never touch disk.
    if (record?.disabled) {
      return { lockfile, deleted: false, warned: false };
    }

    if (onDisk === null) {
      // Already gone; just clean up the lockfile entry.
      return {
        lockfile: withoutItem(lockfile, id),
        deleted: false,
        warned: false,
      };
    }

    if (
      record &&
      record.sha256 !== null &&
      strategy.hash(onDisk) === record.sha256
    ) {
      // Untouched since last write — safe to remove.
      if (!dryRun) strategy.delete(this.projectRoot, orphan);
      return {
        lockfile: withoutItem(lockfile, id),
        deleted: true,
        warned: false,
      };
    }

    if (force) {
      if (!dryRun) strategy.delete(this.projectRoot, orphan);
      return {
        lockfile: withoutItem(lockfile, id),
        deleted: true,
        warned: false,
      };
    }

    return { lockfile, deleted: false, warned: true };
  }

  private installAgentsmdIfMissing(): void {
    // AGENTS.md is one-time install per spec — never overwritten, even by --force.
    // The template (or default) seeds it; users own it from creation.
    const path = join(this.projectRoot, AGENTS_MD_FILENAME);
    if (existsSync(path)) return;
    writeFileAtomic(
      path,
      ensureTrailingNewline(getDefaultAgentsmdAsset()),
      'utf8'
    );
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

export function idFor(descriptor: Descriptor): ItemId {
  return `${descriptor.kind}:${descriptor.name}` as ItemId;
}

/**
 * Spread helper: yields `{ source }` when the prior record had one, or `{}`
 * otherwise. Used during disable / re-enable / orphan-disable transitions
 * to preserve provenance through state changes without overwriting it.
 */
function preservedSource(existing: ItemRecord | undefined): {
  source?: ItemSource;
} {
  return existing?.source ? { source: existing.source } : {};
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : content + '\n';
}
