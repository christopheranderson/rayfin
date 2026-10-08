import {
  flattenManifestEntries,
  resolveEntryPath,
} from '@microsoft/rayfin-tools-common/_internal/templates';
import type {
  ResolvedTemplate,
  TemplateManifest,
} from '@microsoft/rayfin-tools-common/_internal/templates';

import { navigateCatalog } from './catalog-navigator.js';

interface SelectTemplateEntryOptions {
  interactive: boolean;
  templateName?: string;
  onPathFallback?: (message: string) => void;
}

function availableTemplateNames(
  entries: ReturnType<typeof flattenManifestEntries>
): string {
  return entries
    .map((entry) => entry.templateName ?? entry.templatePath)
    .join(', ');
}

/**
 * Select a leaf template entry from a manifest and resolve it through the
 * shared hardened path validator.
 */
export async function selectTemplateEntry(
  manifest: TemplateManifest,
  templateRoot: string,
  options: SelectTemplateEntryOptions
): Promise<ResolvedTemplate> {
  const allEntries = flattenManifestEntries(manifest.entries);
  const available = availableTemplateNames(allEntries);

  if (allEntries.length === 0) {
    throw new Error('Manifest contains no entries');
  }

  if (options.templateName) {
    let matches = allEntries.filter(
      (entry) => entry.templateName === options.templateName
    );
    if (matches.length === 0) {
      matches = allEntries.filter(
        (entry) => entry.templatePath === options.templateName
      );
      if (matches.length > 0) {
        options.onPathFallback?.(
          `⚠️  No template named '${options.templateName}' — matched by path instead`
        );
      }
    }
    if (matches.length === 0) {
      throw new Error(
        `Template '${options.templateName}' not found. Available: ${available}`
      );
    }
    if (matches.length > 1) {
      const paths = matches
        .map(
          (entry) => `${entry.displayPath.join(' > ')} (${entry.templatePath})`
        )
        .join(', ');
      throw new Error(
        `Template name '${options.templateName}' is ambiguous — matches ${matches.length} entries: ${paths}`
      );
    }

    return resolveEntryPath(templateRoot, matches[0].templatePath);
  }

  if (allEntries.length === 1) {
    return resolveEntryPath(templateRoot, allEntries[0].templatePath);
  }

  if (!options.interactive) {
    throw new Error(
      'Template contains multiple entries. Run interactively to select one, pass --template-name <name>, or specify a single-entry template.\n' +
        `Available: ${available}`
    );
  }

  // All interactive multi-entry selection - grouped or flat - flows through
  // navigateCatalog so local and git-backed sources share one picker. For a
  // flat root it lists the top-level entries with no "Back" step, matching the
  // external flow's base behavior.
  return navigateCatalog(manifest, templateRoot);
}
