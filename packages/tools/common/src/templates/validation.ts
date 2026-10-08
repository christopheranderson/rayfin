import type { ProjectNames, TemplateInfo } from './types.js';

// Allow letters, numbers, spaces, hyphens, and underscores in the display name
export const PROJECT_NAME_REGEX = /^[a-zA-Z0-9\s\-_]+$/;
// Slugs must be lowercase alphanumeric segments separated by single hyphens
export const PROJECT_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Generate a normalized slug from the provided project name.
 * Ensures we return lowercase hyphen-separated tokens without leading/trailing hyphens.
 */
export function generateProjectSlug(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return '';
  }

  // Normalize separators and camelCase transitions before lowering the case
  const withWordBoundaries = trimmed
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z0-9]+)/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-');

  const lowercase = withWordBoundaries.toLowerCase();

  return lowercase.replace(/^-+/, '').replace(/-+$/, '');
}

/**
 * Check if a project name is valid
 */
export function isValidProjectName(name: string): boolean {
  if (!name || !PROJECT_NAME_REGEX.test(name)) {
    return false;
  }

  const slug = generateProjectSlug(name);
  return slug.length > 0 && PROJECT_SLUG_REGEX.test(slug);
}

/**
 * Transform project name to different cases
 */
export function transformProjectName(name: string): ProjectNames {
  const trimmed = name.trim();
  const display = trimmed.replace(/\s+/g, ' ');
  const kebab = generateProjectSlug(display);

  if (!kebab) {
    throw new Error('Project slug cannot be empty');
  }

  const pascal = display
    .replace(/[-_\s]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/^(.)/, (c) => c.toUpperCase());

  return {
    original: name,
    display,
    kebab,
    pascal,
  };
}

/**
 * Find a template by name from the discovered templates.
 * Excludes the synthetic Copilot template from the search.
 */
export function findTemplateByName(
  templates: TemplateInfo[],
  name: string
): TemplateInfo | undefined {
  return templates.find((t) => t.name === name && !t.isCopilotTemplate);
}
