import { existsSync, mkdirSync, readFileSync } from 'fs';
import { writeFileSync } from 'fs';
import { join, resolve } from 'path';

import type {
  ConnectorType,
  ConnectorEntry,
  ConnectorOperationType,
} from '@microsoft/rayfin-tools-common/_internal/config';
import {
  CONNECTOR_CATALOG,
  normalizeConnectorsBlock,
  suggestConnectorType,
} from '@microsoft/rayfin-tools-common/_internal/config';
import { Command } from 'commander';
import inquirer from 'inquirer';
import { parse, stringify } from 'yaml';

import { ensureAuthenticated } from '../../auth/index.js';
import { CliHandledError } from '../../errors.js';
import { removeConnectorArtifacts } from '../../services/connector-artifacts.js';
import { resolveKustoEndpoint } from '../../services/connector-kusto-resolution.js';
import type { ConnectorSchemaDiscoveryResult } from '../../services/connector-schema-discovery.js';
import {
  hydrateRayfinEnv,
  runConnectorSchemaDiscovery,
} from '../../services/connector-schema-discovery.js';
import {
  regenerateConnectorWiring,
  reportConnectorWiring,
} from '../../services/connector-wiring.js';
import { FabricApiClient } from '../../services/fabric/client.js';
import { RayfinItemManager } from '../../services/fabric/rayfin-item.js';
import {
  heldConnectorTypeMessage,
  isKnownConnectorType,
  listAuthorableConnectorTypes,
} from '../../utils/connector-authoring.js';
import {
  emitJson,
  emitJsonError,
  isInteractive,
  modeError,
  modeLog,
  modeWarn,
  resolveCommandFlags,
  type OutputMode,
} from '../../utils/output-mode.js';
import { findRayfinProjectRoot } from '../../utils/project-utils.js';
import { getPackageVersion } from '../../utils/version.js';
import { installAgentFilesAfterScaffold } from '../ai-files/install-after-scaffold.js';

const SOURCE_NAME_PATTERN = /^[a-zA-Z0-9\-_]+$/;

const MAX_SOURCE_NAME_LENGTH = 256;

/**
 * Print `message` to stderr (mode-aware) and throw a `CliHandledError`
 * that carries the same text. The CLI entry point treats a thrown
 * `CliHandledError` as "handler already displayed the message", so any
 * code path that wants the user to actually see the failure must print
 * before it throws. Centralizing the "print + throw" pair here keeps
 * the contract impossible to violate accidentally.
 */
function failHandled(mode: OutputMode, message: string): never {
  if (mode === 'json') {
    emitJsonError(mode, message);
  }
  modeError(mode, message);
  throw new CliHandledError(message);
}

/**
 * Version-pinned specs for the packages a connector's generated `schema.ts`
 * imports.
 *
 * Pinned deliberately. Connector packages ship in lockstep with the CLI, but
 * their npm dist-tags lag, so an unversioned `npm install` resolves to an
 * older release that hard-pins its own `@microsoft/rayfin-data` — leaving two
 * Rayfin version lines in one app. Emitting an unpinned spec would reproduce
 * exactly that, so an unreadable version is a hard failure, not a fallback.
 */
export function pinnedPackageSpecs(connectorType: ConnectorType): string[] {
  const version = getPackageVersion();
  if (version === 'Unknown') {
    throw new Error(
      'Could not read the CLI version from package.json, so the connector ' +
        'packages cannot be pinned. Reinstall @microsoft/rayfin-cli.'
    );
  }
  return CONNECTOR_CATALOG[connectorType].clientPackages.map(
    (pkg) => `${pkg.name}@${version}`
  );
}

/**
 * Build the per-folder `schema.ts` scaffold for a function-bridge connector.
 *
 * Unlike SQL-style connectors, there's no discoverable entity schema to
 * generate here. However, Builders still benefit from a ready-to-import
 * connector schema type, so this file exports a real `AppConnectorsSchema`
 * instead of only instructions.
 *
 * When `kustoConfig` is supplied (Kusto connectors), its resolved cluster
 * routing is baked into the emitted `connectorConfig` and the value is typed
 * `satisfies KustoConnectorConfig` for a compile-time guarantee. This is the
 * only place those Kusto-specific keys live — they never touch the shared
 * `rayfin.yml` schema. Every other function-bridge connector emits the generic
 * `ConnectorConfig` shape.
 */
function buildFunctionBridgeScaffold(
  connectorName: string,
  connectorType: string,
  operations: readonly string[],
  schemaMarker: { type: string; package: string } | undefined,
  kustoConfig?: { queryServiceUri: string; databaseName: string }
): string {
  const header = [
    `// @generated — do not edit.`,
    ``,
    `// Connector: ${connectorName} (${connectorType})`,
    ``,
  ];

  // The runtime `connectorConfig` const consumed by `RayfinClient`. `schema.ts`
  // is generated per connector instance, so the two Kusto keys only ever appear
  // in the file the Kusto scaffold writes. Emit single-quoted string literals to
  // stay consistent with the rest of the generated file (and repo Prettier).
  const sq = (value: string): string =>
    `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const connectorConfigConst = kustoConfig
    ? [
        `export const connectorConfig = {`,
        `  connector: '${connectorType}',`,
        `  queryServiceUri: ${sq(kustoConfig.queryServiceUri)},`,
        `  databaseName: ${sq(kustoConfig.databaseName)},`,
        `} as const satisfies KustoConnectorConfig;`,
      ]
    : [
        `export const connectorConfig = {`,
        `  connector: '${connectorType}',`,
        `} as const satisfies ConnectorConfig;`,
      ];

  if (!schemaMarker) {
    // No typed marker published yet. Kusto ships a marker, so `kustoConfig` is
    // never set on this branch — it always emits the generic shape.
    return [
      ...header,
      `// No typed marker is published for this connector type yet.`,
      `// When one ships, add the import + \`<Name>Schema\` alias here.`,
      ``,
      `import type { ConnectorConfig } from '@microsoft/rayfin-connectors';`,
      ``,
      ...connectorConfigConst,
      ``,
    ].join('\n');
  }

  const opUnion =
    operations.length > 0 ? operations.map((o) => `'${o}'`).join(' | ') : `''`;
  const schemaTypeName = `${pascalCaseConnectorName(connectorName) || 'Connector'}Schema`;

  // For Kusto, `KustoConnectorConfig` and the `Kusto` marker come from the same
  // package, so import them together and skip the generic `ConnectorConfig`
  // import entirely.
  const importLines = kustoConfig
    ? [
        `import type { ${schemaMarker.type}, KustoConnectorConfig } from '${schemaMarker.package}';`,
      ]
    : [
        `import type { ConnectorConfig } from '@microsoft/rayfin-connectors';`,
        `import type { ${schemaMarker.type} } from '${schemaMarker.package}';`,
      ];

  return [
    ...header,
    ...importLines,
    ``,
    `/**`,
    ` * Typed connector schema for "${connectorName}" (${connectorType}).`,
    ` * Plug into your AppConnectorsSchema in your RayfinClient setup.`,
    ` */`,
    `export type ${schemaTypeName} = ${schemaMarker.type}<${opUnion}>;`,
    ``,
    ...connectorConfigConst,
    ``,
  ].join('\n');
}

/** PascalCase a connector name for use as a TS type identifier. */
function pascalCaseConnectorName(name: string): string {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Sanitize a Fabric item display name into a valid Connector name.
 * - Lowercase
 * - Replace spaces and non-alphanumeric chars (except hyphens/underscores) with hyphens
 * - Collapse consecutive hyphens
 * - Trim leading/trailing hyphens
 */
export function sanitizeSourceName(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9\-_]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const connectorAddCommand = new Command('add')
  .description('Add an external connector to your Rayfin project')
  .requiredOption(
    '--type <type>',
    'Connector type (run `rayfin connector types` to list)'
  )
  .option('--name <name>', 'Connector name (derived from item if omitted)')
  .option('--workspace-id <id>', 'Fabric workspace ID')
  .option('--item-id <id>', 'Fabric item/artifact ID')
  .option(
    '--operations <ops>',
    'Comma-separated subset of operations to allow (e.g. "read,create"). Each must be in the connector type\'s catalog default. Omit for all allowed operations.'
  )
  .option('-v, --verbose', 'Enable verbose output', false)
  .option('-y, --yes', 'Auto-accept all confirmation prompts', false)
  .option('--json', 'Emit machine-readable JSON output', false)
  .action(async (_options, command: Command) => {
    const mergedOptions = command.optsWithGlobals();

    const { mode, verbose, yes } = resolveCommandFlags(command);

    const { type, name: sourceName, workspaceId, itemId } = mergedOptions;

    // Validate connector type against the authoring view, so a type the
    // catalog still carries for compatibility cannot be added here.
    const authorableTypes = listAuthorableConnectorTypes();
    if (!(authorableTypes as string[]).includes(type)) {
      if (isKnownConnectorType(type)) {
        failHandled(mode, heldConnectorTypeMessage(type));
      }
      const suggestion = suggestConnectorType(type, authorableTypes);
      const hint = suggestion ? ` Did you mean "${suggestion}"?` : '';
      failHandled(
        mode,
        `Unknown connector type "${type}". Supported types: [${authorableTypes.join(', ')}].${hint}`
      );
    }

    const connectorType = type as ConnectorType;
    const meta = CONNECTOR_CATALOG[connectorType];

    // Resolved during validation, before anything is written: an unreadable
    // CLI version means we cannot pin, and failing here leaves the project
    // untouched rather than aborting after rayfin.yml has been rewritten.
    let packageSpecs: string[];
    try {
      packageSpecs = pinnedPackageSpecs(connectorType);
    } catch (err) {
      failHandled(mode, err instanceof Error ? err.message : String(err));
    }

    // Resolve the effective operations set: defaults to every op the
    // catalog allows, narrowed when the Builder passes --operations.
    // Preserve catalog order so the emitted YAML/schema.ts is stable
    // regardless of the order the Builder typed.
    let resolvedOperations: ConnectorOperationType[] = [
      ...meta.allowedOperations,
    ];
    if (mergedOptions.operations) {
      const requested = (mergedOptions.operations as string)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const allowed = new Set<string>(meta.allowedOperations);
      const invalid = requested.filter((op) => !allowed.has(op));
      if (invalid.length > 0) {
        failHandled(
          mode,
          `Invalid --operations [${invalid.join(', ')}] for connector type "${connectorType}". Allowed: [${meta.allowedOperations.join(', ')}].`
        );
      }
      resolvedOperations = meta.allowedOperations.filter((op) =>
        requested.includes(op)
      ) as ConnectorOperationType[];
    }

    // Validate required args for Fabric connectors
    if (meta.requiredConfigArgs.includes('workspaceId') && !workspaceId) {
      failHandled(
        mode,
        `Connector "${connectorType}" requires --workspace-id.`
      );
    }
    if (meta.requiredConfigArgs.includes('itemId') && !itemId) {
      failHandled(mode, `Connector "${connectorType}" requires --item-id.`);
    }

    // Determine Connector name — requires item verification for derivation
    let resolvedName = sourceName;
    let fabricToken: { token: string } | undefined;
    let itemType: string | undefined;

    // Load project root early so .env vars (e.g., RAYFIN_FABRIC_API_URL)
    // are available before any Fabric API calls.
    const projectRoot = findRayfinProjectRoot(process.cwd(), {
      verbose: !!verbose,
    });
    const rayfinYmlPath = resolve(projectRoot, 'rayfin', 'rayfin.yml');

    if (!existsSync(rayfinYmlPath)) {
      failHandled(mode, 'No rayfin.yml found. Run `rayfin init` first.');
    }

    // Load .env to hydrate RAYFIN_* env vars (e.g., RAYFIN_FABRIC_API_URL)
    await hydrateRayfinEnv(projectRoot);

    // Item verification for literal IDs
    if (workspaceId && itemId) {
      if (verbose) {
        FabricApiClient.enableVerbose();
      }

      // Authenticate — prompt login if not already signed in
      fabricToken = await ensureAuthenticated().catch(() => {
        return failHandled(
          mode,
          'Authentication is required for item verification. Run `rayfin login` first.'
        );
      });

      // Verify item exists
      const itemManager = new RayfinItemManager(fabricToken.token);
      const item = await itemManager.getFabricItemById(workspaceId, itemId);

      if (!item) {
        failHandled(
          mode,
          'Item not found. Verify the workspace ID and artifact ID are correct.'
        );
      }

      itemType = item.type;
      modeLog(mode, `✅ Verified item: "${item.displayName}" (${item.type})`);

      // Derive name from displayName if --name was not provided
      if (!resolvedName) {
        resolvedName = sanitizeSourceName(item.displayName);
        if (!resolvedName) {
          failHandled(
            mode,
            `Could not derive a valid Connector name from "${item.displayName}". Use --name to specify a Connector name.`
          );
        }
        modeLog(
          mode,
          `Using derived name: "${resolvedName}". Override with --name <name>.`
        );
      }
    }

    // At this point resolvedName must be set
    if (!resolvedName) {
      failHandled(
        mode,
        'Connector name is required. Use --name <name> or provide literal IDs for auto-derivation.'
      );
    }

    // Lowercase so names differing only by case resolve to the same connector.
    const normalizedName = resolvedName.toLowerCase();
    if (normalizedName !== resolvedName) {
      modeLog(
        mode,
        `Using normalized connector name "${normalizedName}" (from "${resolvedName}").`
      );
    }
    resolvedName = normalizedName;

    // Validate Connector name
    if (resolvedName.length > MAX_SOURCE_NAME_LENGTH) {
      failHandled(
        mode,
        `Connector name "${resolvedName}" exceeds maximum length of ${MAX_SOURCE_NAME_LENGTH} characters.`
      );
    }
    if (!SOURCE_NAME_PATTERN.test(resolvedName)) {
      failHandled(
        mode,
        `Connector name "${resolvedName}" contains invalid characters. Only alphanumeric characters, hyphens, and underscores are allowed.`
      );
    }

    const yamlContent = readFileSync(rayfinYmlPath, 'utf-8');
    const config = parse(yamlContent) as Record<string, unknown>;

    // Normalize legacy formats (map shape, `connector:` field) up-front so
    // every downstream operation works on the array contract.
    const existingConnectors: ConnectorEntry[] =
      normalizeConnectorsBlock(config.connectors) ?? [];

    if (existingConnectors.some((e) => e.name === resolvedName)) {
      if (!yes && mode !== 'json' && isInteractive({ yes })) {
        const { overwrite } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'overwrite',
            message: `Connector "${resolvedName}" already exists. Overwrite?`,
            default: false,
          },
        ]);
        if (!overwrite) {
          modeLog(mode, 'Cancelled.');
          return;
        }
      } else if (!yes) {
        const summary = `Connector "${resolvedName}" already exists.`;
        const hint = 'Re-run with --yes to overwrite the existing connector.';

        modeError(mode, `❌ ${summary}`);
        modeError(mode, `   ${hint}`);
        emitJsonError(mode, `${summary} ${hint}`, {
          action: 'connector.add',
          name: resolvedName,
        });
      }
    }

    // Build connector entry, populating auth and operations from the
    // catalog so the YAML self-describes the active behavior.
    const connectorEntry: ConnectorEntry = {
      name: resolvedName,
      type: connectorType,
      config: {
        workspaceId: workspaceId,
        itemId: itemId,
      },
      auth: {
        type: meta.defaultAuth,
      },
    };

    // Function-bridge connectors (Category B) require a pinned adapter version.
    // The server-side ConnectorsSettingsValidator rejects entries without one.
    if (meta.requiresVersion) {
      if (!meta.defaultVersion) {
        failHandled(
          mode,
          `Connector catalog entry for "${connectorType}" is missing defaultVersion. This is a CLI bug.`
        );
      }
      connectorEntry.version = meta.defaultVersion;
    }

    // Emit `operations:` so the YAML matches the host wire shape
    // (`List<ConnectorOperation>`) and the entry passes
    // `ConnectorsSettingsValidator` on the BaaS side. Every connector opts in
    // to all operations allowed by its catalog entry.
    connectorEntry.operations = resolvedOperations.map((name) => ({ name }));

    // Resolve the Kusto cluster query endpoint + database *before* anything is
    // written. The resolved values are baked into the connector's generated
    // `schema.ts` `connectorConfig` (not `rayfin.yml`), and a resolution
    // failure must abort `connector add` before it leaves a half-written
    // connector the runtime can never route. The declared `itemId` is kept
    // as-is — the resolved database identity travels in the connector config.
    let kustoConfig:
      | { queryServiceUri: string; databaseName: string }
      | undefined;
    if (connectorType === 'kusto') {
      if (!workspaceId || !itemId || !fabricToken || !itemType) {
        failHandled(
          mode,
          'Kusto connectors require --workspace-id, --item-id, and Fabric authentication to resolve the cluster query endpoint.'
        );
      }
      try {
        const resolved = await resolveKustoEndpoint({
          workspaceId,
          itemId,
          itemType,
          fabricToken: fabricToken.token,
        });
        kustoConfig = {
          queryServiceUri: resolved.queryServiceUri,
          databaseName: resolved.databaseName,
        };
        modeLog(
          mode,
          `🔗 Resolved Kusto endpoint ${resolved.queryServiceUri} (database "${resolved.databaseName}")`
        );
      } catch (err) {
        failHandled(
          mode,
          `Kusto endpoint resolution failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const existingIndex = existingConnectors.findIndex(
      (e) => e.name === resolvedName
    );
    if (existingIndex >= 0) {
      existingConnectors[existingIndex] = connectorEntry;
    } else {
      existingConnectors.push(connectorEntry);
    }
    config.connectors = existingConnectors;

    writeFileSync(rayfinYmlPath, stringify(config, { lineWidth: 0 }));

    modeLog(mode, `✅ Connector "${resolvedName}" added to rayfin.yml`);

    // Scrub only the legacy `.temp/sources/<name>/` metadata location. The
    // connector directory is kept: re-running `add` against an existing
    // connector refreshes its declaration, and wiping the directory would
    // take the Builder's generated entity files with it.
    removeConnectorArtifacts(projectRoot, resolvedName, {
      keepConnectorDir: true,
    });

    // Scaffold source directory
    const sourceDir = join(projectRoot, 'rayfin', 'connectors', resolvedName);
    mkdirSync(sourceDir, { recursive: true });
    const schemaTs = join(sourceDir, 'schema.ts');
    const scaffold = meta.requiresVersion
      ? // Function-bridge connectors (e.g. fabric-semanticmodel): generate
        // a self-contained typed schema the Builder can import directly.
        buildFunctionBridgeScaffold(
          resolvedName,
          connectorType,
          resolvedOperations,
          meta.schemaMarker,
          kustoConfig
        )
      : // SQL-style connectors: this is a placeholder. Schema discovery
        // runs below and writes `metadata.json` next to this file. Entity
        // `.ts` files and the final aggregate `schema.ts` are produced
        // separately (by the Rayfin agent skill or by hand) from
        // `metadata.json`; the CLI does not emit them.
        [
          `// Source: ${resolvedName} (${connectorType})`,
          `// Placeholder — entity files are generated from metadata.json.`,
          `// Overwrite this file with the aggregate that re-exports the`,
          `// generated entities and exports a connectorConfig value.`,
          ``,
          `export const schema = [];`,
          ``,
        ].join('\n');
    // `@generated` function-bridge scaffolds carry a `do not edit` header and
    // are always safe to regenerate; only the hand-authored SQL aggregate is
    // protected from clobbering, so scope the skip-if-exists guard to it.
    if (existsSync(schemaTs) && !yes && !meta.requiresVersion) {
      modeWarn(
        mode,
        `⚠️  rayfin/connectors/${resolvedName}/schema.ts already exists — skipping to avoid overwriting manual edits. Pass --yes to overwrite.`
      );
    } else {
      writeFileSync(schemaTs, scaffold);
      modeLog(mode, `📁 Created rayfin/connectors/${resolvedName}/schema.ts`);
    }

    // Ensure the Rayfin agent files — specifically the `rayfin-connectors`
    // skill — are installed so an agent has the connector entity-generation
    // contract available immediately after adding a connector. Scoped to the
    // connectors skill so adding a connector never churns unrelated agent
    // files. Idempotent and best-effort.
    const agentFiles = installAgentFilesAfterScaffold(projectRoot, mode, {
      ids: ['skill:rayfin-connectors'],
    });

    // Schema discovery (best-effort, non-blocking).
    //
    // Only applies to SQL-style connectors (Lakehouse, Warehouse, SQLEndpoint,
    // SQLDatabase).
    let discovery: ConnectorSchemaDiscoveryResult | undefined;
    if (meta.requiresVersion) {
      // Function-bridge / Category B connectors expose no SQL schema surface,
      // so schema discovery is skipped. Kusto resolved its cluster endpoint
      // earlier (before anything was written) and the resolved routing is
      // baked into the generated `schema.ts` `connectorConfig` above — the
      // deployed `rayfin_kusto_v1` UDF reads those keys off `payload.input`,
      // injected at invoke time by the `kusto()` runtime middleware.
      if (verbose) {
        modeLog(
          mode,
          `\n   Skipping schema discovery: "${connectorType}" is a function-bridge connector.`
        );
      }
    } else if (workspaceId && itemId && fabricToken && itemType) {
      const entryIndex = existingConnectors.findIndex(
        (e) => e.name === resolvedName
      );
      discovery = await runConnectorSchemaDiscovery({
        projectRoot,
        rayfinYmlPath,
        config,
        entries: existingConnectors,
        entryIndex,
        itemType,
        fabricToken: fabricToken.token,
        mode,
        verbose,
        yes: !!yes,
        retryHintOnFailure:
          'Connector was added to rayfin.yml. Schema discovery can be retried later.',
      });
    }

    // Wire the app. `rayfin.yml` and the scaffold alone are inert: the app
    // reads its connectors from `src/lib/connectors.ts`, and a connector
    // missing from `connectorRuntimes` there degrades silently to a JSON
    // pass-through that cannot decode a binary (Arrow) response. Regenerating
    // here — after schema discovery, so the connector's schema.ts is final —
    // keeps the wiring a pure function of rayfin.yml.
    const wiring = regenerateConnectorWiring(projectRoot, existingConnectors);
    reportConnectorWiring(mode, wiring, verbose);

    if (verbose) {
      modeLog(
        mode,
        `   connector: ${connectorType}\n   config.workspaceId: ${workspaceId}\n   config.itemId: ${connectorEntry.config?.itemId ?? itemId}`
      );
    }

    // The scaffold imports packages a fresh app does not declare. Print the
    // exact specs so nobody installs unversioned and lands on a stale tag.
    modeLog(mode, '');
    modeLog(mode, '📦 Install the packages this connector needs:');
    modeLog(mode, `   npm install ${packageSpecs.join(' ')}`);

    if (mode === 'json') {
      emitJson({
        status: 'success',
        action: 'connector.add',
        name: resolvedName,
        type: connectorType,
        workspaceId: workspaceId ?? null,
        itemId: itemId ?? null,
        operations: resolvedOperations,
        overwritten: existingIndex >= 0,
        ...(discovery
          ? {
              schemaDiscovery: discovery.succeeded
                ? { status: 'success' }
                : {
                    status: 'failed',
                    reason: discovery.reason,
                    error: discovery.error,
                    recovery: discovery.recovery,
                  },
            }
          : {}),
        install: {
          packages: packageSpecs,
          command: `npm install ${packageSpecs.join(' ')}`,
        },
        agentFiles: {
          installed: agentFiles.installed,
          updated: agentFiles.updated,
          warnings: agentFiles.warnings,
          ...(agentFiles.error ? { error: agentFiles.error } : {}),
        },
        // `reportConnectorWiring` writes through modeLog/modeWarn, which no-op
        // in JSON mode. Without this key, `--json` would report success with no
        // indication the app was left unwired — the original bug, moved to the
        // machine-readable path.
        wiring,
      });
    }
  });
