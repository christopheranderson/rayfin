import pluralize from 'pluralize';

import { getBackendUrl } from './backend';

const RAYFIN_PUBLISHABLE_KEY = 'pk-commonSampleAppPKkey';

/** Execute a raw GraphQL query/mutation and return the parsed JSON response. */
export async function executeGraphQL(
  query: string,
  accessToken?: string
): Promise<{
  data?: Record<string, unknown>;
  errors?: Array<{
    message: string;
    extensions?: Record<string, unknown>;
  }>;
}> {
  const baseUrl = getBackendUrl();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Publishable-Key': RAYFIN_PUBLISHABLE_KEY,
  };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }
  const response = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
  });
  return response.json();
}

/** Parsed field info extracted from a Rayfin entity source string. */
export interface ParsedEntityField {
  /** The field name as declared in the entity class. */
  name: string;
  /** The decorator name (e.g. 'uuid', 'text', 'one'). */
  decorator: string;
  /** Whether the field is optional (uses `?` syntax or `{ optional: true }`). */
  optional: boolean;
}

/**
 * Parse scalar field declarations from a Rayfin entity source string.
 * Returns only scalar fields (excludes `@one` and `@many` relationships).
 */
export function parseScalarFields(entityContent: string): ParsedEntityField[] {
  const fields: ParsedEntityField[] = [];
  // Match: @decorator(...) fieldName!: or @decorator(...) fieldName?:
  const pattern =
    /@(uuid|text|int|decimal|boolean|date|email|set)\(([^)]*)\)\s+(\w+)([!?]):/g;
  let match;

  while ((match = pattern.exec(entityContent)) !== null) {
    const [, decorator, args, name, modifier] = match;
    const optional = modifier === '?' || args.includes('optional: true');
    fields.push({ name, decorator, optional });
  }

  return fields;
}

/**
 * Convert an entity class name to its GraphQL query root field (plural, camelCase).
 * E.g., "TestEntity1" → "testEntity1s", "Category" → "categories".
 */
function toQueryRoot(entityName: string): string {
  const plural = pluralize.plural(entityName);
  return plural.charAt(0).toLowerCase() + plural.slice(1);
}

/**
 * Probe whether an entity exists in the live GraphQL schema by attempting a
 * minimal query. Returns `true` when the query succeeds (entity is present).
 */
export async function probeEntityExists(
  entityName: string,
  accessToken: string
): Promise<boolean> {
  const root = toQueryRoot(entityName);
  const result = await executeGraphQL(
    `{ ${root} { items { id } } }`,
    accessToken
  );
  return !result.errors;
}

/**
 * Probe whether specific scalar fields exist on an entity by querying them.
 * Returns `success: true` when all fields are valid in the live schema.
 */
export async function probeFields(
  entityName: string,
  fieldNames: string[],
  accessToken: string
): Promise<{ success: boolean; errors?: Array<{ message: string }> }> {
  const root = toQueryRoot(entityName);
  const query = `{ ${root} { items { ${fieldNames.join(' ')} } } }`;
  const result = await executeGraphQL(query, accessToken);
  return { success: !result.errors, errors: result.errors };
}

/**
 * Check whether a single field is absent from an entity's GraphQL schema.
 * Returns `true` when querying the field produces a validation error.
 */
export async function isFieldAbsent(
  entityName: string,
  fieldName: string,
  accessToken: string
): Promise<boolean> {
  const result = await probeFields(entityName, [fieldName], accessToken);
  return !result.success;
}
