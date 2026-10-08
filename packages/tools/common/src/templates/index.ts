export {
  findTemplateByName,
  generateProjectSlug,
  isValidProjectName,
  PROJECT_NAME_REGEX,
  PROJECT_SLUG_REGEX,
  transformProjectName,
} from './validation.js';

export {
  addBundledTemplateAliases,
  customizeTemplateFiles,
  readTemplatesFromDirectory,
  visibleTemplates,
} from './scaffolding.js';

export type { TemplateFs } from './scaffolding.js';

export type { ProjectNames, TemplateInfo, TemplateMetadata } from './types.js';

// Engine
export { processFiles, renderFilename } from './engine/file-processor.js';
export type {
  ProcessFilesOptions,
  ProcessFilesResult,
} from './engine/file-processor.js';
export { instantiateTemplate } from './engine/instantiator.js';
export { applyTemplateFeatures } from './engine/features.js';

// Git
export { parseGitUrl, normalizeGitUrl, buildCacheKey } from './git/resolver.js';
export { fetchTemplate, ensureGitAvailable } from './git/fetcher.js';
export {
  QUALIFIED_REF_PREFIXES,
  isAbbreviatedCommitShaRef,
  isBranchSentinel,
  isDashPrefixed,
  isFullCommitShaRef,
  isQualifiedBranchRef,
  isValidShortRefName,
  stripQualifiedRefPrefix,
} from './git/ref-shapes.js';

// Manifest
export { parseManifest, parseManifestFromString } from './manifest/parser.js';
export {
  validateManifest,
  templateManifestSchema,
} from './manifest/validator.js';

// Catalog
export {
  flattenManifestEntries,
  getEntriesAtPath,
  hasGroups,
  resolveEntryPath,
} from './catalog/resolver.js';
export type { FlattenedEntry } from './catalog/resolver.js';

// New types from engine
export type {
  ManifestEntry,
  TemplateEntry,
  GroupManifestEntry,
  GroupEntry,
  TemplateManifest,
  ManifestMetadata,
  TemplateSource,
  ResolvedTemplate,
  InstantiationResult,
  InstantiationOptions,
  RegistryEntry,
  TemplateRegistry,
} from './types.js';
export { MAX_GROUP_DEPTH } from './constants.js';
export { isGitUrl } from './types.js';

// Registry
export { loadRegistries } from './registry/loader.js';
