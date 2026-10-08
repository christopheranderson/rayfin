export { parseGitUrl, normalizeGitUrl, buildCacheKey } from './resolver.js';
export { fetchTemplate, ensureGitAvailable } from './fetcher.js';
export {
  QUALIFIED_REF_PREFIXES,
  isAbbreviatedCommitShaRef,
  isBranchSentinel,
  isDashPrefixed,
  isFullCommitShaRef,
  isQualifiedBranchRef,
  isValidShortRefName,
  stripQualifiedRefPrefix,
} from './ref-shapes.js';
