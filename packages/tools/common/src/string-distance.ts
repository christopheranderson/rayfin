/**
 * Compute the Levenshtein edit distance between two strings.
 * Useful for fuzzy matching and typo suggestions.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }

  return dp[m][n];
}

/**
 * Find the closest match for `input` within `candidates` using
 * case-insensitive Levenshtein distance. Returns `undefined` if no
 * candidate is within `maxDistance` (default 3).
 *
 * Used by "Did you mean ...?" hints across the CLI, both for unknown
 * connector types and unknown operations on a known connector type.
 */
export function suggestClosest<T extends string>(
  input: string,
  candidates: readonly T[],
  maxDistance = 3
): T | undefined {
  const needle = input.toLowerCase();
  let best: T | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const d = levenshtein(needle, candidate.toLowerCase());
    if (d < bestDistance && d <= maxDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  return best;
}

/**
 * Formats the shared "Did you mean ...?" hint text, or `''` when there is no
 * suggestion. Centralizes this user-facing string so every call site stays
 * consistent (see {@link suggestClosest}).
 */
export function formatDidYouMeanHint(suggestion: string | undefined): string {
  return suggestion ? ` Did you mean "${suggestion}"?` : '';
}
