import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  describeReservedEntityName,
  getReservedEntityNameReason,
  RESERVED_ENTITY_NAMES,
} from '@microsoft/rayfin-core/analysis';
import type { Diagnostics } from '@microsoft/rayfin-tools-common/_internal/adapters';
import type {
  ConnectorEntry,
  ConnectorType,
  RayfinConfig,
} from '@microsoft/rayfin-tools-common/_internal/config';
import { CONNECTOR_CATALOG } from '@microsoft/rayfin-tools-common/_internal/config';
import {
  CONNECTOR_CONFIG_SKIP_REASON,
  type ConnectorConfigSkipReason,
} from '@microsoft/rayfin-tools-common/_internal/services/connectors';

import { MONIKER_HEADER } from '../config/constants.js';

import { applyConfigToServer } from './dab-apply.js';
import {
  modeLog,
  modeWarn,
  type OutputMode,
  type ProgressIndicator,
} from './output-mode.js';
import { HttpError, withRetry } from './retry-utils.js';

/**
 * Connector types whose Builder-authored DAB config can be applied to the
 * workload via the GraphQL connector apply endpoint. Derived from
 * `CONNECTOR_CATALOG` — any entry with a non-null `dialect` is treated as
 * GraphQL-capable (matches what `connector-generator.ts` will produce a
 * `dab-config.json` for). Cat-B connectors (e.g. `fabric-semanticmodel`,
 * `dialect: null`) take a different code path and are skipped here.
 */
export const GRAPHQL_CONNECTOR_TYPES: readonly ConnectorType[] = (
  Object.keys(CONNECTOR_CATALOG) as ConnectorType[]
).filter((type) => CONNECTOR_CATALOG[type].dialect != null);

const isGraphQlConnector = (entry: ConnectorEntry): boolean =>
  CONNECTOR_CATALOG[entry.type]?.dialect != null;

/**
 * Narrow declared connectors to those that are safe to apply after generation.
 *
 * A GraphQL connector is applied only when it was freshly generated (its name
 * appears in `generatedNames`). If generation errored or was skipped (e.g. no
 * compiled entity exports were found), the connector is excluded — otherwise
 * `applyConnectorConfigs` would redeploy whatever stale `dab-config.json` is
 * still on disk from an earlier run. Non-GraphQL (Cat-B) connectors are always
 * forwarded; apply reports them as an intentional, non-error skip.
 */
export function selectConnectorsToApply(
  connectors: readonly ConnectorEntry[],
  generatedNames: Iterable<string>
): ConnectorEntry[] {
  const generated = new Set(generatedNames);
  return connectors.filter(
    (entry) => generated.has(entry.name) || !isGraphQlConnector(entry)
  );
}

/**
 * A single GraphQL entity/type name declared by more than one connector.
 */
export interface ConnectorEntityCollision {
  /** The colliding GraphQL type (entity) name. */
  entityName: string;
  /** Connector names that each declare an entity with this name. */
  connectors: string[];
}

/**
 * Read the entity (GraphQL type) names out of a connector's generated
 * `dab-config.json`. Returns an empty list when the config is absent,
 * malformed, or has no `entities` map — the apply step reports those.
 */
function readGeneratedEntityNames(
  projectRoot: string,
  connectorName: string
): string[] {
  const configPath = join(
    projectRoot,
    'rayfin',
    '.temp',
    'connectors',
    connectorName,
    'dab-config.json'
  );
  if (!existsSync(configPath)) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return [];
  }

  const entities = (parsed as { entities?: Record<string, unknown> })?.entities;
  if (!entities || typeof entities !== 'object') {
    return [];
  }

  return Object.keys(entities);
}

/**
 * Inspect each connector's generated `dab-config.json` and report entity
 * (GraphQL type) names declared by more than one connector.
 *
 * DAB derives each entity's GraphQL type name from its entity key, and those
 * type names are **global** across every connector applied to the workload.
 * When two connectors declare an entity with the same name, the workload
 * rejects the second `applyconfig` with a duplicate/redefined GraphQL type
 * error. Detecting the clash locally lets `rayfin up` / `rayfin up connector apply`
 * fail early with an actionable message before any config is POSTed.
 *
 * Connectors without a generated config on disk are skipped (nothing to
 * compare); malformed configs are ignored here and surfaced by the apply step.
 */
export function detectConnectorEntityCollisions(
  projectRoot: string,
  connectorNames: readonly string[]
): ConnectorEntityCollision[] {
  const entityToConnectors = new Map<string, string[]>();

  for (const name of connectorNames) {
    for (const entityName of readGeneratedEntityNames(projectRoot, name)) {
      const owners = entityToConnectors.get(entityName) ?? [];
      if (!owners.includes(name)) {
        owners.push(name);
      }
      entityToConnectors.set(entityName, owners);
    }
  }

  const collisions: ConnectorEntityCollision[] = [];
  for (const [entityName, owners] of entityToConnectors) {
    if (owners.length > 1) {
      collisions.push({ entityName, connectors: owners.sort() });
    }
  }

  return collisions.sort((a, b) => a.entityName.localeCompare(b.entityName));
}

/**
 * Build a multi-line, user-facing error message describing entity name
 * collisions across connectors, including guidance on how to resolve them.
 */
export function formatConnectorEntityCollisionError(
  collisions: readonly ConnectorEntityCollision[]
): string {
  const lines = collisions.map(
    (c) =>
      `  • "${c.entityName}" is declared by connectors: ${c.connectors.join(', ')}`
  );
  return [
    'Duplicate GraphQL type names detected across connectors:',
    ...lines,
    '',
    'GraphQL type names are global across all connectors, so two connectors cannot',
    'declare an entity with the same name. Rename the entity (for example, prefix it',
    'with the source database or connector name) so each GraphQL type is unique, then',
    're-run.',
  ].join('\n');
}

/**
 * A single entity whose GraphQL type name is reserved by the platform.
 */
export interface ReservedConnectorEntityName {
  /** The reserved GraphQL type (entity) name. */
  entityName: string;
  /** Connector names that declare an entity with this name. */
  connectors: string[];
}

/**
 * Inspect each connector's generated `dab-config.json` and report entity names
 * that collide with a GraphQL type the Fabric GraphQL workload already defines
 * (built-in scalars such as `Date`, the operation root types, and the `__`
 * introspection prefix).
 *
 * The workload rejects such a config during schema build with an error that
 * names neither the entity nor the connector, so this pre-flight runs before
 * anything is POSTed. It is a backstop for the same rule enforced by
 * `ConnectorSchemaAnalyzer` during generation, and it also catches a
 * `dab-config.json` produced outside that path.
 */
export function detectReservedConnectorEntityNames(
  projectRoot: string,
  connectorNames: readonly string[]
): ReservedConnectorEntityName[] {
  const reservedToConnectors = new Map<string, string[]>();

  for (const name of connectorNames) {
    for (const entityName of readGeneratedEntityNames(projectRoot, name)) {
      if (!getReservedEntityNameReason(entityName)) {
        continue;
      }
      const owners = reservedToConnectors.get(entityName) ?? [];
      if (!owners.includes(name)) {
        owners.push(name);
      }
      reservedToConnectors.set(entityName, owners);
    }
  }

  return Array.from(reservedToConnectors, ([entityName, connectors]) => ({
    entityName,
    connectors: connectors.sort(),
  })).sort((a, b) => a.entityName.localeCompare(b.entityName));
}

/**
 * Build a multi-line, user-facing error message describing reserved entity
 * names, including guidance on how to resolve them.
 */
export function formatReservedConnectorEntityNameError(
  reserved: readonly ReservedConnectorEntityName[]
): string {
  const lines = reserved.map((r) => {
    const reason = getReservedEntityNameReason(r.entityName);
    const detail = reason
      ? describeReservedEntityName(r.entityName, reason)
      : `Entity name '${r.entityName}' is reserved`;
    return `   • ${detail} (declared by: ${r.connectors.join(', ')})`;
  });
  return [
    'Reserved GraphQL type names detected in connector entities:',
    ...lines,
    '',
    '   These names are already defined by the GraphQL schema the platform builds, so',
    '   the workload rejects the whole configuration. Rename the entity class — or pass',
    "   an explicit name to @entity('...') and keep Source({ table: '...' }) pointed at",
    '   the original table — then re-run.',
    '',
    `   Reserved names: ${RESERVED_ENTITY_NAMES.join(', ')}, and any name starting with "__".`,
  ].join('\n');
}

/**
 * Per-connector apply outcome, surfaced for both step timings and JSON
 * output. `skipped` is used when the entry isn't a GraphQL connector or
 * when its generated DAB config file isn't on disk yet — neither is an
 * error.
 */
export type ConnectorApplyResult =
  | {
      name: string;
      connector: ConnectorType;
      status: 'success';
      durationMs: number;
    }
  | {
      name: string;
      connector: ConnectorType;
      status: 'skipped';
      skipReason: ConnectorConfigSkipReason;
      reason: string;
    }
  | {
      name: string;
      connector: ConnectorType;
      status: 'error';
      error: string;
      durationMs: number;
    };

export interface ApplyConnectorConfigsOptions {
  diagnostics?: Diagnostics;
  /**
   * Full workload endpoint base, e.g.
   * `https://<api>/workspaces/<ws>/appBackends/<itemId>`. The per-connector
   * apply URL is composed from this base.
   */
  itemEndpoint: string;
  rayfinItemId: string;
  authorizationHeader: string;
  /** Project root used to locate `rayfin/.temp/connectors/<name>/dab-config.json`. */
  projectRoot: string;
  /** Connector map from `rayfin.yml` (`RayfinConfig.connectors`). */
  connectors: RayfinConfig['connectors'];
  mode: OutputMode;
  verbose: (...args: any[]) => void;
  /** Optional filter — apply only this connector. */
  connectorFilter?: string;
  /**
   * Distinguishes the inline call site (`rayfin up`) from the standalone
   * call site (`rayfin up connector apply`). Only standalone surfaces the
   * "run `rayfin up` first" hint on `UNKNOWN_CONNECTOR` failures, because
   * inline callers already are running `rayfin up`.
   */
  context: 'inline' | 'standalone';
  /**
   * Optional spinner factory matching the one used elsewhere in `up.ts`.
   * When omitted, the helper falls back to plain `modeLog` writes.
   */
  showProgress?: (message: string, emoji?: string) => ProgressIndicator;
}

export interface ApplyConnectorConfigsOutcome {
  /** Per-connector results in iteration order. */
  results: ConnectorApplyResult[];
  /**
   * Step timings keyed `connector:<name>`, ready to merge into `up`'s
   * `stepResults` map for JSON output.
   */
  steps: Record<
    string,
    { duration: string; status: 'success' | 'error'; error?: string }
  >;
}

/**
 * Iterate `rayfin.yml`'s `connectors` map and POST each GraphQL-capable
 * connector's pre-generated DAB config to the workload. Failures are
 * non-fatal: each connector is processed independently and surfaced via
 * `modeWarn` so a single bad connector doesn't abort `rayfin up`.
 *
 * Generation of `rayfin/.temp/connectors/<name>/dab-config.json` is owned
 * by `services/connector-generator.ts`; this helper consumes whatever is
 * already on disk.
 */
export async function applyConnectorConfigs(
  options: ApplyConnectorConfigsOptions
): Promise<ApplyConnectorConfigsOutcome> {
  const {
    itemEndpoint,
    rayfinItemId,
    authorizationHeader,
    projectRoot,
    connectors,
    mode,
    verbose,
    connectorFilter,
    context,
    showProgress,
  } = options;

  const results: ConnectorApplyResult[] = [];
  const steps: ApplyConnectorConfigsOutcome['steps'] = {};

  if (!connectors || connectors.length === 0) {
    verbose('[connectors] No connectors declared in rayfin.yml — skipping');
    return { results, steps };
  }

  const entries = connectors.filter((entry) =>
    connectorFilter ? entry.name === connectorFilter : true
  );

  if (connectorFilter && entries.length === 0) {
    modeWarn(
      mode,
      `⚠️  Connector "${connectorFilter}" not found in rayfin.yml.`
    );
    return { results, steps };
  }

  for (const entry of entries) {
    const name = entry.name;
    const stepKey = `connector:${name}`;
    const start = Date.now();

    if (!isGraphQlConnector(entry)) {
      const reason = `not a GraphQL connector (type=${entry.type})`;
      verbose(`[connectors] Skipping "${name}" — ${reason}`);
      results.push({
        name,
        connector: entry.type,
        status: 'skipped',
        skipReason: CONNECTOR_CONFIG_SKIP_REASON.NonGraphQlConnector,
        reason,
      });
      continue;
    }

    const configPath = join(
      projectRoot,
      'rayfin',
      '.temp',
      'connectors',
      name,
      'dab-config.json'
    );
    if (!existsSync(configPath)) {
      const reason = `no generated DAB config at ${configPath}`;
      modeWarn(
        mode,
        `⚠️  Connector "${name}" has no generated DAB config — skipping (${configPath})`
      );
      results.push({
        name,
        connector: entry.type,
        status: 'skipped',
        skipReason: CONNECTOR_CONFIG_SKIP_REASON.MissingGeneratedConfig,
        reason,
      });
      continue;
    }

    const applyUrl = `${itemEndpoint}/__private/connectors/${encodeURIComponent(name)}/applyconfig`;
    verbose('[connectors] Applying connector configuration');

    const spinner = showProgress?.(`Applying connector "${name}"`, '🔌');

    try {
      await withRetry(
        async () => {
          await applyConfigToServer(
            configPath,
            applyUrl,
            false,
            true,
            authorizationHeader,
            { [MONIKER_HEADER]: rayfinItemId },
            mode,
            { diagnostics: options.diagnostics }
          );
        },
        {
          label: `connector:${name}`,
          verbose,
          shouldRetry: (error) => {
            // Deterministic client errors (HTTP 4xx) fail identically on
            // every attempt, so retrying only burns the full backoff budget
            // (~33s) before surfacing the same failure. Fail fast instead.
            // 408 (Request Timeout), 425 (Too Early), and 429 (Too Many
            // Requests) are the transient 4xx and are still retried,
            // honoring any Retry-After header.
            if (error instanceof HttpError) {
              if ([408, 425, 429].includes(error.statusCode)) return true;
              if (error.statusCode >= 400 && error.statusCode < 500) {
                return false;
              }
            }
            // Server-validated misconfigurations are deterministic — bail
            // immediately so the user sees the hint instead of N retries.
            const msg = error.message;
            return (
              !msg.includes('UNKNOWN_CONNECTOR') &&
              !msg.includes('INVALID_CONNECTOR_CONFIG') &&
              !msg.includes('UNSUPPORTED_CONNECTOR')
            );
          },
        }
      );

      const durationMs = Date.now() - start;
      spinner?.succeed(`Connector "${name}" applied`);
      results.push({
        name,
        connector: entry.type,
        status: 'success',
        durationMs,
      });
      steps[stepKey] = {
        duration: spinner?.getDurationStr() ?? `${durationMs}ms`,
        status: 'success',
      };
    } catch (error) {
      const msg = (error as Error).message;
      const durationMs = Date.now() - start;
      spinner?.fail(`Connector "${name}" apply failed`);

      results.push({
        name,
        connector: entry.type,
        status: 'error',
        error: msg,
        durationMs,
      });
      steps[stepKey] = {
        duration: spinner?.getDurationStr() ?? `${durationMs}ms`,
        status: 'error',
        error: msg,
      };

      modeWarn(mode, `⚠️  Connector "${name}" apply failed: ${msg}`);

      if (msg.includes('UNKNOWN_CONNECTOR') && context === 'standalone') {
        modeLog(
          mode,
          "💡 Run 'rayfin up' first to persist connector settings, then re-run 'rayfin up connector apply'."
        );
      } else if (msg.includes('INVALID_CONNECTOR_CONFIG')) {
        modeLog(
          mode,
          `💡 Check that connector "${name}" has both \`config.workspaceId\` and \`config.itemId\` set in rayfin.yml.`
        );
      }
    }
  }

  return { results, steps };
}
