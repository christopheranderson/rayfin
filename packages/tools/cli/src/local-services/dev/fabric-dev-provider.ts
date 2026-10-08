/**
 * `FabricDevProvider` — the default `dev` backend strategy.
 *
 * Implements the universal {@link DevBackendProvider} seam against a *deployed*
 * Rayfin item in a Microsoft Fabric workspace, reusing the Phase 2 `up`
 * services (`DataService`, `DevRedirectService`, `FrameworkEnvService`,
 * `DeploymentRegistryService`) and the Fabric external clients.
 * Selected in Layer 1 when `--provider fabric` (the default); the `dev`
 * workflow drives it without knowing it is Fabric.
 *
 * It **hydrates your services with my declared state** — schema and the runtime
 * services/connectors block are applied to the deployed backend — and
 * reconfigures that backend for local-frontend access (dev redirect URIs,
 * refreshed `.env.local`). It never publishes the app itself (static bundle,
 * deployed functions); that stays `rayfin up`. When no deployment exists,
 * `ensureReady` can first prepare Fabric workspace capacity, then reuses the
 * shared `up` workspace/item/persistence steps to provision only the AppBackend
 * required by the local inner loop.
 */
import { join, resolve } from 'node:path';

import type { UserInteraction } from '@microsoft/rayfin-tools-common/_internal/adapters';
import type {
  ConnectorEntry,
  RayfinConfig,
} from '@microsoft/rayfin-tools-common/_internal/config';
import type {
  FabricClient,
  RayfinWorkloadClient,
  WorkloadTarget,
} from '@microsoft/rayfin-tools-common/_internal/external/fabric';
import type { DataService } from '@microsoft/rayfin-tools-common/_internal/services/data';
import type { DeploymentRegistryService } from '@microsoft/rayfin-tools-common/_internal/services/deployment-registry';
import type { DevRedirectService } from '@microsoft/rayfin-tools-common/_internal/services/dev-redirect';
import type { FrameworkEnvService } from '@microsoft/rayfin-tools-common/_internal/services/framework-env';
import type {
  ApplyDataConfigInput,
  DevBackendProvider,
  DevProviderRequest,
  DevTarget,
  EnsureBackendReadyOutcome,
  LocalDevWiring,
  PrepareLocalFrontendOptions,
} from '@microsoft/rayfin-tools-common/_internal/workflows/dev';
import {
  persistDeployment,
  resolveOrCreateItem,
  resolveWorkspace,
} from '@microsoft/rayfin-tools-common/_internal/workflows/up';

import {
  FABRIC_CAPACITY_EXHAUSTED_ERROR,
  getFabricCapacityExhaustedError,
} from '../../errors.js';
import { FRONTEND_DEV_PORT_ENV_VAR } from '../../utils/frontend-dev-port.js';
import { selectWorkspaceResolution } from '../../utils/workspace-resolution.js';

/**
 * A {@link DevTarget} extended with the Fabric workload coordinates the Fabric
 * provider threads through the pipeline. `workload` is absent before a missing
 * deployment is provisioned by {@link FabricDevProvider.ensureReady}.
 */
export interface FabricDevTarget extends DevTarget {
  readonly workload?: WorkloadTarget;
  /** Fabric workspace GUID of the resolved deployment, when one exists. */
  readonly workspaceId?: string;
  /**
   * Publishable key reused during wiring, from one of two producers with
   * different freshness: `resolveTarget` seeds it from the persisted record (so
   * it may be stale), while `ensureReady` fetches it fresh while provisioning.
   * Consumers cannot tell the two apart.
   */
  readonly publishableKey?: string;
  /**
   * Registry key to make active once readiness succeeds. Deferred so a session
   * that fails or is declined leaves the project's active deployment — and the
   * `rayfin/.env` mirror it rewrites — untouched.
   */
  readonly pendingActivation?: string;
  /**
   * Registry key this target was recovered from, when any. Provisioning writes
   * back under it so a portal pre-seed (keyed `'default'`, not by workspace
   * display name) is replaced rather than duplicated.
   */
  readonly registryKey?: string;
  /** Warnings discovered while resolving the target and returned on readiness. */
  readonly readinessWarnings?: string[];
}

/** Capacity-readiness adapter supplied only for the Fabric provider. */
export interface FabricDevReadiness {
  prepare(
    workspaceId?: string
  ): Promise<
    | { status: 'ready'; workspace: { id: string; displayName: string } }
    | { status: 'cancelled' }
    | { status: 'declined' }
    | { status: 'unavailable'; code: string; message: string }
  >;
}

/** Collaborators for {@link createFabricDevProvider}. */
export interface FabricDevProviderDeps {
  /** Fabric workspace and AppBackend item operations. */
  fabric: FabricClient;
  /** Deployed-item workload seam (endpoint resolution, publishable key, runtime settings). */
  workload: RayfinWorkloadClient;
  /** DAB schema generation + remote apply. */
  data: DataService;
  /** Deployment registry (resolves the active deployment). */
  registry: DeploymentRegistryService;
  /** Local dev-server redirect-URI allow-list management. */
  devRedirect: DevRedirectService;
  /** Framework `.env.local` (re)writer. */
  frameworkEnv: FrameworkEnvService;
  /** The loaded `rayfin.yml`, source of the services block posted to the backend. */
  config: RayfinConfig;
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
  /** Ambient Fabric workspace GUID, which takes precedence over the registry. */
  targetWorkspaceId?: string;
  /** Fabric workspace selected when no ambient target or deployment exists. */
  targetWorkspaceName?: string;
  /** Effective Entra tenant id persisted with a newly provisioned deployment. */
  tenantId?: string;
  /** Fabric portal base URL persisted with a newly provisioned deployment. */
  portalUrl?: string;
  /** Pre-approve reuse of an existing same-named AppBackend (`--yes`). */
  autoConfirmReuse?: boolean;
  /** Capacity requested for this invocation, ignored for an existing deployment. */
  requestedCapacityId?: string;
  /** Interactive confirmation capability; absent in JSON and non-interactive modes. */
  ui?: UserInteraction;
  /** Mode-aware user-visible provisioning notices. */
  notify?: (message: string) => void;
  /** Fabric capacity readiness used when no reusable backend exists. */
  readiness?: FabricDevReadiness;
  /** Reports whether the host has requested cooperative cancellation. */
  isCancelled?: () => boolean;
  /**
   * Persist `RAYFIN_PUBLIC_*` values into `rayfin/.env`. Injected so the
   * provider's local-wiring orchestration is unit-testable without touching
   * the filesystem. Defaults in the factory to the real env-file writer.
   */
  persistPublicEnv: (
    rayfinDir: string,
    vars: { key: string; value: string | null }[]
  ) => Promise<void>;
  /**
   * Whether to regenerate the framework `.env.local` during local wiring.
   * `false` mirrors `--no-emit-env`; defaults to `true`.
   */
  emitFrameworkEnv?: boolean;
}

/**
 * Construct the Fabric `dev` backend provider. Collaborators are injected so
 * the strategy is unit-testable with fakes; Layer 1 wires the real CLI impls.
 */
export function createFabricDevProvider(
  deps: FabricDevProviderDeps
): DevBackendProvider<FabricDevTarget> {
  const {
    fabric,
    workload,
    data,
    registry,
    devRedirect,
    frameworkEnv,
    config,
    projectRoot,
    targetWorkspaceId,
    targetWorkspaceName,
    tenantId,
    portalUrl,
    autoConfirmReuse,
    requestedCapacityId,
    ui,
    notify = (): void => {},
    readiness,
    isCancelled = () => false,
    persistPublicEnv,
    emitFrameworkEnv = true,
  } = deps;
  const rayfinDir = join(projectRoot, 'rayfin');

  /**
   * Decide which workspace a first-run backend goes into when automatic Fabric
   * readiness is disabled. There is deliberately no default in that path: the
   * host asks rather than silently targeting "My Workspace", and fails closed
   * when it cannot ask.
   */
  async function chooseWorkspace(
    knownWorkspaceId: string | undefined,
    options: { ignoreConfiguredTarget?: boolean } = {}
  ): Promise<
    | {
        status: 'selected';
        selector: { workspaceId: string } | { workspaceName: string };
      }
    | Extract<
        EnsureBackendReadyOutcome<FabricDevTarget>,
        { status: 'unavailable' }
      >
  > {
    if (knownWorkspaceId) {
      return {
        status: 'selected',
        selector: { workspaceId: knownWorkspaceId },
      };
    }
    if (targetWorkspaceName && !options.ignoreConfiguredTarget) {
      return {
        status: 'selected',
        selector: { workspaceName: targetWorkspaceName },
      };
    }
    if (!ui) {
      return {
        status: 'unavailable',
        code: 'fabric-workspace-required',
        message:
          'No Fabric workspace is recorded for this project, and none was specified.',
      };
    }
    const workspaces = await fabric.listWorkspaces();
    if (workspaces.length === 0) {
      return {
        status: 'unavailable',
        code: 'fabric-workspace-required',
        message:
          'Your account has no accessible Fabric workspaces to create a backend in.',
      };
    }
    const selected = await ui.select(
      `Which Fabric workspace should the "${config.id}" backend live in?`,
      workspaces.map((workspace) => ({
        label: workspace.displayName,
        value: workspace.id,
      }))
    );
    if (!selected) {
      return {
        status: 'unavailable',
        code: 'fabric-workspace-required',
        message: 'No Fabric workspace was selected.',
      };
    }
    return { status: 'selected', selector: { workspaceId: selected } };
  }

  return {
    async resolveTarget(
      _request: DevProviderRequest
    ): Promise<FabricDevTarget> {
      if (targetWorkspaceId) {
        const registryState = await registry.listDeployments(projectRoot);
        const registered = registryState.deployments.find(
          (entry) => entry.record.workspaceId === targetWorkspaceId
        );
        if (registered) {
          if (!registered.record.itemId) {
            // Partial pre-seed: never activate it. Activation rewrites the env
            // mirror, and this record has no values to restore the cleared
            // RAYFIN_PUBLIC_* keys with.
            return {
              provider: 'fabric',
              displayName: registered.workspaceName,
              workspaceId: registered.record.workspaceId,
              registryKey: registered.workspaceName,
            };
          }
          const target = await workload.resolveTarget(
            registered.record.workspaceId,
            registered.record.itemId
          );
          return {
            provider: 'fabric',
            displayName: registered.workspaceName,
            apiUrl: registered.record.apiUrl || target.baasEndpoint,
            workload: target,
            workspaceId: registered.record.workspaceId,
            publishableKey: registered.record.publishableKey,
            pendingActivation: registered.workspaceName,
            readinessWarnings: requestedCapacityId
              ? [ignoredCapacityWarning()]
              : undefined,
          };
        }
        return {
          provider: 'fabric',
          displayName: `workspace ${targetWorkspaceId}`,
          workspaceId: targetWorkspaceId,
        };
      }

      const active = await registry.getActiveDeployment(projectRoot);
      if (!active) {
        // No recorded deployment — leave `workload` absent so ensureReady can
        // provision the backend lazily and return a hydrated replacement.
        return { provider: 'fabric', displayName: '(no active deployment)' };
      }
      if (!active.record.itemId) {
        return {
          provider: 'fabric',
          displayName: active.workspaceName,
          workspaceId: active.record.workspaceId,
          registryKey: active.workspaceName,
        };
      }
      const target = await workload.resolveTarget(
        active.record.workspaceId,
        active.record.itemId
      );
      return {
        provider: 'fabric',
        displayName: active.workspaceName,
        apiUrl: active.record.apiUrl || target.baasEndpoint,
        workload: target,
        workspaceId: active.record.workspaceId,
        publishableKey: active.record.publishableKey,
        readinessWarnings: requestedCapacityId
          ? [ignoredCapacityWarning()]
          : undefined,
      };
    },

    async ensureReady(
      target: FabricDevTarget
    ): Promise<EnsureBackendReadyOutcome<FabricDevTarget>> {
      try {
        let effectiveTarget = target;
        let workspace: { id: string; displayName: string } | undefined;
        const hasFixedWorkspace =
          effectiveTarget.workspaceId !== undefined ||
          targetWorkspaceName !== undefined;

        if (readiness && !effectiveTarget.workload) {
          let workspaceId = effectiveTarget.workspaceId;
          if (!workspaceId && targetWorkspaceName) {
            workspace = await resolveWorkspace(
              { workspaceName: targetWorkspaceName },
              { fabric }
            );
            workspaceId = workspace.id;
          }
          let shouldRunReadiness = true;
          if (!hasFixedWorkspace && ui && !requestedCapacityId) {
            const resolution = await selectWorkspaceResolution(ui);
            if (!resolution) {
              return { status: 'cancelled' };
            }
            if (resolution === 'existing') {
              const chosen = await chooseWorkspace(undefined);
              if (chosen.status === 'unavailable') {
                return chosen;
              }
              workspace = await resolveWorkspace(chosen.selector, { fabric });
              workspaceId = workspace.id;
              effectiveTarget = {
                ...effectiveTarget,
                displayName: workspace.displayName,
                workspaceId: workspace.id,
              };
              shouldRunReadiness = false;
            }
          }
          let prepared = shouldRunReadiness
            ? await readiness.prepare(workspaceId)
            : undefined;
          if (prepared?.status === 'declined') {
            const chosen = await chooseWorkspace(undefined, {
              ignoreConfiguredTarget: true,
            });
            if (chosen.status === 'unavailable') {
              return chosen;
            }
            workspace = await resolveWorkspace(chosen.selector, { fabric });
            effectiveTarget = {
              ...effectiveTarget,
              displayName: workspace.displayName,
              workspaceId: workspace.id,
            };
          }
          if (
            prepared?.status === 'unavailable' &&
            !requestedCapacityId &&
            !hasFixedWorkspace &&
            ui
          ) {
            const chosen = await chooseWorkspace(undefined);
            if (chosen.status === 'unavailable') {
              return chosen;
            }
            workspace = await resolveWorkspace(chosen.selector, { fabric });
            prepared = await readiness.prepare(workspace.id);
          }
          if (
            prepared &&
            prepared.status !== 'ready' &&
            prepared.status !== 'declined'
          ) {
            return prepared;
          }
          if (prepared?.status === 'ready') {
            workspace = prepared.workspace;
            effectiveTarget = {
              ...effectiveTarget,
              displayName: workspace.displayName,
              workspaceId: workspace.id,
            };
          }
        }

        if (effectiveTarget.workload) {
          if (!effectiveTarget.pendingActivation) {
            return {
              status: 'ready',
              target: effectiveTarget,
              warnings: effectiveTarget.readinessWarnings,
            };
          }
          const activated = await registry.setActiveDeployment(
            projectRoot,
            effectiveTarget.pendingActivation
          );
          return {
            status: 'ready',
            target: effectiveTarget,
            warnings: [
              ...(effectiveTarget.readinessWarnings ?? []),
              ...(activated
                ? []
                : [
                    `Could not make "${effectiveTarget.pendingActivation}" the active deployment; ` +
                      'the local registry no longer lists it.',
                  ]),
            ],
          };
        }

        if (!workspace) {
          const chosen = await chooseWorkspace(effectiveTarget.workspaceId);
          if (chosen.status === 'unavailable') {
            return chosen;
          }
          workspace = await resolveWorkspace(chosen.selector, { fabric });
        }

        notify(
          `Preparing Fabric backend "${config.id}" in "${workspace.displayName}"...`
        );
        // Creating a durable tenant item is consent-worthy, and
        // `resolveOrCreateItem` gates reuse only. A host that cannot ask
        // fails closed unless an explicit capacity authorizes provisioning.
        if (!ui && !autoConfirmReuse && !requestedCapacityId) {
          const existing = await fabric.getItemByName(workspace.id, config.id);
          if (!existing) {
            return {
              status: 'unavailable',
              code: 'fabric-provisioning-consent-required',
              message:
                `No Fabric backend named "${config.id}" exists in ` +
                `"${workspace.displayName}", and creating one needs your confirmation.`,
            };
          }
        }
        const itemResult = await resolveOrCreateItem(
          {
            workspaceId: workspace.id,
            displayName: config.id,
            workspaceDisplayName: workspace.displayName,
            autoConfirmReuse,
          },
          { fabric, ui }
        );
        if (itemResult.status === 'reuse-declined') {
          return { status: 'cancelled' };
        }
        if (itemResult.status === 'reuse-required') {
          return {
            status: 'unavailable',
            code: 'fabric-item-reuse-required',
            message:
              `A Fabric backend named "${config.id}" already exists in ` +
              `"${workspace.displayName}" (ID: ${itemResult.item.id}) but is not registered for this project.`,
          };
        }
        if (itemResult.status === 'capacity-exhausted') {
          return {
            status: 'unavailable',
            code: FABRIC_CAPACITY_EXHAUSTED_ERROR.code,
            message: FABRIC_CAPACITY_EXHAUSTED_ERROR.message,
          };
        }

        notify(
          itemResult.created
            ? `Created Fabric backend "${config.id}" in "${workspace.displayName}".`
            : `Using existing Fabric backend "${config.id}" in "${workspace.displayName}".`
        );

        let provisionedWorkload: WorkloadTarget;
        try {
          provisionedWorkload = await workload.resolveTarget(
            workspace.id,
            itemResult.item.id
          );
        } catch (error) {
          return {
            status: 'unavailable',
            code: 'fabric-backend-setup-failed',
            message:
              `Fabric backend "${config.id}" exists in "${workspace.displayName}" ` +
              `(ID: ${itemResult.item.id}), but its workload endpoint could not be resolved: ${messageOf(error)}`,
          };
        }

        const warnings: string[] = [];
        let publishableKey = '';
        try {
          publishableKey =
            await workload.getPublishableKey(provisionedWorkload);
        } catch (error) {
          warnings.push(
            `Could not read the Fabric publishable key while provisioning: ${messageOf(error)}`
          );
        }

        let persistence: Awaited<ReturnType<typeof persistDeployment>>;
        try {
          persistence = await persistDeployment(
            {
              projectRoot,
              // Reuse the recovered entry's key so a pre-seed is replaced.
              workspaceName:
                effectiveTarget.registryKey ?? workspace.displayName,
              record: {
                itemId: itemResult.item.id,
                apiUrl: provisionedWorkload.baasEndpoint,
                workspaceId: workspace.id,
                tenantId,
                publishableKey: publishableKey || undefined,
                portalUrl,
              },
            },
            { registry }
          );
        } catch (error) {
          return {
            status: 'unavailable',
            code: 'fabric-backend-record-failed',
            message:
              `Fabric backend "${config.id}" exists in "${workspace.displayName}" ` +
              `(ID: ${itemResult.item.id}), but it could not be recorded locally: ${messageOf(error)}`,
          };
        }

        return {
          status: 'ready',
          target: {
            provider: 'fabric',
            displayName: workspace.displayName,
            apiUrl: provisionedWorkload.baasEndpoint,
            workload: provisionedWorkload,
            workspaceId: workspace.id,
            publishableKey: publishableKey || undefined,
          },
          warnings: [...warnings, ...persistence.warnings],
        };
      } catch (error) {
        if (isPromptCancellation(error) || isCancelled()) {
          return { status: 'cancelled' };
        }
        const capacityError = getFabricCapacityExhaustedError(error);
        if (capacityError) {
          return {
            status: 'unavailable',
            code: capacityError.code,
            message: capacityError.message,
          };
        }
        const targetWorkspace = target.workspaceId
          ? `workspace ${target.workspaceId}`
          : targetWorkspaceName
            ? `"${targetWorkspaceName}"`
            : 'the selected workspace';
        return {
          status: 'unavailable',
          code: 'fabric-provisioning-failed',
          message:
            `Could not provision the Fabric backend in ${targetWorkspace}: ${messageOf(error)} ` +
            'Verify the workspace exists and your account can create AppBackend items, then retry `rayfin dev`.',
        };
      }
    },

    async applyDataConfig(
      target: FabricDevTarget,
      input: ApplyDataConfigInput
    ): Promise<void> {
      if (!target.workload) return;
      await data.applyDatabaseConfig({
        projectRoot: input.projectRoot,
        target: 'remote',
        dialect: input.data.dialect,
        remoteEndpoint: target.workload.itemEndpoint,
        authorizationHeader: target.workload.authorizationHeader,
        itemId: target.workload.itemId,
        servicePath: input.data.path,
        buildCommand: input.data.buildCommand,
      });
    },

    async applyStorageConfig(): Promise<void> {
      // No-op: storage is not implemented on Fabric. The storage *service flag*
      // still travels in the runtime settings block posted by `syncConnectors`;
      // the Docker provider is where a local storage apply happens.
    },

    async syncConnectors(
      target: FabricDevTarget,
      connectors: ConnectorEntry[] | undefined
    ): Promise<void> {
      if (!target.workload) return;
      // Hydrate the backend with the declared services + connectors so the
      // local frontend runs against current state. Connectors merge as a
      // sibling of the service keys inside the workload client.
      await workload.applyRuntimeSettings(target.workload, {
        services: config.services,
        connectors,
        label: 'runtime-settings',
      });
    },

    async prepareForLocalFrontend(
      target: FabricDevTarget,
      options?: PrepareLocalFrontendOptions
    ): Promise<LocalDevWiring> {
      const warnings: string[] = [];
      let services = config.services;
      // `dev` cannot safely start a strict-port frontend without one
      // authoritative port, so resolution failures abort the session.
      const resolution = await devRedirect.resolveFrontendDevPort(projectRoot);
      const { port } = resolution;

      // Extend the backend's auth redirect allow-list with the local dev-server
      // origin(s) so a locally-run frontend can complete auth. Auth-gated and
      // non-fatal — the Builder can add the origin by hand if this fails.
      if (services.auth?.enabled) {
        try {
          for (const redirectPort of resolution.redirectPorts) {
            services = devRedirect.appendLocalDevRedirectUris(
              services,
              redirectPort
            );
          }
          if (target.workload) {
            await workload.applyRuntimeSettings(target.workload, {
              services,
              label: 'runtime-settings-patch',
            });
          }
        } catch (error) {
          warnings.push(
            `Could not register the local dev redirect URI on the backend: ${messageOf(error)}`
          );
        }
      }

      let publishableKey = target.publishableKey ?? '';
      if (!publishableKey && target.workload) {
        try {
          publishableKey = await workload.getPublishableKey(target.workload);
        } catch (error) {
          warnings.push(
            `Could not read the Fabric publishable key: ${messageOf(error)}`
          );
        }
      }
      const functionsUrl = options?.runtimeUrls?.functions;

      const publicEnv: { key: string; value: string | null }[] = [
        { key: 'RAYFIN_PUBLIC_API_URL', value: target.apiUrl ?? '' },
        ...(publishableKey
          ? [{ key: 'RAYFIN_PUBLIC_PUBLISHABLE_KEY', value: publishableKey }]
          : []),
        // Projected to `VITE_RAYFIN_FUNCTIONS_URL` (and framework equivalents)
        // by `rayfin env`, so browser code calls the local functions host
        // instead of the deployed one for the duration of the session.
        {
          key: 'RAYFIN_PUBLIC_FUNCTIONS_URL',
          value: functionsUrl ?? null,
        },
      ];
      await persistPublicEnv(rayfinDir, publicEnv);

      // Refresh the framework `.env.local` so the dev server reads current
      // values; best-effort, mirroring the legacy `dev` env emission. Skipped
      // under `--no-emit-env` so a hand-managed `.env.local` is left untouched.
      if (emitFrameworkEnv) {
        try {
          const frontendDir = config.services.staticHosting?.path
            ? resolve(projectRoot, config.services.staticHosting.path)
            : projectRoot;
          const framework = await frameworkEnv.detectFramework(frontendDir);
          if (framework) {
            await frameworkEnv.writeEnvFile({
              projectRoot,
              framework,
              outputDir: config.services.staticHosting?.path ?? '.',
            });
          }
        } catch (error) {
          warnings.push(
            `Could not regenerate the framework .env.local: ${messageOf(error)}`
          );
        }
      }

      const env: Record<string, string> = {
        RAYFIN_PUBLIC_API_URL: target.apiUrl ?? '',
        [FRONTEND_DEV_PORT_ENV_VAR]: String(port),
        ...(publishableKey
          ? { RAYFIN_PUBLIC_PUBLISHABLE_KEY: publishableKey }
          : {}),
        ...(functionsUrl ? { RAYFIN_PUBLIC_FUNCTIONS_URL: functionsUrl } : {}),
        // Fabric coordinates the locally-run functions host needs to resolve
        // its `FabricContext`; the frontend ignores them (Vite only exposes
        // `VITE_*` to the browser).
        ...(target.workspaceId
          ? { RAYFIN_FABRIC_WORKSPACE_ID: target.workspaceId }
          : {}),
        ...(target.workload
          ? { RAYFIN_FABRIC_ITEM_ID: target.workload.itemId }
          : {}),
      };
      return { env, warnings };
    },

    async teardown(): Promise<void> {
      // No-op: a Fabric backend is long-lived even when `dev` provisions it,
      // so there is nothing to tear down on Ctrl-C.
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ignoredCapacityWarning(): string {
  return 'Ignoring --capacity-id because an existing deployment keeps its current workspace capacity.';
}

/** True for inquirer's Ctrl-C rejection, which is a cancel and not a failure. */
function isPromptCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === 'ExitPromptError';
}
