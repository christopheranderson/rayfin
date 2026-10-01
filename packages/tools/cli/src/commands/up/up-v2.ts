/**
 * Layer 1 (host) wrapper for the v2 `rayfin up` path.
 *
 * Its job is the Layer 1 contract: parse flags into an {@link UpRequest},
 * assemble the {@link UpDeps}
 * slice from host adapters, run {@link runUpWorkflow}, and render the typed
 * {@link Result} to output + an exit code. All deployment orchestration lives
 * in the workflow (Layer 2); this file owns only flag parsing, pre-flight
 * targeting resolution, host wiring, and rendering.
 *
 * Pre-flight targeting (resolving `--workspace*` / ambient env / the recorded
 * deployment registry to a concrete workspace id, and recovering a recorded
 * item id for redeployments) stays here because it is host-and-prompt shaped;
 * the workflow takes the already-resolved identifiers as typed input.
 */
import { applyWorkspaceUriOverrides } from '@microsoft/rayfin-tools-common/_internal';
import type {
  Diagnostics,
  Logger,
  Progress,
  UserInteraction,
} from '@microsoft/rayfin-tools-common/_internal/adapters';
import {
  cancellationTokenFromSignal,
  noopTelemetryHandle,
  silentLogger,
} from '@microsoft/rayfin-tools-common/_internal/adapters';
import {
  type RayfinConfig,
  validateFunctionsConfig,
  validateServiceDependencies,
} from '@microsoft/rayfin-tools-common/_internal/config';
import type { AuthSession } from '@microsoft/rayfin-tools-common/_internal/services/auth';
import { noopDeploymentTelemetryCollector } from '@microsoft/rayfin-tools-common/_internal/services/project-telemetry';
import {
  extractSafeParamNames,
  type InvocationContext,
} from '@microsoft/rayfin-tools-common/_internal/telemetry';
import { cancelled } from '@microsoft/rayfin-tools-common/_internal/workflows';
import { runEnsureUserLicenseWorkflow } from '@microsoft/rayfin-tools-common/_internal/workflows/ensure-user-license';
import type { PremiumCapacitySelectionPolicy } from '@microsoft/rayfin-tools-common/_internal/workflows/fabric-readiness';
import {
  describeOutdatedAuthSdk,
  describeUnresolvedAuthSdk,
  ensureAuthSdk,
  resolveWorkspace,
  runUpWorkflow,
  type UpRequest,
} from '@microsoft/rayfin-tools-common/_internal/workflows/up';

import { createInteractiveConsole } from '../../adapters/interactive-console.js';
import { cliLogger } from '../../adapters/logger.js';
import { plainProgress, silentProgress } from '../../adapters/progress.js';
import { CliTelemetryHandle } from '../../adapters/telemetry.js';
import { cliUserInteraction } from '../../adapters/user-interaction.js';
import { ensureAuthenticated } from '../../auth/index.js';
import { validateCapacityOptions } from '../../commands/capacity-options.js';
import { validateWorkspaceFlagSet } from '../../commands/init-helpers.js';
import {
  createCliDiagnosticSession,
  type DiagnosticOutcome,
} from '../../diagnostics/session.js';
import {
  classifyCliError,
  CliCancelledError,
  CliHandledError,
} from '../../errors.js';
import { getCliFabricItemById } from '../../external-services/fabric/client.js';
import { createCliFabricClient } from '../../external-services/fabric/index.js';
import { createCliProjectTelemetryService } from '../../local-services/index.js';
import { createCliAuthSdkService } from '../../rayfin-services/auth-sdk.js';
import { createCliUserLicenseService } from '../../services/user-license.js';
import { getCurrentContext } from '../../telemetry/context-store.js';
import {
  getAmbientTenantId,
  getAmbientWorkspaceId,
} from '../../utils/ambient-env.js';
import { loadRayfinConfig } from '../../utils/config-utils.js';
import { createCliFeatureFlags } from '../../utils/feature-flags.js';
import { collectLegacyMigrationWarnings } from '../../utils/migration-utils.js';
import {
  type OutputMode,
  isInteractive,
  modeLog,
  modeWarn,
  resolveOutputMode,
} from '../../utils/output-mode.js';
import { resolveDeclaredPackageVersions } from '../../utils/package-versions.js';
import { findRayfinProjectRoot } from '../../utils/project-utils.js';
import { validateStaticHostingInputs } from '../../utils/static-hosting-utils.js';
import { getPackageVersion } from '../../utils/version.js';

import { describeAnonStaticPreflight } from './anonstatic-preflight-plan.js';
import {
  failUp,
  failUpWithWarnings,
  mergeWarnings,
  renderUpDryRun,
  renderUpResult,
} from './render.js';
import { resolveStaticHostingPosture } from './static-hosting-posture-preflight.js';
import { createUpDeps } from './up-deps.js';
import { resolveItemName } from './up-item-name.js';
import {
  type FabricReadinessContext,
  resolveCapacityAssignmentMode,
  resolveLocalTargeting,
  resolveTargeting,
} from './up-v2-targeting.js';

/** Commander option bag for `rayfin up`, after root-flag merge. */
export interface UpCommandOptions {
  tenant?: string;
  itemName?: string;
  workspace?: string;
  workspaceId?: string;
  workspaceUri?: string;
  capacityId?: string;
  force?: boolean;
  dryRun?: boolean;
  envFile?: string;
  verbose?: boolean;
  json?: boolean;
  output?: OutputMode;
  yes?: boolean;
  encryptionFallbackEnabled?: boolean;
  excludeServices?: string;
}

const ALLOWED_EXCLUDE_SERVICES = ['staticHosting', 'functions'] as const;
const NON_INTERACTIVE_PREMIUM_CAPACITY_SELECTION: PremiumCapacitySelectionPolicy =
  'fallback';

function premiumCapacitySelectionPolicy(
  interactive: boolean
): PremiumCapacitySelectionPolicy {
  return interactive ? 'prompt' : NON_INTERACTIVE_PREMIUM_CAPACITY_SELECTION;
}

/**
 * Execute the v2 `up` path end to end. Resolves on success or a declined item
 * reuse (exit 0), and throws a handled error on failure (exit 1), after
 * rendering — never calls `process.exit`.
 */
export async function runUpV2(options: UpCommandOptions): Promise<void> {
  const mode = resolveOutputMode({
    json: options.json,
    output: options.output,
  });
  const session = await createCliDiagnosticSession({
    commandName: 'up',
    cliVersion: getPackageVersion(),
    projectRoot: process.cwd(),
    safeParameterNames: extractSafeParamNames(process.argv.slice(2)),
    mirror:
      options.verbose && mode !== 'json'
        ? (line) => {
            process.stderr.write(line);
          }
        : undefined,
  });
  let outcome: DiagnosticOutcome = { status: 'failed', exitCode: 1 };
  try {
    outcome = await executeUp(
      options,
      mode,
      session.diagnostics,
      session.logPath
    );
  } catch (error) {
    outcome = {
      ...classifyCliError(error),
      error: error instanceof CliHandledError ? error.originalError : error,
    };
    if (outcome.status === 'failed' && !(error instanceof CliHandledError)) {
      failUp(
        mode,
        error instanceof Error ? error.message : String(error),
        {
          diagnosticLog: session.logPath,
        },
        error
      );
    }
    throw error;
  } finally {
    await session.close(outcome);
  }
}

async function executeUp(
  options: UpCommandOptions,
  mode: OutputMode,
  diagnostics: Diagnostics,
  diagnosticLog?: string
): Promise<DiagnosticOutcome> {
  if (options.verbose === true && mode === 'json') {
    failUp(
      mode,
      '--verbose cannot be combined with JSON output.\n' +
        '   JSON output requires a single JSON object on stdout; verbose logging would corrupt it.\n' +
        '   Re-run with either JSON output or --verbose, not both.',
      { diagnosticLog }
    );
  }
  const interactive = mode !== 'json' && isInteractive({ yes: options.yes });
  const { excludeStaticHosting, excludeFunctions } = parseExcludedServices(
    options,
    mode,
    diagnosticLog
  );

  // Reject deterministic local failures before authentication or target lookup.
  diagnostics.debug({
    area: 'up.preflight',
    message: 'Loading deployment configuration',
  });
  const prepared = validateAndLoad(options, mode, diagnosticLog);
  const normalizedOptions = prepared.options;
  const config = prepared.config;
  const projectName = config.id;
  const explicitItemName = normalizeItemName(options.itemName, mode);
  const connectorsEnabled = (config.connectors?.length ?? 0) > 0;
  const invocationFeatureFlags = createCliFeatureFlags(prepared.projectRoot, {
    command: 'up',
    envFile: normalizedOptions.envFile,
    silent: true,
  });
  const anonStaticEnabled =
    invocationFeatureFlags.get('cli-up-anonstatic') === true;

  const preflight = normalizedOptions.dryRun
    ? describeAnonStaticPreflight(
        config,
        prepared.projectRoot,
        anonStaticEnabled,
        interactive
      )
    : [];
  const hasExplicitWorkspace =
    normalizedOptions.workspaceId !== undefined ||
    normalizedOptions.workspace !== undefined;
  let hasWorkspaceTarget = hasExplicitWorkspace;
  let dryRunItemName = explicitItemName ?? projectName;
  let dryRunWarnings = prepared.warnings;
  let dryRunReusesRecordedDeployment = false;
  if (normalizedOptions.dryRun) {
    const localTargeting = resolveLocalTargeting(
      normalizedOptions,
      prepared.projectRoot,
      interactive
    );
    hasWorkspaceTarget ||= localTargeting.hasWorkspaceTarget;
    dryRunReusesRecordedDeployment = localTargeting.existingDeployment !== null;
    const recordedNameUnknown =
      Boolean(localTargeting.existingDeployment?.rayfinItemId) &&
      !localTargeting.existingDeployment?.rayfinItemName;
    const itemName = resolveItemName({
      explicitItemName,
      recordedItemName: localTargeting.existingDeployment?.rayfinItemName,
      hasRecordedItemId: false,
      fallbackItemName: config.id,
      mode,
    });
    dryRunItemName = itemName;
    const localWarnings = recordedNameUnknown
      ? [
          ...localTargeting.warnings,
          'The recorded deployment predates item-name tracking. Its current Fabric item name will be resolved during deployment.',
        ]
      : localTargeting.warnings;
    dryRunWarnings = mergeWarnings(prepared.warnings, localWarnings);
    if (config.services.staticHosting?.enabled && !excludeStaticHosting) {
      validateStaticHostingInputs(
        prepared.projectRoot,
        config.services.staticHosting
      );
    }
    if (preflight.some((entry) => entry.blocking)) {
      renderUpDryRun(
        config,
        dryRunItemName,
        excludeStaticHosting,
        excludeFunctions,
        connectorsEnabled,
        mode,
        dryRunWarnings,
        resolveDeclaredPackageVersions(prepared.projectRoot, config.services),
        preflight,
        diagnosticLog,
        undefined,
        hasWorkspaceTarget,
        premiumCapacitySelectionPolicy(interactive),
        {
          capacityId: normalizedOptions.capacityId,
          assignmentMode: resolveCapacityAssignmentMode({
            capacityId: normalizedOptions.capacityId,
            autoConfirm: normalizedOptions.yes === true,
            automaticWorkspaceResolution: !interactive && !hasWorkspaceTarget,
          }),
        },
        dryRunReusesRecordedDeployment
      );
    }
    if (!hasWorkspaceTarget) {
      renderUpDryRun(
        config,
        dryRunItemName,
        excludeStaticHosting,
        excludeFunctions,
        connectorsEnabled,
        mode,
        dryRunWarnings,
        resolveDeclaredPackageVersions(prepared.projectRoot, config.services),
        preflight,
        diagnosticLog,
        undefined,
        hasWorkspaceTarget,
        premiumCapacitySelectionPolicy(interactive),
        {
          capacityId: normalizedOptions.capacityId,
          assignmentMode: resolveCapacityAssignmentMode({
            capacityId: normalizedOptions.capacityId,
            autoConfirm: normalizedOptions.yes === true,
            automaticWorkspaceResolution: !interactive && !hasWorkspaceTarget,
          }),
        },
        dryRunReusesRecordedDeployment
      );
      return { status: 'success', exitCode: 0 };
    }
  }

  // Ahead of `buildRequest()`: the posture decides who may open the app, so a
  // run that cannot supply one stops before authenticating or targeting.
  let staticHostingPosture: UpRequest['staticHostingPosture'] = undefined;
  if (!normalizedOptions.dryRun) {
    const posture = await resolveStaticHostingPosture({
      config,
      enabled: anonStaticEnabled,
      interactive,
    });
    if (posture.status === 'failed') {
      failUp(mode, posture.message, { diagnosticLog });
    }
    staticHostingPosture = posture.posture;
    await validateBlockingAuthSdkPreflight({
      config,
      projectRoot: prepared.projectRoot,
      enabled: anonStaticEnabled,
      interactive,
      mode,
      diagnosticLog,
    });
  }

  diagnostics.debug({
    area: 'up.preflight',
    message: 'Authenticating and resolving deployment target',
  });
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  const signal = cancellationTokenFromSignal(controller.signal);
  let consoleHost: ReturnType<typeof createConsole> | undefined;
  try {
    const session = await ensureAuthenticated(undefined, {
      tenantId: normalizedOptions.tenant ?? getAmbientTenantId() ?? undefined,
      encryptionFallbackEnabled: normalizedOptions.encryptionFallbackEnabled,
    });
    if (!normalizedOptions.dryRun) {
      process.on('SIGINT', onSigint);
    }

    const verbose = options.verbose === true;
    consoleHost = createConsole(mode, interactive, verbose);
    const licenseResult = await runEnsureUserLicenseWorkflow(
      {
        allowInteractiveEnrollment:
          interactive && normalizedOptions.dryRun !== true,
      },
      {
        userLicense: await createCliUserLicenseService({
          provider: 'fabric',
          session,
          notify: consoleHost.writeLine,
        }),
        progress: consoleHost.progress,
        signal,
      }
    );
    if (licenseResult.status === 'cancelled') {
      consoleHost.stop();
      renderUpResult(
        cancelled([]),
        projectName,
        mode,
        prepared.warnings,
        true,
        diagnosticLog
      );
      throw new CliCancelledError();
    }
    if (licenseResult.status === 'failed') {
      consoleHost.stop();
      failUp(mode, licenseResult.error.message, {
        code: licenseResult.error.code,
        diagnosticLog,
      });
    }

    const builtRequest = await buildRequest(
      normalizedOptions,
      explicitItemName,
      session,
      config,
      prepared.projectRoot,
      prepared.warnings,
      mode,
      interactive,
      consoleHost,
      excludeStaticHosting,
      excludeFunctions,
      connectorsEnabled,
      anonStaticEnabled,
      controller.signal,
      diagnostics,
      diagnosticLog
    );
    if ('cancelled' in builtRequest) {
      consoleHost.stop();
      renderUpResult(
        cancelled(builtRequest.notices),
        projectName,
        mode,
        prepared.warnings,
        true,
        diagnosticLog
      );
      throw new CliCancelledError();
    }
    const {
      request,
      accessToken,
      warnings: targetingWarnings,
      reusesRecordedDeployment,
    } = builtRequest;
    for (const warning of targetingWarnings) {
      consoleHost.writeLine(`⚠️  ${warning}`);
    }
    const preflightWarnings = mergeWarnings(
      prepared.warnings,
      targetingWarnings
    );

    if (normalizedOptions.dryRun) {
      consoleHost.progress.report({
        phase: 'workspace',
        message: 'Resolving workspace',
      });
      const workspace = await resolveWorkspace(request, {
        fabric: createCliFabricClient(session.token, { diagnostics }),
      }).catch((error: unknown) =>
        failUp(
          mode,
          `${error instanceof Error ? error.message : String(error)}\n` +
            '   Verify the workspace target and your access, then run `rayfin login` and retry.',
          { diagnosticLog },
          error
        )
      );
      consoleHost.stop();
      renderUpDryRun(
        config,
        request.itemName,
        excludeStaticHosting,
        excludeFunctions,
        connectorsEnabled,
        mode,
        preflightWarnings,
        resolveDeclaredPackageVersions(prepared.projectRoot, config.services),
        preflight,
        diagnosticLog,
        workspace,
        hasWorkspaceTarget,
        premiumCapacitySelectionPolicy(interactive),
        {
          capacityId: normalizedOptions.capacityId,
          assignmentMode: resolveCapacityAssignmentMode({
            capacityId: normalizedOptions.capacityId,
            autoConfirm: normalizedOptions.yes === true,
            automaticWorkspaceResolution: !interactive && !hasWorkspaceTarget,
          }),
        },
        reusesRecordedDeployment
      );
      return { status: 'success', exitCode: 0 };
    }

    const { telemetry, projectTelemetry } = createUpTelemetryDeps();
    const upDeps = createUpDeps({
      accessToken,
      progress: consoleHost.progress,
      ui: consoleHost.ui,
      diagnostics,
      telemetry,
      projectTelemetry,
      signal,
    });
    const result = await runUpWorkflow(
      { ...request, staticHostingPosture },
      upDeps
    ).finally(() => {
      upDeps.dispose();
    });

    for (const message of mergeWarnings(
      preflightWarnings,
      result.warnings ?? []
    )) {
      diagnostics.debug({ area: 'up.warning', message });
    }
    consoleHost.stop();
    renderUpResult(
      result,
      projectName,
      mode,
      preflightWarnings,
      controller.signal.aborted,
      diagnosticLog
    );
    return {
      status: result.status === 'cancelled' ? 'cancelled' : 'success',
      exitCode: 0,
    };
  } finally {
    process.removeListener('SIGINT', onSigint);
    consoleHost?.stop();
  }
}

/** Select real telemetry deps only when the Commander hook created a context. */
export function createUpTelemetryDeps(
  invocationContext: InvocationContext | undefined = getCurrentContext()
): Pick<ReturnType<typeof createUpDeps>, 'telemetry' | 'projectTelemetry'> {
  return invocationContext
    ? {
        telemetry: new CliTelemetryHandle(invocationContext),
        projectTelemetry: createCliProjectTelemetryService(),
      }
    : {
        telemetry: noopTelemetryHandle,
        projectTelemetry: noopDeploymentTelemetryCollector,
      };
}

/**
 * Parse `--exclude-services`. `staticHosting` and `functions` are skippable;
 * an unknown name is a hard, rendered failure. Returns which services are excluded.
 */
interface ExcludedServices {
  excludeStaticHosting: boolean;
  excludeFunctions: boolean;
}

function parseExcludedServices(
  options: UpCommandOptions,
  mode: OutputMode,
  diagnosticLog?: string
): ExcludedServices {
  if (typeof options.excludeServices !== 'string') {
    return { excludeStaticHosting: false, excludeFunctions: false };
  }
  const names = options.excludeServices
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  let excludeStaticHosting = false;
  let excludeFunctions = false;
  for (const name of names) {
    const canonical = ALLOWED_EXCLUDE_SERVICES.find(
      (allowed) => allowed.toLowerCase() === name.toLowerCase()
    );
    if (!canonical) {
      failUp(
        mode,
        `Unknown service: ${name}. Allowed: ${ALLOWED_EXCLUDE_SERVICES.join(', ')}`,
        { diagnosticLog }
      );
    }
    if (canonical === 'staticHosting') excludeStaticHosting = true;
    if (canonical === 'functions') excludeFunctions = true;
  }
  return { excludeStaticHosting, excludeFunctions };
}

/**
 * Validate the targeting flags, apply `--workspace-uri` env overrides (which
 * must precede reading the resolved Fabric environment), and load
 * `rayfin.yml`. Performs no auth or network calls so it is safe ahead of the
 * `--dry-run` gate.
 */
function validateAndLoad(
  options: UpCommandOptions,
  mode: OutputMode,
  diagnosticLog?: string
): {
  options: UpCommandOptions;
  config: RayfinConfig;
  projectRoot: string;
  warnings: string[];
} {
  const normalizedOptions = { ...options };
  const hasExplicitWorkspaceOption =
    normalizedOptions.workspace !== undefined ||
    normalizedOptions.workspaceId !== undefined ||
    normalizedOptions.workspaceUri !== undefined;
  const flagErrors = validateWorkspaceFlagSet({
    workspace: normalizedOptions.workspace,
    workspaceId: normalizedOptions.workspaceId,
    workspaceUri: normalizedOptions.workspaceUri,
  });
  if (flagErrors.length > 0) {
    failUp(mode, flagErrors[0], { diagnosticLog });
  }

  if (normalizedOptions.workspaceUri) {
    try {
      const parsed = applyWorkspaceUriOverrides(normalizedOptions.workspaceUri);
      if (!parsed.isMyWorkspace) {
        normalizedOptions.workspaceId = parsed.workspaceId;
      }
    } catch (err) {
      failUp(
        mode,
        err instanceof Error ? err.message : String(err),
        { diagnosticLog },
        err
      );
    }
  }

  const projectRoot = findRayfinProjectRoot(process.cwd(), {
    verbose: false,
    silent: true,
  });
  modeLog(mode, `👀 Found Rayfin project root: ${projectRoot}`);
  const warnings = collectLegacyMigrationWarnings(projectRoot);
  for (const warning of warnings) {
    modeWarn(mode, warning);
  }

  let config: RayfinConfig | null;
  try {
    config = loadRayfinConfig(projectRoot, {
      silent: true,
      envFile: normalizedOptions.envFile,
      requireExplicitEnvFile: true,
      command: 'up',
    });
  } catch (err) {
    // failUp is typed `never` (always throws CliHandledError); no return needed.
    failUp(
      mode,
      err instanceof Error ? err.message : String(err),
      { diagnosticLog },
      err
    );
  }
  const capacityError = validateCapacityOptions({
    capacityId: normalizedOptions.capacityId,
    workspace: options.workspace,
    workspaceId: options.workspaceId,
    workspaceUri: options.workspaceUri,
    ambientWorkspaceId:
      normalizedOptions.capacityId && !hasExplicitWorkspaceOption
        ? (getAmbientWorkspaceId() ?? undefined)
        : undefined,
  })[0];
  if (capacityError) {
    failUp(mode, `${capacityError.message}\n   ${capacityError.recoveryHint}`, {
      code: capacityError.code,
      diagnosticLog,
    });
  }
  if (!config?.id) {
    failUp(mode, 'Project name not found in rayfin.yml configuration', {
      diagnosticLog,
    });
  }
  const [dependencyError] = validateServiceDependencies({
    dataEnabled: config.services.data.enabled === true,
    storageEnabled: config.services.storage?.enabled === true,
  });
  if (dependencyError) {
    failUp(mode, `${dependencyError.message}\n   ${dependencyError.hint}`, {
      diagnosticLog,
    });
  }
  const functionsErrors = validateFunctionsConfig(config.services.functions);
  if (functionsErrors.length > 0) {
    const message =
      `functions block in rayfin.yml has validation errors:\n` +
      functionsErrors
        .map((error) => `  • ${error.field}: ${error.message}`)
        .join('\n');
    failUp(mode, message, {
      code: 'invalid-functions-config',
      warnings,
    });
  }
  return { options: normalizedOptions, config, projectRoot, warnings };
}

/**
 * Resolve flags, config, and targeting into a normalized {@link UpRequest}
 * using the token acquired before the license preflight.
 */
async function buildRequest(
  options: UpCommandOptions,
  explicitItemName: string | undefined,
  session: AuthSession,
  config: RayfinConfig,
  projectRoot: string,
  preflightWarnings: string[],
  mode: OutputMode,
  interactive: boolean,
  host: ReturnType<typeof createConsole>,
  excludeStaticHosting: boolean,
  excludeFunctions: boolean,
  connectorsEnabled: boolean,
  staticHostingAccessControlEnabled: boolean,
  signal: AbortSignal,
  diagnostics: Diagnostics,
  diagnosticLog?: string
): Promise<
  | {
      request: UpRequest;
      accessToken: string;
      warnings: string[];
      reusesRecordedDeployment: boolean;
    }
  | { cancelled: true; notices: UpRequest['readinessNotices'] }
> {
  const readinessOptions: FabricReadinessContext | undefined = options.dryRun
    ? undefined
    : {
        projectId: config.id,
        capacityId: options.capacityId,
        capacityAssignmentMode: resolveCapacityAssignmentMode({
          capacityId: options.capacityId,
          autoConfirm: options.yes === true,
          automaticWorkspaceResolution: false,
        }),
        premiumCapacitySelection: premiumCapacitySelectionPolicy(interactive),
      };
  const targeting = await resolveTargeting(
    options,
    session.token,
    mode,
    interactive,
    projectRoot,
    preflightWarnings,
    readinessOptions,
    signal,
    diagnosticLog,
    {
      diagnostics,
      logger: host.logger,
      progress: host.progress,
      ui: host.ui,
    }
  );
  if ('cancelled' in targeting) {
    return targeting;
  }
  const targetingWarnings = mergeWarnings(
    preflightWarnings,
    targeting.warnings
  );
  const failAfterTargeting = (message: string, cause?: unknown): never =>
    failUpWithWarnings(
      mode,
      message,
      targetingWarnings,
      targeting.notices,
      diagnosticLog,
      cause
    );

  let recordedItemName = targeting.existingDeployment?.rayfinItemName;
  const recordedItemId = targeting.existingDeployment?.rayfinItemId;
  if (recordedItemId && !recordedItemName) {
    let recordedItem;
    try {
      recordedItem = await getCliFabricItemById(
        session.token,
        targeting.workspaceId,
        recordedItemId
      );
    } catch (error) {
      failAfterTargeting(
        `Unable to resolve the recorded Fabric item ${recordedItemId}: ${
          error instanceof Error ? error.message : String(error)
        }\n   Verify the item still exists and that you can access the target workspace, then retry.`,
        error
      );
    }
    if (!recordedItem) {
      failAfterTargeting(
        `The recorded Fabric item ${recordedItemId} no longer exists in the target workspace.\n` +
          '   Remove the stale deployment record or deploy to a different workspace.'
      );
    } else {
      recordedItemName = recordedItem.displayName;
    }
  }
  const itemName = resolveItemName({
    explicitItemName,
    recordedItemName,
    hasRecordedItemId: Boolean(recordedItemId),
    fallbackItemName: config.id,
    mode,
    fail: failAfterTargeting,
  });

  const portalBaseUrl = process.env.RAYFIN_FABRIC_PORTAL_URL?.replace(
    /\/+$/,
    ''
  );

  const request: UpRequest = {
    config,
    itemName,
    projectRoot,
    workspaceId: targeting.workspaceId,
    // Readiness ran in the targeting pre-flight, which is what let a failure
    // fall back to the picker. The workflow is handed the outcome so its
    // structured result records what targeting prepared.
    workspaceCreated: targeting.workspaceCreated,
    capacitySource: targeting.capacitySource,
    readinessNotices: targeting.notices,
    knownItemId: targeting.existingDeployment?.rayfinItemId,
    force: options.force,
    autoConfirmReuse: options.yes === true,
    excludeStaticHosting,
    excludeFunctions,
    connectorsEnabled,
    functionsEnabled: true,
    staticHostingAccessControlEnabled,
    tenantId: session.tenantId,
    portalBaseUrl,
    retainedHostingUrl: targeting.existingDeployment?.hostingUrl,
  };

  return {
    request,
    accessToken: session.token,
    warnings: targeting.warnings,
    reusesRecordedDeployment: targeting.existingDeployment !== null,
  };
}

function normalizeItemName(
  value: string | undefined,
  mode: OutputMode
): string | undefined {
  if (value === undefined) return undefined;
  const itemName = value.trim();
  if (!itemName) {
    failUp(
      mode,
      'Fabric item name cannot be empty.\n' +
        '   Pass a non-empty value with --item-name <name>.'
    );
  }
  return itemName;
}

async function validateBlockingAuthSdkPreflight(options: {
  config: RayfinConfig;
  projectRoot: string;
  enabled: boolean;
  interactive: boolean;
  mode: OutputMode;
  diagnosticLog?: string;
}): Promise<void> {
  if (
    !options.enabled ||
    options.config.services.staticHosting?.enabled !== true
  ) {
    return;
  }

  const result = await ensureAuthSdk(
    {
      services: options.config.services,
      projectRoot: options.projectRoot,
    },
    {
      authSdk: createCliAuthSdkService(),
      ui: options.interactive ? cliUserInteraction : undefined,
    }
  );
  if (result.status === 'unresolved') {
    failUp(options.mode, describeUnresolvedAuthSdk(result.reason), {
      code: 'auth-sdk-unresolved',
      diagnosticLog: options.diagnosticLog,
    });
  }
  if (result.status === 'outdated') {
    failUp(
      options.mode,
      describeOutdatedAuthSdk(result.packages, result.error),
      {
        code: 'auth-sdk-outdated',
        diagnosticLog: options.diagnosticLog,
      }
    );
  }
  if (result.status === 'upgraded') {
    modeLog(
      options.mode,
      `Updated ${result.packages.join(', ')} before resolving Fabric readiness.`
    );
  }
}

/**
 * Resolve the host's push-style progress impl, the matching user-interaction
 * adapter, and a stop hook from the rendering mode.
 *
 * In interactive mode the spinner and prompts share one
 * {@link createInteractiveConsole} so a mid-workflow prompt suspends the
 * spinner rather than being overwritten by it. `ui` is exposed only when the
 * host is `interactive` (a TTY without `--yes`); otherwise it stays absent and
 * the workflow takes its non-interactive path instead of blocking on a prompt
 * that can never be answered.
 *
 * Exported for unit testing of the `(mode, interactive) → ui` selection table.
 */
export function createConsole(
  mode: OutputMode,
  interactive: boolean,
  verbose = false
): {
  logger: Logger;
  progress: Progress;
  ui: UserInteraction | undefined;
  writeLine: (message: string) => void;
  stop: () => void;
} {
  if (mode === 'interactive' && !verbose) {
    const interactiveConsole = createInteractiveConsole('Deploying…');
    return {
      logger: interactiveConsole.logger,
      progress: interactiveConsole.progress,
      ui: interactive ? interactiveConsole.ui : undefined,
      writeLine: (message) =>
        interactiveConsole.writeDiagnostic(`${message}\n`),
      stop: interactiveConsole.stop,
    };
  }
  if (mode === 'plain' || (mode === 'interactive' && verbose)) {
    const logger =
      mode === 'plain'
        ? {
            ...cliLogger,
            log: (message: string): void => {
              process.stderr.write(`${message}\n`);
            },
          }
        : cliLogger;
    return {
      logger,
      progress: plainProgress,
      ui: interactive ? cliUserInteraction : undefined,
      writeLine: (message) => modeLog(mode, message),
      stop: () => {},
    };
  }
  return {
    logger: silentLogger,
    progress: silentProgress,
    ui: undefined,
    writeLine: () => {},
    stop: () => {},
  };
}
