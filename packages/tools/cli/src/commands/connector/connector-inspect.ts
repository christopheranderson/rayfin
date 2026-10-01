import { existsSync, readFileSync } from 'fs';
import { extname, resolve, sep } from 'path';

import {
  formatDidYouMeanHint,
  shellEscape,
} from '@microsoft/rayfin-tools-common/_internal';
import type {
  ConnectorEntry,
  ConnectorOperationType,
  ConnectorType,
} from '@microsoft/rayfin-tools-common/_internal/config';
import {
  CONNECTOR_CATALOG,
  normalizeConnectorsBlock,
  suggestConnectorType,
} from '@microsoft/rayfin-tools-common/_internal/config';
import { Command, Option } from 'commander';
import { parse } from 'yaml';

import {
  ambientMismatchRecovery,
  inspectDbTokenAudience,
  resolveDbTokenTarget,
  unreadableAudienceMessage,
} from '../../auth/db-token.js';
import { ensureAuthenticated } from '../../auth/index.js';
import { CliHandledError } from '../../errors.js';
import { hydrateRayfinEnv } from '../../services/connector-schema-discovery.js';
import {
  formatConnectorInspectColumns,
  formatConnectorInspectValue,
} from '../../services/connectors/inspect/format.js';
import {
  runConnectorInspect,
  ConnectorInspectError,
  type ConnectorInspectInput,
  type ConnectorInspectResult,
} from '../../services/connectors/inspect/service.js';
import { hasAmbientToken } from '../../utils/ambient-env.js';
import { isKnownConnectorType } from '../../utils/connector-authoring.js';
import {
  emitJson,
  emitJsonError,
  formatDuration,
  modeError,
  modeLog,
  OUTPUT_MODE,
  resolveOutputMode,
  resolveRootOutputFlags,
  createOraProgressIndicator,
  type OutputMode,
  type ProgressIndicator,
} from '../../utils/output-mode.js';
import { findRayfinProjectRoot } from '../../utils/project-utils.js';
import { resolveItemIdByName } from '../../utils/resolve-item-name.js';
import { resolveWorkspaceIdByNameFuzzy } from '../../utils/resolve-workspace-name.js';
import { truncateCell } from '../../utils/table.js';

const DEFAULT_ROWS = 10;
const MAX_ROWS = 100;
const SQL_CONNECTOR_TYPES: ReadonlySet<ConnectorType> = new Set([
  'fabric-sqldatabase',
  'fabric-sqlanalytics',
  'fabric-warehouse',
]);

const POWERBI_SCOPED_CONNECTOR_TYPES: ReadonlySet<ConnectorType> = new Set([
  ...SQL_CONNECTOR_TYPES,
  'fabric-semanticmodel',
]);

function failHandled(
  mode: OutputMode,
  message: string,
  recovery?: string
): never {
  if (mode === 'json') {
    return emitJsonError(mode, message, recovery ? { recovery } : undefined);
  }
  modeError(mode, recovery ? `❌ ${message}\n   ${recovery}` : `❌ ${message}`);
  throw new CliHandledError(message);
}

/**
 * Writes an immediate `<emoji> <message>...` line (ora spinner in
 * `interactive` mode, plain stderr line otherwise); a true silent no-op in
 * `json` mode (no progress output at all, per the CLI UX contract).
 */
function showProgress(
  message: string,
  emoji: string,
  mode: OutputMode
): ProgressIndicator {
  const startTime = Date.now();
  const getDuration = () => Date.now() - startTime;
  const getDurationStr = () => formatDuration(getDuration());
  if (mode === 'json') {
    return {
      succeed: () => {},
      fail: () => {},
      stop: () => {},
      start: () => {},
      log: () => {},
      getDuration,
      getDurationStr,
    };
  }
  if (mode === 'interactive') {
    return createOraProgressIndicator(message, emoji);
  }
  process.stderr.write(`${emoji} ${message}...\n`);
  return {
    succeed: (successMessage?: string) => {
      process.stderr.write(
        `✅ ${successMessage || message} (${getDurationStr()})\n`
      );
    },
    fail: (errorMessage?: string) => {
      process.stderr.write(
        `❌ ${errorMessage || `Failed: ${message}`} (${getDurationStr()})\n`
      );
    },
    stop: () => {},
    start: () => {},
    log: (msg: string) => process.stderr.write(`${msg}\n`),
    getDuration,
    getDurationStr,
  };
}

function parseRows(raw: string | number | undefined, mode: OutputMode): number {
  if (raw === undefined) return DEFAULT_ROWS;
  const rows = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
  if (!Number.isFinite(rows) || rows <= 0) {
    failHandled(
      mode,
      '--rows must be a positive integer.',
      `Provide a positive integer, e.g. --rows ${DEFAULT_ROWS}.`
    );
  }
  if (rows > MAX_ROWS) {
    failHandled(
      mode,
      `--rows cannot exceed ${MAX_ROWS}.`,
      `Use --rows <= ${MAX_ROWS}.`
    );
  }
  return rows;
}

function parseType(
  raw: string | undefined,
  mode: OutputMode
): ConnectorType | undefined {
  if (!raw) return undefined;
  // No authoring gate here: `POWERBI_SCOPED_CONNECTOR_TYPES` below already
  // rejects everything direct inspect cannot read, and it never included a
  // held-back type. Suggestions and the supported list come from that same set,
  // so the error text stays accurate without enumerating the whole catalog.
  const supported = [...POWERBI_SCOPED_CONNECTOR_TYPES];
  if (!isKnownConnectorType(raw)) {
    const suggestion = suggestConnectorType(raw, supported);
    const hint = formatDidYouMeanHint(suggestion);
    failHandled(
      mode,
      `Unknown connector type "${raw}". Supported types: [${supported.join(', ')}].${hint}`,
      'Run `rayfin connector types` to see all supported connector types.'
    );
  }
  if (!POWERBI_SCOPED_CONNECTOR_TYPES.has(raw as ConnectorType)) {
    failHandled(
      mode,
      `Unsupported connector type: ${raw}`,
      `connector inspect supports: ${[...POWERBI_SCOPED_CONNECTOR_TYPES].join(', ')}.`
    );
  }
  return raw as ConnectorType;
}

/** Path segments Power BI/Fabric portal URLs use to address a semantic model. */
const SEMANTIC_MODEL_URL_SEGMENTS = new Set([
  'modeling',
  'semanticmodels',
  'datasets',
]);

/**
 * Extracts `{ workspaceId, itemId }` from a Power BI or Fabric portal URL
 * addressing a semantic model, e.g.
 * `https://app.powerbi.com/groups/<workspaceId>/modeling/<itemId>/daxQueryView`.
 * Returns `undefined` when the URL doesn't match. Reimplemented locally
 * (rather than importing `@microsoft/rayfin-connector-fabric-semanticmodel`)
 * to avoid pulling `apache-arrow`/`lz4js` into the CLI just for URL parsing.
 */
function parseSemanticModelUrl(
  url: string
): { workspaceId: string; itemId: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  const index = segments.indexOf('groups');
  if (index === -1 || index + 3 >= segments.length) {
    return undefined;
  }
  const workspaceId = segments[index + 1];
  const typeSegment = segments[index + 2].toLowerCase();
  const itemId = segments[index + 3];
  if (
    !SEMANTIC_MODEL_URL_SEGMENTS.has(typeSegment) ||
    !workspaceId ||
    !itemId
  ) {
    return undefined;
  }
  return { workspaceId, itemId };
}

const QUERY_FILE_EXTENSIONS = new Set(['.sql', '.dax']);

function readQueryFile(
  queryPath: string,
  projectRoot: string,
  mode: OutputMode
): string {
  const root = resolve(projectRoot);
  const absolute = resolve(root, queryPath);
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    failHandled(
      mode,
      `Query file must be inside the project: ${queryPath}`,
      'Verify the file path and extension.'
    );
  }
  if (!QUERY_FILE_EXTENSIONS.has(extname(queryPath).toLowerCase())) {
    failHandled(
      mode,
      `Query file must have a .sql or .dax extension: ${queryPath}`,
      'Verify the file path and extension.'
    );
  }
  if (!existsSync(absolute)) {
    failHandled(
      mode,
      `Query file not found: ${queryPath}`,
      'Verify the file path and extension.'
    );
  }
  return readFileSync(absolute, 'utf8');
}

function resolveConnectorFromConfig(
  connectorName: string,
  mode: OutputMode
): {
  connector: ConnectorEntry;
  connectorType: ConnectorType;
  workspaceId: string;
  itemId: string;
  operations: readonly ConnectorOperationType[];
} {
  let projectRoot: string;
  try {
    projectRoot = findRayfinProjectRoot(process.cwd(), { silent: true });
  } catch {
    failHandled(
      mode,
      'No rayfin.yml found.',
      'Run `rayfin init` first, or use --workspace-id, --item-id, and --type for direct mode.'
    );
  }
  const rayfinYmlPath = resolve(projectRoot, 'rayfin', 'rayfin.yml');

  if (!existsSync(rayfinYmlPath)) {
    failHandled(mode, 'No rayfin.yml found.', 'Run `rayfin init` first.');
  }

  const yaml = readFileSync(rayfinYmlPath, 'utf8');
  const config = parse(yaml) as Record<string, unknown>;
  const connectors = normalizeConnectorsBlock(config.connectors) ?? [];
  const connector = connectors.find((entry) => entry.name === connectorName);
  if (!connector) {
    const known = connectors.map((entry) => entry.name).join(', ');
    const recovery =
      known.length > 0
        ? `Use one of the declared connectors: ${known}.`
        : 'Run `rayfin connector add` to declare a connector in rayfin.yml.';
    failHandled(
      mode,
      `Connector "${connectorName}" is not declared in rayfin.yml.`,
      recovery
    );
  }

  const connectorType = connector.type as ConnectorType;
  const workspaceId = connector.config?.workspaceId;
  const itemId = connector.config?.itemId;
  if (!workspaceId || !itemId) {
    failHandled(
      mode,
      `Connector "${connectorName}" is missing required config.workspaceId/config.itemId.`,
      'Update config.workspaceId and config.itemId for this connector in rayfin.yml.'
    );
  }

  const operations = (connector.operations ?? []).map((op) => op.name);
  return {
    connector,
    connectorType,
    workspaceId,
    itemId,
    operations,
  };
}

function checkSemanticOperationAllowed(
  connectorName: string,
  operations: readonly ConnectorOperationType[],
  mode: OutputMode
): void {
  if (operations.length === 0) return;
  if (operations.includes('executeQuery')) return;
  failHandled(
    mode,
    `Connector "${connectorName}" does not allow executeQuery.`,
    'Update connector operations in rayfin.yml and retry.'
  );
}

function checkSqlOperationAllowed(
  connectorName: string,
  operations: readonly ConnectorOperationType[],
  mode: OutputMode
): void {
  if (operations.length === 0) return;
  if (operations.includes('read')) return;
  failHandled(
    mode,
    `Connector "${connectorName}" does not allow read.`,
    'Update connector operations in rayfin.yml and retry.'
  );
}

interface ConnectorMetadataSnapshot {
  schemas?: {
    schemaName: string;
    tables: { tableName: string }[];
  }[];
}

/**
 * Qualifies a bare `--entity` from the connector's generated metadata.json,
 * skipping the live schema query. Returns `undefined` if it can't help.
 */
function resolveEntitySchemaFromMetadata(
  projectRoot: string,
  connectorName: string,
  entity: string,
  mode: OutputMode
): string | undefined {
  const metadataPath = resolve(
    projectRoot,
    'rayfin',
    'connectors',
    connectorName,
    'metadata.json'
  );
  if (!existsSync(metadataPath)) {
    return undefined;
  }

  let metadata: ConnectorMetadataSnapshot;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  } catch {
    return undefined;
  }

  const lowered = entity.toLowerCase();
  const matches = (metadata.schemas ?? [])
    .map((schema) => ({
      schemaName: schema.schemaName,
      table: schema.tables.find(
        (table) => table.tableName.toLowerCase() === lowered
      ),
    }))
    .filter(
      (match): match is { schemaName: string; table: { tableName: string } } =>
        match.table !== undefined
    );
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length > 1) {
    failHandled(
      mode,
      `Entity '${entity}' exists in multiple schemas: ${matches.map((m) => m.schemaName).join(', ')}.`,
      `Disambiguate with a schema-qualified name, e.g. --entity ${matches[0].schemaName}.${matches[0].table.tableName}`
    );
  }
  return `${matches[0].schemaName}.${matches[0].table.tableName}`;
}

/** Max characters per column in the horizontal table layout. */
const MAX_COLUMN_WIDTH = 40;

/**
 * Renders rows as "-- Row N/total --" blocks instead of a horizontal
 * table, as a fallback when the table would be wider than the terminal.
 */
function formatVertical(
  columns: ConnectorInspectResult['columns'],
  previewRows: Record<string, unknown>[]
): string[] {
  const headers = columns.map((column) => column.name);
  const labelWidth = Math.max(...headers.map((h) => h.length));
  const lines: string[] = [];
  previewRows.forEach((row, index) => {
    lines.push(`-- Row ${index + 1}/${previewRows.length} --`);
    for (const column of columns) {
      const value = truncateCell(
        formatConnectorInspectValue(row[column.name], column.type),
        MAX_COLUMN_WIDTH
      );
      lines.push(`${column.name.padEnd(labelWidth, ' ')} : ${value}`);
    }
  });
  return lines;
}

function formatConnectorInspectTable(result: ConnectorInspectResult): string[] {
  const terminalWidth = process.stdout.columns || 120;
  const columnContract = formatConnectorInspectColumns(
    result.columns,
    terminalWidth
  );

  if (result.rows.length === 0) {
    if (result.columns.length > 0) {
      return [...columnContract, 'No rows returned.'];
    }
    return ['No rows returned.'];
  }

  if (result.columns.length === 0) {
    return ['Result has rows but no column metadata.'];
  }

  const headers = result.columns.map((column) => column.name);
  const previewRows = result.rows.slice(0, Math.min(result.rows.length, 10));
  const widths = headers.map((h) => h.length);

  for (const row of previewRows) {
    result.columns.forEach((column, index) => {
      const text = formatConnectorInspectValue(row[column.name], column.type);
      widths[index] = Math.min(
        Math.max(widths[index], text.length),
        MAX_COLUMN_WIDTH
      );
    });
  }

  // Horizontal table width = each column + " | " separators + outer "| "/" |".
  const tableWidth =
    widths.reduce((sum, w) => sum + w, 0) + widths.length * 3 + 1;
  if (tableWidth > terminalWidth) {
    return [...columnContract, ...formatVertical(result.columns, previewRows)];
  }

  const pad = (text: string, width: number) =>
    truncateCell(text, width).padEnd(width, ' ');
  const line = `| ${headers.map((h, i) => pad(h, widths[i])).join(' | ')} |`;
  const separator = `|-${widths.map((w) => '-'.repeat(w)).join('-|-')}-|`;

  const body = previewRows.map((row) => {
    const values = result.columns.map((column, index) =>
      pad(
        formatConnectorInspectValue(row[column.name], column.type),
        widths[index]
      )
    );
    return `| ${values.join(' | ')} |`;
  });

  return [...columnContract, line, separator, ...body];
}

/**
 * Rebuild the source selector the caller actually passed so follow-up hints are
 * copy-pasteable. `inspect` still requires exactly one selector, so a hint that
 * omits it would fail validation the moment a user pastes it.
 */
function formatSourceSelector(options: Record<string, unknown>): string {
  const flag = (name: string, value: unknown) =>
    typeof value === 'string' && value.length > 0
      ? [`${name} ${shellEscape(value)}`]
      : [];

  if (typeof options.name === 'string' && options.name.length > 0) {
    return flag('--name', options.name).join(' ');
  }
  if (typeof options.url === 'string' && options.url.length > 0) {
    return flag('--url', options.url).join(' ');
  }
  return [
    ...flag('--workspace', options.workspace),
    ...flag('--workspace-id', options.workspaceId),
    ...flag('--item', options.item),
    ...flag('--item-id', options.itemId),
    ...flag('--type', options.type),
  ].join(' ');
}

export const connectorInspectCommand = new Command('inspect')
  .description(
    'Inspect a connector in read-only mode: list its entities, or sample one with --entity'
  )
  .option('--name <name>', 'Connector name declared in rayfin.yml')
  .option(
    '-w, --workspace <name>',
    'Fabric workspace display name for direct inspect mode (resolved to an ID; mutually exclusive with --workspace-id and --name)'
  )
  .option(
    '--workspace-id <id>',
    'Fabric workspace ID for direct inspect mode (requires --item-id and --type; mutually exclusive with --workspace and --name)'
  )
  .option(
    '--item <name>',
    'Fabric item display name for direct inspect mode (resolved to an ID within the target workspace; mutually exclusive with --item-id and --name)'
  )
  .option(
    '--item-id <id>',
    'Fabric item ID for direct inspect mode (requires --workspace-id/--workspace and --type; mutually exclusive with --item and --name)'
  )
  .option(
    '--type <type>',
    'Connector type for direct inspect mode (run `rayfin connector types` to list); mutually exclusive with --name'
  )
  .option(
    '--url <url>',
    'Power BI or Fabric portal URL for a semantic model; extracts --workspace-id and --item-id automatically (mutually exclusive with --workspace/--workspace-id, --item/--item-id, --type, and --name)'
  )
  .option(
    '--entity <name>',
    'Entity/table name for structured inspect mode (omit both --entity and --query to list available entities)'
  )
  .option('--query <path>', 'Path to .sql or .dax file for raw inspect mode')
  // No Commander default here on purpose: parseRows already falls back to
  // DEFAULT_ROWS, and leaving the option unset is what lets entity listing tell
  // "user asked for 10" apart from "user asked for nothing".
  .option(
    '--rows <n>',
    `Row cap (entity listing default ${MAX_ROWS}; --entity/--query sampling default ${DEFAULT_ROWS}; max ${MAX_ROWS})`
  )
  .option('-v, --verbose', 'Enable verbose output', false)
  .addOption(
    new Option('--output <mode>', 'Output format for this command').choices([
      'interactive',
      'plain',
      'json',
    ])
  )
  .option('--json', 'Output a machine-readable JSON object', false)
  // Tolerate an unquoted multi-word --entity value (e.g. `--entity Business
  // Area`); Commander would otherwise reject the leftover word(s) as an
  // unexpected argument before the action handler ever runs.
  .allowExcessArguments(true)
  .action(async (options, command) => {
    // Direct mode never needs a rayfin.yml lookup; fall back to cwd so this
    // never throws (the --name selector path validates its own project root).
    let projectRoot: string;
    try {
      projectRoot = findRayfinProjectRoot(process.cwd(), { silent: true });
    } catch {
      projectRoot = process.cwd();
    }

    const root = resolveRootOutputFlags(command);
    const mode = resolveOutputMode({
      json: Boolean(options.json) || root.json,
      output: (options.output as OutputMode | undefined) ?? root.output,
    });
    const verbose = Boolean(options.verbose) || root.verbose;

    // Rejoin an unquoted multi-word --entity (e.g. `--entity Business Area`).
    // Any other stray argument is still rejected explicitly, since
    // allowExcessArguments no longer catches it.
    if (options.entity && command.args.length > 0) {
      options.entity = [options.entity, ...command.args].join(' ');
    } else if (command.args.length > 0) {
      failHandled(
        mode,
        `Unexpected argument(s): ${command.args.join(' ')}`,
        'Remove the extra argument, or quote a multi-word --entity value.'
      );
    }

    const rows = parseRows(options.rows, mode);
    const connectorTypeFromFlag = parseType(options.type, mode);

    if (options.workspace && options.workspaceId) {
      failHandled(
        mode,
        'Specify either --workspace <name> or --workspace-id <id>, not both.',
        'Drop one of --workspace or --workspace-id.'
      );
    }
    if (options.item && options.itemId) {
      failHandled(
        mode,
        'Specify either --item <name> or --item-id <id>, not both.',
        'Drop one of --item or --item-id.'
      );
    }
    if (
      options.url &&
      (options.workspace ||
        options.workspaceId ||
        options.item ||
        options.itemId ||
        options.type)
    ) {
      failHandled(
        mode,
        '--url cannot be combined with --workspace/--workspace-id, --item/--item-id, or --type.',
        'Use --url by itself for a Power BI/Fabric semantic-model portal URL.'
      );
    }

    const hasNameSelector = Boolean(options.name);
    const hasDirectSelector = Boolean(
      options.workspace ||
      options.workspaceId ||
      options.item ||
      options.itemId ||
      connectorTypeFromFlag ||
      options.url
    );
    if (hasNameSelector === hasDirectSelector) {
      failHandled(
        mode,
        'Specify either --name <connector>, or --workspace/--workspace-id, --item/--item-id, and --type for direct mode.',
        'Use --name <connector> by itself, or provide --workspace (or --workspace-id), --item (or --item-id), and --type together, or --url alone — not a mix.'
      );
    }

    const hasEntityMode = Boolean(options.entity);
    const hasQueryMode = Boolean(options.query);
    // Neither flag is not an error: it means "I don't know the entity names
    // yet", so inspect lists them instead. Only asking for both at once is
    // ambiguous.
    if (hasEntityMode && hasQueryMode) {
      failHandled(
        mode,
        'Specify at most one query mode: --entity <name> or --query <path>.',
        'Use --entity for structured sampling, --query <path> for a raw .sql/.dax file, or neither to list available entities.'
      );
    }
    const queryMode: ConnectorInspectInput['mode'] = hasEntityMode
      ? 'structured'
      : hasQueryMode
        ? 'raw'
        : 'entities';

    let connectorType: ConnectorType;
    let workspaceId: string;
    let itemId: string;
    let sourceLabel: string;
    let queryText: string;

    if (hasNameSelector) {
      const resolved = resolveConnectorFromConfig(options.name, mode);
      connectorType = resolved.connectorType;
      workspaceId = resolved.workspaceId;
      itemId = resolved.itemId;
      sourceLabel = `connector:${options.name}`;
      if (connectorType === 'fabric-semanticmodel') {
        checkSemanticOperationAllowed(options.name, resolved.operations, mode);
      }
      if (SQL_CONNECTOR_TYPES.has(connectorType)) {
        checkSqlOperationAllowed(options.name, resolved.operations, mode);
      }
      if (!POWERBI_SCOPED_CONNECTOR_TYPES.has(connectorType)) {
        failHandled(
          mode,
          `Unsupported connector type: ${connectorType}`,
          `connector inspect supports: ${[...POWERBI_SCOPED_CONNECTOR_TYPES].join(', ')}.`
        );
      }
    } else if (options.url) {
      const parsedUrl = parseSemanticModelUrl(options.url);
      if (!parsedUrl) {
        failHandled(
          mode,
          `Could not extract workspace and item IDs from URL: ${options.url}`,
          'Provide a Power BI or Fabric portal URL for a semantic model, e.g. https://app.powerbi.com/groups/<workspaceId>/modeling/<itemId>.'
        );
      }
      connectorType = 'fabric-semanticmodel';
      workspaceId = parsedUrl.workspaceId;
      itemId = parsedUrl.itemId;
      sourceLabel = `item:${workspaceId}/${itemId}`;
    } else {
      if (
        (!options.workspace && !options.workspaceId) ||
        (!options.item && !options.itemId) ||
        !connectorTypeFromFlag
      ) {
        failHandled(
          mode,
          'Direct inspect mode requires --workspace (or --workspace-id), --item (or --item-id), and --type <connector-type>.',
          'Provide all three together, --url <portal-url>, or use --name <connector> instead.'
        );
      }
      connectorType = connectorTypeFromFlag;
      workspaceId = options.workspaceId ?? '';
      itemId = options.itemId ?? '';
      sourceLabel = `item:${options.workspace ?? workspaceId}/${options.item ?? itemId}`;
    }

    if (hasQueryMode) {
      queryText = readQueryFile(options.query, projectRoot, mode);
    } else {
      queryText = '';
    }

    // Auto-qualify a bare "--entity customer" from the connector's
    // generated schema snapshot when available, so `--name` mode doesn't
    // pay for an extra live INFORMATION_SCHEMA round-trip. Falls back to
    // the live check in the service layer when the snapshot can't help.
    let resolvedEntity = options.entity;
    if (
      hasNameSelector &&
      hasEntityMode &&
      SQL_CONNECTOR_TYPES.has(connectorType) &&
      !options.entity!.includes('.')
    ) {
      const fromMetadata = resolveEntitySchemaFromMetadata(
        projectRoot,
        options.name,
        options.entity!,
        mode
      );
      if (fromMetadata) {
        resolvedEntity = fromMetadata;
        modeLog(
          mode,
          `\uD83D\uDCC4 Resolved entity "${options.entity}" \u2192 "${resolvedEntity}" (from generated schema)`
        );
      }
    }

    await hydrateRayfinEnv(projectRoot);

    const token = await ensureAuthenticated(undefined, {
      silent: mode === OUTPUT_MODE.Json,
    }).catch(() => {
      return failHandled(
        mode,
        'Authentication is required.',
        'Run `rayfin login`.'
      );
    });

    // Resolve --workspace (display name → ID). Ties throw rather than
    // prompt, since this command runs non-interactively.
    if (!hasNameSelector && options.workspace && !options.workspaceId) {
      const resolved = await resolveWorkspaceIdByNameFuzzy(options.workspace, {
        token: token.token,
      }).catch((error: Error) => {
        return failHandled(
          mode,
          error.message,
          'Or retry with --workspace-id <guid>.'
        );
      });
      workspaceId = resolved.id;
      modeLog(
        mode,
        `🏢 Resolved workspace "${resolved.displayName}" → ${resolved.id}`
      );
    }

    // Resolve --item (display name → ID); must run after workspace
    // resolution since it needs a real workspaceId.
    if (!hasNameSelector && options.item && !options.itemId) {
      const fabricItemType = CONNECTOR_CATALOG[connectorType].fabricItemType;
      const resolved = await resolveItemIdByName(workspaceId, options.item, {
        token: token.token,
        type: fabricItemType,
      }).catch((error: Error) => {
        return failHandled(
          mode,
          error.message,
          'Or retry with --item-id <guid>.'
        );
      });
      itemId = resolved.id;
      modeLog(
        mode,
        `📦 Resolved item "${resolved.displayName}" → ${resolved.id}`
      );
    }

    if (!hasNameSelector) {
      sourceLabel = `item:${workspaceId}/${itemId}`;
    }

    const dbTarget = resolveDbTokenTarget();
    const dataToken = POWERBI_SCOPED_CONNECTOR_TYPES.has(connectorType)
      ? await ensureAuthenticated(dbTarget.scopes, {
          silent: mode === OUTPUT_MODE.Json,
        }).catch(() => {
          const kind = SQL_CONNECTOR_TYPES.has(connectorType)
            ? 'SQL'
            : 'semantic model';
          return failHandled(
            mode,
            `Database-scoped authentication is required for ${kind} inspect.`,
            'Run `rayfin login` and retry.'
          );
        })
      : token;

    // An ambient `RAYFIN_TOKEN` is returned verbatim, so the scopes requested
    // above were never consulted — a launcher that exports one Fabric-audience
    // token satisfies the request while failing the requirement. Check locally
    // rather than letting the data plane 401 and be reported as a workspace or
    // model permission problem.
    //
    // Only the ambient path is guarded: when MSAL mints the token it was
    // acquired *for* these scopes, so its audience is correct by construction.
    if (
      hasAmbientToken() &&
      POWERBI_SCOPED_CONNECTOR_TYPES.has(connectorType)
    ) {
      const finding = inspectDbTokenAudience(dataToken.token, dbTarget);
      const kind = SQL_CONNECTOR_TYPES.has(connectorType)
        ? 'SQL'
        : 'semantic model';

      if (finding.status === 'unreadable') {
        const { summary, recovery } = unreadableAudienceMessage(dbTarget);
        failHandled(mode, summary, recovery);
      } else if (finding.status === 'mismatch') {
        failHandled(
          mode,
          `Access token has the wrong audience for ${kind} inspect (got ${finding.actual}, expected ${dbTarget.audience}).`,
          ambientMismatchRecovery(dbTarget)
        );
      }
    }

    // --rows is a *sampling* knob, so its 10-row default is the wrong ceiling
    // for a listing. When the user did not ask for a specific count, entity
    // discovery uses the cap so it does not silently hide entities.
    const effectiveRows =
      queryMode === 'entities' && options.rows === undefined ? MAX_ROWS : rows;

    const input: ConnectorInspectInput = {
      connectorType,
      workspaceId,
      itemId,
      rows: effectiveRows,
      mode: queryMode,
      entity: resolvedEntity,
      query: hasQueryMode ? queryText : undefined,
      token: token.token,
      dataToken: dataToken.token,
      log: verbose
        ? (message: string) => modeLog(mode, `   ${message}`)
        : undefined,
    };

    const progressLabel = `Querying ${sourceLabel}`;
    const spinner = showProgress(progressLabel, '🔍', mode);

    let result: ConnectorInspectResult;
    try {
      result = await runConnectorInspect(input);
      spinner.succeed(`${progressLabel} complete`);
    } catch (error) {
      spinner.fail(`${progressLabel} failed`);
      if (error instanceof ConnectorInspectError) {
        return failHandled(mode, error.message, error.recovery);
      }
      return failHandled(
        mode,
        `Inspect failed: ${(error as Error).message}`,
        'Re-run with --verbose for details, or check that the entity/table name and permissions are correct.'
      );
    }

    const envelope = {
      status: 'ok' as const,
      connectorType: result.connectorType,
      queryMode: result.queryMode,
      entity: result.entity,
      rowsReturned: result.rows.length,
      truncated: result.truncated,
      columns: result.columns,
      rows: result.rows,
    };

    if (mode === 'json') {
      emitJson(envelope);
      return;
    }

    modeLog(mode, `\nInspect result for ${sourceLabel}`);
    modeLog(mode, `connector type: ${result.connectorType}`);
    modeLog(
      mode,
      `rows: ${result.rows.length}${result.truncated ? ' (truncated to cap)' : ''}`
    );
    modeLog(mode, `query mode: ${result.queryMode}`);
    if (result.entity) {
      modeLog(mode, `entity: ${result.entity}`);
    }
    for (const line of formatConnectorInspectTable(result)) {
      modeLog(mode, line);
    }
    if (result.queryMode === 'entities') {
      // Close the loop the bug report called out: listing is only useful if it
      // tells you what to do with the names it just printed. Echo back the
      // selector the caller used so the suggestion is runnable as-is.
      const selector = formatSourceSelector(options);
      modeLog(
        mode,
        `\nSample one of these with: rayfin connector inspect ${
          selector ? `${selector} ` : ''
        }--entity <name>`
      );
    }
  });
