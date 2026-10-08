import { realpath } from 'fs/promises';
import { isAbsolute, resolve, sep } from 'path';

import { MAX_GROUP_DEPTH } from '../constants.js';
import { parseManifest } from '../manifest/parser.js';
import type {
  ManifestEntry,
  TemplateManifest,
  ResolvedTemplate,
} from '../types.js';

/**
 * Check whether `child` is within (or equal to) `parent` directory.
 * Uses case-insensitive comparison on Windows (detected via path separator).
 */
function isWithinDirectory(child: string, parent: string): boolean {
  const isWindows = sep === '\\';
  const c = isWindows ? child.toLowerCase() : child;
  const p = isWindows ? parent.toLowerCase() : parent;
  return c === p || c.startsWith(p + sep);
}

/** Flattened template entry with display breadcrumbs. */
export interface FlattenedEntry {
  templatePath: string;
  templateName?: string;
  displayPath: string[];
}

/**
 * Flatten manifest entries (including groups) into a flat list of template
 * paths with display-path breadcrumbs.
 */
export function flattenManifestEntries(
  entries: ManifestEntry[],
  parentPath: string[] = [],
  depth = 0
): FlattenedEntry[] {
  if (depth >= MAX_GROUP_DEPTH) {
    throw new Error(
      `Group nesting exceeds maximum depth of ${MAX_GROUP_DEPTH}`
    );
  }

  const result: FlattenedEntry[] = [];

  for (const entry of entries) {
    if (entry.path) {
      result.push({
        templatePath: entry.path,
        ...(entry.name ? { templateName: entry.name } : {}),
        displayPath: [...parentPath, entry.name ?? entry.path],
      });
    } else if (entry.group) {
      const groupPath = [...parentPath, entry.group.displayName];
      result.push(
        ...flattenManifestEntries(entry.group.entries, groupPath, depth + 1)
      );
    }
  }

  return result;
}

/**
 * Get the manifest entries at a given navigation path.
 * An empty path returns the root entries.
 * Path segments are matched by group name.
 */
export function getEntriesAtPath(
  manifest: TemplateManifest,
  path: string[]
): ManifestEntry[] {
  let current = manifest.entries;

  for (const segment of path) {
    const group = current.find((e) => e.group && e.group.name === segment);
    if (!group?.group) {
      return [];
    }
    current = group.group.entries;
  }

  return current;
}

/**
 * Check whether a manifest has any group entries (i.e., is a multi-template catalog).
 */
export function hasGroups(entries: ManifestEntry[]): boolean {
  return entries.some((e) => e.group !== undefined);
}

/**
 * Resolve a manifest entry path to a full ResolvedTemplate.
 * Validates that the template path does not escape the repo root.
 */
export async function resolveEntryPath(
  repoPath: string,
  templatePath: string
): Promise<ResolvedTemplate> {
  if (
    isAbsolute(templatePath) ||
    /^[A-Za-z]:[\\/]/.test(templatePath) ||
    templatePath.startsWith('\\')
  ) {
    throw new Error(`Template path must be relative: '${templatePath}'`);
  }

  const segments = templatePath.split(/[/\\]/);
  if (segments.includes('..')) {
    throw new Error(`Template path must not contain '..': '${templatePath}'`);
  }

  const resolvedRepo = resolve(repoPath);
  const resolvedTemplate = resolve(resolvedRepo, templatePath);

  if (!isWithinDirectory(resolvedTemplate, resolvedRepo)) {
    throw new Error(`Template path escapes repository root: '${templatePath}'`);
  }

  let realRepo: string;
  let realTemplate: string;
  try {
    [realRepo, realTemplate] = await Promise.all([
      realpath(resolvedRepo),
      realpath(resolvedTemplate),
    ]);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') {
      throw new Error(
        `Template path '${templatePath}' does not exist in the repository`
      );
    }
    throw new Error(
      `Failed to resolve template path '${templatePath}': ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!isWithinDirectory(realTemplate, realRepo)) {
    throw new Error(
      `Template path escapes repository root via symlink: '${templatePath}'`
    );
  }

  const manifest = await parseManifest(realTemplate);

  return {
    manifest,
    sourcePath: realTemplate,
  };
}
