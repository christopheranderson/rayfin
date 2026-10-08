/**
 * Deterministic JSON canonicalization for content hashing.
 *
 * Used by ai-files for stable lockfile serialization and for sha256
 * comparison of nested JSON values (e.g., `mcpServers.<name>` objects).
 *
 * Output: 2-space indented JSON, recursively sorted object keys, no trailing
 * newline. Arrays preserve their order (semantically meaningful).
 */

export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(value, sortKeysReplacer, 2);
}

function sortKeysReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}
