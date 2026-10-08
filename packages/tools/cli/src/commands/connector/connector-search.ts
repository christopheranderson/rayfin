import { formatDidYouMeanHint } from '@microsoft/rayfin-tools-common/_internal';
import type {
  ConnectorType,
  DiscoveredSource,
  DiscoveryScope,
} from '@microsoft/rayfin-tools-common/_internal/config';
import {
  CONNECTOR_CATALOG,
  suggestConnectorType,
} from '@microsoft/rayfin-tools-common/_internal/config';
import { Command, Option } from 'commander';
import inquirer from 'inquirer';

import { ensureAuthenticated } from '../../auth/index.js';
import { CliHandledError } from '../../errors.js';
import { resolveKustoEndpoint } from '../../services/connector-kusto-resolution.js';
import { checkSemanticModelAccess } from '../../services/connector-semanticmodel-probe.js';
import { createDiscoveryEngine } from '../../services/connectors/discovery/engine.js';
import { FabricApiClient } from '../../services/fabric/client.js';
import { SqlEndpointManager } from '../../services/fabric/sql-endpoint.js';
import {
  heldConnectorTypeMessage,
  isKnownConnectorType,
  listAuthorableConnectorTypes,
} from '../../utils/connector-authoring.js';
import { listDeployments } from '../../utils/deployments-registry.js';
import {
  createModeAwareSpinner,
  emitJson,
  emitJsonError,
  isInteractive,
  modeError,
  modeLog,
  OUTPUT_MODE,
  resolveOutputMode,
  resolveRootOutputFlags,
  type OutputMode,
} from '../../utils/output-mode.js';
import { findRayfinProjectRoot } from '../../utils/project-utils.js';

import { connectorAddCommand, sanitizeSourceName } from './connector-add.js';

/** Decode OID from JWT access token (no validation, just base64url decode). */
function getOidFromToken(token: string): string | undefined {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8')
    );
    return payload.oid ?? payload.sub;
  } catch {
    return undefined;
  }
}

/**
 * Print a mode-aware error and throw a handled CLI error carrying the text.
 * In `--json` mode this emits a `{status:'error', error}` envelope on stdout
 * (via {@link emitJsonError}) so machine consumers get a parseable failure
 * instead of an empty stdout and a bare non-zero exit. In human modes it
 * prints the message to stderr and throws.
 */
function failHandled(mode: OutputMode, message: string): never {
  if (mode === OUTPUT_MODE.Json) {
    return emitJsonError(mode, message);
  }
  modeError(mode, message);
  throw new CliHandledError(message);
}

function failMissingScope(mode: OutputMode): never {
  const exampleType = listAuthorableConnectorTypes()[0];
  const errorMsg =
    '❌ Command incomplete: workspace scope is required.\n\n' +
    'Supported commands (--type is also required with --workspace-id/--all-workspaces):\n' +
    `  • rayfin connector search --workspace-id <workspace-id> --type <type>\n` +
    `  • rayfin connector search "<query>" --workspace-id <workspace-id> --type <type>\n` +
    `  • rayfin connector search --all-workspaces --type <type>\n\n` +
    'Example:\n' +
    `  $ rayfin connector search "Test-Viewer-workspace" --workspace-id abc-123 --type ${exampleType}\n` +
    `  $ rayfin connector search --all-workspaces --type ${exampleType}`;

  return failHandled(mode, errorMsg);
}

/** Validate command syntax and workspace scope are provided. */
function validateCommandSyntax(
  options: { workspaceId?: string; allWorkspaces?: boolean },
  mode: OutputMode,
  deploymentCount: number
): void {
  const hasWorkspaceId = !!options.workspaceId;
  const hasAllWorkspaces = !!options.allWorkspaces;
  const hasDeployments = deploymentCount > 0;

  if (!hasWorkspaceId && !hasAllWorkspaces && !hasDeployments) {
    failMissingScope(mode);
  }
}

/**
 * A discovered source enriched with the two things a caller needs to act on
 * it: a suggested connector name and the exact `rayfin connector add` command
 * that would add it. Agents consume the command verbatim; the interactive
 * picker uses the same fields to pre-fill the add handoff.
 */
interface DiscoveredSourceRow extends DiscoveredSource {
  suggestedName: string;
  addCommand: string;
}

/** Built-in default for the interactive picker's page size, when `RAYFIN_CONNECTOR_SEARCH_PAGE_SIZE` is not set. */
const DEFAULT_PICKER_PAGE_SIZE = 30;

/** Number of sources shown per page in the interactive picker. Honours `RAYFIN_CONNECTOR_SEARCH_PAGE_SIZE`. */
function getPickerPageSize(): number {
  const raw = process.env['RAYFIN_CONNECTOR_SEARCH_PAGE_SIZE'];
  const value = raw ? Number(raw) : NaN;
  return Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_PICKER_PAGE_SIZE;
}

/** Build the exact `rayfin connector add …` argv (without the leading binary). */
function buildAddArgs(source: DiscoveredSource, name: string): string[] {
  return [
    '--type',
    source.connectorType,
    '--workspace-id',
    source.workspaceId,
    '--item-id',
    source.itemId,
    '--name',
    name,
  ];
}

function toRow(source: DiscoveredSource): DiscoveredSourceRow {
  const suggestedName = sanitizeSourceName(source.displayName) || source.itemId;
  const addCommand = `rayfin connector add ${buildAddArgs(source, suggestedName).join(' ')}`;
  return { ...source, suggestedName, addCommand };
}

/**
 * Resolve the effective discovery scope from the flags, defaulting to the
 * workspaces the current app is deployed to when the caller is inside a
 * deployed project and gave no scope flag. Requires an explicit
 * `--workspace-id`/`--all-workspaces` scope otherwise.
 *
 * The default (no scope flag) prefers the union of every workspace in the
 * project's deployments registry — a bounded, known set — so a Builder with
 * dev/prod deployments discovers across all of them without switching their
 * active deployment or passing `--workspace-id`. Searching the bounded
 * deployment set is always allowed.
 */
function resolveScope(
  options: { workspaceId?: string; allWorkspaces?: boolean },
  mode: OutputMode,
  deployments: ReturnType<typeof listDeployments>
): DiscoveryScope {
  if (options.workspaceId) {
    return { workspaceId: options.workspaceId };
  }
  if (options.allWorkspaces) {
    return { allWorkspaces: true };
  }

  // No explicit scope: default to the workspaces this app is deployed to so a
  // Builder working in a deployed app gets fast, relevant results across every
  // deployment (dev/prod/…) without switching their active deployment.
  const byId = new Map<string, string>();
  for (const d of deployments) {
    if (d.record.workspaceId && !byId.has(d.record.workspaceId)) {
      byId.set(d.record.workspaceId, d.workspaceName);
    }
  }
  if (byId.size > 0) {
    const names = [...byId.values()].join(', ');
    modeLog(
      mode,
      `Searching ${byId.size} deployment workspace(s): ${names}. ` +
        'Use --all-workspaces to widen or --workspace-id to narrow.'
    );
    return { workspaceIds: [...byId.keys()] };
  }

  // Unreachable via the real deployments registry: listDeployments() only
  // ever returns entries with a workspace ID, so deployments.length > 0
  // guarantees byId.size > 0 above. Kept as a defensive fallback.
  return failMissingScope(mode);
}

/**
 * Parse and validate the `--type` filter into a set of connector types.
 *
 * Exported for tests: an empty result here silently re-enables every provider
 * downstream, so the empty case is worth pinning directly.
 */
export function parseTypeFilter(
  raw: string | undefined,
  mode: OutputMode
): ConnectorType[] | undefined {
  if (!raw) return undefined;
  const requested = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // A list that trims away to nothing (`--type ,`) means the same as no flag at
  // all. Returning `[]` would read as "no filter" to the discovery engines and
  // re-enable every provider, gated types included.
  if (requested.length === 0) return undefined;
  const authorableTypes = listAuthorableConnectorTypes();
  const types: ConnectorType[] = [];
  for (const t of requested) {
    if (!(authorableTypes as string[]).includes(t)) {
      if (isKnownConnectorType(t)) {
        failHandled(mode, `❌ ${heldConnectorTypeMessage(t)}`);
      }
      const suggestion = suggestConnectorType(t, authorableTypes);
      const hint = formatDidYouMeanHint(suggestion);
      failHandled(
        mode,
        `❌ Unknown connector type "${t}". Supported types: [${authorableTypes.join(', ')}].${hint}`
      );
    }
    types.push(t as ConnectorType);
  }
  return types;
}

/** Parse and validate the `--limit` flag into a positive integer, or `undefined` if not given. */
function parseLimit(
  raw: string | undefined,
  mode: OutputMode
): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    failHandled(mode, `❌ --limit must be a positive integer, got "${raw}".`);
  }
  return value;
}

/**
 * Pre-flight check that the caller can reach this item's data endpoint
 * (SQL / Kusto / semantic model) before committing to `connector add`.
 */
async function checkAddEligibility(
  source: DiscoveredSourceRow,
  token: string,
  mode: OutputMode
): Promise<boolean> {
  const spinner = createModeAwareSpinner(
    mode,
    `Checking access to "${source.displayName}"`,
    '🔐',
    { prefix: '[connector search]' }
  );
  try {
    if (source.connectorType === 'kusto') {
      await resolveKustoEndpoint({
        workspaceId: source.workspaceId,
        itemId: source.itemId,
        itemType: source.itemType,
        fabricToken: token,
      });
    } else if (source.connectorType === 'fabric-semanticmodel') {
      await checkSemanticModelAccess({
        workspaceId: source.workspaceId,
        itemId: source.itemId,
      });
    } else {
      await new SqlEndpointManager(token).getConnectionStringByType(
        source.workspaceId,
        source.itemId,
        source.itemType
      );
    }
    spinner.succeed(
      `You have access to "${source.displayName}" — adding it as a connector...`
    );
    return true;
  } catch (error) {
    spinner.fail('Access check failed');
    modeError(
      mode,
      `❌ You don't have the required permission on "${source.displayName}".\n` +
        `   ${error instanceof Error ? error.message : String(error)}\n` +
        '   Pick a different source below, or ask a workspace admin for access.'
    );
    return false;
  }
}

/**
 * Key for "same underlying data source" (e.g. a SQLDatabase and its
 * SQL analytics endpoint twin share a workspace + display name).
 */
function sourceGroupKey(row: DiscoveredSourceRow): string {
  return `${row.workspaceId}::${row.displayName.toLowerCase()}`;
}

/**
 * Reorder rows (display-only, nothing dropped) so entries sharing a
 * {@link sourceGroupKey} sit next to each other. Never used for `--json`.
 */
function groupDuplicateSources(
  rows: DiscoveredSourceRow[]
): DiscoveredSourceRow[] {
  const groups = new Map<string, DiscoveredSourceRow[]>();
  const order: string[] = [];
  for (const row of rows) {
    const key = sourceGroupKey(row);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(row);
  }
  return order.flatMap((key) => groups.get(key)!);
}

/** True if any row is a connector type backed by a SQL dialect. */
function hasSqlBasedSource(rows: DiscoveredSourceRow[]): boolean {
  return rows.some(
    (row) => CONNECTOR_CATALOG[row.connectorType]?.dialect !== null
  );
}

/** Render a human-readable list of discovered sources to the active mode. */
function printSources(mode: OutputMode, rows: DiscoveredSourceRow[]): void {
  modeLog(mode, `\nFound ${rows.length} connectable source(s):\n`);
  rows.forEach((row, index) => {
    const ws = row.workspaceName ?? row.workspaceId;
    const roleTag = row.workspaceRole ? ` (${row.workspaceRole})` : '';
    const isGroupedDuplicate =
      index > 0 && sourceGroupKey(rows[index - 1]!) === sourceGroupKey(row);
    const marker = isGroupedDuplicate
      ? '\u21b3 same source as above \u2014 '
      : '';
    modeLog(
      mode,
      `  ${index + 1}. ${marker}${row.displayName}  [${row.connectorType}]\n` +
        `     workspace: ${ws}${roleTag}\n` +
        `     item:      ${row.itemId} (${row.itemType})\n` +
        `     add:       ${row.addCommand}`
    );
  });
  if (hasSqlBasedSource(rows)) {
    modeLog(
      mode,
      `\nℹ️  Schema discovery for SQL-based connectors requires SQL endpoint permissions.\n`
    );
  }
}

export const connectorSearchCommand = new Command('search')
  .description(
    'Search Fabric data sources you can add as connectors (workspaces, warehouses, SQL databases, lakehouses, semantic models)'
  )
  .argument(
    '[query]',
    'Optional case-insensitive name filter. Omit to list every connectable source in scope.'
  )
  .option(
    '--query <text>',
    'Same filter as [query], as a named flag (takes precedence if both are given)'
  )
  .option(
    '--type <type>',
    'Narrow to one or more connector types, comma-separated (run `rayfin connector types` to list). Required with --all-workspaces and --workspace-id.'
  )
  .option('--workspace-id <id>', 'Search a single Fabric workspace')
  .option(
    '--all-workspaces',
    'Search every workspace the signed-in identity can access',
    false
  )
  .option('-y, --yes', 'Auto-accept prompts in the add handoff', false)
  .option(
    '--limit <n>',
    'Show at most n results (search still runs across the full scope)'
  )
  .addOption(
    new Option('--output <mode>', 'Output format for this command').choices([
      'interactive',
      'plain',
      'json',
    ])
  )
  .option(
    '--json',
    'List sources as machine-readable JSON on stdout and skip the interactive picker',
    false
  )
  .option('-v, --verbose', 'Enable verbose output', false)
  .action(async (query: string | undefined, options, command) => {
    const root = resolveRootOutputFlags(command);
    const mode = resolveOutputMode({
      json: Boolean(options.json) || root.json,
      output: (options.output as OutputMode | undefined) ?? root.output,
    });
    const verbose = Boolean(options.verbose) || root.verbose;

    if (mode === OUTPUT_MODE.Json && verbose) {
      emitJsonError(mode, 'Cannot combine --verbose with --json.', {
        recovery:
          'Use --json for machine output, or drop --json to use verbose human-readable output.',
      });
    }

    if (verbose) {
      FabricApiClient.enableVerbose();
    }

    const types = parseTypeFilter(options.type, mode);
    const limit = parseLimit(options.limit as string | undefined, mode);
    const queryText = (options.query as string | undefined) ?? query ?? '';

    // Validate command syntax early before any async operations. Reused below
    // by resolveScope so the project root / deployments registry is only
    // read once per invocation.
    let deployments: ReturnType<typeof listDeployments> = [];
    try {
      // Silent lookup: findRayfinProjectRoot's default logging writes to
      // stdout, which would corrupt the --json envelope when run inside a project.
      const projectRoot = findRayfinProjectRoot(process.cwd(), {
        silent: true,
      });
      deployments = listDeployments(projectRoot);
      validateCommandSyntax(options, mode, deployments.length);
    } catch (error) {
      if (error instanceof CliHandledError) {
        throw error;
      }
      // Continue if project lookup fails (not inside a rayfin project)
      validateCommandSyntax(options, mode, 0);
    }

    const scope = resolveScope(options, mode, deployments);

    // --all-workspaces is a tenant-wide scan; --type is the only server-side
    // filter, so require it here to keep the scan bounded. --workspace-id
    // also requires --type: without it, every discoverable item type is
    // fetched with a separate request to that workspace.
    if (scope.allWorkspaces && (!types || types.length === 0)) {
      failHandled(
        mode,
        '❌ --type is required with --all-workspaces.\n' +
          `   Example: rayfin connector search --all-workspaces --type ${listAuthorableConnectorTypes()[0]}`
      );
    }
    if (scope.workspaceId && (!types || types.length === 0)) {
      failHandled(
        mode,
        '❌ --type is required with --workspace-id.\n' +
          `   Example: rayfin connector search --workspace-id ${scope.workspaceId} --type ${listAuthorableConnectorTypes()[0]}`
      );
    }

    const token = await ensureAuthenticated(undefined, {
      silent: mode === OUTPUT_MODE.Json,
    }).catch(() => {
      return failHandled(
        mode,
        '❌ Authentication is required for search.\n' +
          '   Run `rayfin login` first.'
      );
    });

    const userOid = getOidFromToken(token.token);

    // --limit only makes sense for the non-interactive paths (--json, or
    // plain text piped to a non-TTY): the interactive picker already
    // paginates the full result set, so truncating first would just hide
    // results behind pages that no longer exist.
    const usesInteractivePicker =
      mode === OUTPUT_MODE.Interactive && isInteractive();
    if (usesInteractivePicker && limit !== undefined) {
      modeLog(
        mode,
        `ℹ️  Ignoring --limit ${limit} in interactive mode — results will be paginated instead.`
      );
    }

    const spinnerMessage = scope.allWorkspaces
      ? 'Searching workspaces for connectable sources'
      : scope.workspaceIds
        ? `Searching ${scope.workspaceIds.length} workspace(s) for connectable sources`
        : 'Searching workspace for connectable sources';
    const spinner = createModeAwareSpinner(mode, spinnerMessage, '🔍', {
      prefix: '[connector search]',
    });

    let sources: DiscoveredSource[];
    try {
      // Catalog Search only pays off for a true tenant-wide scan; a known
      // workspace scope uses the fan-out so it hits just that workspace.
      const engine = createDiscoveryEngine(token.token, {
        catalogSearch: Boolean(scope.allWorkspaces),
        userOid,
      });
      sources = await engine.discover({
        request: { query: queryText, scope },
        // Unfiltered discovery still only searches types the Builder could go
        // on to add, so search never surfaces a source it cannot connect. The
        // length check matters: the engines read an empty array as "no filter".
        types:
          types && types.length > 0 ? types : listAuthorableConnectorTypes(),
      });
      const totalCount = sources.length;
      if (
        !usesInteractivePicker &&
        limit !== undefined &&
        sources.length > limit
      ) {
        sources = sources.slice(0, limit);
      }
      spinner.succeed(
        !usesInteractivePicker && limit !== undefined && totalCount > limit
          ? `Found ${totalCount} connectable source(s), showing first ${limit}`
          : `Found ${totalCount} connectable source(s)`
      );
    } catch (error) {
      spinner.fail('Discovery failed');
      const message = (error as Error).message;
      // `buildRemoteErrorMessage` already appends a `RootActivityId: <id>`
      // line for Fabric API errors; surface it as a support reference hint.
      const hint = message.includes('RootActivityId:')
        ? '   If this persists, share the RootActivityId above with support.'
        : '   Run with --verbose for more detail, or try again.';
      return failHandled(mode, `❌ Discovery failed: ${message}\n${hint}`);
    }

    const rows = sources.map(toRow);

    // Non-interactive machine output: emit the full list as JSON and stop.
    // This is the "just give me the list" path — every row carries the
    // workspace id, item id, connector type, a suggested name, and the exact
    // `rayfin connector add …` command, i.e. everything needed to run the add
    // flow without the interactive picker.
    if (mode === OUTPUT_MODE.Json) {
      emitJson({
        status: 'ok',
        query: queryText,
        scope,
        count: rows.length,
        ...(limit !== undefined ? { limit } : {}),
        sources: rows,
      });
      return;
    }

    if (rows.length === 0) {
      modeLog(
        mode,
        'No connectable sources found in scope. Try --all-workspaces or a different --type.'
      );
      return;
    }

    // Reorder for display only — groups duplicate sources together; the
    // `--json` branch above already returned using the canonical order.
    const displayRows = groupDuplicateSources(rows);

    // Non-interactive: print the list and stop, no prompt. Also honors an
    // explicit --output plain/json even on a real TTY, not just TTY/CI.
    if (!usesInteractivePicker) {
      printSources(mode, displayRows);
      return;
    }

    // Interactive flow: pick a source, then run `connector add` on it.
    // A failed access check re-shows the list so the user can pick another.
    if (hasSqlBasedSource(displayRows)) {
      modeLog(
        mode,
        `\n\u2139\ufe0f  Schema discovery for SQL-based connectors requires SQL endpoint permissions.\n`
      );
    }
    // Results are chunked into fixed pages (not just a scrolling window) so
    // large result sets get an explicit "page N of M" instead of one long list.
    const pickerPageSize = getPickerPageSize();
    const totalPages = Math.max(
      1,
      Math.ceil(displayRows.length / pickerPageSize)
    );
    let page = 0;
    let picked: DiscoveredSourceRow | undefined;
    while (!picked) {
      const start = page * pickerPageSize;
      const end = Math.min(start + pickerPageSize, displayRows.length);
      const pageChoices = displayRows.slice(start, end).map((row, offset) => {
        const globalIndex = start + offset;
        const isGroupedDuplicate =
          globalIndex > 0 &&
          sourceGroupKey(displayRows[globalIndex - 1]!) === sourceGroupKey(row);
        const prefix = isGroupedDuplicate ? '\u21b3 ' : '';
        return {
          name: `${prefix}${row.displayName}  [${row.connectorType}]  ws:${row.workspaceName ?? row.workspaceId}${row.workspaceRole ? ` (${row.workspaceRole})` : ''}`,
          value: globalIndex,
        };
      });

      const { choice } = await inquirer.prompt<{
        choice: number | 'next' | 'prev';
      }>([
        {
          type: 'list',
          name: 'choice',
          message:
            `Select a source to add as a connector ` +
            `(showing ${start + 1}-${end} of ${displayRows.length}, page ${page + 1} of ${totalPages})`,
          pageSize: Math.min(pageChoices.length + 3, 15),
          loop: false,
          choices: [
            ...pageChoices,
            ...(page < totalPages - 1
              ? [{ name: '▶ Next page', value: 'next' as const }]
              : []),
            ...(page > 0
              ? [{ name: '◀ Previous page', value: 'prev' as const }]
              : []),
            { name: 'Cancel', value: -1 },
          ],
        },
      ]);

      if (choice === 'next') {
        page += 1;
        continue;
      }
      if (choice === 'prev') {
        page -= 1;
        continue;
      }
      if (choice < 0) {
        modeLog(mode, 'Cancelled. No connector added.');
        return;
      }

      const candidate = displayRows[choice]!;
      if (await checkAddEligibility(candidate, token.token, mode)) {
        picked = candidate;
      }
    }

    const addArgs = buildAddArgs(picked, picked.suggestedName);
    if (options.yes) addArgs.push('--yes');
    if (verbose) addArgs.push('--verbose');

    modeLog(mode, `\n▶ rayfin connector add ${addArgs.join(' ')}\n`);
    await connectorAddCommand.parseAsync(addArgs, { from: 'user' });
  });
