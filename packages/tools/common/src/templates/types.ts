/**
 * Template metadata from package.json
 */
export interface TemplateMetadata {
  name: string;
  displayName: string;
  description: string;
  /**
   * Ship the template, but keep it out of the pickers and listings.
   *
   * A hidden template still resolves by name, so `--template <name>` works and
   * anything holding the name keeps working. It just isn't offered to someone
   * browsing for a starting point. Use it for templates that are real and
   * supported but reached through a specific entry point rather than chosen
   * from a menu.
   *
   * Hiding is a presentation concern only. Never filter on it in a lookup path,
   * or the template becomes unreachable by the callers it exists for.
   */
  hidden?: boolean;
}

/**
 * Complete template information including file system path
 */
export interface TemplateInfo extends TemplateMetadata {
  path: string;
  packageJson: Record<string, unknown>;
  isLocal: boolean;
  /** True for the synthetic "Build with the GitHub Copilot SDK (Experimental)" template */
  isCopilotTemplate?: boolean;
}

/**
 * Project name transformations (original, kebab-case, PascalCase)
 */
export interface ProjectNames {
  original: string;
  display: string;
  kebab: string;
  pascal: string;
}

// ---------------------------------------------------------------------------
// Template engine types (relocated from @microsoft/rayfin-template-engine)
// ---------------------------------------------------------------------------

/** Metadata block of a template manifest (rayfin-template.yml). */
export interface ManifestMetadata {
  name: string;
  displayName?: string;
  description?: string;
  version?: string;
  tags?: string[];
}

/** A template entry pointing to a template directory. */
export interface TemplateEntry {
  path: string;
  name?: string;
  description?: string;
  group?: never;
}

/** A group entry containing nested entries. */
export interface GroupManifestEntry {
  group: GroupEntry;
  path?: never;
  name?: never;
  description?: never;
}

/** An entry in a template manifest — either a template (with path) or a group. */
export type ManifestEntry = TemplateEntry | GroupManifestEntry;

/** A group of entries in a template manifest. */
export interface GroupEntry {
  name: string;
  displayName: string;
  description?: string;
  entries: ManifestEntry[];
}

/** The full template manifest (rayfin-template.yml). */
export interface TemplateManifest {
  apiVersion: string;
  metadata: ManifestMetadata;
  entries: ManifestEntry[];
}

/** A template source referencing a git URL. */
export interface TemplateSource {
  url: string;
  ref?: string;
}

/** A resolved template ready for instantiation. */
export interface ResolvedTemplate {
  manifest: TemplateManifest;
  sourcePath: string;
  source?: TemplateSource;
}

/** Result of template instantiation. */
export interface InstantiationResult {
  createdFiles: string[];
  skippedFiles: string[];
  parameters: Record<string, unknown>;
  targetDir: string;
}

/** Options passed to the instantiation pipeline. */
export interface InstantiationOptions {
  targetDir: string;
  presets?: Record<string, unknown>;
  dryRun?: boolean;
  overwrite?: boolean;
}

/** A single entry in a template registry configuration file. */
export interface RegistryEntry {
  name: string;
  displayName: string;
  description?: string;
  url: string;
  /** Stable/default git ref (tag, branch) to pin to a specific version. */
  ref?: string;
  /** Git ref used by alpha CLI versions. Falls back to `ref`. */
  alphaRef?: string;
  /** Git ref used by beta CLI versions. Falls back to `ref`. */
  betaRef?: string;
  /** Subdirectory within the repo to scope to (e.g., a specific catalog). */
  path?: string;
  /** Template entry name/path to select within the manifest. */
  templateName?: string;
  /** Whether this is a CLI-shipped default entry (read-only). */
  default?: boolean;
  /** Whether this CLI-shipped entry should appear and dispatch as built-in. */
  firstClass?: boolean;
  /** Name of the registry this entry came from (set during merge). */
  registrySource?: string;
  /**
   * `ref`/`alphaRef`/`betaRef` fields that were present in the source file
   * but not a string (e.g. a number, `null`, or a boolean).
   *
   * The loader drops the value itself (so `entry.alphaRef` etc. stay
   * `string | undefined`), but records the field name here rather than
   * treating it the same as "not configured" - protected-entry validation
   * (`hasPinnedBundledRegistryRefs`) must reject an entry that configured a
   * malformed override, including on a channel that isn't currently
   * selected, rather than silently falling back as if it were absent.
   */
  malformedRefFields?: Array<'ref' | 'alphaRef' | 'betaRef'>;
}

/** Parsed template registry containing discovered registry entries. */
export interface TemplateRegistry {
  registries: RegistryEntry[];
  warnings: string[];
}

/**
 * Check whether a string looks like a git URL.
 * Matches `https://`, `git@`, `ssh://`, or `file://` schemes.
 */
export function isGitUrl(input: string): boolean {
  if (!input || typeof input !== 'string') return false;
  const trimmed = input.trim();
  // Require content after the scheme (not just bare 'https://' etc.)
  return (
    /^https:\/\/.+/.test(trimmed) ||
    /^git@.+/.test(trimmed) ||
    /^ssh:\/\/.+/.test(trimmed) ||
    /^file:\/\/.+/.test(trimmed)
  );
}
