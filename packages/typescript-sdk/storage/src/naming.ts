/**
 * Normalizes a container/folder name so it satisfies Azure Blob container
 * naming rules:
 * - lowercase letters, numbers, and hyphen (`-`) only
 * - must start and end with a letter or number
 * - no consecutive hyphens
 * - length between 3 and 63 characters
 *
 * Internal to this package — not part of its public export surface.
 *
 * @param input - The raw container/folder name to normalize.
 * @returns A name guaranteed to satisfy Azure Blob container naming rules.
 */
export function normalizeContainerName(input: string): string {
  // 1) Lowercase
  let name = (input ?? '').toLowerCase();

  // 2) Replace any invalid characters with '-'
  name = name.replace(/[^a-z0-9-]/g, '-');

  // 3) Collapse multiple hyphens
  name = name.replace(/-+/g, '-');

  // 4) Trim hyphens from start and end to ensure starts/ends with alphanumeric
  name = name.replace(/^-+|(?<!-)-+$/g, '');

  // 5) Fallback if empty after sanitization
  if (name.length === 0) {
    name = 'container';
  }

  // 6) Enforce length constraints (3..63)
  if (name.length < 3) {
    name = name.padEnd(3, '0');
  }
  if (name.length > 63) {
    name = name.substring(0, 63);
  }

  // 7) Re-trim trailing hyphens after truncation, and ensure minimum length
  name = name.replace(/^|(?<!-)-+$/g, '');
  if (name.length < 3) {
    name = (name + '000').substring(0, 3);
  }

  return name;
}
