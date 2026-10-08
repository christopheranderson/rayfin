/**
 * @internal
 * Reads `RAYFIN_FEATURE_FLAGS` (comma-separated) and returns whether the
 * `cli-minor-fixes` GA-rollout gate is on. Matches the CLI's flag semantics
 * (`createCliFeatureFlags(projectRoot).get('cli-minor-fixes')`) so both
 * CLI-driven and direct-SDK code paths honor the same env var.
 *
 * Browsers/runtimes without `process.env` are treated as flag-off.
 */
export function isMinorFixesOn(): boolean {
  const raw =
    typeof process !== 'undefined' && process.env
      ? process.env.RAYFIN_FEATURE_FLAGS
      : undefined;
  if (!raw) return false;
  for (const token of raw.split(',')) {
    if (token.trim().toLowerCase() === 'cli-minor-fixes') return true;
  }
  return false;
}
