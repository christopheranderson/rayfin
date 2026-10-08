import { writeFileSync } from 'fs';

import type { ConnectorEntry } from '@microsoft/rayfin-tools-common/_internal/config';
import { stringify } from 'yaml';

import {
  ambientMismatchRecovery,
  inspectDbTokenAudience,
  resolveDbTokenTarget,
  unreadableAudienceMessage,
  type DbTokenTarget,
} from '../auth/db-token.js';
import { ensureAuthenticated } from '../auth/index.js';
import { hasAmbientToken } from '../utils/ambient-env.js';
import { modeLog, modeWarn, type OutputMode } from '../utils/output-mode.js';

import { SqlEndpointManager } from './fabric/sql-endpoint.js';
import { discoverSchema, writeMetadataFile } from './schema-discovery.js';
import { classifySqlAccessError } from './sql-error.js';

/**
 * Resolve the database token target for schema discovery.
 *
 * Shared with `connector inspect`, `invoke`, and the semantic-model probe so
 * `add` and `update` cannot drift from the rest of the toolchain.
 */
function dbTokenTarget(): DbTokenTarget {
  return resolveDbTokenTarget();
}

export interface RunConnectorSchemaDiscoveryArgs {
  projectRoot: string;
  rayfinYmlPath: string;
  /**
   * The parsed YAML root object. We mutate `config.connectors` and
   * re-serialize it when a Lakehouse `itemId` resolves to a different
   * SQL endpoint id.
   */
  config: Record<string, unknown>;
  /** Full normalized connectors array (already attached to `config.connectors`). */
  entries: ConnectorEntry[];
  /** Index into `entries` for the connector being discovered. */
  entryIndex: number;
  /**
   * Fabric item `type` returned by `RayfinItemManager.getFabricItemById`.
   * Used to pick the right SQL endpoint resolution path (Lakehouse vs
   * Warehouse vs SQLEndpoint vs SQLDatabase).
   */
  itemType: string;
  /** OAuth bearer for Fabric control-plane calls (e.g. SQL endpoint resolve). */
  fabricToken: string;
  mode: OutputMode;
  verbose: boolean;
  /**
   * Auto-accept the "generate entity files?" prompt that runs after
   * schema discovery completes. When `false`, an interactive shell is
   * prompted (default Y); a non-interactive shell skips entity
   * generation with a hint so the connector is still usable via
   * `metadata.json` and the user can re-run with `--yes` later.
   */
  yes: boolean;
  /**
   * Trailing hint appended to the "Schema discovery failed" warning so
   * the caller can clarify what state the project is in
   * (e.g. "Connector was added to rayfin.yml" vs
   * "rayfin.yml was normalized"). Discovery is best-effort and
   * non-fatal.
   */
  retryHintOnFailure: string;
}

export interface ConnectorSchemaDiscoveryResult {
  succeeded: boolean;
  /** Why discovery failed, when it did. Drives the recovery hint. */
  reason?: 'permission' | 'auth' | 'login' | 'audience' | 'unknown';
  /** Human-readable failure summary, already printed to stderr. */
  error?: string;
  /** The next step offered to the user alongside `error`. */
  recovery?: string;
}

/**
 * Check a supplied `RAYFIN_TOKEN` against the audience discovery requires.
 *
 * `ensureAuthenticated` returns an ambient token verbatim without consulting
 * the scopes asked for, so a launcher that exports one Fabric-audience token
 * satisfies the request while failing the requirement. Left unchecked, the TDS
 * connection rejects it and {@link describeDiscoveryFailure} reads that as a
 * stale session or missing access — advice that cannot work here, because
 * `rayfin login` does not replace a token supplied through the environment.
 *
 * Only the ambient path is checked: an MSAL-minted token was acquired *for*
 * these scopes, so its audience is correct by construction.
 *
 * Returns `undefined` when there is nothing to complain about.
 */
function describeAudienceMismatch(
  token: string,
  connectorName: string
): { summary: string; recovery: string } | undefined {
  if (!hasAmbientToken()) return undefined;

  const target = dbTokenTarget();
  const finding = inspectDbTokenAudience(token, target);

  if (finding.status === 'unreadable') {
    const { summary, recovery } = unreadableAudienceMessage(target);
    return {
      summary: `${summary.replace(/\.$/u, '')} for connector "${connectorName}".`,
      recovery,
    };
  }

  if (finding.status === 'mismatch') {
    return {
      summary: `Access token has the wrong audience for schema discovery on connector "${connectorName}" (got ${finding.actual}, expected ${target.audience}).`,
      recovery: ambientMismatchRecovery(target),
    };
  }

  return undefined;
}

/**
 * Turn a discovery failure into the summary line and the next step the
 * user can actually act on.
 *
 * The `login` case is the common one and the reason this exists. Its raw
 * driver text (`Login failed for user '<token-identified principal>'`) reads
 * as a stale session, but we reach it holding a token acquired seconds
 * earlier, so missing access to the item is the likelier cause. Neither is
 * asserted: access is offered first because it is more probable, with the
 * session refresh kept as the fallback.
 */
function describeDiscoveryFailure(
  error: unknown,
  ctx: { name: string; workspaceId?: string; itemId?: string }
): {
  reason: 'permission' | 'auth' | 'login' | 'unknown';
  summary: string;
  recovery: string;
} {
  const { category, message } = classifySqlAccessError(error);
  const item =
    ctx.workspaceId && ctx.itemId
      ? `item ${ctx.itemId} in workspace ${ctx.workspaceId}`
      : `the item behind connector "${ctx.name}"`;

  if (category === 'permission') {
    return {
      reason: 'permission',
      summary: `You do not have permission to read the data behind connector "${ctx.name}".\n   ${message}`,
      recovery: `Ask an admin to grant your account read access to ${item}, then re-run this command.`,
    };
  }
  if (category === 'login') {
    return {
      reason: 'login',
      summary: `The data source rejected the login for connector "${ctx.name}".\n   ${message}`,
      recovery: `Confirm your account has read access to ${item} — that is the usual cause. If it does, run \`rayfin login\` to refresh your session and retry.`,
    };
  }
  if (category === 'auth') {
    return {
      reason: 'auth',
      summary: `Could not authenticate to the data source for connector "${ctx.name}".\n   ${message}`,
      recovery: `Run \`rayfin login\` to refresh your session, then re-run this command.`,
    };
  }
  return {
    reason: 'unknown',
    summary: `Schema discovery failed for connector "${ctx.name}".\n   ${message}`,
    recovery: `Verify ${item} exists and that you have read access, then re-run this command.`,
  };
}

/**
 * Resolve a Fabric SQL connection, discover the schema, and write all
 * per-connector artifacts (`metadata.json` + entity files).
 *
 * Used by `rayfin connector add` so the Lakehouse `itemId` write-back,
 * DB token acquisition, and the success / error log surface live in
 * one place.
 *
 * Discovery and entity-generation failures are caught and reported; this
 * function never throws, so the connector stays declared in `rayfin.yml`
 * and discovery can be retried once access is sorted out.
 */
export async function runConnectorSchemaDiscovery(
  args: RunConnectorSchemaDiscoveryArgs
): Promise<ConnectorSchemaDiscoveryResult> {
  const {
    projectRoot,
    rayfinYmlPath,
    config,
    entries,
    entryIndex,
    itemType,
    fabricToken,
    mode,
    verbose,
    retryHintOnFailure,
  } = args;

  const entry = entries[entryIndex]!;
  const name = entry.name;
  const workspaceId = entry.config?.workspaceId as string;
  const itemId = entry.config?.itemId as string;

  try {
    modeLog(mode, `\n🔍 Discovering schema...`);

    const sqlManager = new SqlEndpointManager(fabricToken);
    const resolved = await sqlManager.getConnectionStringByType(
      workspaceId,
      itemId,
      itemType
    );

    // Lakehouse adds resolve to a separate SQL endpoint id. Persist any
    // new id back to rayfin.yml so subsequent commands (`up`, `update`)
    // bind to the resolved endpoint.
    if (resolved.resolvedItemId !== itemId) {
      entry.config!.itemId = resolved.resolvedItemId;
      entries[entryIndex] = entry;
      config.connectors = entries;
      writeFileSync(rayfinYmlPath, stringify(config, { lineWidth: 0 }));
      if (verbose) {
        modeLog(
          mode,
          `   Updated config.itemId to resolved SQL endpoint: ${resolved.resolvedItemId}`
        );
      }
    }

    const dbToken = await ensureAuthenticated(dbTokenTarget().scopes);

    // Check the supplied token before spending a TDS round trip on it, so a
    // wrong-audience `RAYFIN_TOKEN` is named as such instead of surfacing as
    // the driver's login rejection.
    const mismatch = describeAudienceMismatch(dbToken.token, name);
    if (mismatch) {
      modeWarn(mode, `⚠️  ${mismatch.summary}`);
      modeWarn(mode, `   ${mismatch.recovery}`);
      modeWarn(mode, `   ${retryHintOnFailure}`);
      return {
        succeeded: false,
        reason: 'audience',
        error: mismatch.summary,
        recovery: mismatch.recovery,
      };
    }

    const metadata = await discoverSchema({
      sourceName: name,
      connector: entry.type,
      connectionString: resolved.connectionString,
      database: resolved.databaseName ?? resolved.resolvedItemId,
      token: dbToken.token,
      verbose,
      log: (msg) => modeLog(mode, msg),
    });

    const metadataPath = writeMetadataFile(projectRoot, name, metadata);

    const tableCount = metadata.schemas.reduce(
      (sum, s) => sum + s.tables.length,
      0
    );
    modeLog(
      mode,
      `✅ Discovered ${tableCount} tables across ${metadata.schemas.length} schemas`
    );
    if (verbose) {
      modeLog(mode, `   Metadata saved to ${metadataPath}`);
    }
    return { succeeded: true };
  } catch (err) {
    const { reason, summary, recovery } = describeDiscoveryFailure(err, {
      name,
      workspaceId,
      itemId,
    });
    // Warning, not an error: the connector is usable and the command exits 0.
    modeWarn(mode, `⚠️  ${summary}`);
    modeWarn(mode, `   ${recovery}`);
    modeWarn(mode, `   ${retryHintOnFailure}`);
    return { succeeded: false, reason, error: summary, recovery };
  }
}

/**
 * Hydrate `RAYFIN_*` environment variables from the project's `.env`
 * file before any Fabric API call. No-op for keys already set in the
 * ambient environment.
 */
export async function hydrateRayfinEnv(projectRoot: string): Promise<void> {
  const { loadEnvironmentVariables } = await import('../utils/config-utils.js');
  const envVars = loadEnvironmentVariables({ projectRoot });
  for (const [key, value] of envVars) {
    if (key.startsWith('RAYFIN_') && !process.env[key]) {
      process.env[key] = value;
    }
  }
}
