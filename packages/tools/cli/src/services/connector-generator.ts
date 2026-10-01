import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ConnectorConfigGenerator,
  ConnectorSchemaAnalyzer,
  type AnalyzerDialect,
} from '@microsoft/rayfin-core/analysis';
import { isRayfinEntity } from '@microsoft/rayfin-core/schema';
import type { Diagnostics } from '@microsoft/rayfin-tools-common/_internal/adapters';
import {
  CONNECTOR_CATALOG,
  type ConnectorEntry,
  type ConnectorType,
  type RayfinConfig,
} from '@microsoft/rayfin-tools-common/_internal/config';
import { glob } from 'glob';

import { modeLog, modeWarn, type OutputMode } from '../utils/output-mode.js';
import {
  compileRayfinDirectory,
  RAYFIN_COMPILED_DIR,
} from '../utils/typescript-compiler.js';

/**
 * Outcome of generating a `dab-config.json` for a single connector.
 *
 * `'skipped'` covers connector types with `dialect: null` in the catalog
 * (Cat-B, e.g. `fabric-semanticmodel`). A GraphQL connector without usable
 * compiled entity exports is an authoring/configuration error.
 */
export interface GenerateConnectorDabConfigResult {
  name: string;
  connector: ConnectorType;
  status: 'generated' | 'skipped' | 'error';
  reason?: string;
  error?: string;
  /** Absolute path to the written `dab-config.json` (when `'generated'`). */
  configPath?: string;
}

export interface GenerateConnectorDabConfigsOptions {
  diagnostics?: Diagnostics;
  projectRoot: string;
  /** Connector map from `rayfin.yml` (`RayfinConfig.connectors`). */
  connectors: RayfinConfig['connectors'];
  /** Names to generate for; defaults to every entry in `connectors`. */
  connectorNames?: string[];
  /** Output verbose logger used by `compileRayfinDirectory`. */
  verbose?: boolean;
  mode: OutputMode;
  /**
   * When true, skip the TypeScript compile step. Useful when an outer
   * orchestrator has already invoked `compileRayfinDirectory` for the
   * same project root in this run.
   */
  skipCompile?: boolean;
}

export interface GenerateConnectorDabConfigsOutcome {
  results: GenerateConnectorDabConfigResult[];
  /** Names successfully written; convenience for downstream POST helpers. */
  generated: string[];
}

/**
 * Resolve a connector type to its target dialect. Returns `null` when the
 * type has no `dialect` in the catalog (Cat-B connector) — callers should
 * treat that as "skip", not error.
 */
function resolveConnectorDialect(
  connectorType: ConnectorType
): AnalyzerDialect | null {
  const meta = CONNECTOR_CATALOG[connectorType];
  if (!meta) {
    throw new Error(`Unknown connector type '${connectorType}'.`);
  }
  return meta.dialect ?? null;
}

/**
 * Discover compiled connector entity files, dynamic-import them, and run
 * them through `ConnectorSchemaAnalyzer` + `ConnectorConfigGenerator` to produce the DAB
 * config payload. Writes to
 * `rayfin/.temp/connectors/<connectorName>/dab-config.json` and returns
 * `true` when something was written.
 */
async function writeConnectorDabConfig(
  projectRoot: string,
  connectorName: string,
  dialect: AnalyzerDialect,
  verbose: boolean,
  mode: OutputMode,
  diagnostics?: Diagnostics
): Promise<boolean> {
  const rootDir = resolve(projectRoot);
  const connectorFiles = await glob(
    `**/rayfin/${RAYFIN_COMPILED_DIR}/connectors/${connectorName}/*.js`,
    {
      cwd: rootDir,
      absolute: true,
      dot: true,
      ignore: ['**/node_modules/**', '**/*.d.ts'],
    }
  );

  if (connectorFiles.length === 0) {
    return false;
  }

  const foundEntities: Record<string, any> = {};
  for (const filePath of connectorFiles) {
    const moduleExports = await import(pathToFileURL(filePath).href);
    for (const [key, value] of Object.entries(moduleExports)) {
      if (value && isRayfinEntity(value)) {
        foundEntities[key] = value;
      } else if (value && Array.isArray(value)) {
        for (const item of value) {
          if (isRayfinEntity(item)) {
            foundEntities[item.name] = item;
          }
        }
      }
    }
  }

  const entities = Object.values(foundEntities);
  if (entities.length === 0) {
    return false;
  }

  const analyzer = new ConnectorSchemaAnalyzer(entities, dialect, {
    log: (message: string) => {
      diagnostics?.debug({ area: 'connectors.generate', message });
      if (verbose) modeLog(mode, message);
    },
  });
  const analyzed = analyzer.analyzeEntities();

  const configGenerator = new ConnectorConfigGenerator(dialect);
  const dabConfig = configGenerator.generateConfig(analyzed);

  const outputDir = join(
    projectRoot,
    'rayfin',
    '.temp',
    'connectors',
    connectorName
  );
  mkdirSync(outputDir, { recursive: true });

  const outputPath = join(outputDir, 'dab-config.json');
  writeFileSync(outputPath, JSON.stringify(dabConfig, null, 2));
  return true;
}

/**
 * Compile the project's `rayfin/` directory (unless `skipCompile`) and
 * generate `dab-config.json` for each requested connector. Per-connector
 * failures (missing entries, missing usable compiled entities) and intentional
 * Cat-B skips are reported in the result list instead of thrown — the caller
 * decides whether they're fatal.
 */
export async function generateConnectorDabConfigs(
  options: GenerateConnectorDabConfigsOptions
): Promise<GenerateConnectorDabConfigsOutcome> {
  const {
    projectRoot,
    connectors,
    connectorNames,
    verbose = false,
    mode,
    skipCompile = false,
  } = options;

  const targetNames =
    connectorNames && connectorNames.length > 0
      ? connectorNames
      : (connectors ?? []).map((c) => c.name);

  if (targetNames.length === 0) {
    return { results: [], generated: [] };
  }

  if (!skipCompile) {
    const compileResult = await compileRayfinDirectory(
      projectRoot,
      { verbose, diagnostics: options.diagnostics },
      mode
    );
    if (!compileResult.success) {
      const diagnostics = compileResult.errors
        .map((error) => error.trim())
        .filter((error) => error.length > 0)
        .join('\n');
      throw new Error(
        diagnostics
          ? `TypeScript compilation failed:\n${diagnostics}`
          : 'TypeScript compilation failed.'
      );
    }
  }

  const results: GenerateConnectorDabConfigResult[] = [];
  const generated: string[] = [];

  for (const connectorName of targetNames) {
    const entry: ConnectorEntry | undefined = connectors?.find(
      (c) => c.name === connectorName
    );
    if (!entry) {
      results.push({
        name: connectorName,
        connector: 'fabric-sqldatabase' as ConnectorType, // placeholder, unknown
        status: 'error',
        error: `Connector '${connectorName}' is missing from rayfin.yml.`,
      });
      continue;
    }

    const dialect = resolveConnectorDialect(entry.type);
    if (dialect === null) {
      const reason = `connector type '${entry.type}' has no dialect (Cat-B)`;
      modeLog(mode, `ℹ️  Skipping connector "${connectorName}" — ${reason}.`);
      results.push({
        name: connectorName,
        connector: entry.type,
        status: 'skipped',
        reason,
      });
      continue;
    }

    mkdirSync(
      join(projectRoot, 'rayfin', '.temp', 'connectors', connectorName),
      { recursive: true }
    );

    try {
      const written = await writeConnectorDabConfig(
        projectRoot,
        connectorName,
        dialect,
        verbose,
        mode,
        options.diagnostics
      );
      if (!written) {
        const error =
          `No usable compiled connector entities found for "${connectorName}" ` +
          `in rayfin/${RAYFIN_COMPILED_DIR}/connectors/${connectorName}. ` +
          'Ensure rayfin/tsconfig.json includes the connector sources and each ' +
          'source exports at least one @entity() class, then try again.';
        modeWarn(mode, `❌ ${error}`);
        results.push({
          name: connectorName,
          connector: entry.type,
          status: 'error',
          error,
        });
        continue;
      }

      const configPath = join(
        projectRoot,
        'rayfin',
        '.temp',
        'connectors',
        connectorName,
        'dab-config.json'
      );
      results.push({
        name: connectorName,
        connector: entry.type,
        status: 'generated',
        configPath,
      });
      generated.push(connectorName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      modeWarn(
        mode,
        `❌ Generating DAB config for "${connectorName}" failed: ${message}`
      );
      results.push({
        name: connectorName,
        connector: entry.type,
        status: 'error',
        error: message,
      });
    }
  }

  return { results, generated };
}
