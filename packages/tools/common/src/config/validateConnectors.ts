import { suggestClosest } from '../string-distance.js';

import { CONNECTOR_CATALOG } from './connectors.js';
import type { ConnectorMeta } from './connectors.js';
import type {
  ConnectorAuthType,
  ConnectorEntry,
  ConnectorOperationType,
  ConnectorType,
} from './types.js';

/**
 * All known connector types, derived from the connector catalog.
 * Typed as `readonly ConnectorType[]` so the compiler ensures it stays
 * in sync with the `ConnectorType` union.
 */
export const KNOWN_CONNECTOR_TYPES: readonly ConnectorType[] = Object.keys(
  CONNECTOR_CATALOG
) as ConnectorType[];

const KNOWN_AUTH_TYPES: readonly ConnectorAuthType[] = [
  'delegated',
  'application',
];

const CONNECTOR_NAME_PATTERN = /^[a-zA-Z0-9\-_]+$/;
const MAX_CONNECTOR_NAME_LENGTH = 256;

/**
 * Whether a connector name is safe to interpolate into file paths, import
 * specifiers, and quoted map keys.
 *
 * Exported because `rayfin.yml` is a hand-editable file: consumers that read
 * entries without re-running full config validation (the wiring generator, for
 * one) still need to reject a malformed name before it reaches generated
 * source.
 */
export function isValidConnectorName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_CONNECTOR_NAME_LENGTH &&
    CONNECTOR_NAME_PATTERN.test(name)
  );
}

/**
 * Set of connector types that require `config.workspaceId` and `config.itemId`,
 * derived from the catalog's `requiredConfigArgs`.
 */
const FABRIC_CONNECTORS = new Set<ConnectorType>(
  (
    Object.entries(CONNECTOR_CATALOG) as [
      ConnectorType,
      { requiredConfigArgs: string[] },
    ][]
  )
    .filter(([, meta]) => meta.requiredConfigArgs.includes('workspaceId'))
    .map(([type]) => type)
);

/**
 * Set of connector types that require `config.version`,
 * derived from the catalog's `requiresVersion` flag.
 */
const VERSIONED_CONNECTORS = new Set<ConnectorType>(
  (Object.entries(CONNECTOR_CATALOG) as [ConnectorType, ConnectorMeta][])
    .filter(([, meta]) => meta.requiresVersion)
    .map(([type]) => type)
);

export interface ConnectorValidationError {
  /** The connector entry's `name`, or `'<unnamed>'` when missing. */
  sourceName: string;
  message: string;
}

/**
 * Validate all connector entries from `rayfin.yml`.
 *
 * Returns an array of validation errors. An empty array means every entry is
 * valid. A missing or empty `connectors` array is valid (no error).
 */
export function validateConnectors(
  connectors: ConnectorEntry[] | undefined
): ConnectorValidationError[] {
  if (!connectors || connectors.length === 0) {
    return [];
  }

  const errors: ConnectorValidationError[] = [];
  const seenNames = new Set<string>();

  for (const entry of connectors) {
    const name = entry.name ?? '<unnamed>';

    // Validate name presence
    if (!entry.name || !entry.name.trim()) {
      errors.push({
        sourceName: name,
        message: `Connector entry is missing required field "name".`,
      });
      continue;
    }

    if (entry.name.length > MAX_CONNECTOR_NAME_LENGTH) {
      errors.push({
        sourceName: name,
        message: `Connector name "${entry.name}" exceeds maximum length of ${MAX_CONNECTOR_NAME_LENGTH} characters.`,
      });
    } else if (!CONNECTOR_NAME_PATTERN.test(entry.name)) {
      errors.push({
        sourceName: name,
        message: `Connector name "${entry.name}" contains invalid characters. Only alphanumeric characters, hyphens, and underscores are allowed.`,
      });
    }

    if (seenNames.has(entry.name)) {
      errors.push({
        sourceName: name,
        message: `Duplicate connector name "${entry.name}". Each entry under "connectors:" must have a unique name.`,
      });
    } else {
      seenNames.add(entry.name);
    }

    // Validate type field
    if (!entry.type) {
      errors.push({
        sourceName: name,
        message: `Connector "${name}" is missing required field "type".`,
      });
      continue;
    }

    if (!KNOWN_CONNECTOR_TYPES.includes(entry.type as ConnectorType)) {
      errors.push({
        sourceName: name,
        message: `Connector "${name}" has unsupported type "${entry.type}". Supported types: ${KNOWN_CONNECTOR_TYPES.join(', ')}.`,
      });
      continue;
    }

    // Validate Fabric connector requirements
    if (FABRIC_CONNECTORS.has(entry.type)) {
      if (!entry.config?.workspaceId) {
        errors.push({
          sourceName: name,
          message: `Connector "${name}" (${entry.type}) requires "config.workspaceId".`,
        });
      }
      if (!entry.config?.itemId) {
        errors.push({
          sourceName: name,
          message: `Connector "${name}" (${entry.type}) requires "config.itemId".`,
        });
      }
    }

    // Validate pinned adapter version requirement (Cat B connectors).
    if (VERSIONED_CONNECTORS.has(entry.type) && !entry.version?.trim()) {
      errors.push({
        sourceName: name,
        message: `Connector "${name}" (${entry.type}) requires "version".`,
      });
    }

    // Validate version format for connectors that have one. The workload
    // parses `version` as an int and routes invocations to
    // `rayfin_<type>_v<n>` functions, so reject decimal, signed,
    // leading-zero, or non-numeric values at validation time instead of
    // letting them fail at runtime with INVALID_CONNECTOR_VERSION.
    // Mirrors the host `ConnectorVersionPattern` in
    // `ConnectorsSettingsValidator.cs`.
    if (VERSIONED_CONNECTORS.has(entry.type) && entry.version?.trim()) {
      const trimmed = entry.version.trim();
      if (!/^[1-9][0-9]*$/.test(trimmed)) {
        errors.push({
          sourceName: name,
          message: `Connector "${name}" (${entry.type}) has invalid "version" "${entry.version}": must be a positive integer (e.g. "1", "2").`,
        });
      }
    }

    // Validate auth. Required by the host contract; default-on-read is not
    // applied so Builders get an explicit error rather than a silent default.
    if (!entry.auth || !entry.auth.type) {
      errors.push({
        sourceName: name,
        message: `Connector "${name}" is missing required field "auth.type".`,
      });
    } else if (!KNOWN_AUTH_TYPES.includes(entry.auth.type)) {
      errors.push({
        sourceName: name,
        message: `Connector "${name}" has unsupported "auth.type" "${entry.auth.type}". Supported: ${KNOWN_AUTH_TYPES.join(', ')}.`,
      });
    } else if (
      !CONNECTOR_CATALOG[entry.type].allowedAuthTypes.includes(entry.auth.type)
    ) {
      errors.push({
        sourceName: name,
        message: `Connector "${name}" (${entry.type}) does not support auth type "${entry.auth.type}".`,
      });
    }

    // Validate requested operations against the connector's allowed set.
    // Operations are object entries (`{ name }`) on the wire, mirroring the
    // host `ConnectorOperation` model in `Microsoft.Rayfin.Common.Models`.
    if (entry.operations && entry.operations.length > 0) {
      const allowed = new Set<ConnectorOperationType>(
        CONNECTOR_CATALOG[entry.type].allowedOperations
      );
      const seen = new Set<ConnectorOperationType>();
      for (const op of entry.operations) {
        const opName = op?.name;
        if (!opName) {
          errors.push({
            sourceName: name,
            message: `Connector "${name}" has an operation entry missing required field "name".`,
          });
          continue;
        }
        if (seen.has(opName)) {
          errors.push({
            sourceName: name,
            message: `Connector "${name}" has duplicate operation "${opName}".`,
          });
          continue;
        }
        seen.add(opName);

        if (!allowed.has(opName)) {
          const suggestion = suggestClosest(opName, [...allowed]);
          const hint = suggestion ? ` Did you mean "${suggestion}"?` : '';
          errors.push({
            sourceName: name,
            message: `Connector "${name}" (${entry.type}) does not support operation "${opName}".${hint}`,
          });
        }
      }
    }
  }

  return errors;
}

/**
 * Result of {@link parseConnectorOperations}.
 *
 * Discriminated union so callers can branch on success vs failure
 * without try/catch and without coupling to a CLI-specific error type.
 */
export type ParseConnectorOperationsResult =
  | { ok: true; operations: ConnectorOperationType[] }
  | { ok: false; message: string };

/**
 * Parse and validate a comma-separated `--operations` value (or any
 * caller-provided CSV string) against the allowed-operations set for a
 * connector type. Deduplicates while preserving input order.
 *
 * Returns a {@link ParseConnectorOperationsResult} rather than throwing,
 * so this can be shared between the CLI (which wraps the error into a
 * `CliHandledError`) and any other consumer.
 *
 * Unknown operation names produce a "Did you mean ...?" hint using
 * Levenshtein distance over the connector's allowed set, so customers
 * can't silently land bogus identifiers like `executeQuery2` in their
 * YAML.
 */
export function parseConnectorOperations(
  raw: string,
  connectorType: ConnectorType
): ParseConnectorOperationsResult {
  const allowed = CONNECTOR_CATALOG[connectorType].allowedOperations;
  const allowedSet = new Set<string>(allowed);
  const seen = new Set<string>();
  const operations: ConnectorOperationType[] = [];

  for (const piece of raw.split(',')) {
    const trimmed = piece.trim();
    if (!trimmed) continue;

    if (!allowedSet.has(trimmed)) {
      const suggestion = suggestClosest(trimmed, allowed);
      const hint = suggestion ? ` Did you mean "${suggestion}"?` : '';
      return {
        ok: false,
        message: `Connector "${connectorType}" does not support operation "${trimmed}". Allowed: ${allowed.join(', ')}.${hint}`,
      };
    }

    if (seen.has(trimmed)) {
      // Silently de-duplicate within a single input value.
      continue;
    }
    seen.add(trimmed);
    operations.push(trimmed as ConnectorOperationType);
  }

  if (operations.length === 0) {
    return {
      ok: false,
      message: `No operations were provided. Provide at least one of: ${allowed.join(', ')}.`,
    };
  }

  return { ok: true, operations };
}
