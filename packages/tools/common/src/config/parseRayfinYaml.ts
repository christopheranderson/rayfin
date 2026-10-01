import { parse } from 'yaml';

import { interpolateConfig } from './interpolation.js';
import type { ConnectorEntry, RayfinConfig } from './types.js';

/**
 * Parse a `rayfin.yml` string into a typed {@link RayfinConfig}.
 *
 * No environment-variable interpolation is performed — `${VAR}` references
 * are left as literal strings. Use {@link parseRayfinYamlInterpolated} when
 * you need interpolation.
 *
 * This is a **pure function** — no file I/O. The consumer reads the file.
 *
 * @param yamlContent - Raw YAML string content.
 * @returns Parsed configuration object.
 * @throws On invalid YAML.
 */
export function parseRayfinYaml(yamlContent: string): RayfinConfig {
  const parsed = parse(yamlContent) as RayfinConfig;
  return applyDefaults(parsed);
}

/**
 * Parse a `rayfin.yml` string with environment-variable interpolation.
 *
 * Supports Docker Compose-style `${VAR}` and `${VAR:-default}` syntax.
 *
 * @param yamlContent - Raw YAML string content.
 * @param envVars - Variable name → value map (from .env, shell, etc.).
 * @param envFilePath - Display path used in error messages (default `"rayfin/.env"`).
 * @returns Parsed and interpolated configuration object.
 * @throws On invalid YAML or missing environment variables.
 */
export function parseRayfinYamlInterpolated(
  yamlContent: string,
  envVars: Map<string, string>,
  envFilePath = 'rayfin/.env'
): RayfinConfig {
  const parsed = parse(yamlContent) as unknown;
  const interpolated = interpolateConfig(
    parsed,
    envVars,
    'root',
    envFilePath
  ) as RayfinConfig;
  return applyDefaults(interpolated);
}

/**
 * Normalize a raw `connectors` block (as read from `rayfin.yml`) into the
 * canonical `ConnectorEntry[]` shape:
 *
 * - Map shape (legacy) `{ name: { connector: ... } }` becomes an array
 *   with `name` lifted to a field.
 * - Per-entry legacy `connector:` field is renamed to `type:`.
 *
 * Returns `undefined` for missing/empty input. Unknown shapes pass through
 * to the validator, which produces a structured error.
 *
 * Exported so YAML-edit commands (`connector add/remove`) can normalize
 * after a raw `yaml.parse` without going through {@link parseRayfinYaml}.
 */
export function normalizeConnectorsBlock(
  raw: unknown
): ConnectorEntry[] | undefined {
  if (raw == null) {
    return undefined;
  }

  if (Array.isArray(raw)) {
    return raw.map((entry) => normalizeEntry(entry));
  }

  if (typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>).map(([name, value]) =>
      normalizeEntry({ name, ...(value as Record<string, unknown>) })
    );
  }

  // Anything else (string, number, …) is a malformed block; preserve it
  // by returning an empty array so the validator can flag it cleanly.
  return [];
}

function normalizeEntry(raw: unknown): ConnectorEntry {
  const entry = (raw ?? {}) as Record<string, unknown>;
  const { connector, type, ...rest } = entry;
  // Prefer `type` when both are present; legacy entries use `connector`.
  const resolvedType = (type ?? connector) as ConnectorEntry['type'];
  return {
    ...(rest as Omit<ConnectorEntry, 'type'>),
    type: resolvedType,
  } as ConnectorEntry;
}

/**
 * Apply sensible defaults for optional fields so consumers don't need
 * defensive optional-chaining everywhere.
 */
function applyDefaults(config: RayfinConfig): RayfinConfig {
  config.services ??= {} as RayfinConfig['services'];
  config.services.auth ??= { enabled: false };
  config.services.data ??= { enabled: false };
  // Required on the wire: the host's `ServiceSettings.Storage` is a `required`
  // property, and every runtime-settings POST sends `config.services` as-is.
  // Dropping this default makes those requests fail with a 400.
  config.services.storage ??= { enabled: false };
  config.services.staticHosting ??= { enabled: false, folder: 'dist' };
  if (config.frontend) {
    config.frontend.outputDir ??= '.';
  }
  // Preserve authored auth, including missing or invalid values, so validation
  // can require explicit application auth rather than silently migrating it.
  config.services.functions ??= { enabled: false };
  config.connectors = normalizeConnectorsBlock(config.connectors as unknown) as
    | ConnectorEntry[]
    | undefined;
  return config;
}
