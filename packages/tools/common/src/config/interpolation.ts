/**
 * Environment variable interpolation for rayfin.yml configuration.
 *
 * Supports Docker Compose-style syntax: `${VAR}` and `${VAR:-default}`.
 *
 * These are **pure functions** — they operate on in-memory data only.
 * The consumer is responsible for loading the YAML string and building
 * the `envVars` Map (from .env files, shell, etc.).
 */

/**
 * Regex for `${VAR}` and `${VAR:-default}` syntax.
 *
 * ReDoS-safe by design:
 * - Var-name group uses `\w+` so it can't overlap with `:-` or `}`.
 * - Default-value group uses the "unrolled loop" pattern
 *   `[^}\\]*(?:\\.[^}\\]*)*` instead of `(?:[^}\\]|\\.)*`
 *   so each repeat must consume a `\\.` pair — no polynomial backtracking.
 */
const ENV_VAR_PATTERN = /\$\{(\w+)(?::-((?:[^}\\]*(?:\\.[^}\\]*)*)))?\}/g;

/**
 * Interpolates environment variables in a single string.
 *
 * @param str - String potentially containing `${VAR}` references.
 * @param envVars - Variable name → value map.
 * @param context - Config path for error messages (e.g. `"services.data.host"`).
 * @param envFilePath - Display path for error messages (default `"rayfin/.env"`).
 * @returns Interpolated string.
 * @throws If a referenced variable is not defined and has no default.
 */
export function interpolateString(
  str: string,
  envVars: Map<string, string>,
  context: string,
  envFilePath = 'rayfin/.env'
): string {
  return str.replace(
    ENV_VAR_PATTERN,
    (_match, varName: string, defaultValue?: string) => {
      const varValue = envVars.get(varName);

      // Docker Compose semantics: use default if var is unset OR empty
      if (varValue !== undefined && varValue !== '') {
        return varValue;
      }

      if (defaultValue !== undefined) {
        return defaultValue.replace(/\\}/g, '}');
      }

      throw new Error(
        `Environment variable '${varName}' referenced in rayfin.yml (${context}) is not defined.\n` +
          `   Set it in ${envFilePath} or shell environment.`
      );
    }
  );
}

/**
 * Attempts to coerce an interpolated string value to its YAML type.
 *
 * Returns `number`, `boolean`, `null`, or the original `string`.
 */
export function coerceType(value: string): string | number | boolean | null {
  if (value === '') return value;

  const lower = value.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (lower === 'null' || lower === '~') return null;

  const num = Number(value);
  if (!isNaN(num) && value.trim() === String(num)) return num;

  return value;
}

/**
 * Recursively interpolates environment variables in a parsed config object.
 *
 * @param config - Parsed YAML value (object, array, or primitive).
 * @param envVars - Variable name → value map.
 * @param contextPath - Dot-separated path for error messages.
 * @param envFilePath - Display path for error messages.
 * @returns A new object tree with all string values interpolated.
 */
export function interpolateConfig(
  config: unknown,
  envVars: Map<string, string>,
  contextPath = 'root',
  envFilePath = 'rayfin/.env'
): unknown {
  if (config === null || config === undefined) return config;

  if (Array.isArray(config)) {
    return config.map((item: unknown, i: number) =>
      interpolateConfig(item, envVars, `${contextPath}[${i}]`, envFilePath)
    );
  }

  if (typeof config === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      config as Record<string, unknown>
    )) {
      const newContext = contextPath === 'root' ? key : `${contextPath}.${key}`;
      result[key] = interpolateConfig(value, envVars, newContext, envFilePath);
    }
    return result;
  }

  if (typeof config === 'string') {
    const interpolated = interpolateString(
      config,
      envVars,
      contextPath,
      envFilePath
    );
    // If the entire string was a single ${VAR} reference, coerce the type
    if (
      config.startsWith('${') &&
      config.endsWith('}') &&
      !config.includes('$', 2)
    ) {
      return coerceType(interpolated);
    }
    return interpolated;
  }

  // Primitives (number, boolean) pass through unchanged
  return config;
}
