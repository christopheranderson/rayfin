/**
 * Request, result, and dependency contracts for the `up` workflow.
 *
 * `UpRequest` is the normalized product intent Layer 1 hands to the workflow —
 * flags, config, and pre-resolved targeting, but no raw Commander options,
 * `OutputMode`, or TTY booleans. `UpResult` is the structured outcome Layer 1
 * renders. `UpDeps` is the per-workflow capability slice each host satisfies;
 * adding a dependency edits this type and breaks every host call site until
 * updated, so the compiler enumerates what's affected.
 *
 * See docs/rfc/rayfin-tools-architecture.md ("Workflow signature & Deps").
 */
import type {
  CancellationToken,
  Diagnostics,
  Progress,
  TelemetryHandle,
  UserInteraction,
} from '../../adapters/index.js';
import type { RayfinConfig } from '../../config/index.js';
import type {
  FabricClient,
  RayfinWorkloadClient,
} from '../../external/fabric/index.js';
import type { AuthSdkService } from '../../services/auth-sdk/index.js';
import type {
  ConnectorConfigApplyResult,
  ConnectorService,
} from '../../services/connectors/index.js';
import type { DataService } from '../../services/data/index.js';
import type { DeploymentRegistryService } from '../../services/deployment-registry/index.js';
import type { DevRedirectService } from '../../services/dev-redirect/index.js';
import type { FrameworkEnvService } from '../../services/framework-env/index.js';
import type { FunctionsService } from '../../services/functions/index.js';
import type { PackageInventoryService } from '../../services/package-inventory/index.js';
import type { DeploymentTelemetryCollector } from '../../services/project-telemetry/index.js';
import type { RuntimeConfigService } from '../../services/runtime-config/index.js';
import type { StaticHostingService } from '../../services/static-hosting/index.js';
import type { StorageService } from '../../services/storage/index.js';
import type {
  FabricCapacitySource,
  FabricReadinessNotice,
} from '../fabric-readiness/index.js';

import type { StaticHostingPosture } from './steps/ensure-static-hosting-posture.js';

/** Normalized product intent for a `rayfin up` invocation. */
export interface UpRequest {
  /** The loaded `rayfin.yml` configuration. */
  config: RayfinConfig;
  /** Effective Fabric item display name for this deployment. */
  itemName: string;
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
  /** Target workspace GUID (resolved from `--workspace-id`/`--workspace-uri`/env). */
  workspaceId?: string;
  /** Target workspace display name (resolved from `--workspace`), used when no id is set. */
  workspaceName?: string;
  /**
   * Readiness facts carried over from the host's `ensureFabricTarget`
   * pre-flight, alongside the `workspaceId` it resolved.
   */
  workspaceCreated?: boolean;
  capacitySource?: FabricCapacitySource;
  /** Readiness side effects that must survive later failure or cancellation. */
  readinessNotices?: FabricReadinessNotice[];
  /**
   * Recorded item id for a known redeployment. When set, the workflow reuses
   * it directly and skips the create/same-name-reuse path (no prompt) —
   * matching the legacy registry short-circuit. Workspace targeting
   * (`workspaceId`/`workspaceName`) is still required: the workflow always
   * resolves the workspace.
   */
  knownItemId?: string;
  /** Allow destructive DAB schema changes (`--force`). */
  force?: boolean;
  /** Auto-confirm reuse of an existing same-named item (`--yes`). */
  autoConfirmReuse?: boolean;
  /** Skip the static-hosting build/deploy phase (`--exclude-services staticHosting`). */
  excludeStaticHosting?: boolean;
  /** Skip the functions build/deploy phase (`--exclude-services functions`). */
  excludeFunctions?: boolean;
  /** Whether connector config generation/apply is enabled by the host feature gate. */
  connectorsEnabled?: boolean;
  /**
   * Whether the `functions` feature is enabled. Resolved in Layer 1 from the
   * feature flag; the workflow additionally gates on `services.functions.enabled`.
   */
  functionsEnabled?: boolean;
  /**
   * Whether static-hosting access control is enabled by the host feature gate
   * (`cli-up-anonstatic`). Gates the access-posture and auth-SDK pre-flight
   * steps; when false neither inspects, prompts, nor writes anything.
   */
  staticHostingAccessControlEnabled?: boolean;
  /**
   * Access posture chosen ahead of the workflow by a host that collects
   * pre-flight answers. Only consulted when the project has authored none; a
   * host that leaves it unset has the workflow ask through `UpDeps.ui`.
   */
  staticHostingPosture?: StaticHostingPosture;
  /**
   * Consent to raise the project's Rayfin package versions, collected ahead of
   * the workflow. Unset has the workflow ask through `UpDeps.ui`.
   */
  authSdkUpgradeApproved?: boolean;
  /** Effective Entra tenant id for portal deep-link composition and the registry record. */
  tenantId?: string;
  /** Configured Fabric portal base URL. When omitted, the workflow infers it from the resolved endpoint. */
  portalBaseUrl?: string;
  /**
   * Hosting URL to retain in the registry when the static deploy is excluded
   * but static hosting is enabled (so an `--exclude-services` run does not drop
   * a previously-recorded URL).
   */
  retainedHostingUrl?: string;
}

/** Structured outcome of a successful `up` run. */
export interface UpResult {
  /** Rayfin item (AppBackend) GUID deployed to. */
  itemId: string;
  /** Fabric display name of the deployed Rayfin item. */
  itemName: string;
  /** Workload API (BaaS) endpoint for the deployed item. */
  apiUrl: string;
  /** Fabric workspace GUID. */
  workspaceId: string;
  /** Workspace display name. */
  workspaceName: string;
  /** Whether this run created the workspace rather than reusing one. */
  workspaceCreated: boolean;
  /** Whether this run started a Fabric trial to obtain capacity. */
  trialStarted: boolean;
  /**
   * Whether this run attached capacity to a workspace the Builder already
   * owned.
   *
   * Distinct from `trialStarted`: assigning an existing trial starts nothing,
   * yet still changes a workspace the Builder owns, so it needs its own signal
   * to be reportable.
   */
  capacityAssigned: boolean;
  /** Structured readiness side effects, including resource identities. */
  readinessNotices?: FabricReadinessNotice[];
  /** Deployment-registry key actually written for the workspace. */
  workspaceKey: string;
  /** Original env file backed up before its first v2-format rewrite. */
  envBackup?: { sourcePath: string; backupPath: string };
  /** Composed Fabric portal deep link to the item. */
  portalUrl: string;
  /** Publishable key issued for the deployment, when available. */
  publishableKey?: string;
  /** Public hosting URL for deployed static content, when produced or retained. */
  hostingUrl?: string;
  /** Whether the workflow updated `rayfin.yml` with the hosting redirect origin. */
  configUpdated: boolean;
  /** Service names skipped via `--exclude-services`. */
  excludedServices: string[];
  /**
   * Per-connector generation/apply outcomes (generated / skipped / error),
   * mirroring `up connector apply`. Empty when connectors are disabled or the
   * project declares none.
   */
  generate: ConnectorConfigApplyResult[];
}

/**
 * Structured side-effect notice that must survive a later workflow failure.
 *
 * Each variant records something the workflow did on the Builder's behalf that
 * they did not explicitly ask for in this invocation, and that they would
 * otherwise have to discover in the Fabric portal.
 */
export type UpNotice =
  | FabricReadinessNotice
  | {
      kind: 'env-backup';
      sourcePath: string;
      backupPath: string;
    }
  | { kind: 'operation-cancelled' };

/** Capability slice the `up` workflow composes. */
export interface UpDeps {
  diagnostics: Diagnostics;
  fabric: FabricClient;
  workload: RayfinWorkloadClient;
  connectors: ConnectorService;
  data: DataService;
  storage: StorageService;
  staticHosting: StaticHostingService;
  runtimeConfig: RuntimeConfigService;
  registry: DeploymentRegistryService;
  frameworkEnv: FrameworkEnvService;
  functions: FunctionsService;
  devRedirect: DevRedirectService;
  /** Rayfin auth package floor check and in-place upgrade. */
  authSdk: AuthSdkService;
  /** Versions of the Rayfin packages this deploy ships, declared on the wire. */
  packageInventory: PackageInventoryService;
  projectTelemetry: DeploymentTelemetryCollector;
  telemetry: TelemetryHandle;
  /** Push-style progress reporting; rendered (or silenced) by the host. */
  progress: Progress;
  /**
   * Mid-flow consent: reusing an existing same-named item, choosing a
   * static-hosting access posture, and approving a Rayfin package upgrade.
   * Absent on non-interactive hosts, which turns each into a typed requirement
   * the caller must satisfy through the request instead.
   */
  ui?: UserInteraction;
  /** Cooperative cancellation honored between steps. */
  signal?: CancellationToken;
}
