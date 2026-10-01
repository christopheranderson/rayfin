/**
 * Normalize a display name for fuzzy matching: lowercases and strips
 * every character except Unicode letters and numbers.
 */
export function normalizeForFuzzyMatch(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}
