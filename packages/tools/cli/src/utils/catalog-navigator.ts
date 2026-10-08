import type {
  ManifestEntry,
  TemplateManifest,
  ResolvedTemplate,
} from '@microsoft/rayfin-tools-common/_internal/templates';
import {
  getEntriesAtPath,
  resolveEntryPath,
} from '@microsoft/rayfin-tools-common/_internal/templates';
import inquirer from 'inquirer';

type Selection =
  | { type: 'group'; name: string; displayName: string }
  | { type: 'template'; path: string }
  | { type: 'back' };

/**
 * Interactively navigate a manifest with groups and resolve the selected template.
 */
export async function navigateCatalog(
  manifest: TemplateManifest,
  repoPath: string
): Promise<ResolvedTemplate> {
  const stack: Array<{ name: string; displayName: string }> = [];

  while (true) {
    const entries = getEntriesAtPath(
      manifest,
      stack.map(({ name }) => name)
    );

    if (entries.length === 0) {
      if (stack.length > 0) {
        stack.pop();
        continue;
      }
      throw new Error('Manifest contains no entries');
    }

    const breadcrumb =
      stack.length > 0
        ? `${manifest.metadata.displayName} > ${stack.map(({ displayName }) => displayName).join(' > ')}`
        : manifest.metadata.displayName;

    const choices: Array<{ name: string; value: Selection }> = entries.map(
      (entry: ManifestEntry) => {
        if (entry.group) {
          return {
            name: `📁 ${entry.group.displayName}${entry.group.description ? ` — ${entry.group.description}` : ''}`,
            value: {
              type: 'group' as const,
              name: entry.group.name,
              displayName: entry.group.displayName,
            },
          };
        }
        return {
          name: entry.name ?? entry.path!,
          value: { type: 'template' as const, path: entry.path! },
        };
      }
    );

    if (stack.length > 0) {
      choices.push({
        name: '↩ Back',
        value: { type: 'back' as const },
      });
    }

    const { selection } = await inquirer.prompt<{ selection: Selection }>([
      {
        type: 'list',
        name: 'selection',
        message: `Select a template (${breadcrumb}):`,
        choices,
      },
    ]);

    if (selection.type === 'back') {
      stack.pop();
      continue;
    }

    if (selection.type === 'group') {
      stack.push(selection);
      continue;
    }

    return resolveEntryPath(repoPath, selection.path);
  }
}
