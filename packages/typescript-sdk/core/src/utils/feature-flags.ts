/**
 * Minimal, dependency-free feature-flag reader for the rayfin-core runtime.
 *
 * The CLI owns the authoritative flag registry (`@microsoft/rayfin-tools-common`
 * / `createCliFeatureFlags`), but rayfin-core is consumed from both the CLI and
 * deployed apps and cannot depend on the CLI package. For env-only flags such
 * as `cli-minor-fixes` the CLI resolver is simply `parseFeatureFlags(env).has(name)`,
 * so we mirror that same semantics here by reading `RAYFIN_FEATURE_FLAGS` directly.
 */
export const FEATURE_FLAGS_ENV_VAR = 'RAYFIN_FEATURE_FLAGS';

function normalizeFeatureFlagName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Returns true when `name` appears in the comma-separated
 * `RAYFIN_FEATURE_FLAGS` environment variable. Matching is case-insensitive and
 * whitespace-insensitive, matching the CLI's `parseFeatureFlags` behavior.
 */
export function isFeatureFlagEnabled(
  name: string,
  env?: NodeJS.ProcessEnv
): boolean {
  const resolvedEnv =
    env ?? (typeof process !== 'undefined' ? process.env : undefined);
  const raw = resolvedEnv?.[FEATURE_FLAGS_ENV_VAR] ?? '';
  const enabled = new Set(
    raw
      .split(',')
      .map((flag) => normalizeFeatureFlagName(flag))
      .filter((flag) => flag.length > 0)
  );

  return enabled.has(normalizeFeatureFlagName(name));
}
