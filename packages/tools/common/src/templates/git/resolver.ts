import type { TemplateSource } from '../types.js';

import {
  isAbbreviatedCommitShaRef,
  isDashPrefixed,
  isFullCommitShaRef,
} from './ref-shapes.js';

export { isFullCommitShaRef };

/**
 * Parse a git URL input (potentially with #ref suffix) into a TemplateSource.
 */
export function parseGitUrl(input: string): TemplateSource {
  const trimmed = input.trim();

  if (!trimmed) {
    throw new Error('Git URL cannot be empty');
  }

  // Split on # for ref
  const hashIndex = trimmed.indexOf('#');
  let url: string;
  let ref: string | undefined;

  if (hashIndex !== -1) {
    url = trimmed.slice(0, hashIndex);
    ref = trimmed.slice(hashIndex + 1);

    if (!ref) {
      throw new Error('Empty ref after # in URL');
    }

    // Reject abbreviated SHAs because they are ambiguous; full commit SHAs are
    // supported by the fetcher via an explicit fetch + detached checkout.
    if (isAbbreviatedCommitShaRef(ref)) {
      throw new Error(
        `Abbreviated commit SHAs are not supported as refs: '${ref}'. Use a full 40-character commit SHA, branch, or tag name instead.`
      );
    }

    // Reject dash-prefixed refs (could be interpreted as git flags)
    if (isDashPrefixed(ref)) {
      throw new Error(`Invalid ref '${ref}': refs cannot start with a dash`);
    }
  } else {
    url = trimmed;
  }

  if (!url) {
    throw new Error('Git URL cannot be empty');
  }

  return { url, ref };
}

/**
 * Normalize a git URL by stripping the .git suffix.
 */
export function normalizeGitUrl(url: string): string {
  return url.replace(/\.git$/, '');
}

/**
 * Build a cache key from a template source (normalized URL + optional ref).
 */
export function buildCacheKey(source: TemplateSource): string {
  const normalized = normalizeGitUrl(source.url);
  return source.ref ? `${normalized}#${source.ref}` : normalized;
}
