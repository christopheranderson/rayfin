import { join } from 'node:path';

import { applyWorkspaceUriOverrides } from '@microsoft/rayfin-tools-common/_internal';
import {
  composeFabricItemDeepLink,
  validateConnectors,
  validateFunctionsConfig,
  validateServiceDependencies,
} from '@microsoft/rayfin-tools-common/_internal/config';
import { formatFailedConnectorsRetryTip } from '@microsoft/rayfin-tools-common/_internal/services/connectors';
import { isStorageApplyError } from '@microsoft/rayfin-tools-common/_internal/services/storage';
import {
  refreshFrameworkEnv,
  withAssetAccess,
} from '@microsoft/rayfin-tools-common/_internal/workflows/up';
import { Command } from 'commander';
import inquirer from 'inquirer';

import { ensureAuthenticated, loadAuthState } from '../../auth/index.js';
import { validateWorkspaceFlagSet } from '../../commands/init-helpers.js';
import {
  getFabricSettings,
  MONIKER_HEADER,
  resolveFabricPortalUrl,
} from '../../config/constants.js';
import { CliHandledError } from '../../errors.js';
import {
  createCliFrameworkEnvService,
  createCliStorageService,
} from '../../rayfin-services/index.js';
import { generateConnectorDabConfigs } from '../../services/connector-generator.js';
import { FabricApiClient } from '../../services/fabric/client.js';
import {
  RayfinItemManager,
  RayfinItemReuseDeclinedError,
} from '../../services/fabric/rayfin-item.js';
import { WorkspaceManager } from '../../services/fabric/workspace.js';
import { getAmbientWorkspaceId } from '../../utils/ambient-env.js';
import {
  loadRayfinConfig,
  resolveServiceRoot,
  resolveServiceSubpath,
} from '../../utils/config-utils.js';
import {
  applyConnectorConfigs,
  detectConnectorEntityCollisions,
  detectReservedConnectorEntityNames,
  formatConnectorEntityCollisionError,
  formatReservedConnectorEntityNameError,
  selectConnectorsToApply,
} from '../../utils/connector-apply.js';
import { applyConfigToServer } from '../../utils/dab-apply.js';
import { generateDabConfig } from '../../utils/dab-config-generator.js';
import {
  type DeploymentEnvVars,
  findExistingEnvFabricFiles,
  readDeploymentEnvFile,
  resolveDeploymentEnvFile,
  sanitizeWorkspaceName,
  writeDeploymentEnvFile,
} from '../../utils/env-fabric-utils.js';
import { createCliFeatureFlags } from '../../utils/feature-flags.js';
import { formatBytes } from '../../utils/format-utils.js';
import { ensureLocalDevRedirectUris } from '../../utils/frontend-dev-port.js';
import { persistHostingUrl } from '../../utils/hosting-url-utils.js';
import {
  type OutputMode,
  type ProgressIndicator,
  resolveOutputMode,
  resolveRootOutputFlags,
  isInteractive,
  createProgress,
  createOraProgressIndicator,
  createVerboseLogger,
  modeLog,
  modeError,
  modeWarn,
  emitJson,
  emitJsonError,
} from '../../utils/output-mode.js';
import {
  resolveDeclaredPackageVersions,
  resolveDeployPackageVersions,
} from '../../utils/package-versions.js';
import { findRayfinProjectRoot } from '../../utils/project-utils.js';
import { getPublishableKey } from '../../utils/publishable-key-utils.js';
import { resolveWorkspaceIdByName } from '../../utils/resolve-workspace-name.js';
import { HttpError, withRetry, RETRY_CONFIG } from '../../utils/retry-utils.js';
import {
  removeRuntimeConfigFile,
  writeRuntimeConfigFile,
} from '../../utils/runtime-config-file.js';
import { postRuntimeSettings } from '../../utils/runtime-settings.js';
import {
  validateStaticFolder,
  runStaticBuildCommand,
  packageStaticFolder,
  deployStaticContent,
  validateStaticHostingInputs,
} from '../../utils/static-hosting-utils.js';
import { resolveEffectiveTenantId } from '../../utils/tenant-resolution.js';

import { runAnonStaticPreflight } from './anonstatic-preflight-legacy.js';
import { describeAnonStaticPreflight } from './anonstatic-preflight-plan.js';
import { failUp, renderUpDryRun } from './render.js';
import { upConnectorCommand } from './up-connector.js';
import { upDbCommand } from './up-db.js';
import { deployFunctions, upFunctionsCommand } from './up-functions.js';
import { resolveItemName } from './up-item-name.js';
import { upListCommand } from './up-list.js';
import { upStaticappCommand } from './up-staticapp.js';
import { upStatusCommand } from './up-status.js';
import { upStorageCommand } from './up-storage.js';
import { upSwitchCommand } from './up-switch.js';
import { resolveLocalTargeting } from './up-v2-targeting.js';
import { runUpV2 } from './up-v2.js';

// `postRuntimeSettings` moved to `utils/runtime-settings.ts` so the v2 Fabric
// workload client and the legacy path share one connectors-merge source of
// truth. Re-exported here to preserve the historical import path.
export { postRuntimeSettings } from '../../utils/runtime-settings.js';

const featureFlags = createCliFeatureFlags(process.cwd(), { silent: true });

/**
 * Derive the top-level JSON `status` for a legacy `up` run. A deployment that
 * landed but left one or more connectors unapplied is a partial success, not a
 * clean deploy — automation branching on `.status` must be able to tell them
 * apart. Mirrors `resolveConnectorApplyStatus` in up-connector.ts.
 */
export function resolveUpStatus(
  failedConnectorNames: readonly string[]
): 'success' | 'partial' {
  return failedConnectorNames.length > 0 ? 'partial' : 'success';
}

export function resolveConnectorCollisionFailureState(
  blockedConnectorNames: readonly string[],
  generationFailureNames: readonly string[],
  collisionMessage: string
): {
  failedConnectorNames: string[];
  steps: Record<string, { duration: string; status: 'error'; error: string }>;
} {
  const failedConnectorNames = Array.from(
    new Set([...generationFailureNames, ...blockedConnectorNames])
  );
  const steps = Object.fromEntries(
    blockedConnectorNames.map((name) => [
      `connector:${name}`,
      { duration: '—', status: 'error' as const, error: collisionMessage },
    ])
  );
  return { failedConnectorNames, steps };
}

/**
 * Find an existing deployment record for a given workspace.
 * Tries by slugified display name first, then scans the registry by workspace ID.
 */
function resolveExistingDeployment(
  projectRoot: string,
  displayName: string,
  workspaceId: string
): DeploymentEnvVars | null {
  const slugifiedName = sanitizeWorkspaceName(displayName);
  return (
    readDeploymentEnvFile(projectRoot, slugifiedName) ??
    findExistingEnvFabricFiles(projectRoot)
      .map((f) => readDeploymentEnvFile(projectRoot, f.workspaceName))
      .find((d) => d?.fabricWorkspaceId === workspaceId) ??
    null
  );
}

/**
 * Creates a mode-aware progress indicator.
 * - interactive: ora spinner with emoji
 * - plain: writes `[rayfin up] <msg>... done (<dur>)` to stderr
 * - json: silent no-op (timing only)
 */
const showProgress = (
  message: string,
  emoji = '🔄',
  mode: OutputMode = 'interactive'
): ProgressIndicator => {
  if (mode !== 'interactive') {
    return createProgress(mode, message, { prefix: '[rayfin up]' });
  }
  return createOraProgressIndicator(message, emoji);
};

/**
 * Implements the 'up' command which:
 * 1. Resolves a Fabric workspace (default: "My Workspace" or --workspace-id)
 * 2. Creates a Rayfin item (AppBackend) in the workspace
 * 3. Applies runtime settings and DAB config to the workload endpoint
 * 4. Writes deployment metadata to rayfin/.deployments.json (and merges
 *    matching RAYFIN_PUBLIC_* values into rayfin/.env)
 */
export const up = () => {
  const cmd = new Command('up')
    .description('Deploy the application to Fabric as a Rayfin item')
    .option(
      '-t, --tenant <id>',
      'Entra ID tenant GUID. Use when your account spans multiple tenants'
    )
    .option(
      '-w, --workspace <name>',
      'Fabric workspace display name (resolved to ID via the Fabric API; defaults to "My Workspace" when omitted)'
    )
    .option(
      '--item-name <name>',
      'Fabric item display name (defaults to the project ID in rayfin.yml)'
    )
    .option('--workspace-id <id>', 'Fabric workspace GUID to deploy into')
    .option(
      '--capacity-id <id>',
      'ID of the Fabric capacity to assign when the target workspace has no usable capacity'
    )
    .option(
      '--workspace-uri <uri>',
      'Fabric portal workspace URL (e.g. https://app.fabric.microsoft.com/groups/<id>/list) — derives workspace ID and target environment from the URL'
    )
    .option(
      '--force',
      'Allow destructive data schema changes that may result in data loss',
      false
    )
    .option(
      '-n, --dry-run',
      'Validate local inputs and resolve the workspace without deploying or modifying resources'
    )
    .option(
      '--env-file <path>',
      "Defaults to rayfin/.env and contains Fabric app's properties",
      undefined
    )
    .option('-v, --verbose', 'Enable verbose output', false)
    .option('--json', 'Output deployment result as JSON', false)
    .option('-y, --yes', 'Auto-accept all confirmation prompts', false)
    .option(
      '--encryption-fallback-enabled',
      "Allow plaintext token storage when the OS keychain is unavailable (some Linux distros, dev containers, Codespaces). Equivalent to Az CLI's same-named fallback. Required only when login fails with a keychain error.",
      false
    )
    .option(
      '--exclude-services <names>',
      'Comma-separated list of services to skip during deployment (supported: staticHosting, functions). Runtime settings remain unchanged; only the build/package/deploy phase is skipped.'
    )
    .option(
      '--provider <provider>',
      'Deploy run-target provider (reserved; only "fabric" is supported today). Defaults to fabric.',
      'fabric'
    )
    .action(async (cmdOptions, command: Command) => {
      cmdOptions = { ...cmdOptions, ...command.optsWithGlobals() };
      // optsWithGlobals can return the local `false` default for --verbose /
      // --json even when the root flag is `true`. OR-merge with the root
      // command directly so `rayfin --verbose up` / `rayfin --json up` work.
      const root = resolveRootOutputFlags(command);
      cmdOptions.verbose = Boolean(cmdOptions.verbose) || root.verbose;
      cmdOptions.json = Boolean(cmdOptions.json) || root.json;
      cmdOptions.output = root.output;

      // `--provider` is reserved for the deploy run-target seam (#1361); only
      // `fabric` is supported today. Rejected here (before the dual-path split)
      // so both paths share the guard. Default `fabric` means existing
      // invocations are unaffected.
      if (
        cmdOptions.provider &&
        String(cmdOptions.provider).toLowerCase() !== 'fabric'
      ) {
        const mode = resolveOutputMode({
          json: cmdOptions.json,
          output: root.output,
        });
        const message = `Unsupported provider: ${cmdOptions.provider}. Only "fabric" is supported today.`;
        if (mode === 'json') {
          emitJsonError(mode, message);
        }
        modeError(mode, `❌ ${message}`);
        modeError(mode, '   Omit `--provider` or use `--provider fabric`.');
        throw new CliHandledError(new Error(message));
      }

      // The v2 (workflow) architecture is the default `up` path. The legacy
      // orchestration below is retained for a one-line revert ahead of the
      // stable release and is removed in migration Phase 2.4. `up-legacy` is an
      // internal, undocumented kill-switch (RAYFIN_FEATURE_FLAGS=up-legacy) that
      // falls back to the legacy path for emergency diagnosis without a
      // rebuild — it is not a user-facing opt-out.
      if (featureFlags.get('up-legacy') !== true) {
        return runUpV2(cmdOptions);
      }

      if (cmdOptions.capacityId) {
        const legacyMode = resolveOutputMode({
          json: cmdOptions.json,
          output: root.output,
        });
        const message =
          'Capacity targeting options are not available on the legacy deployment path.';
        if (legacyMode === 'json') {
          emitJsonError(legacyMode, message, {
            hint: 'Remove the up-legacy feature flag and rerun the command.',
          });
        }
        modeError(legacyMode, `❌ ${message}`);
        modeError(
          legacyMode,
          '   Remove the up-legacy feature flag and rerun the command.'
        );
        throw new CliHandledError(new Error(message));
      }

      const verbose = createVerboseLogger(cmdOptions.verbose);
      const mode = resolveOutputMode({
        json: cmdOptions.json,
        output: root.output,
      });
      // Annotated so the `mode !== 'json'` term does not narrow `mode` for the
      // rest of the function and make the defensive json branches unreachable.
      const interactive: boolean =
        mode !== 'json' && isInteractive({ yes: cmdOptions.yes });

      // Tracks the most recently entered major phase so the outer catch
      // can surface a step-specific retry tip when something throws.
      let failedStep: 'static' | 'functions' | undefined;
      let connectorApplyPending = false;
      let failedConnectorNames: string[] = [];

      // Path of the transient rayfin.config.json emitted for this deploy.
      // Written before the static build so the bundle picks it up, then
      // removed in the finally below so it is never left on disk — unless it
      // preexisted, in which case it is left untouched and reused as-is.
      let emittedRuntimeConfigPath: string | undefined;
      let emittedRuntimeConfigPreexisting = false;

      // Step timing tracker for JSON output
      const stepResults: Record<
        string,
        { duration: string; status: 'success' | 'error'; error?: string }
      > = {};
      const recordStep = (
        name: string,
        indicator: ProgressIndicator,
        status: 'success' | 'error' = 'success',
        error?: string
      ) => {
        stepResults[name] = {
          duration: indicator.getDurationStr(),
          status,
          ...(error ? { error } : {}),
        };
      };

      try {
        verbose('Command options:', JSON.stringify(cmdOptions, null, 2));
        verbose('Working directory:', process.cwd());

        // ── Parse and validate --exclude-services ─────────────────────
        // Only staticHosting and functions can be skipped currently. Toggle
        // auth/data/storage via the `enabled` field in `rayfin.yml`
        // instead — those go through the runtime settings POST, which we
        // intentionally leave untouched here so a transient
        // `--exclude-services` invocation never disables a service server-side.
        const ALLOWED_EXCLUDE_SERVICES = [
          'staticHosting',
          'functions',
        ] as const;
        const excludedServices = new Set<string>();
        if (typeof cmdOptions.excludeServices === 'string') {
          const raw = cmdOptions.excludeServices
            .split(/[,\s]+/)
            .map((s: string) => s.trim())
            .filter((s: string) => s.length > 0);
          for (const name of raw) {
            const canonical = ALLOWED_EXCLUDE_SERVICES.find(
              (allowed) => allowed.toLowerCase() === name.toLowerCase()
            );
            if (!canonical) {
              const msg = `Unknown service: ${name}. Allowed: ${ALLOWED_EXCLUDE_SERVICES.join(', ')}`;
              if (mode === 'json') {
                emitJsonError(mode, msg);
              }
              modeError(mode, `❌ ${msg}`);
              process.exit(1);
            }
            excludedServices.add(canonical);
          }
          if (excludedServices.size > 0) {
            verbose('Excluded services:', [...excludedServices].join(', '));
          }
        }

        // ── Validate workspace flag mutual exclusion ──────────────────
        const workspaceFlagErrors = validateWorkspaceFlagSet({
          workspace: cmdOptions.workspace,
          workspaceId: cmdOptions.workspaceId,
          workspaceUri: cmdOptions.workspaceUri,
        });
        if (workspaceFlagErrors.length > 0) {
          if (mode === 'json') {
            emitJsonError(mode, workspaceFlagErrors[0]);
          }
          for (const msg of workspaceFlagErrors) {
            modeError(mode, msg);
          }
          process.exit(1);
        }

        // ── Resolve --workspace-uri (if provided) ─────────────────────
        // Must happen BEFORE any call to getFabricSettings() so the
        // URI-derived API/portal URLs feed through as env var overrides.
        if (cmdOptions.workspaceUri) {
          try {
            const parsed = applyWorkspaceUriOverrides(cmdOptions.workspaceUri);
            if (parsed.isMyWorkspace) {
              modeLog(
                mode,
                `Parsed --workspace-uri: environment='${parsed.environment}', workspace='My workspace'`
              );
            } else {
              cmdOptions.workspaceId = parsed.workspaceId;
              modeLog(
                mode,
                `Parsed --workspace-uri: environment='${parsed.environment}', workspace=${parsed.workspaceId}`
              );
            }
            verbose('URI-derived fabric API URL:', parsed.fabricApiBaseUrl);
            verbose('URI-derived fabric portal URL:', parsed.fabricPortalUrl);
          } catch (err) {
            if (mode === 'json') {
              emitJsonError(mode, (err as Error).message);
            }
            modeError(mode, `${(err as Error).message}`);
            process.exit(1);
          }
        }

        const fabricSettings = getFabricSettings();
        verbose(
          'Fabric API base URL (standard):',
          fabricSettings.fabricApiBaseUrl
        );
        verbose('Item type:', fabricSettings.itemType);
        verbose('Workload ID:', fabricSettings.workloadId);

        // Enable verbose logging on the Fabric API client layer
        if (cmdOptions.verbose) {
          FabricApiClient.enableVerbose();
        }

        // ── Load project config ───────────────────────────────────────
        verbose('Loading rayfin.yml config...');
        const rayfinConfig = loadRayfinConfig(undefined, {
          envFile: cmdOptions.envFile,
          command: 'up',
          silent: mode === 'json',
        });

        if (!rayfinConfig?.id) {
          if (mode === 'json') {
            emitJsonError(
              mode,
              'Project name not found in rayfin.yml configuration'
            );
          }
          modeError(
            mode,
            '❌ Project name not found in rayfin.yml configuration'
          );
          modeError(
            mode,
            "   Please ensure you have a rayfin.yml file with a project 'id' field"
          );
          modeError(
            mode,
            "   Run 'rayfin init' to create a new project configuration"
          );
          throw new CliHandledError(
            new Error('Project name not found in rayfin.yml configuration')
          );
        }

        const [dependencyError] = validateServiceDependencies({
          dataEnabled: rayfinConfig.services.data.enabled === true,
          storageEnabled: rayfinConfig.services.storage?.enabled === true,
        });
        if (dependencyError) {
          if (mode === 'json') {
            emitJsonError(mode, dependencyError.message, {
              hint: dependencyError.hint,
            });
          }
          modeError(mode, `❌ ${dependencyError.message}`);
          modeError(mode, `   ${dependencyError.hint}`);
          throw new CliHandledError(new Error(dependencyError.message));
        }

        const functionsErrors = validateFunctionsConfig(
          rayfinConfig.services.functions
        );
        if (functionsErrors.length > 0) {
          const message =
            'functions block in rayfin.yml has validation errors:\n' +
            functionsErrors
              .map((error) => `  • ${error.field}: ${error.message}`)
              .join('\n');
          if (mode === 'json') {
            emitJsonError(mode, message, { code: 'invalid-functions-config' });
          }
          modeError(mode, message);
          throw new CliHandledError(message);
        }

        const projectName = rayfinConfig.id;
        const explicitItemName =
          typeof cmdOptions.itemName === 'string'
            ? cmdOptions.itemName.trim()
            : undefined;
        if (cmdOptions.itemName !== undefined && !explicitItemName) {
          const message =
            'Fabric item name cannot be empty.\n' +
            '   Pass a non-empty value with --item-name <name>.';
          if (mode === 'json') {
            emitJsonError(mode, message);
          }
          modeError(mode, `❌ ${message}`);
          throw new CliHandledError(new Error(message));
        }
        let itemName = explicitItemName ?? projectName;
        verbose(
          'Full rayfin.yml config:',
          JSON.stringify(rayfinConfig, null, 2)
        );

        if ((rayfinConfig.connectors?.length ?? 0) > 0) {
          connectorApplyPending = true;
        }

        const anonStaticEnabled =
          featureFlags.get('cli-up-anonstatic') === true;

        // Resolved unconditionally: posture onboarding needs it only behind the
        // flag, but the `packageVersions` declaration is not flag-gated.
        const preflightProjectRoot = findRayfinProjectRoot(process.cwd(), {
          verbose: false,
          silent: true,
        });

        const preflight = cmdOptions.dryRun
          ? describeAnonStaticPreflight(
              rayfinConfig,
              preflightProjectRoot,
              anonStaticEnabled,
              interactive
            )
          : [];
        let dryRunWarnings: string[] = [];
        if (cmdOptions.dryRun) {
          const localTargeting = resolveLocalTargeting(
            cmdOptions,
            preflightProjectRoot,
            interactive
          );
          const recordedNameUnknown =
            Boolean(localTargeting.existingDeployment?.rayfinItemId) &&
            !localTargeting.existingDeployment?.rayfinItemName;
          itemName = resolveItemName({
            explicitItemName,
            recordedItemName: localTargeting.existingDeployment?.rayfinItemName,
            hasRecordedItemId: false,
            fallbackItemName: projectName,
            mode,
          });
          dryRunWarnings = [...localTargeting.warnings];
          if (recordedNameUnknown) {
            dryRunWarnings.push(
              'The recorded deployment predates item-name tracking. Its current Fabric item name will be resolved during deployment.'
            );
          }
          for (const warning of dryRunWarnings) {
            modeWarn(mode, warning);
          }
          if (
            rayfinConfig.services.staticHosting?.enabled &&
            !excludedServices.has('staticHosting')
          ) {
            validateStaticHostingInputs(
              preflightProjectRoot,
              rayfinConfig.services.staticHosting
            );
          }
          if (preflight.some((entry) => entry.blocking)) {
            renderUpDryRun(
              rayfinConfig,
              itemName,
              excludedServices.has('staticHosting'),
              excludedServices.has('functions'),
              (rayfinConfig.connectors?.length ?? 0) > 0,
              mode,
              dryRunWarnings,
              resolveDeclaredPackageVersions(
                preflightProjectRoot,
                rayfinConfig.services
              ),
              preflight
            );
          }
        } else {
          const anonStaticPreflight = await runAnonStaticPreflight({
            config: rayfinConfig,
            projectRoot: preflightProjectRoot,
            mode,
            interactive,
            enabled: anonStaticEnabled,
          });
          if (anonStaticPreflight.status === 'failed') {
            if (mode === 'json') {
              emitJsonError(mode, anonStaticPreflight.message);
            }
            modeError(mode, `❌ ${anonStaticPreflight.message}`);
            throw new CliHandledError(new Error(anonStaticPreflight.message));
          }
          rayfinConfig.services = withAssetAccess(
            rayfinConfig.services,
            anonStaticPreflight.assetAccess
          );
        }

        // ── Authenticate ──────────────────────────────────────────────
        verbose('Acquiring Fabric token via MSAL...');
        const fabricToken = await ensureAuthenticated(undefined, {
          tenantId: cmdOptions.tenant,
          encryptionFallbackEnabled: cmdOptions.encryptionFallbackEnabled,
          silent: mode === 'json',
        });

        verbose('Fabric token acquired successfully');
        verbose(
          'Token expires on:',
          fabricToken.expiresOnTimestamp
            ? new Date(fabricToken.expiresOnTimestamp).toISOString()
            : 'unknown'
        );
        verbose('Token length:', fabricToken.token.length);
        verbose('Token prefix:', fabricToken.token.substring(0, 20) + '...');

        verbose('Creating WorkspaceManager and RayfinItemManager...');
        const workspaceManager = new WorkspaceManager(fabricToken.token);
        const rayfinItemManager = new RayfinItemManager(fabricToken.token);
        verbose(
          'Auth header being used:',
          rayfinItemManager.getAuthorizationHeader().substring(0, 40) + '...'
        );

        // ── Resolve project root (needed for env files) ────────────────
        const projectRoot = findRayfinProjectRoot(process.cwd(), {
          verbose: false,
          silent: true,
        });

        // ── Resolve --workspace (display name → ID) ───────────────────
        // Reuse the just-acquired fabric token so we don't re-prompt;
        // mutex with --workspace-id / --workspace-uri was enforced
        // earlier via validateWorkspaceFlagSet.
        if (cmdOptions.workspace && !cmdOptions.workspaceId) {
          try {
            const resolved = await resolveWorkspaceIdByName(
              cmdOptions.workspace,
              { token: fabricToken.token }
            );
            cmdOptions.workspaceId = resolved.id;
            modeLog(
              mode,
              `🏢 Resolved workspace "${resolved.displayName}" → ${resolved.id}`
            );
          } catch (err) {
            if (mode === 'json') {
              emitJsonError(mode, (err as Error).message);
            }
            modeError(mode, `❌ ${(err as Error).message}`);
            process.exit(1);
          }
        }

        // ── Resolve workspace ─────────────────────────────────────────
        let workspaceId: string;
        let workspaceDisplayName: string;
        let existingDeployment: DeploymentEnvVars | null = null;

        const envWorkspaceId = getAmbientWorkspaceId();
        if (cmdOptions.workspaceId) {
          // Explicit --workspace-id: validate via API (takes precedence over env)
          verbose('Fetching workspace by ID:', cmdOptions.workspaceId);
          verbose(
            'GET (standard API)',
            `${getFabricSettings().fabricApiBaseUrl}/workspaces/${cmdOptions.workspaceId}`
          );
          const workspace = await workspaceManager.getWorkspace(
            cmdOptions.workspaceId
          );
          workspaceId = workspace.id;
          workspaceDisplayName = workspace.displayName;
          verbose('Workspace response:', JSON.stringify(workspace, null, 2));
          modeLog(
            mode,
            `🏢 Using workspace "${workspace.displayName}" (ID: ${workspaceId})`
          );

          // Look for a matching env file for this workspace
          existingDeployment = resolveExistingDeployment(
            projectRoot,
            workspaceDisplayName,
            workspaceId
          );
        } else if (envWorkspaceId) {
          // RAYFIN_WORKSPACE_ID ambient env var
          verbose(
            'Using workspace ID from RAYFIN_WORKSPACE_ID:',
            envWorkspaceId
          );
          const workspace = await workspaceManager.getWorkspace(envWorkspaceId);
          workspaceId = workspace.id;
          workspaceDisplayName = workspace.displayName;
          modeLog(
            mode,
            `Using workspace "${workspace.displayName}" (ID: ${workspaceId}) [from RAYFIN_WORKSPACE_ID]`
          );

          existingDeployment = resolveExistingDeployment(
            projectRoot,
            workspaceDisplayName,
            workspaceId
          );
        } else {
          // No --workspace-id or env var: check the deployment registry first
          const resolved = await resolveDeploymentEnvFile({
            projectRoot,
            nonInteractive: !interactive,
          });

          if (resolved) {
            // Have an existing deployment — resolve the workspace from it
            existingDeployment = resolved.deployment;
            workspaceId = resolved.deployment.fabricWorkspaceId;
            verbose(
              'Resolved workspace from deployment registry:',
              workspaceId,
              `(${resolved.workspaceName})`
            );

            // Fetch workspace details (display name)
            const workspace = await workspaceManager.getWorkspace(workspaceId);
            workspaceDisplayName = workspace.displayName;
            modeLog(
              mode,
              `🏢 Using workspace "${workspace.displayName}" (ID: ${workspaceId})`
            );
          } else {
            // Without a recorded deployment, prompt interactive users for a workspace;
            // non-interactive callers must pass explicit targeting flags.
            if (!interactive) {
              const msg =
                'No workspace targeting context. Pass --workspace <name> (or --workspace-id <id> / --workspace-uri <url>), or run `rayfin up` once interactively to record a deployment.';
              if (mode === 'json') {
                emitJsonError(mode, msg);
              }
              modeError(mode, `❌ ${msg}`);
              throw new CliHandledError(new Error(msg));
            }

            const { promptedWorkspace } = await inquirer.prompt<{
              promptedWorkspace: string;
            }>([
              {
                type: 'input',
                name: 'promptedWorkspace',
                message: 'Enter a Fabric workspace name to deploy to:',
                validate: (val: string) =>
                  val.trim().length > 0 || 'Workspace name is required.',
              },
            ]);
            try {
              const resolved = await resolveWorkspaceIdByName(
                promptedWorkspace.trim(),
                { token: fabricToken.token }
              );
              workspaceId = resolved.id;
              workspaceDisplayName = resolved.displayName;
              modeLog(
                mode,
                `🏢 Resolved workspace "${resolved.displayName}" → ${resolved.id}`
              );
              existingDeployment = resolveExistingDeployment(
                projectRoot,
                workspaceDisplayName,
                workspaceId
              );
            } catch (err) {
              if (mode === 'json') {
                emitJsonError(mode, (err as Error).message);
              }
              modeError(mode, `❌ ${(err as Error).message}`);
              throw new CliHandledError(err);
            }
          }
        }

        let recordedItemName = existingDeployment?.rayfinItemName;
        const recordedItemId = existingDeployment?.rayfinItemId;
        if (recordedItemId && !recordedItemName) {
          const recordedItem = await rayfinItemManager.getFabricItemById(
            workspaceId,
            recordedItemId
          );
          if (!recordedItem) {
            const message =
              `The recorded Fabric item ${recordedItemId} no longer exists in workspace "${workspaceDisplayName}".\n` +
              '   Remove the stale deployment record or deploy to a different workspace.';
            if (mode === 'json') {
              emitJsonError(mode, message);
            }
            modeError(mode, `❌ ${message}`);
            throw new CliHandledError(new Error(message));
          }
          recordedItemName = recordedItem.displayName;
        }
        itemName = resolveItemName({
          explicitItemName,
          recordedItemName,
          hasRecordedItemId: Boolean(recordedItemId),
          fallbackItemName: projectName,
          mode,
          workspaceDisplayName,
        });

        if (cmdOptions.dryRun) {
          renderUpDryRun(
            rayfinConfig,
            itemName,
            excludedServices.has('staticHosting'),
            excludedServices.has('functions'),
            (rayfinConfig.connectors?.length ?? 0) > 0,
            mode,
            dryRunWarnings,
            resolveDeclaredPackageVersions(
              preflightProjectRoot,
              rayfinConfig.services
            ),
            preflight,
            undefined,
            { id: workspaceId, displayName: workspaceDisplayName }
          );
          return;
        }

        modeLog(
          mode,
          recordedItemName
            ? `📋 Using recorded Fabric item name '${itemName}'`
            : explicitItemName
              ? `📋 Using Fabric item name '${itemName}' from --item-name`
              : `📋 Using Fabric item name '${itemName}' from rayfin.yml configuration`
        );

        modeLog(mode, `\n🚀 Deploying item "${itemName}" to Fabric...\n`);

        // ── Create or reuse Rayfin item ───────────────────────────────
        let rayfinItemId: string;

        const existingItemId = existingDeployment?.rayfinItemId;
        verbose(
          'Existing deployment from registry:',
          JSON.stringify(existingDeployment ?? null, null, 2)
        );

        if (existingItemId) {
          // Redeployment — item ID recovered from env file
          modeLog(
            mode,
            `♻️  Redeployment detected — reusing Rayfin item ${existingItemId}`
          );
          rayfinItemId = existingItemId;
        } else {
          // Don't wrap in a spinner immediately — getOrCreateRayfinItem
          // may prompt the user interactively (inquirer) when an item
          // with the same name already exists. An active ora spinner
          // overwrites the prompt line, making it invisible.
          try {
            const item = await rayfinItemManager.getOrCreateRayfinItem(
              workspaceId,
              itemName,
              {
                nonInteractive: !interactive,
                confirmReuse: cmdOptions.yes === true,
                workspaceDisplayName,
              }
            );
            rayfinItemId = item.id;
            modeLog(mode, `✔ Rayfin item ready (ID: ${rayfinItemId})`);
          } catch (error) {
            if (error instanceof RayfinItemReuseDeclinedError) {
              if (mode === 'json') {
                emitJson({
                  status: 'cancelled',
                  reason: 'reuse-declined',
                  message: error.message,
                });
              } else {
                modeLog(mode, `\n${error.message}`);
              }
              return;
            }
            modeError(
              mode,
              `✖ Failed to create Rayfin item: ${(error as Error).message}`
            );
            throw error;
          }
        }

        const authorizationHeader = rayfinItemManager.getAuthorizationHeader();
        verbose(
          'Auth header prefix:',
          authorizationHeader.substring(0, 30) + '...'
        );

        // Print resolved target details before remote writes; JSON mode returns
        // this in the final payload, and dry-run has its own preview.
        if (mode !== 'json') {
          const tenantForBanner =
            cmdOptions.tenant ?? (await loadAuthState())?.tenantId;
          modeLog(mode, '\n📍 Targeting:');
          modeLog(
            mode,
            `   Fabric API:  ${getFabricSettings().fabricApiBaseUrl}`
          );
          if (tenantForBanner) {
            modeLog(mode, `   Tenant:      ${tenantForBanner}`);
          }
          modeLog(
            mode,
            `   Workspace:   ${workspaceDisplayName} (${workspaceId})`
          );
          modeLog(mode, `   Item:        ${itemName} (${rayfinItemId})\n`);
        }

        // ── Construct workload endpoint ───────────────────────────────
        verbose(
          'Constructing workload endpoint for workspace:',
          workspaceId,
          'item:',
          rayfinItemId
        );
        const itemEndpoint = rayfinItemManager.getRayfinItemEndpoint(
          workspaceId,
          rayfinItemId
        );
        verbose('Fabric API endpoint:', itemEndpoint);

        // ── Resolve BaaS endpoint via extended properties ─────────────
        const extendedProps = await rayfinItemManager.getExtendedProperties(
          workspaceId,
          rayfinItemId
        );
        const baasEndpoint = extendedProps.BaaSEndpoint;
        verbose('BaaS endpoint:', baasEndpoint);
        modeLog(mode, `🔗 Workload endpoint: ${baasEndpoint}`);
        verbose('Full endpoint URL:', itemEndpoint);

        // ── Retrieve publishable key ──────────────────────────────────
        let publishableKey = '';
        const keySpinner = showProgress(
          'Retrieving publishable key',
          '🔑',
          mode
        );
        verbose('Authorization header length:', authorizationHeader.length);
        try {
          publishableKey = await getPublishableKey(itemEndpoint, rayfinItemId, {
            authorizationHeader,
            verbose,
          });
          keySpinner.succeed('Publishable key retrieved');
        } catch (error) {
          keySpinner.fail(
            `Publishable key fetch failed: ${(error as Error).message}`
          );
          throw error;
        }

        // ── POST runtime settings ─────────────────────────────────────
        // Allow-list the local frontend's stable dev-server origin so
        // sign-ins from a locally-run frontend against this deployed
        // backend succeed. The preferred port is persisted in `rayfin/.env`
        // (mapped to `VITE_PORT`) and replaced when occupied; prior occupied
        // ports remain temporarily allow-listed for already-running frontends.
        // Auth-gated and non-fatal: a failure here doesn't block deployment.
        rayfinConfig.services = await ensureLocalDevRedirectUris(
          rayfinConfig.services,
          join(projectRoot, 'rayfin'),
          (message) =>
            verbose(
              `[redirect-uris] Failed to ensure local dev origin: ${message}`
            )
        );

        const settingsSpinner = showProgress(
          'Applying runtime settings',
          '⚙️',
          mode
        );
        try {
          // Validate connectors block locally before sending to the workload,
          // so Builders get actionable errors (unknown type, bad version, etc.)
          // at `rayfin up` time rather than a cryptic server-side rejection.
          const connectorErrors = validateConnectors(rayfinConfig.connectors);
          if (connectorErrors.length > 0) {
            const summary = connectorErrors
              .map((e) => `  • ${e.sourceName}: ${e.message}`)
              .join('\n');
            throw new CliHandledError(
              `connectors block in rayfin.yml has validation errors:\n${summary}`
            );
          }
          await postRuntimeSettings(
            itemEndpoint,
            rayfinConfig.services,
            authorizationHeader,
            verbose,
            'runtime-settings',
            { [MONIKER_HEADER]: rayfinItemId },
            rayfinConfig.connectors,
            resolveDeployPackageVersions(projectRoot, rayfinConfig.services)
          );
          settingsSpinner.succeed('Runtime settings applied');
          recordStep('settings', settingsSpinner);
        } catch (error) {
          verbose('[runtime-settings] Error:', (error as Error).message);
          verbose('[runtime-settings] Stack:', (error as Error).stack);
          recordStep(
            'settings',
            settingsSpinner,
            'error',
            (error as Error).message
          );
          settingsSpinner.fail(
            `Runtime settings failed: ${(error as Error).message}`
          );
          throw error;
        }

        // ── Apply DAB config ──────────────────────────────────────────
        if (rayfinConfig.services.data.enabled) {
          modeLog(mode, '\n🗄️  Applying database configuration...');
          verbose(
            '[dab] Data service enabled, dialect:',
            rayfinConfig.services.data.dialect || 'mssql'
          );

          const dbSpinner = showProgress(
            'Generating database configuration',
            '⚙️',
            mode
          );
          try {
            verbose('[dab] Generating DAB config...');
            const dabResult = await generateDabConfig({
              dialect: rayfinConfig.services.data.dialect || 'mssql',
              verbose: cmdOptions.verbose,
              serviceRoot: resolveServiceRoot(
                projectRoot,
                'data',
                rayfinConfig.services.data.path ?? '.'
              ),
              buildCommand: rayfinConfig.services.data.buildCommand,
            });

            if (dabResult.entities.length === 0) {
              dbSpinner.succeed(
                'No entity classes found — skipping database configuration'
              );
              recordStep('dbConfigGen', dbSpinner);
            }

            if (dabResult.entities.length > 0) {
              verbose('[dab] Generated config path:', dabResult.configPath);
              dbSpinner.succeed(
                `Database configuration generated: ${dabResult.configPath}`
              );
              recordStep('dbConfigGen', dbSpinner);

              const applySpinner = showProgress(
                'Applying configuration to workload',
                '📡',
                mode
              );

              const applyEndpoint = `${itemEndpoint}/__private/applyconfig`;
              verbose('[dab] Apply endpoint:', applyEndpoint);

              try {
                await withRetry(
                  async () => {
                    verbose(`[dab] force=${cmdOptions.force}`);
                    await applyConfigToServer(
                      dabResult.configPath,
                      applyEndpoint,
                      cmdOptions.force,
                      true,
                      authorizationHeader,
                      { [MONIKER_HEADER]: rayfinItemId }
                    );
                  },
                  {
                    label: 'dab',
                    verbose,
                    shouldRetry: (error) => {
                      // Destructive schema changes are not transient — stop immediately
                      if (
                        !cmdOptions.force &&
                        error.message.toLowerCase().includes('destructive')
                      ) {
                        return false;
                      }
                      // Deterministic client errors (HTTP 4xx) fail identically
                      // on every attempt — fail fast instead of burning the full
                      // backoff budget. 408, 425, and 429 are the transient 4xx
                      // and are still retried.
                      if (error instanceof HttpError) {
                        if ([408, 425, 429].includes(error.statusCode))
                          return true;
                        if (error.statusCode >= 400 && error.statusCode < 500) {
                          return false;
                        }
                      }
                      return true;
                    },
                    onRetry: (attempt, delay) => {
                      modeLog(
                        mode,
                        `⏳ Waiting ${delay / 1000}s before retry... (${attempt}/${RETRY_CONFIG.maxAttempts})`
                      );
                    },
                  }
                );
                applySpinner.succeed(
                  'Database configuration applied successfully'
                );
                recordStep('dbConfig', applySpinner);
              } catch (error) {
                const msg = (error as Error).message;
                recordStep('dbConfig', applySpinner, 'error', msg);
                if (
                  !cmdOptions.force &&
                  msg.toLowerCase().includes('destructive')
                ) {
                  applySpinner.fail('Destructive schema changes detected');
                  modeError(mode, `\n${msg}`);
                  modeError(
                    mode,
                    '\nUse --force to apply destructive changes. This may result in data loss.'
                  );
                  if (mode === 'json') {
                    emitJsonError(mode, msg, {
                      step: 'dbConfig',
                      partialResult: {
                        rayfinItemId,
                        fabricWorkspaceId: workspaceId,
                        rayfinApiUrl: baasEndpoint,
                      },
                      steps: stepResults,
                    });
                  }
                  throw new CliHandledError(error);
                }
                applySpinner.fail(`Database apply failed: ${msg}`);
                modeWarn(
                  mode,
                  "💡 You can manually run 'rayfin up db apply' after the workload is ready"
                );
              }
            }
          } catch (error) {
            recordStep(
              'dbConfigGen',
              dbSpinner,
              'error',
              (error as Error).message
            );
            dbSpinner.fail(
              `Database configuration failed: ${(error as Error).message}`
            );
            modeWarn(
              mode,
              "💡 You can manually run 'rayfin up db apply' after the workload is ready"
            );
          }
        }

        // ── Apply storage config ──────────────────────────────────────
        if (rayfinConfig.services.storage?.enabled === true) {
          modeLog(mode, '\n📦 Applying storage configuration...');
          const storageSpinner = showProgress(
            'Generating and applying storage configuration',
            '📦',
            mode
          );
          try {
            await createCliStorageService({
              verbose: cmdOptions.verbose,
            }).applyStorageConfig({
              projectRoot,
              target: {
                itemId: rayfinItemId,
                itemEndpoint,
                baasEndpoint,
                authorizationHeader,
              },
              force: cmdOptions.force,
            });
            storageSpinner.succeed(
              'Storage configuration applied successfully'
            );
            recordStep('storageConfig', storageSpinner);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            recordStep('storageConfig', storageSpinner, 'error', message);
            if (
              isStorageApplyError(error) &&
              (error.status === 409 || error.code === 'removal-blocked')
            ) {
              storageSpinner.fail('Storage configuration changes blocked');
              modeError(mode, `\n${message}`);
              modeError(
                mode,
                '\nUse --force to apply storage changes that may result in data loss.'
              );
              throw new CliHandledError(error);
            }
            storageSpinner.fail(`Storage apply failed: ${message}`);
            modeWarn(
              mode,
              "💡 You can retry with 'rayfin up storage apply' after the workload is ready"
            );
          }
        }

        // ── Apply connector configs ───────────────────────────────────
        // Two-step pipeline: generate `rayfin/.temp/connectors/<name>/dab-config.json`
        // for each declared connector, then POST each to the workload.
        // Non-fatal; skipped when the project declares no connectors.
        if ((rayfinConfig.connectors?.length ?? 0) > 0) {
          const connectorList = rayfinConfig.connectors ?? [];
          const connectorNames = connectorList.map((c) => c.name);

          try {
            modeLog(mode, '\n🧬 Generating connector configs...');
            const generateOutcome = await generateConnectorDabConfigs({
              projectRoot,
              connectors: connectorList,
              connectorNames,
              verbose: cmdOptions.verbose,
              mode,
            });

            const generateFailures = generateOutcome.results.filter(
              (r) => r.status === 'error'
            );
            for (const failure of generateFailures) {
              // Namespace per-connector step keys so a connector named
              // `connectors`, `static`, or `functions` cannot overwrite a
              // real deploy step. Matches the `connector:<name>` keys the
              // apply step already emits.
              stepResults[`connector:${failure.name}`] = {
                duration: '—',
                status: 'error',
                error:
                  failure.error ??
                  failure.reason ??
                  'Connector config generation failed.',
              };
            }

            // Apply only connectors with a freshly generated config (plus
            // non-GraphQL Cat-B skips). A GraphQL connector that errored or
            // was skipped during generation is excluded so a stale on-disk
            // dab-config.json is never redeployed.
            const connectorsToApply = selectConnectorsToApply(
              connectorList,
              generateOutcome.generated
            );

            // Validate only configs that will be POSTed. Other .temp configs
            // may be stale after a generation skip/failure; the workload
            // remains authoritative for already deployed connectors.
            const applyNames = connectorsToApply.map((entry) => entry.name);
            const reserved = detectReservedConnectorEntityNames(
              projectRoot,
              applyNames
            );
            const collisions = detectConnectorEntityCollisions(
              projectRoot,
              applyNames
            );
            const blockMessage =
              reserved.length > 0
                ? formatReservedConnectorEntityNameError(reserved)
                : collisions.length > 0
                  ? formatConnectorEntityCollisionError(collisions)
                  : undefined;
            if (blockMessage) {
              const blockedFailureState = resolveConnectorCollisionFailureState(
                applyNames,
                generateFailures.map((result) => result.name),
                blockMessage
              );
              failedConnectorNames = blockedFailureState.failedConnectorNames;
              Object.assign(stepResults, blockedFailureState.steps);
              modeWarn(mode, `\n⚠️  ${blockMessage}`);
            } else {
              modeLog(mode, '\n🔌 Applying connector configurations...');
              const connectorOutcome = await applyConnectorConfigs({
                itemEndpoint,
                rayfinItemId,
                authorizationHeader,
                projectRoot,
                connectors: connectorsToApply,
                mode,
                verbose,
                context: 'inline',
                showProgress: (message, emoji) =>
                  showProgress(message, emoji, mode),
              });
              for (const [name, step] of Object.entries(
                connectorOutcome.steps
              )) {
                stepResults[name] = step;
              }

              const applyFailures = connectorOutcome.results
                .filter((r) => r.status === 'error')
                .map((r) => r.name);

              // Merge generation + apply failures (deduped) so every failed
              // connector surfaces in the summary and JSON output.
              failedConnectorNames = Array.from(
                new Set([
                  ...generateFailures.map((r) => r.name),
                  ...applyFailures,
                ])
              );
            }

            // Surface the failure summary inline (not only in the final
            // success block) so it is visible even when a later step such
            // as the static deploy throws and unwinds before success output.
            // A blocked run is skipped: retrying re-runs the same local
            // validation and fails identically until the config is fixed.
            if (!blockMessage && failedConnectorNames.length > 0) {
              const [summaryLine, ...retryLines] =
                formatFailedConnectorsRetryTip(failedConnectorNames);
              modeWarn(mode, `\n⚠️  ${summaryLine}`);
              for (const line of retryLines) {
                modeWarn(mode, `   ${line}`);
              }
            }
          } catch (connectorError) {
            // Defensive: the helper already swallows per-connector errors.
            // An exception here means the generator (e.g. tsc) failed, so no
            // connector was applied. Record the failure in the structured
            // result — `modeWarn` is suppressed in JSON mode, so without this
            // a scripted caller would otherwise receive `status: "success"`
            // despite the connectors never being applied.
            const connectorMessage = (connectorError as Error).message;
            modeWarn(
              mode,
              `⚠️  Connector apply step failed: ${connectorMessage}`
            );
            modeWarn(
              mode,
              "💡 You can manually run 'rayfin up connector apply' after the workload is ready, or target a single connector with 'rayfin up connector apply --name <connector_name>'"
            );
            failedConnectorNames = [...connectorNames];
            stepResults['connectors'] = {
              duration: '—',
              status: 'error',
              error: `Connector apply step failed: ${connectorMessage}`,
            };
          }

          connectorApplyPending = false;
        }

        // ── Persist deployment metadata (before static build so Vite can read it) ──
        const portalBase = resolveFabricPortalUrl({
          configuredPortalUrl: process.env.RAYFIN_FABRIC_PORTAL_URL,
          backendUrl: baasEndpoint,
          hostingUrl: existingDeployment?.hostingUrl,
        }).replace(/\/+$/, '');

        // Resolve tenant ID for the portal URL.  When the workspace lives
        // in a different Entra ID tenant the portal needs a `ctid` query
        // parameter so the auth popup targets the correct tenant.
        const authState = await loadAuthState();
        const effectiveTenantId = resolveEffectiveTenantId(
          cmdOptions.tenant,
          authState?.tenantId
        );

        // If a deployment for this workspace already exists with a different
        // recorded tenant, surface a warning.  Silently re-stamping the
        // record with the current login's tenant would mask multi-tenant
        // misconfiguration.
        const priorDeployment = readDeploymentEnvFile(
          projectRoot,
          workspaceDisplayName
        );
        if (
          priorDeployment?.fabricTenantId &&
          effectiveTenantId &&
          priorDeployment.fabricTenantId !== effectiveTenantId
        ) {
          modeWarn(
            mode,
            `\n⚠️  Workspace was previously deployed against tenant` +
              ` ${priorDeployment.fabricTenantId}, but the current` +
              ` sign-in is in tenant ${effectiveTenantId}.`
          );
          modeWarn(
            mode,
            `   Pass \`--tenant ${priorDeployment.fabricTenantId}\` or run` +
              ` \`rayfin login --tenant ${priorDeployment.fabricTenantId}\`` +
              ` if this was unintended.`
          );
        }

        const fabricDeepLink = composeFabricItemDeepLink(
          portalBase,
          workspaceId,
          rayfinItemId,
          effectiveTenantId ?? undefined
        );
        const isStaticHostingDeployExcluded =
          rayfinConfig.services.staticHosting?.enabled === true &&
          excludedServices.has('staticHosting');
        const retainedStaticHostingUrl = isStaticHostingDeployExcluded
          ? existingDeployment?.hostingUrl
          : undefined;

        // Resolve workspace display name for the env file (already fetched above)
        const envFilePath = await writeDeploymentEnvFile(
          projectRoot,
          workspaceDisplayName,
          {
            rayfinItemId,
            rayfinItemName: itemName,
            rayfinApiUrl: baasEndpoint,
            fabricWorkspaceId: workspaceId,
            fabricTenantId: effectiveTenantId ?? undefined,
            publishableKey: publishableKey || undefined,
            // Bare portal origin; ctid is appended at deep-link composition
            // time inside the registry helper so the marker
            // `/groups/<wsId>/appbackends/` consumed by `extractPortalUrl`
            // remains parseable.
            fabricPortalUrl: portalBase,
            hostingUrl: retainedStaticHostingUrl,
          }
        );

        modeLog(mode, `\n✅ Wrote deployment config to ${envFilePath}`);

        // Warn when other workspaces already have deployments registered.
        // Compare by sanitized workspace name — the registry no longer has
        // per-file paths so the legacy `fullPath` comparison always
        // mismatches and would falsely flag every entry as "other".
        const activeWorkspaceKey = sanitizeWorkspaceName(workspaceDisplayName);
        const otherEnvFiles = findExistingEnvFabricFiles(projectRoot).filter(
          (f) => f.workspaceName !== activeWorkspaceKey
        );
        if (otherEnvFiles.length > 0) {
          modeLog(
            mode,
            `\n⚠️  Other workspace deployments registered: ${otherEnvFiles.map((f) => f.workspaceName).join(', ')}`
          );
        }

        // ── Refresh framework .env.local before the static build ─────
        // The build command (e.g. Vite) reads `.env.local`, not the
        // deployment registry. Regenerate it here — after the new
        // deployment values have been merged into `rayfin/.env` by
        // `writeDeploymentEnvFile` — so the produced bundle embeds the
        // current deployment's item id, API URL, and publishable key.
        // Without this the bundle is built from stale values left over
        // from a prior deployment and the served frontend talks to a
        // backend that no longer exists.
        {
          const envResult = await refreshFrameworkEnv(
            {
              projectRoot,
              staticHosting: rayfinConfig.services.staticHosting?.enabled
                ? rayfinConfig.services.staticHosting
                : undefined,
            },
            { frameworkEnv: createCliFrameworkEnvService() }
          );
          if (envResult.status === 'refreshed') {
            modeLog(
              mode,
              `✅ ${envResult.framework} detected - refreshed ${envResult.path} before build.`
            );
          } else if (envResult.status === 'failed') {
            modeWarn(
              mode,
              `⚠️  Could not refresh framework .env.local before build: ${envResult.message}`
            );
          } else if (rayfinConfig.services.staticHosting?.enabled) {
            modeWarn(
              mode,
              '⚠️  staticHosting is enabled but no frontend framework could be auto-detected.\n' +
                '   To generate .env.local manually: rayfin env --framework <vite|nextjs|plain>'
            );
          }
        }

        // ── Write public/rayfin.config.json before static build ───────
        // Written into public/ so the static build bundles it alongside the
        // deployed app. The served SPA fetches it at runtime via
        // loadRayfinConfig(), which wins over the baked VITE_* values, so the
        // deployment always talks to this backend. Values come from the
        // resolved item metadata (endpoint, workspace, item id, portal, key).
        // Removed after the deploy (see finally) so a stray copy never shadows
        // local-dev VITE_* on the next `rayfin dev` — unless a file already
        // existed at that path, in which case it is left untouched and reused
        // as-is instead of being written or removed.
        if (rayfinConfig.services.staticHosting?.enabled) {
          // Emission failures are fatal here, matching the v2 workflow and
          // `up staticapp deploy`: a deploy without runtime config would
          // silently retain the source-stage backend after promotion, so this
          // fails the static deployment rather than warning and continuing.
          const staticServiceRoot = resolveServiceRoot(
            projectRoot,
            'staticHosting',
            rayfinConfig.services.staticHosting.path ?? '.'
          );
          const staticRoot = resolveServiceSubpath(
            staticServiceRoot,
            'staticHosting',
            'root',
            rayfinConfig.services.staticHosting.root ?? '.'
          );
          const publicDir = resolveServiceSubpath(
            staticRoot,
            'staticHosting',
            'public directory',
            'public'
          );
          const written = await writeRuntimeConfigFile(publicDir, {
            apiUrl: baasEndpoint,
            publishableKey,
            workspaceId,
            itemId: rayfinItemId,
            portalUrl: portalBase,
            tenantId: effectiveTenantId ?? undefined,
          });
          emittedRuntimeConfigPath = written.path;
          emittedRuntimeConfigPreexisting = written.preexisting;
          // rayfin.config.json is a CLI-managed transient: emitted here,
          // bundled into the static build, then removed in the finally below.
          // A file already on disk is unexpected — a leftover from an
          // interrupted `rayfin up`, or a hand-committed copy — so it is left
          // untouched and reused as-is for this deploy rather than
          // overwritten, and it will not be removed afterward.
          if (written.differences.length > 0) {
            modeWarn(
              mode,
              `⚠️  Found an existing ${written.path} that doesn't match this deployment (${written.differences.join('; ')}) — reusing it as-is (not overwritten). Delete it and re-run to regenerate it.`
            );
          }
          modeLog(
            mode,
            written.preexisting
              ? `✅ Using existing ${written.path}`
              : `✅ Emitted ${written.path}`
          );
        }

        // ── Deploy static content ─────────────────────────────────────
        let staticHostingUrl = retainedStaticHostingUrl;
        let deployedStaticHostingUrl: string | undefined;
        const staticConfig = rayfinConfig.services.staticHosting;
        if (isStaticHostingDeployExcluded) {
          modeLog(
            mode,
            '\n⏭️  Skipping staticHosting deploy (--exclude-services)'
          );
        } else if (staticConfig && staticConfig.enabled) {
          failedStep = 'static';
          modeLog(mode, '\n📄 Deploying static content...');
          const serviceRoot = resolveServiceRoot(
            projectRoot,
            'staticHosting',
            staticConfig.path ?? '.'
          );

          // Run build command if configured
          if (staticConfig.buildCommand) {
            modeLog(
              mode,
              `🔨 Running static build command: ${staticConfig.buildCommand}`
            );
            const buildSuccess = await runStaticBuildCommand(
              serviceRoot,
              staticConfig
            );
            if (buildSuccess) {
              modeLog(mode, '✔ Static build command completed');
            } else {
              throw new Error(
                'Static build command failed. Fix the build errors and re-run, ' +
                  "or use 'rayfin up staticapp deploy --skip-build' to deploy existing content."
              );
            }
          }

          // Validate the static folder
          const validation = validateStaticFolder(serviceRoot, staticConfig);

          if (!validation.exists) {
            throw new Error(validation.message || 'Static folder not found');
          } else if (validation.empty) {
            throw new Error(
              'Static folder is empty. Build your project first, ' +
                "or use 'rayfin up staticapp deploy --skip-build' after building manually."
            );
          }

          // Package and deploy
          const packageSpinner = showProgress(
            'Packaging static content',
            '📦',
            mode
          );
          let zipBuffer: Buffer;
          try {
            zipBuffer = await packageStaticFolder(validation.resolvedPath);
          } catch (packError) {
            recordStep(
              'staticBuild',
              packageSpinner,
              'error',
              (packError as Error).message
            );
            packageSpinner.fail(
              `Failed to package static content: ${(packError as Error).message}`
            );
            throw packError;
          }
          packageSpinner.succeed(
            `Static content packaged (${validation.fileCount} files, ${formatBytes(validation.totalSizeBytes)})`
          );
          recordStep('staticBuild', packageSpinner);

          const deploySpinner = showProgress(
            'Deploying static content',
            '🚀',
            mode
          );
          const deployEndpoint = `${itemEndpoint}/__private/webapp/deploy`;
          verbose('[static] Deploy endpoint:', deployEndpoint);

          let deployResult;
          try {
            deployResult = await withRetry(
              async () =>
                deployStaticContent(
                  zipBuffer,
                  deployEndpoint,
                  authorizationHeader,
                  { [MONIKER_HEADER]: rayfinItemId }
                ),
              {
                label: 'static-deploy',
                verbose,
                shouldRetry: (error) =>
                  error instanceof HttpError &&
                  [404, 408, 425, 429, 502, 503].includes(error.statusCode),
                onRetry: (attempt, delay, error) => {
                  const status =
                    error instanceof HttpError ? error.statusCode : 'error';
                  deploySpinner.stop();
                  modeLog(
                    mode,
                    `\u23f3 Deploy endpoint not ready (${status}), retrying in ${delay / 1000}s... (${attempt}/${RETRY_CONFIG.maxAttempts})`
                  );
                  deploySpinner.start();
                },
              }
            );
          } catch (deployError) {
            recordStep(
              'staticDeploy',
              deploySpinner,
              'error',
              (deployError as Error).message
            );
            deploySpinner.fail(
              `Static content deployment failed: ${(deployError as Error).message}`
            );
            throw deployError;
          }

          deploySpinner.succeed(
            `Static content deployed (${validation.fileCount} files, ${formatBytes(validation.totalSizeBytes)})`
          );
          recordStep('staticDeploy', deploySpinner);

          if (deployResult.hostingUrl) {
            staticHostingUrl = deployResult.hostingUrl;
            deployedStaticHostingUrl = deployResult.hostingUrl;
            modeLog(mode, `  🌐 Hosting URL: ${deployResult.hostingUrl}`);
          }
          if (deployResult.deploymentId) {
            modeLog(mode, `  🏷️ Deployment ID: ${deployResult.deploymentId}`);
          }
        }

        // ── Deploy functions ──────────────────────────────────────────
        // Auto-deploys when `services.functions.enabled === true`.  Uses the
        // shared `deployFunctions` orchestrator with spinner-based progress.
        // On failure we log a functions-specific retry tip and rethrow so
        // the outer catch handles cleanup (matches the static-app pattern).
        if (rayfinConfig.services.functions?.enabled) {
          if (excludedServices.has('functions')) {
            modeLog(
              mode,
              '\n⏭️  Skipping functions deploy (--exclude-services)'
            );
          } else {
            failedStep = 'functions';
            modeLog(mode, '\n⚡ Deploying functions...');
            const functionsConfig = rayfinConfig.services.functions;
            const functionsServiceRoot = resolveServiceRoot(
              projectRoot,
              'functions',
              functionsConfig.path ?? 'rayfin/functions'
            );
            const functionsDeployUrl = `${itemEndpoint}/__private/functions/deploy`;
            verbose('[functions] Deploy endpoint:', functionsDeployUrl);

            try {
              const functionsResult = await deployFunctions({
                serviceRoot: functionsServiceRoot,
                deployUrl: functionsDeployUrl,
                rayfinItemId,
                authorizationHeader,
                functionsConfig,
                skipBuild: false,
                isCompiledZip: true,
                verbose: cmdOptions.verbose ? verbose : undefined,
                mode,
                showProgress: (message, emoji) =>
                  showProgress(message, emoji, mode),
              });

              // Merge step timings into the parent's step results
              for (const [name, step] of Object.entries(
                functionsResult.steps
              )) {
                stepResults[name] = step;
              }
            } catch (deployError) {
              modeError(
                mode,
                `\n❌ Functions deploy failed: ${(deployError as Error).message}`
              );
              modeError(
                mode,
                '💡 To retry only the functions step, run: rayfin up functions deploy'
              );
              throw deployError;
            }
          }
        }

        // ── Persist hosting URL, update redirect URIs, and deployment registry ──
        if (deployedStaticHostingUrl) {
          await persistHostingUrl({
            hostingUrl: deployedStaticHostingUrl,
            services: rayfinConfig.services,
            projectRoot,
            workspaceName: workspaceDisplayName,
            postSettings: async (updatedServices) => {
              await postRuntimeSettings(
                itemEndpoint,
                updatedServices,
                authorizationHeader,
                verbose,
                'runtime-settings-patch',
                { [MONIKER_HEADER]: rayfinItemId },
                rayfinConfig.connectors,
                resolveDeployPackageVersions(projectRoot, updatedServices)
              );
            },
          });
        }

        // ── Success output ────────────────────────────────────────────
        if (mode === 'json') {
          emitJson({
            // A run where connectors failed to apply is a partial success —
            // the deployment landed but not every connector did. Automation
            // branching on `.status` must not read this as a clean deploy.
            status: resolveUpStatus(failedConnectorNames),
            deployment: {
              rayfinItemId,
              itemName,
              rayfinApiUrl: baasEndpoint,
              fabricWorkspaceId: workspaceId,
              fabricPortalUrl: fabricDeepLink,
              publishableKey: publishableKey || null,
              hostingUrl: staticHostingUrl || null,
            },
            excludedServices: [...excludedServices],
            steps: stepResults,
            failedConnectors: failedConnectorNames,
          });
        } else {
          modeLog(mode, '\n📝 Deployment details:');
          modeLog(mode, `  - Rayfin Item Name: ${itemName}`);
          modeLog(mode, `  - Rayfin Item ID: ${rayfinItemId}`);
          modeLog(mode, `  - Endpoint: ${baasEndpoint}`);
          modeLog(mode, `  - Fabric Workspace: ${workspaceId}`);
          modeLog(mode, `  - Portal: ${fabricDeepLink}`);
          if (publishableKey) {
            modeLog(
              mode,
              `  - Publishable Key: ${publishableKey.slice(0, 8)}…`
            );
          }
          if (staticHostingUrl) {
            modeLog(mode, `  - Static Hosting URL: ${staticHostingUrl}`);
          }

          modeLog(
            mode,
            `\n🎉 Project "${projectName}" is now deployed to Fabric!`
          );

          // Note: framework `.env.local` was already refreshed before the
          // static build above so the deployed bundle uses current values.

          modeLog(mode, `\n📌 Next steps:`);
          modeLog(mode, `   • Open in Fabric portal: ${fabricDeepLink}`);
          if (!staticHostingUrl) {
            // `RAYFIN_PUBLIC_API_URL` was already written to `rayfin/.env`
            // above. Run `rayfin env --framework <fw>` hooks to project it into the
            // framework-specific name (e.g. `VITE_RAYFIN_API_URL`,
            // `NEXT_PUBLIC_RAYFIN_API_URL`) the build pipeline expects.
            modeLog(
              mode,
              `   • Build your frontend — use \`rayfin env\` to generate env variables for your framework (e.g. VITE_RAYFIN_API_URL) and reference them in your code to connect to the backend`
            );
          }
          if (publishableKey) {
            modeLog(
              mode,
              `   • Use the publishable key as X-Publishable-Key header in data-plane requests`
            );
          }
          if (staticHostingUrl) {
            modeLog(mode, `   • Your app is live at: ${staticHostingUrl}`);
          }
        }
      } catch (error) {
        if (error instanceof CliHandledError) {
          throw error;
        }

        if (cmdOptions.dryRun) {
          failUp(
            mode,
            `${error instanceof Error ? error.message : String(error)}\n` +
              '   Check the configuration and workspace access, then retry with --dry-run.',
            undefined,
            error
          );
        }

        if (mode === 'json') {
          emitJsonError(mode, (error as Error).message, {
            steps: stepResults,
            ...(connectorApplyPending
              ? {
                  pendingConnectors: {
                    applied: false,
                    reason:
                      'Deployment failed before the connector step; connector configurations were not applied.',
                    retry:
                      "Re-run 'rayfin up' (which re-applies connectors) or run 'rayfin up connector apply' once the workload is ready.",
                  },
                }
              : {}),
          });
        }

        modeError(mode, `\n❌ Deployment failed:`);
        modeError(mode, `   Error: ${(error as Error).message}`);

        // If core deployment metadata was persisted before the failure,
        // let the user know the backend is up and they can retry just
        // the static deploy.
        const errorProjectRoot = findRayfinProjectRoot(process.cwd(), {
          verbose: false,
          silent: true,
        });
        const existingFiles = findExistingEnvFabricFiles(errorProjectRoot);
        const latestDeploy =
          existingFiles.length > 0
            ? readDeploymentEnvFile(
                errorProjectRoot,
                existingFiles[0].workspaceName
              )
            : null;
        if (latestDeploy?.rayfinApiUrl) {
          modeError(mode, '\n✅ Backend services were deployed successfully:');
          modeError(
            mode,
            `   • Rayfin item endpoint: ${latestDeploy.rayfinApiUrl}`
          );
          modeError(
            mode,
            failedStep === 'functions'
              ? '\n💡 To retry only the functions step, run: rayfin up functions deploy'
              : '\n💡 To retry only the static hosting step, run: rayfin up staticapp deploy'
          );
        }

        if (connectorApplyPending) {
          modeError(
            mode,
            '\n🔌 Connector configurations were not applied because deployment failed before the connector step.'
          );
          modeError(
            mode,
            "💡 After fixing the error above, either re-run 'rayfin up' (which re-applies connectors), run 'rayfin up connector apply' to apply every connector, or target a single one with 'rayfin up connector apply --name <connector_name>' once the workload is ready."
          );
        }

        verbose('Full error:', error);
        verbose('Error stack:', (error as Error).stack);
        throw new CliHandledError(error);
      } finally {
        // The runtime config is a transient deploy artifact: it is bundled
        // into the deployed static content but must never be left on disk,
        // where a stale file would shadow the local-dev VITE_* values on the
        // next `rayfin dev`. Remove it regardless of success or failure —
        // unless it preexisted, in which case it was left untouched above and
        // is not ours to delete.
        if (!emittedRuntimeConfigPreexisting) {
          await removeRuntimeConfigFile(emittedRuntimeConfigPath);
        }
      }
    });

  return cmd;
};

export const upCommand = up()
  .addCommand(upDbCommand)
  .addCommand(upStaticappCommand)
  .addCommand(upStatusCommand)
  .addCommand(upListCommand)
  .addCommand(upSwitchCommand);

upCommand.addCommand(upFunctionsCommand);

upCommand.addCommand(upConnectorCommand);

if (featureFlags.get('storage') === true) {
  upCommand.addCommand(upStorageCommand);
}
