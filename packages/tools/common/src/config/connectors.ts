import { suggestClosest } from '../string-distance.js';

import {
  ConnectorDialect,
  DatabaseDialect,
  FABRIC_SEMANTIC_MODEL_CONNECTOR_OPERATIONS,
  FABRIC_SQL_CONNECTOR_OPERATIONS,
  KUSTO_CONNECTOR_OPERATIONS,
  LAKEHOUSE_CONNECTOR_OPERATIONS,
} from './types.js';
import type {
  AnalyzerDialect,
  ConnectorAuthType,
  ConnectorOperationType,
  ConnectorType,
} from './types.js';

/**
 * Common config argument names used by connectors.
 */
export const ConnectorConfigArg = {
  WorkspaceId: 'workspaceId',
  ItemId: 'itemId',
} as const;

/**
 * Auth type constants for connectors. Category A connectors default to
 * `Application`; Category B connectors default to `Delegated`.
 */
export const ConnectorAuth = {
  Delegated: 'delegated' as ConnectorAuthType,
  Application: 'application' as ConnectorAuthType,
} as const;

/**
 * npm package a Builder must install for a connector type's generated code to
 * compile.
 *
 * `marker` exports the typed `<Name>Schema` marker the generated `schema.ts`
 * imports; `runtime` exports the `ConnectorConfig` / `ConnectorsRuntime` shapes
 * the generated `src/lib/connectors.ts` consumes. Every type lists a runtime
 * package because the app wiring file always imports those shared types, even
 * for connectors like Kusto whose marker and config type come from their own
 * package and whose `runtimeFactory` is `null`.
 */
export interface ConnectorPackageRef {
  name: string;
  role: 'marker' | 'runtime';
}

/**
 * Whether a connector type can be authored in this release.
 *
 * `held` hides the type from the authoring surfaces — `connector add`,
 * `connector types`, `connector search` and their suggestions. It deliberately
 * does *not* affect validation, generation, apply or `rayfin up`, so a project
 * that already declares the type still validates and deploys.
 *
 * Required rather than optional, so a forgotten type cannot default to
 * released.
 *
 * **Releasing a held type** is one line here, plus four things that must move
 * with it or the tests and docs will disagree with the CLI:
 *
 * 1. Replace the refusal tests with positive coverage for `connector add` and
 *    `connector search`. They are type-specific on purpose, so the flip cannot
 *    go green while the contract is stale.
 * 2. Delete the availability notices. Grep both phrasings:
 *    `authoring is held in this release` (guide pages) and
 *    `not available in this release` (CLI skill, Universal App skills,
 *    AGENTS.md, package-owned docs).
 * 3. Grep the live connector surfaces for identifiers that were added, removed,
 *    renamed, released, or held: CLI and Universal App skills,
 *    `packages/guide/assets/docs/cli/connectors/`, connector package docs,
 *    `docs/rfc/connectors/`, and `openspec/specs/`. Update live authoring prose
 *    while preserving text that is explicitly historical.
 * 4. Re-align `openspec/specs/cli-source-commands/spec.md`
 *    (`CLI-SOURCE-CATALOG-001`).
 */
export type ConnectorAuthoringPolicy = 'released' | 'held';

/** Category A markers and the shared runtime package the SQL scaffold imports. */
const GRAPHQL_ENTITY_PACKAGES: readonly ConnectorPackageRef[] = [
  { name: '@microsoft/rayfin-connector-fabric-graphql', role: 'marker' },
  { name: '@microsoft/rayfin-connectors', role: 'runtime' },
];

export interface ConnectorMeta {
  description: string;
  /**
   * Which connector contract this type follows.
   *
   * `graphql-entities` (Category A) surfaces the source as typed entities with
   * CRUD and `@role` policies; `function-bridge` (Category B) surfaces named
   * operations backed by a platform-owned function and has no entities.
   */
  category: 'graphql-entities' | 'function-bridge';
  requiredConfigArgs: string[];
  defaultAuth: ConnectorAuthType;
  /** Authentication types accepted by this connector. */
  allowedAuthTypes: readonly ConnectorAuthType[];
  /**
   * Dialect used by the analyzer when this connector participates in DAB
   * config generation. `null` means no SQL-dialect-backed generation is
   * supported (function-bridge connectors).
   *
   * Accepts both data-path `Dialect` values (e.g. `mssql` for
   * `fabric-sqldatabase`, which is Azure SQL DB hosted in Fabric) and
   * connector-only `ConnectorDialectType` values (e.g. `fabric-warehouse`,
   * `fabric-sqlanalytics`) for engines whose column-type ceilings differ
   * from what `services.data.dialect` permits.
   */
  dialect: AnalyzerDialect | null;
  /**
   * Operations a Builder may request for this connector type in `rayfin.yml`.
   * Mirrors the host `AllowedOperationsByConnector` matrix.
   */
  allowedOperations: readonly ConnectorOperationType[];
  /**
   * Whether this connector requires a pinned top-level `version` on the
   * connector entry (adapter / protocol version). True for function-bridge
   * (Category B) connectors. Different versions of the same connector type
   * may accept different `config` shapes, so the version lives at the
   * connector level rather than inside `config`.
   */
  requiresVersion: boolean;
  /**
   * Default adapter version written to `rayfin.yml` by `rayfin connector add`
   * when `requiresVersion` is true. Must be set whenever `requiresVersion` is
   * true; ignored otherwise.
   */
  defaultVersion?: string;
  /**
   * For function-bridge connectors: the TypeScript marker type that drives
   * `client.connectors.<name>.*` IntelliSense, and the package that exports
   * it. Emitted into the generated `rayfin/connectors/<name>/schema.ts` by
   * `rayfin connector add`. Undefined for SQL-style connectors, which don't
   * go through the typed connectors surface today.
   */
  schemaMarker?: {
    /** Exported type name, e.g. `FabricSemanticModel`. */
    type: string;
    /** Package the type is exported from. */
    package: string;
  };
  /**
   * For function-bridge connectors that ship a client-side runtime: the
   * factory that produces the `ConnectorRuntime` and the package exporting
   * it. `rayfin connector add` uses this to wire the `connectorRuntimes` map
   * in the app's `src/lib/connectors.ts`.
   *
   * A runtime is required whenever the connector needs client-side work on
   * the request or response path: decoding a binary payload (e.g. an Apache
   * Arrow stream) before the app sees it, or injecting routing the server
   * does not supply (e.g. kusto's `queryServiceUri`/`databaseName`). Only
   * connectors that need neither set this to `null`.
   *
   * Required, not optional, on purpose: a connector missing from
   * `connectorRuntimes` produces a blank app with no error (AB#2258759), and
   * an omitted field is indistinguishable from an oversight. Adding a
   * connector type now fails to compile until its author states which case
   * it is.
   *
   * The factory is always invoked with no arguments — the connector target
   * is resolved server-side from `rayfin.yml`, never from client code.
   */
  runtimeFactory: {
    /** Exported factory function name, e.g. `fabricSemanticModel`. */
    name: string;
    /** Package the factory is exported from. */
    package: string;
  } | null;
  /** Fabric REST API item `type` value used to filter Items API lookups by display name. */
  fabricItemType: string;
  /**
   * npm packages the generated `rayfin/connectors/<name>/schema.ts` imports for
   * this type, so an agent can install exactly what compiles without a
   * hand-copied table. Published in lockstep with the CLI, so the version to
   * install is the CLI's own version.
   */
  clientPackages: readonly ConnectorPackageRef[];
  /**
   * Whether this type appears in `rayfin connector search` results, listed by
   * `fabricItemType`. Required rather than optional so adding a type is a
   * deliberate yes/no — an omitted flag silently made `kusto` unsearchable.
   *
   * Independent of {@link ConnectorMeta.authoring}: this is whether Fabric
   * search can find the type at all, applied only once the type is authorable.
   */
  discoverable: boolean;
  /**
   * Whether this type ships in the current release. Required rather than
   * optional so adding a type is a deliberate ship/hold decision.
   */
  authoring: ConnectorAuthoringPolicy;
}

export const CONNECTOR_CATALOG: Record<ConnectorType, ConnectorMeta> = {
  'fabric-sqlanalytics': {
    description: 'Fabric SQL Analytics endpoint',
    category: 'graphql-entities',
    requiredConfigArgs: [
      ConnectorConfigArg.WorkspaceId,
      ConnectorConfigArg.ItemId,
    ],
    defaultAuth: ConnectorAuth.Application,
    allowedAuthTypes: [ConnectorAuth.Delegated, ConnectorAuth.Application],
    dialect: ConnectorDialect.FabricSqlAnalytics,
    // Lakehouse SQL endpoint is a read-only query surface.
    allowedOperations: LAKEHOUSE_CONNECTOR_OPERATIONS,
    requiresVersion: false,
    // SQL results arrive as JSON; nothing to decode client-side.
    runtimeFactory: null,
    fabricItemType: 'Lakehouse',
    clientPackages: GRAPHQL_ENTITY_PACKAGES,
    discoverable: true,
    authoring: 'released',
  },
  'fabric-warehouse': {
    description: 'Fabric Warehouse',
    category: 'graphql-entities',
    requiredConfigArgs: [
      ConnectorConfigArg.WorkspaceId,
      ConnectorConfigArg.ItemId,
    ],
    defaultAuth: ConnectorAuth.Application,
    allowedAuthTypes: [ConnectorAuth.Delegated, ConnectorAuth.Application],
    dialect: ConnectorDialect.FabricWarehouse,
    allowedOperations: FABRIC_SQL_CONNECTOR_OPERATIONS,
    requiresVersion: false,
    // SQL results arrive as JSON; nothing to decode client-side.
    runtimeFactory: null,
    fabricItemType: 'Warehouse',
    clientPackages: GRAPHQL_ENTITY_PACKAGES,
    discoverable: true,
    authoring: 'released',
  },
  'fabric-sqldatabase': {
    description: 'Fabric SQL Database',
    category: 'graphql-entities',
    requiredConfigArgs: [
      ConnectorConfigArg.WorkspaceId,
      ConnectorConfigArg.ItemId,
    ],
    defaultAuth: ConnectorAuth.Application,
    allowedAuthTypes: [ConnectorAuth.Delegated, ConnectorAuth.Application],
    dialect: DatabaseDialect.MsSql,
    allowedOperations: FABRIC_SQL_CONNECTOR_OPERATIONS,
    requiresVersion: false,
    // SQL results arrive as JSON; nothing to decode client-side.
    runtimeFactory: null,
    fabricItemType: 'SQLDatabase',
    clientPackages: GRAPHQL_ENTITY_PACKAGES,
    discoverable: true,
    authoring: 'released',
  },
  'fabric-semanticmodel': {
    description: 'Fabric semantic model',
    category: 'function-bridge',
    requiredConfigArgs: [
      ConnectorConfigArg.WorkspaceId,
      ConnectorConfigArg.ItemId,
    ],
    defaultAuth: ConnectorAuth.Delegated,
    allowedAuthTypes: [ConnectorAuth.Delegated],
    dialect: null,
    allowedOperations: FABRIC_SEMANTIC_MODEL_CONNECTOR_OPERATIONS,
    requiresVersion: true,
    defaultVersion: '1',
    schemaMarker: {
      type: 'FabricSemanticModel',
      package: '@microsoft/rayfin-connector-fabric-semanticmodel',
    },
    // executeQuery returns an Apache Arrow stream; without this runtime the
    // app receives an undecoded ArrayBuffer and silently renders nothing.
    runtimeFactory: {
      name: 'fabricSemanticModel',
      package: '@microsoft/rayfin-connector-fabric-semanticmodel',
    },
    fabricItemType: 'SemanticModel',
    clientPackages: [
      {
        name: '@microsoft/rayfin-connector-fabric-semanticmodel',
        role: 'marker',
      },
      { name: '@microsoft/rayfin-connectors', role: 'runtime' },
    ],
    discoverable: true,
    authoring: 'released',
  },
  kusto: {
    description: 'Fabric Eventhouse (KQL Database)',
    category: 'function-bridge',
    requiredConfigArgs: [
      ConnectorConfigArg.WorkspaceId,
      ConnectorConfigArg.ItemId,
    ],
    defaultAuth: ConnectorAuth.Delegated,
    allowedAuthTypes: [ConnectorAuth.Delegated],
    dialect: null,
    allowedOperations: KUSTO_CONNECTOR_OPERATIONS,
    requiresVersion: true,
    defaultVersion: '1',
    schemaMarker: {
      type: 'Kusto',
      package: '@microsoft/rayfin-connector-kusto',
    },
    // Kusto returns JSON rows, so no decoder is needed — but `kusto()` is
    // request middleware, not a decoder: it injects `queryServiceUri`,
    // `databaseName`, and `clientRequestId` into every invoke. Those values
    // live only in the connector's `schema.ts` (never `rayfin.yml`) and the
    // server injects neither, so without this entry kusto requests reach the
    // adapter with no cluster to route to.
    runtimeFactory: {
      name: 'kusto',
      package: '@microsoft/rayfin-connector-kusto',
    },
    fabricItemType: 'KQLDatabase',
    // The Eventhouse scaffold imports its marker and `KustoConnectorConfig` from
    // `@microsoft/rayfin-connector-kusto`, but the generated
    // `src/lib/connectors.ts` also needs `ConnectorConfig`/`ConnectorsRuntime`
    // from `@microsoft/rayfin-connectors`. Without it here, the install line
    // `connector add` prints omits it and a kusto-only app can end up with an
    // unresolved import.
    clientPackages: [
      { name: '@microsoft/rayfin-connector-kusto', role: 'marker' },
      { name: '@microsoft/rayfin-connectors', role: 'runtime' },
    ],
    discoverable: true,
    // Held out of the initial release. The record stays complete so an app that
    // already declares a Kusto connector keeps validating and deploying.
    authoring: 'held',
  },
};

/**
 * Find the closest matching connector type for a typo suggestion.
 * Returns `undefined` if no match is within edit distance 3.
 *
 * `candidates` is required so a caller cannot accidentally suggest a type the
 * user is not allowed to author. Pass the authorable view, not the catalog.
 */
export function suggestConnectorType(
  input: string,
  candidates: readonly ConnectorType[]
): ConnectorType | undefined {
  return suggestClosest(input, candidates);
}
