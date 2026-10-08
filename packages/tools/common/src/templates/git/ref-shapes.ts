/**
 * Shared predicates for git ref-name shapes.
 *
 * Consolidated here so the three ref-shape boundaries cannot drift apart:
 *
 *   - `parseGitUrl` (resolver.ts) — validates an unqualified ref parsed from
 *     a URL `#ref` suffix.
 *   - `stripQualifiedRefPrefix` (this file) — validates the tail of a
 *     `refs/tags/<X>` or `refs/heads/<X>` ref after stripping the prefix,
 *     before it is handed to `git clone --branch <name>`.
 *   - `isPinnedBundledRegistryRef` (cli/template-registry.ts) — gates which
 *     refs a bundled-registry author may pin to.
 *
 * Before consolidation, each boundary held its own copy of the rules. That
 * let `refs/tags/-rf` and `refs/tags/568c87f` slip through `stripQualifiedRefPrefix`
 * and the bundled-pin gate even though the unqualified forms (`-rf`,
 * `568c87f`) were correctly rejected. Keeping the predicates in one place
 * makes a future divergence a compile error rather than a silent bypass.
 */

export const QUALIFIED_REF_PREFIXES = ['refs/tags/', 'refs/heads/'] as const;

/** Exactly 40 hex characters (case-insensitive). */
export function isFullCommitShaRef(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

/**
 * 7-39 hex characters - long enough to be confused with an abbreviated
 * commit SHA, short enough to not be a full one. `git clone --branch`
 * would interpret these ambiguously, so we reject at every ref-shape
 * boundary.
 */
export function isAbbreviatedCommitShaRef(ref: string): boolean {
  return /^[0-9a-f]{7,39}$/i.test(ref);
}

/**
 * Starts with `-`. Would be interpreted as a git flag if passed positionally
 * to `git clone --branch <ref>` or any other git command.
 */
export function isDashPrefixed(ref: string): boolean {
  return ref.startsWith('-');
}

/**
 * Known mutable branch sentinels (case-insensitive). Pinning to any of
 * these defeats per-release reproducibility for bundled-registry consumers.
 */
export function isBranchSentinel(ref: string): boolean {
  return /^(HEAD|FETCH_HEAD|main|master|develop|trunk)$/i.test(ref);
}

/** `refs/heads/<anything>` — explicit branch form (any depth). */
export function isQualifiedBranchRef(ref: string): boolean {
  return /^refs\/heads\//i.test(ref);
}

/**
 * The shape-acceptance predicate for a short ref name that will be passed
 * to `git clone --branch <name>`.
 *
 * Returns `true` iff `name` is non-empty, not dash-prefixed, and not shaped
 * like an abbreviated commit SHA. This is the same set of guards that
 * `parseGitUrl` applies to unqualified refs at parse time; applying it to
 * the tail of qualified refs (after `stripQualifiedRefPrefix`) and inside
 * the bundled-pin gate keeps all three boundaries consistent.
 */
export function isValidShortRefName(name: string): boolean {
  if (name.length === 0) return false;
  if (isDashPrefixed(name)) return false;
  if (isAbbreviatedCommitShaRef(name)) return false;
  return true;
}

/**
 * Strip `refs/tags/` or `refs/heads/` prefix so a fully-qualified ref can
 * be passed to `git clone --branch <name>`, which only accepts short names.
 *
 * Throws on:
 *   - **Empty tail** (e.g. `refs/tags/`) - surfaces the contract violation
 *     at the parse boundary instead of letting `git clone --branch ''`
 *     fail with an opaque downstream message.
 *   - **Malformed tail** (dash-prefixed, or shaped like an abbreviated
 *     commit SHA) - mirrors the rejection that `parseGitUrl` applies to
 *     unqualified refs. Without this, `refs/tags/-rf` would inject a flag
 *     and `refs/tags/568c87f` would silently scaffold an ambiguous abbrev
 *     SHA through `--branch`.
 *
 * Returns the input unchanged if no prefix matches.
 */
export function stripQualifiedRefPrefix(ref: string): string {
  for (const prefix of QUALIFIED_REF_PREFIXES) {
    if (ref.startsWith(prefix)) {
      const tail = ref.slice(prefix.length);
      if (tail.length === 0) {
        throw new Error(
          `Invalid ref '${ref}': qualified refs must have a non-empty tail after '${prefix}'`
        );
      }
      if (!isValidShortRefName(tail)) {
        throw new Error(
          `Invalid ref '${ref}': qualified-ref tail '${tail}' fails the short-ref-name shape check (dash-prefixed and abbreviated-SHA-shaped tails are rejected to mirror parseGitUrl).`
        );
      }
      return tail;
    }
  }
  return ref;
}
