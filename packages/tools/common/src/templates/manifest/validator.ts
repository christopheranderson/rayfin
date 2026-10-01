import { z } from 'zod';

import { MAX_GROUP_DEPTH } from '../constants.js';

const VALID_API_VERSION = 'v1';

/** Zod schema for a relative path without traversal. */
const relativePathSchema = z
  .string()
  .min(1, 'path must be a non-empty string')
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.startsWith('\\') &&
      !/^[A-Za-z]:[\\/]/.test(p) &&
      !p.split(/[/\\]/).includes('..'),
    "path must be a relative path without '..' segments"
  );

/** Zod schema for a template entry (has path, optional name). */
const templateEntrySchema = z
  .object({
    name: z.string().min(1, 'name must be a non-empty string').optional(),
    path: relativePathSchema,
    description: z.string().optional(),
  })
  .strict();

/**
 * Zod schema for a manifest entry — either a template (with path) or a group.
 * Uses lazy evaluation for recursive group nesting.
 * Both branches use strict() to reject entries with both path and group.
 */
const manifestEntrySchema: z.ZodType = z.lazy(() =>
  z.union([
    templateEntrySchema,
    z
      .object({
        group: z.object({
          name: z.string().min(1, 'group.name is required'),
          displayName: z.string().min(1, 'group.displayName is required'),
          description: z.string().optional(),
          entries: z
            .array(manifestEntrySchema)
            .min(1, 'group.entries must not be empty'),
        }),
      })
      .strict(),
  ])
);

/** Zod schema for the template manifest (rayfin-template.yml). */
export const templateManifestSchema = z.object({
  apiVersion: z.literal(VALID_API_VERSION, {
    message: `apiVersion must be '${VALID_API_VERSION}'`,
  }),
  metadata: z.object({
    name: z.string().min(1, 'metadata.name is required'),
    displayName: z.string().optional(),
    description: z.string().optional(),
    version: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
  entries: z
    .array(manifestEntrySchema)
    .min(1, 'entries must contain at least one entry'),
});

/**
 * Collect all template names and paths from entries (recursively).
 * Returns an error string if duplicates or collisions are found.
 */
function checkEntryUniqueness(
  entries: unknown[],
  prefix: string,
  depth = 0,
  names = new Set<string>(),
  paths = new Set<string>()
): string[] {
  if (depth >= MAX_GROUP_DEPTH) {
    return [
      `${prefix}: group nesting exceeds maximum depth of ${MAX_GROUP_DEPTH}`,
    ];
  }

  const errors: string[] = [];
  const groupNames = new Set<string>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as Record<string, unknown>;
    if (!entry || typeof entry !== 'object') continue;

    if ('path' in entry && typeof entry.path === 'string') {
      const p = entry.path;
      const n =
        'name' in entry && typeof entry.name === 'string'
          ? entry.name
          : undefined;

      // Check path uniqueness
      if (paths.has(p)) {
        errors.push(`${prefix}[${i}].path '${p}' is a duplicate`);
      } else if (names.has(p)) {
        errors.push(`${prefix}[${i}].path '${p}' collides with an entry name`);
      }

      // Check name uniqueness (skip self-collision when name === path)
      if (n !== undefined) {
        if (names.has(n)) {
          errors.push(`${prefix}[${i}].name '${n}' is a duplicate`);
        } else if (n !== p && paths.has(n)) {
          errors.push(
            `${prefix}[${i}].name '${n}' collides with an entry path`
          );
        }
        names.add(n);
      }

      paths.add(p);
    }

    if ('group' in entry && entry.group && typeof entry.group === 'object') {
      const g = entry.group as Record<string, unknown>;
      if (typeof g.name === 'string') {
        if (groupNames.has(g.name)) {
          errors.push(`${prefix}[${i}].group.name '${g.name}' is a duplicate`);
        }
        groupNames.add(g.name);
      }
      if (Array.isArray(g.entries)) {
        errors.push(
          ...checkEntryUniqueness(
            g.entries as unknown[],
            `${prefix}[${i}].group.entries`,
            depth + 1,
            names,
            paths
          )
        );
      }
    }
  }

  return errors;
}

/**
 * Validate a parsed manifest object.
 * Returns an array of error strings (empty = valid).
 */
export function validateManifest(obj: unknown): string[] {
  const result = templateManifestSchema.safeParse(obj);
  if (!result.success) {
    return result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${path}${issue.message}`;
    });
  }

  // Zod validates structure; check cross-cutting uniqueness constraints
  const manifest = obj as { entries: unknown[] };
  return checkEntryUniqueness(manifest.entries, 'entries');
}
