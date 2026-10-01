/**
 * `runUpWorkflow` — the `up` Layer 2 orchestration.
 *
 * Reads as a table of contents: each line is a named step (or a service call)
 * threaded with the data resolved before it. The workflow owns sequencing,
 * conditional gating (data / static / functions), and aggregation of non-fatal
 * warnings; the steps own the work. It returns a typed {@link Result} and never
 * throws for expected failure or calls `process.exit` — Layer 1 maps the result
 * to output and an exit code.
 *
 * Ordering mirrors the legacy `up`: resolve → settings → data → **persist
 * (before the static build so the bundle reads current values)** → refresh env
 * → **connectors (before static so a connector-backed frontend targets a
 * fully-provisioned backend)** → static → functions → patch hosting URL.
 *
 * See docs/rfc/rayfin-tools-architecture.md ("Workflow signature & Deps").
 */
import {
  composeFabricItemDeepLink,
  validateFunctionsConfig,
} from '../../config/index.js';
import { resolveFabricPortalUrl } from '../../fabric.js';
import type { ConnectorConfigApplyResult } from '../../services/connectors/index.js';
import { type Workflow, cancelled, failed, ok } from '../types.js';

import { applyConnectorConfigs } from './steps/apply-connector-configs.js';
import { applyDataConfig } from './steps/apply-data-config.js';
import { applyRuntimeSettings } from './steps/apply-runtime-settings.js';
import { applyStorageConfig } from './steps/apply-storage-config.js';
import { deployFunctions } from './steps/deploy-functions.js';
import { deployStatic } from './steps/deploy-static.js';
import { emitRuntimeConfig } from './steps/emit-runtime-config.js';
import { enrichDeploymentTelemetry } from './steps/enrich-deployment-telemetry.js';
import {
  describeOutdatedAuthSdk,
  describeUnresolvedAuthSdk,
  ensureAuthSdk,
  type EnsureAuthSdkResult,
} from './steps/ensure-auth-sdk.js';
import { ensureLocalDevRedirectUris } from './steps/ensure-local-dev-redirect-uris.js';
import {
  describeInvalidPostureError,
  describeMissingPostureError,
  describePosturePersistError,
  ensureStaticHostingPosture,
  withAssetAccess,
  type EnsureStaticHostingPostureResult,
} from './steps/ensure-static-hosting-posture.js';
import { persistDeployment } from './steps/persist-deployment.js';
import { persistHostingUrl } from './steps/persist-hosting-url.js';
import { refreshFrameworkEnv } from './steps/refresh-framework-env.js';
import { resolveOrCreateItem } from './steps/resolve-or-create-item.js';
import { resolveWorkspace } from './steps/resolve-workspace.js';
import { validateRequest } from './steps/validate-request.js';
import type { UpDeps, UpNotice, UpRequest, UpResult } from './types.js';

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

export const runUpWorkflow: Workflow<
  UpRequest,
  UpResult,
  UpDeps,
  UpNotice
> = async (req, deps) => {
  const { diagnostics, signal } = deps;
  const progress: UpDeps['progress'] = {
    report(update) {
      diagnostics.debug({
        area: `up.${update.phase ?? 'progress'}`,
        message: update.message ?? update.phase ?? 'Deployment progress',
      });
      deps.progress.report(update);
    },
  };
  const isCancelled = (): boolean => signal?.isCancellationRequested === true;
  const notices: UpNotice[] = [...(req.readinessNotices ?? [])];

  diagnostics.debug({ area: 'up', message: 'Validating deployment request' });
  const validation = await validateRequest(req, {});
  if (validation.status === 'invalid') {
    return failed(
      'invalid-request',
      validation.errors.join('\n'),
      undefined,
      notices
    );
  }

  const functionsErrors = validateFunctionsConfig(
    req.config.services?.functions
  );
  if (functionsErrors.length > 0) {
    return failed(
      'invalid-functions-config',
      `functions block in rayfin.yml has validation errors:\n${functionsErrors
        .map((error) => `  • ${error.field}: ${error.message}`)
        .join('\n')}`,
      undefined,
      notices
    );
  }

  const warnings: string[] = [];
  let connectorResults: ConnectorConfigApplyResult[] = [];
  const uniqueWarnings = (): string[] => [...new Set(warnings)];
  const cancelWithFacts = () => cancelled(notices, uniqueWarnings());
  const itemName = req.itemName;
  const excludedServices: string[] = [
    ...(req.excludeStaticHosting ? ['staticHosting'] : []),
    ...(req.excludeFunctions ? ['functions'] : []),
  ];

  try {
    if (isCancelled()) return cancelWithFacts();
    progress.report({
      phase: 'dependencies',
      message: 'Inspecting project dependencies',
    });
    await enrichDeploymentTelemetry(
      { projectRoot: req.projectRoot, config: req.config },
      {
        telemetry: deps.telemetry,
        projectTelemetry: deps.projectTelemetry,
      }
    );

    // Capacity and first-workspace readiness runs in the host's pre-flight,
    // not here: recovering from a readiness failure means falling back to an
    // interactive workspace picker, which only the host can offer. The host
    // hands back what it did so the result reports the same side effects.
    const workspaceCreated = req.workspaceCreated ?? false;
    const capacitySource = req.capacitySource;

    if (isCancelled()) return cancelWithFacts();
    progress.report({ phase: 'workspace', message: 'Resolving workspace' });
    const workspace = await resolveWorkspace(
      { workspaceId: req.workspaceId, workspaceName: req.workspaceName },
      { fabric: deps.fabric }
    );

    // Both pre-flight obligations change the Builder's project (a YAML write, a
    // package upgrade), so they resolve before anything remote is created — a
    // failure here leaves nothing half-configured. They live in the workflow
    // rather than in a host's command layer so a direct caller of
    // `runUpWorkflow` cannot bypass either invariant.
    //
    // The feature gate is applied here rather than inside either step: a step
    // decides what is true of a project, not whether the feature is switched on.
    const accessControlEnabled = req.staticHostingAccessControlEnabled === true;

    if (isCancelled()) return cancelWithFacts();
    const posture: EnsureStaticHostingPostureResult = accessControlEnabled
      ? await ensureStaticHostingPosture(
          {
            services: req.config.services,
            projectRoot: req.projectRoot,
            postureAnswer: req.staticHostingPosture,
          },
          { staticHosting: deps.staticHosting }
        )
      : { status: 'skipped' };
    switch (posture.status) {
      case 'invalid-posture':
        return failed(
          'invalid-static-hosting-posture',
          describeInvalidPostureError(posture.value),
          undefined,
          notices,
          uniqueWarnings()
        );
      case 'answer-required':
        return failed(
          'static-hosting-posture-required',
          describeMissingPostureError(),
          undefined,
          notices,
          uniqueWarnings()
        );
      case 'persist-failed':
        return failed(
          'static-hosting-posture-not-persisted',
          describePosturePersistError(posture.error),
          undefined,
          notices,
          uniqueWarnings()
        );
      default:
        break;
    }
    const assetAccess =
      posture.status === 'resolved' ? posture.assetAccess : undefined;
    if (posture.status === 'resolved' && posture.persisted) {
      progress.report({
        phase: 'posture',
        message: `Static-hosting asset access set to '${assetAccess}' in rayfin.yml`,
      });
    }

    if (isCancelled()) return cancelWithFacts();
    const authSdk: EnsureAuthSdkResult = accessControlEnabled
      ? await ensureAuthSdk(
          {
            services: req.config.services,
            projectRoot: req.projectRoot,
            upgradeApproved: req.authSdkUpgradeApproved,
          },
          { authSdk: deps.authSdk, ui: deps.ui }
        )
      : ({ status: 'ok' } as const);
    switch (authSdk.status) {
      case 'ok':
        if (authSdk.notice) warnings.push(authSdk.notice);
        break;
      case 'upgraded':
        progress.report({
          phase: 'dependencies',
          message: `Updated ${authSdk.packages.join(', ')}`,
        });
        break;
      case 'unresolved':
        return failed(
          'auth-sdk-unresolved',
          describeUnresolvedAuthSdk(authSdk.reason),
          undefined,
          notices,
          uniqueWarnings()
        );
      case 'outdated':
        return failed(
          'auth-sdk-outdated',
          describeOutdatedAuthSdk(authSdk.packages, authSdk.error),
          undefined,
          notices,
          uniqueWarnings()
        );
    }

    if (isCancelled()) return cancelWithFacts();
    progress.report({ phase: 'item', message: 'Resolving Rayfin item' });
    const itemResolution = await resolveItemId(req, deps, workspace, itemName);
    if (itemResolution.status === 'cancelled') return cancelWithFacts();
    if (itemResolution.status === 'capacity-exhausted') {
      return failed(
        'fabric-capacity-exhausted',
        'The Fabric capacity assigned to this workspace cannot create another Rayfin item.',
        itemResolution.cause,
        notices,
        uniqueWarnings()
      );
    }
    const itemId = itemResolution.itemId;

    if (isCancelled()) return cancelWithFacts();
    progress.report({
      phase: 'target',
      message: 'Resolving workload endpoint',
    });
    const target = await deps.workload.resolveTarget(workspace.id, itemId);
    const portalBaseUrl = stripTrailingSlashes(
      resolveFabricPortalUrl({
        configuredPortalUrl: req.portalBaseUrl,
        backendUrl: target.baasEndpoint,
        hostingUrl: req.retainedHostingUrl,
      })
    );
    const publishableKey = await deps.workload.getPublishableKey(target);

    if (isCancelled()) return cancelWithFacts();
    const redirect = await ensureLocalDevRedirectUris(
      { services: req.config.services, projectRoot: req.projectRoot },
      { devRedirect: deps.devRedirect }
    );
    if (redirect.warning) warnings.push(redirect.warning);
    // The posture step returns its answer instead of writing it back into the
    // config, so the carry-forward onto the wire payload happens here, once.
    const services = withAssetAccess(redirect.services, assetAccess);

    // Resolved once and declared on both settings writes. The workload gates
    // static-hosting writes on this, so it is explicit workflow data rather
    // than something the workload client discovers on its own.
    const packageVersions =
      await deps.packageInventory.resolveDeployPackageVersions({
        projectRoot: req.projectRoot,
        services,
      });

    if (isCancelled()) return cancelWithFacts();
    progress.report({
      phase: 'settings',
      message: 'Applying runtime settings',
    });
    const settings = await applyRuntimeSettings(
      { target, services, connectors: req.config.connectors, packageVersions },
      { workload: deps.workload }
    );
    if (settings.status === 'invalid-connectors') {
      return failed(
        'invalid-connectors',
        `connectors block in rayfin.yml has validation errors:\n${settings.errors
          .map((e) => `  • ${e.sourceName}: ${e.message}`)
          .join('\n')}`,
        undefined,
        notices,
        uniqueWarnings()
      );
    }
    if (settings.status === 'invalid-functions-config') {
      return failed(
        'invalid-functions-config',
        `functions block in rayfin.yml has validation errors:\n${settings.errors
          .map((e) => `  • ${e.field}: ${e.message}`)
          .join('\n')}`,
        undefined,
        notices,
        uniqueWarnings()
      );
    }

    if (req.config.services.data.enabled) {
      if (isCancelled()) return cancelWithFacts();
      progress.report({
        phase: 'data',
        message: 'Applying database configuration',
      });
      await applyDataConfig(
        {
          target,
          dataConfig: req.config.services.data,
          force: req.force,
          projectRoot: req.projectRoot,
        },
        { data: deps.data }
      );
    }
    if (req.config.services.storage?.enabled === true) {
      if (isCancelled()) return cancelWithFacts();
      progress.report({
        phase: 'storage',
        message: 'Applying storage configuration',
      });
      const storageResult = await applyStorageConfig(
        {
          target,
          projectRoot: req.projectRoot,
          force: req.force,
        },
        { storage: deps.storage }
      );
      if (storageResult.status === 'failed-nonfatal') {
        warnings.push(
          `Storage configuration was not applied: ${storageResult.message}. ` +
            'Run `rayfin up storage apply` to retry.'
        );
      }
    }

    if (isCancelled()) return cancelWithFacts();
    progress.report({ phase: 'persist', message: 'Recording deployment' });
    const retainedHostingUrl = req.excludeStaticHosting
      ? req.retainedHostingUrl
      : undefined;
    const persist = await persistDeployment(
      {
        projectRoot: req.projectRoot,
        workspaceName: workspace.displayName,
        record: {
          itemId,
          itemName,
          apiUrl: target.baasEndpoint,
          workspaceId: workspace.id,
          tenantId: req.tenantId,
          publishableKey: publishableKey || undefined,
          portalUrl: portalBaseUrl,
          hostingUrl: retainedHostingUrl,
        },
      },
      { registry: deps.registry }
    );
    warnings.push(...persist.warnings);
    if (persist.envBackup) {
      notices.push({ kind: 'env-backup', ...persist.envBackup });
    }

    if (isCancelled()) return cancelWithFacts();
    const envResult = await refreshFrameworkEnv(
      {
        projectRoot: req.projectRoot,
        staticHosting: req.config.services.staticHosting?.enabled
          ? req.config.services.staticHosting
          : undefined,
      },
      { frameworkEnv: deps.frameworkEnv }
    );
    if (envResult.status === 'failed') {
      warnings.push(
        `Could not refresh framework .env.local before build: ${envResult.message}`
      );
    } else if (
      envResult.status === 'no-framework' &&
      req.config.services.staticHosting?.enabled
    ) {
      warnings.push(
        'staticHosting is enabled but no frontend framework could be auto-detected. ' +
          'Run `rayfin env --framework <vite|nextjs|plain>` to generate .env.local manually.'
      );
    }

    // Apply connector database configs *before* static content deploys so a
    // frontend that reads connector-backed data at build/runtime targets a
    // fully-provisioned backend. Connector failures are non-fatal warnings.
    if (req.connectorsEnabled) {
      if (isCancelled()) return cancelWithFacts();
      progress.report({
        phase: 'connectors',
        message: 'Applying connector configurations',
      });
      const connectorResult = await applyConnectorConfigs(
        {
          projectRoot: req.projectRoot,
          connectors: req.config.connectors ?? [],
          target,
        },
        { connectors: deps.connectors }
      );
      warnings.push(...connectorResult.warnings);
      connectorResults = connectorResult.results;
    }

    let hostingUrl = retainedHostingUrl;
    let deployedHostingUrl: string | undefined;
    let configUpdated = false;
    const staticConfig = req.config.services.staticHosting;
    if (staticConfig?.enabled && !req.excludeStaticHosting) {
      if (isCancelled()) return cancelWithFacts();
      progress.report({ phase: 'static', message: 'Deploying static content' });

      // Emitted before the build so it is bundled into the static output;
      // failures here are fatal (see emitRuntimeConfig) rather than a warned
      // best-effort, since a deploy without it would silently retain the
      // source-stage backend after promotion.
      const emittedConfig = await emitRuntimeConfig(
        {
          projectRoot: req.projectRoot,
          config: staticConfig,
          target,
          workspaceId: workspace.id,
          publishableKey: publishableKey || undefined,
          portalUrl: portalBaseUrl,
          tenantId: req.tenantId,
        },
        { runtimeConfig: deps.runtimeConfig }
      );
      if (emittedConfig.differences.length > 0) {
        warnings.push(
          `Found an existing ${emittedConfig.path} that doesn't match this deployment (${emittedConfig.differences.join('; ')}) — reusing it as-is (not overwritten). Delete it and re-run to regenerate it.`
        );
      }

      try {
        const staticResult = await deployStatic(
          { target, config: staticConfig, projectRoot: req.projectRoot },
          { staticHosting: deps.staticHosting }
        );
        if (staticResult.hostingUrl) {
          deployedHostingUrl = staticResult.hostingUrl;
          hostingUrl = staticResult.hostingUrl;
        }
      } finally {
        // Only remove the file this run actually wrote — a pre-existing file
        // was left untouched above and is not ours to delete.
        if (!emittedConfig.preexisting) {
          await deps.runtimeConfig.remove(emittedConfig.path);
        }
      }
    }
    if (req.config.services.functions?.enabled && !req.excludeFunctions) {
      if (isCancelled()) return cancelWithFacts();
      progress.report({ phase: 'functions', message: 'Deploying functions' });
      await deployFunctions(
        {
          projectRoot: req.projectRoot,
          config: req.config.services.functions,
          target,
        },
        { functions: deps.functions }
      );
    }

    // Content and functions have already shipped; finalize the hosting-URL
    // record so the registry reflects the deployed content.
    if (deployedHostingUrl) {
      const hostingPersistence = await persistHostingUrl(
        {
          target,
          hostingUrl: deployedHostingUrl,
          services,
          connectors: req.config.connectors,
          packageVersions,
          projectRoot: req.projectRoot,
          workspaceName: workspace.displayName,
        },
        { staticHosting: deps.staticHosting, workload: deps.workload }
      );
      configUpdated = hostingPersistence.configUpdated;
      warnings.push(...hostingPersistence.warnings);
    }

    // Success delivers side-effect notices as UpResult facts; cancelled and
    // failed results use the notice channel because they have no result data.
    return ok(
      {
        itemId,
        itemName,
        apiUrl: target.baasEndpoint,
        workspaceId: workspace.id,
        workspaceName: workspace.displayName,
        workspaceKey: persist.workspaceKey,
        workspaceCreated,
        trialStarted: capacitySource === 'new-trial',
        // Readiness only reports a non-`workspace` source for a workspace it
        // had to attach capacity to. A workspace this run created is excluded:
        // it is announced as created, and was never the Builder's to change.
        capacityAssigned:
          !workspaceCreated &&
          capacitySource !== undefined &&
          capacitySource !== 'workspace',
        readinessNotices: req.readinessNotices,
        envBackup: persist.envBackup,
        portalUrl: composeFabricItemDeepLink(
          portalBaseUrl,
          workspace.id,
          itemId,
          req.tenantId
        ),
        publishableKey: publishableKey || undefined,
        hostingUrl: hostingUrl || undefined,
        configUpdated,
        excludedServices,
        generate: connectorResults,
      },
      uniqueWarnings()
    );
  } catch (error) {
    if (isCancelled()) return cancelWithFacts();
    diagnostics.debug({
      area: 'up',
      message: 'Workflow failed',
      data: { code: 'up-failed' },
    });
    return failed(
      'up-failed',
      error instanceof Error ? error.message : String(error),
      error,
      notices,
      uniqueWarnings()
    );
  }
};

/**
 * Resolve the target item id: reuse a recorded redeployment id directly, else
 * create-or-reuse a same-named item.
 */
type ItemIdResolution =
  | { status: 'resolved'; itemId: string }
  | { status: 'cancelled' }
  | { status: 'capacity-exhausted'; cause: unknown };

async function resolveItemId(
  req: UpRequest,
  deps: UpDeps,
  workspace: { id: string; displayName: string },
  itemName: string
): Promise<ItemIdResolution> {
  if (req.knownItemId) {
    return { status: 'resolved', itemId: req.knownItemId };
  }

  const itemResult = await resolveOrCreateItem(
    {
      workspaceId: workspace.id,
      displayName: itemName,
      workspaceDisplayName: workspace.displayName,
      autoConfirmReuse: req.autoConfirmReuse,
    },
    { fabric: deps.fabric, ui: deps.ui }
  );

  if (itemResult.status === 'reuse-declined') {
    return { status: 'cancelled' };
  }
  if (itemResult.status === 'reuse-required') {
    throw new Error(
      `A Rayfin item named "${itemName}" already exists in ` +
        `"${workspace.displayName}" (ID: ${itemResult.item.id}), but this ` +
        `project has not been deployed there before. Run \`rayfin up\` in an ` +
        `interactive terminal to confirm reuse, pass \`--yes\` to auto-accept, ` +
        `or pass \`--item-name <name>\` to choose a different item name.`
    );
  }
  if (itemResult.status === 'capacity-exhausted') {
    return itemResult;
  }
  return { status: 'resolved', itemId: itemResult.item.id };
}
