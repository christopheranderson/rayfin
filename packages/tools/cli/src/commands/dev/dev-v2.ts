/**
 * Layer 1 (host) wrapper for the workflow-based `rayfin dev` path.
 *
 * Parses `--provider` and flags into a {@link DevRequest}, assembles the
 * {@link DevDeps} slice (selecting the backend provider), runs
 * {@link runDevWorkflow}, and render the typed {@link Result} to output + an
 * exit code. All inner-loop orchestration lives in the workflow (Layer 2); this
 * file owns flag parsing, host wiring, Ctrl-C → cancellation, and rendering.
 *
 * `dev` is a long-running session: the workflow blocks in `start-local-runtimes`
 * until the runtimes exit or Ctrl-C aborts them, at which point the provider is
 * torn down and the result is rendered.
 */
import { resolve } from 'node:path';

import {
  cancellationTokenFromSignal,
  type CommandRunner,
  type Diagnostics,
  type Progress,
  type UserInteraction,
} from '@microsoft/rayfin-tools-common/_internal/adapters';
import {
  type RayfinConfig,
  validateFunctionsConfig,
} from '@microsoft/rayfin-tools-common/_internal/config';
import type { AuthSession } from '@microsoft/rayfin-tools-common/_internal/services/auth';
import { extractSafeParamNames } from '@microsoft/rayfin-tools-common/_internal/telemetry';
import type { Result } from '@microsoft/rayfin-tools-common/_internal/workflows';
import {
  type DevRequest,
  type DevResult,
  runDevWorkflow,
} from '@microsoft/rayfin-tools-common/_internal/workflows/dev';
import {
  type EnsureUserLicenseResult,
  runEnsureUserLicenseWorkflow,
} from '@microsoft/rayfin-tools-common/_internal/workflows/ensure-user-license';
import {
  type FabricReadinessNotice,
  readinessHintForReason,
} from '@microsoft/rayfin-tools-common/_internal/workflows/fabric-readiness';

import {
  createBuildOutput,
  createChildOutputSinks,
  type ChildOutputSinks,
} from '../../adapters/child-output.js';
import { createDiagnosticRunner } from '../../adapters/diagnostic-runner.js';
import { createFunctionsOutputRunner } from '../../adapters/functions-output.js';
import { createInteractiveConsole } from '../../adapters/interactive-console.js';
import { plainProgress, silentProgress } from '../../adapters/progress.js';
import { cliCommandRunner } from '../../adapters/runner.js';
import { cliUserInteraction } from '../../adapters/user-interaction.js';
import { ensureAuthenticated } from '../../auth/index.js';
import {
  createCliDiagnosticSession,
  type DiagnosticOutcome,
} from '../../diagnostics/session.js';
import {
  classifyCliError,
  CliCancelledError,
  CliHandledError,
  FABRIC_CAPACITY_EXHAUSTED_ERROR,
} from '../../errors.js';
import { createCliUserLicenseService } from '../../services/user-license.js';
import {
  getAmbientTenantId,
  getAmbientWorkspaceId,
} from '../../utils/ambient-env.js';
import { loadRayfinConfig } from '../../utils/config-utils.js';
import { createCliFeatureFlags } from '../../utils/feature-flags.js';
import {
  type OutputMode,
  emitJson,
  emitJsonError,
  modeError,
  modeLog,
  modeWarn,
  isInteractive,
  resolveOutputMode,
} from '../../utils/output-mode.js';
import { findRayfinProjectRoot } from '../../utils/project-utils.js';
import { getPackageVersion } from '../../utils/version.js';
import { validateCapacityOptions } from '../capacity-options.js';

import {
  DEV_PROVIDERS,
  type DevProviderId,
  createDevDeps,
} from './dev-deps.js';

/** Commander option bag for `rayfin dev`, after root-flag merge. */
export interface DevCommandOptions {
  provider?: string;
  purge?: boolean;
  skipDataApply?: boolean;
  tenant?: string;
  workspace?: string;
  workspaceId?: string;
  capacityId?: string;
  encryptionFallbackEnabled?: boolean;
  envFile?: string;
  /** When false (`--no-emit-env`), skip regenerating the framework `.env.local`. */
  emitEnv?: boolean;
  verbose?: boolean;
  json?: boolean;
  output?: OutputMode;
  /** Pre-approve prompts such as same-name Fabric backend reuse. */
  yes?: boolean;
}

/**
 * Execute the workflow-based `dev` path end to end. Resolves on a normal session end or
 * Ctrl-C (exit 0 / 2); throws {@link CliHandledError} on failure (exit 1) after
 * rendering the error — never calls `process.exit`.
 */
export async function runDevV2(
  projectPath: string,
  options: DevCommandOptions
): Promise<void> {
  const mode = resolveOutputMode({
    json: options.json,
    output: options.output,
  });
  const startPath =
    projectPath === '.' ? process.cwd() : resolve(process.cwd(), projectPath);
  const session = await createCliDiagnosticSession({
    commandName: 'dev',
    cliVersion: getPackageVersion(),
    projectRoot: startPath,
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
    await executeDev(
      startPath,
      options,
      mode,
      session.diagnostics,
      session.logPath
    );
    outcome = { status: 'success', exitCode: 0 };
  } catch (error) {
    outcome = {
      ...classifyCliError(error),
      error: error instanceof CliHandledError ? error.originalError : error,
    };
    if (outcome.status === 'failed' && !(error instanceof CliHandledError)) {
      fail(
        mode,
        error instanceof Error ? error.message : String(error),
        recoveryHintFor('dev-failed'),
        session.logPath,
        error
      );
    }
    throw error;
  } finally {
    await session.close(outcome);
  }
}

async function executeDev(
  startPath: string,
  options: DevCommandOptions,
  mode: OutputMode,
  diagnostics: Diagnostics,
  diagnosticLog?: string
): Promise<void> {
  if (options.verbose && mode === 'json') {
    fail(
      mode,
      '--verbose cannot be combined with JSON output.',
      'Use JSON output without --verbose; diagnostics are still saved locally.',
      diagnosticLog
    );
  }
  const interactive = mode !== 'json' && isInteractive({ yes: options.yes });
  diagnostics.debug({
    area: 'dev.preflight',
    message: 'Loading configuration and resolving provider',
  });
  const provider = resolveProvider(options, mode, startPath, diagnosticLog);
  const config = validateAndLoad(options, mode, startPath, diagnosticLog);
  const hasExplicitWorkspaceOption =
    options.workspace !== undefined || options.workspaceId !== undefined;
  const capacityError = validateCapacityOptions({
    capacityId: options.capacityId,
    workspace: options.workspace,
    workspaceId: options.workspaceId,
    ambientWorkspaceId:
      options.capacityId && !hasExplicitWorkspaceOption
        ? (getAmbientWorkspaceId() ?? undefined)
        : undefined,
    provider,
  })[0];
  if (capacityError) {
    fail(
      mode,
      capacityError.message,
      capacityError.recoveryHint,
      diagnosticLog,
      undefined,
      capacityError.code
    );
  }
  const projectRoot = findRayfinProjectRoot(startPath, {
    verbose: false,
    silent: true,
  });

  const errors = validateFunctionsConfig(config.services.functions);
  if (errors.length > 0) {
    renderResult(
      {
        status: 'failed',
        error: {
          code: 'invalid-functions-config',
          message: errors.map(({ message }) => message).join('\n'),
        },
      },
      mode,
      diagnostics,
      diagnosticLog
    );
  }

  const request: DevRequest = {
    config,
    projectRoot,
    provider,
    purge: options.purge === true,
    skipDataApply: options.skipDataApply === true,
  };

  // Ctrl-C aborts the session: the workflow honors the token between steps and
  // forwards it to the local runtimes, then tears the backend down.
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  const readinessNotices: FabricReadinessNotice[] = [];

  const buildOutput = createBuildOutput(diagnostics, 'dev.build');
  let result: Result<DevResult>;
  let consoleHost: DevConsole | undefined;
  try {
    diagnostics.debug({
      area: 'dev.preflight',
      message: 'Preparing backend and runtime dependencies',
    });
    const signal = cancellationTokenFromSignal(controller.signal);
    const session = await resolveDevAuthSession(provider, options);
    process.on('SIGINT', onSigint);

    consoleHost = createDevConsole(mode, interactive, options.verbose === true);
    const childOutput = createChildOutputSinks(mode, consoleHost.stop);
    const licenseResult = await runEnsureUserLicenseWorkflow(
      { allowInteractiveEnrollment: interactive },
      {
        userLicense: await createCliUserLicenseService({
          provider,
          session,
          notify: consoleHost.writeLine,
        }),
        progress: consoleHost.progress,
        signal,
      }
    );
    if (licenseResult.status !== 'ok') {
      consoleHost.stop();
    }
    renderLicensePreflightResult(
      licenseResult,
      mode,
      diagnostics,
      diagnosticLog
    );

    const deps = await createDevDeps({
      diagnostics,
      provider,
      config,
      projectRoot,
      session,
      abortSignal: controller.signal,
      cancellationToken: signal,
      onReadinessNotice: (notice) => readinessNotices.push(notice),
      progress: consoleHost.progress,
      runner: createStreamingRunner(
        childOutput,
        mode === 'interactive' && interactive,
        diagnostics,
        mode !== 'json' && options.verbose !== true,
        consoleHost.stop
      ),
      notify: consoleHost.writeLine,
      onBuildStdout: buildOutput.stdout,
      onBuildStderr: buildOutput.stderr,
      workspace: options.workspace,
      workspaceId: options.workspaceId,
      capacityId: options.capacityId,
      emitFrameworkEnv: options.emitEnv !== false,
      autoConfirmReuse: options.yes === true,
      ui: consoleHost.ui,
    });

    result = await runDevWorkflow({ ...request }, { ...deps, signal });
  } finally {
    buildOutput.end();
    process.removeListener('SIGINT', onSigint);
    consoleHost?.stop();
  }

  for (const message of result.warnings ?? [])
    diagnostics.debug({ area: 'dev.warning', message });
  const failedBuildOutput =
    result.status === 'failed' &&
    result.error.code === 'functions-build-failed' &&
    options.verbose !== true
      ? buildOutput.tail()
      : undefined;
  if (failedBuildOutput && mode !== 'json')
    createChildOutputSinks(mode).stderr(failedBuildOutput);
  renderResult(
    result,
    mode,
    diagnostics,
    diagnosticLog,
    readinessNotices,
    failedBuildOutput
  );
  if (result.status === 'cancelled') {
    throw new CliCancelledError();
  }
}

async function resolveDevAuthSession(
  provider: DevProviderId,
  options: DevCommandOptions
): Promise<AuthSession | undefined> {
  if (provider !== 'fabric') {
    return undefined;
  }
  return ensureAuthenticated(undefined, {
    tenantId: options.tenant ?? getAmbientTenantId() ?? undefined,
    encryptionFallbackEnabled: options.encryptionFallbackEnabled,
  });
}

interface DevConsole {
  progress: Progress;
  ui: UserInteraction | undefined;
  writeLine(message: string): void;
  stop(): void;
}

function createDevConsole(
  mode: OutputMode,
  interactive: boolean,
  verbose: boolean
): DevConsole {
  if (mode === 'interactive' && !verbose) {
    const interactiveConsole = createInteractiveConsole(
      'Preparing development session…'
    );
    return {
      progress: interactiveConsole.progress,
      ui: interactive ? interactiveConsole.ui : undefined,
      writeLine: (message) =>
        interactiveConsole.writeDiagnostic(`${message}\n`),
      stop: interactiveConsole.stop,
    };
  }
  if (mode === 'plain' || (mode === 'interactive' && verbose)) {
    return {
      progress: plainProgress,
      ui: interactive ? cliUserInteraction : undefined,
      writeLine: (message) => modeLog(mode, message),
      stop() {},
    };
  }
  return {
    progress: silentProgress,
    ui: undefined,
    writeLine() {},
    stop() {},
  };
}

function renderLicensePreflightResult(
  result: Result<EnsureUserLicenseResult>,
  mode: OutputMode,
  diagnostics: Diagnostics,
  diagnosticLog?: string
): void {
  if (result.status === 'ok') {
    return;
  }
  if (result.status === 'cancelled') {
    throw new CliCancelledError();
  }
  renderResult(
    { status: 'failed', error: result.error },
    mode,
    diagnostics,
    diagnosticLog
  );
}

/**
 * Resolve and validate `--provider`. `docker` additionally requires the
 * `docker-local-dev` flag; an unknown value or an unavailable Docker provider is
 * a hard, rendered failure.
 */
function resolveProvider(
  options: DevCommandOptions,
  mode: OutputMode,
  startPath: string,
  diagnosticLog?: string
): DevProviderId {
  const raw = (options.provider ?? 'fabric').toLowerCase();
  if (!DEV_PROVIDERS.includes(raw as DevProviderId)) {
    fail(
      mode,
      `Unknown provider: ${options.provider}. Supported: ${DEV_PROVIDERS.join(', ')}.`,
      'Use `--provider fabric` or `--provider docker`.',
      diagnosticLog
    );
  }
  if (raw === 'docker') {
    const flags = createCliFeatureFlags(startPath, { silent: true });
    if (flags.get('docker-local-dev') !== true) {
      fail(
        mode,
        'The `docker` provider is not available yet.',
        'Enable `docker-local-dev`, or use `--provider fabric` to run against your deployed Fabric backend.',
        diagnosticLog
      );
    }
  }
  return raw as DevProviderId;
}

/** Load `rayfin.yml`, rendering a failure when the project name is missing. */
function validateAndLoad(
  options: DevCommandOptions,
  mode: OutputMode,
  startPath: string,
  diagnosticLog?: string
): RayfinConfig {
  const config = loadRayfinConfig(startPath, {
    silent: true,
    envFile: options.envFile,
    command: 'dev',
  });
  if (!config?.id) {
    fail(
      mode,
      'Project name not found in rayfin.yml configuration',
      'Add an `id` to `rayfin/rayfin.yml`, or run `rayfin init` to create the project configuration.',
      diagnosticLog
    );
  }
  return config;
}

function createStreamingRunner(
  output: ChildOutputSinks,
  allowInheritedStdio: boolean,
  diagnostics: Diagnostics,
  renderFunctionsOutput: boolean,
  onOutputStart: () => void = () => {}
): CommandRunner {
  const runner = createFunctionsOutputRunner(
    createDiagnosticRunner(cliCommandRunner, diagnostics),
    renderFunctionsOutput
  );
  return {
    run: (command, args, runOptions) => {
      if (allowInheritedStdio && runOptions?.inheritStdio === true) {
        onOutputStart();
      }
      return runner.run(command, args, {
        ...runOptions,
        inheritStdio: allowInheritedStdio && runOptions?.inheritStdio === true,
        onStdout: runOptions?.onStdout ?? output.stdout,
        onStderr: runOptions?.onStderr ?? output.stderr,
      });
    },
  };
}

/** Render the workflow {@link Result} to output and map it to an exit code. */
function renderResult(
  result: Result<DevResult>,
  mode: OutputMode,
  diagnostics: Diagnostics,
  diagnosticLog?: string,
  readinessNotices: FabricReadinessNotice[] = [],
  buildOutput?: string
): void {
  if (result.status === 'cancelled') {
    if (mode === 'json') {
      emitJson({
        status: 'cancelled',
        warnings: result.warnings ?? [],
        ...(readinessNotices.length > 0 ? { notices: readinessNotices } : {}),
      });
    } else {
      for (const warning of result.warnings ?? []) {
        modeWarn(mode, `⚠️  ${warning}`);
      }
      modeLog(mode, '\nDev session ended.');
    }
    return;
  }

  if (result.status === 'failed') {
    diagnostics.debug({
      area: 'dev',
      message: 'Workflow failed',
      data: { code: result.error.code },
    });
    const hint = recoveryHintFor(result.error.code);
    const cause = result.error.cause ?? new Error(result.error.message);
    if (mode === 'json') {
      const actionRequired = isReadinessActionRequired(result.error.code);
      emitJsonError(
        mode,
        result.error.message,
        {
          ...(actionRequired ? { status: 'action_required' } : {}),
          code: result.error.code,
          ...(actionRequired
            ? {
                reason: result.error.code.slice('fabric-readiness:'.length),
                retryable: true,
              }
            : {}),
          hint,
          diagnosticLog,
          ...(buildOutput ? { buildOutput } : {}),
          ...(readinessNotices.length > 0 ? { notices: readinessNotices } : {}),
        },
        cause
      );
    }
    modeError(mode, `\n❌ Dev session failed: ${result.error.message}`);
    modeError(mode, `   ${hint}`);
    if (diagnosticLog) modeError(mode, `   Diagnostic log: ${diagnosticLog}`);
    throw new CliHandledError(cause);
  }

  renderSuccess(result.data, result.warnings ?? [], mode, readinessNotices);
}

function isReadinessActionRequired(code: string): boolean {
  return (
    code === 'fabric-readiness:capacity_assignment_confirmation_required' ||
    code === 'fabric-readiness:capacity_selection_required'
  );
}

/** Render a completed dev session (RFC §6 output contract). */
function renderSuccess(
  data: DevResult,
  warnings: string[],
  mode: OutputMode,
  readinessNotices: FabricReadinessNotice[]
): void {
  if (mode === 'json') {
    emitJson({
      status: warnings.length > 0 ? 'ready-with-warnings' : 'ready',
      provider: data.provider,
      target: {
        displayName: data.target.displayName,
        apiUrl: data.target.apiUrl ?? null,
      },
      startedRuntimes: data.startedRuntimes,
      runtimeUrls: data.runtimeUrls,
      warnings,
      ...(readinessNotices.length > 0 ? { notices: readinessNotices } : {}),
    });
    return;
  }

  for (const warning of warnings) {
    modeWarn(mode, `⚠️  ${warning}`);
  }
  modeLog(
    mode,
    `\nRayfin dev  provider=${data.provider}  target=${data.target.displayName}`
  );
  if (data.target.apiUrl) {
    modeLog(mode, `  backend: ${data.target.apiUrl}`);
  }
  modeLog(
    mode,
    `  runtimes: ${data.startedRuntimes.length > 0 ? data.startedRuntimes.join(', ') : 'none'}`
  );
  modeLog(mode, `Dev session ended  warnings=${warnings.length}`);
}

/** Return the actionable recovery hint for a stable workflow error code. */
function recoveryHintFor(code: string): string {
  const readinessPrefix = 'fabric-readiness:';
  if (code.startsWith(readinessPrefix)) {
    return readinessHintForReason(code.slice(readinessPrefix.length), 'dev');
  }
  switch (code) {
    case 'fabric_license_enrollment_required':
      return 'Rerun `rayfin dev` in an interactive terminal to open Fabric license setup.';
    case 'fabric_license_enrollment_timeout':
      return 'Complete Fabric license setup in the browser, then rerun `rayfin dev`.';
    case 'fabric_license_browser_open_failed':
      return 'Open the Fabric setup URL shown above in a supported browser, complete licensing, then rerun `rayfin dev`.';
    case 'fabric_license_probe_failed':
      return 'Run `rayfin login`, verify the configured Fabric backend, then retry `rayfin dev`.';
    case 'fabric_auto_license_disabled_by_tenant':
      return 'Contact your Fabric administrator or visit https://aka.ms/pbiAdHocSubscriptionNotAllowed.';
    case 'fabric-provisioning-failed':
      return 'Set `RAYFIN_WORKSPACE_ID` to an accessible workspace, or run `rayfin up --workspace <name>` once to record another target, then retry `rayfin dev`.';
    case 'fabric-capacity-exhausted':
      return FABRIC_CAPACITY_EXHAUSTED_ERROR.hint;
    case 'fabric-backend-setup-failed':
      return 'The backend already exists; retry with `--yes` to reuse it, and verify the workload is accessible if setup still fails.';
    case 'fabric-backend-record-failed':
      return 'Resolve the reported local registry write issue, then retry with `--yes` to reuse and record the existing backend.';
    case 'fabric-item-reuse-required':
      return 'Pass `--yes` to reuse that backend, change `id` in `rayfin/rayfin.yml`, or set `RAYFIN_WORKSPACE_ID` to target another workspace.';
    case 'fabric-provisioning-consent-required':
      return 'Run `rayfin dev` in an interactive terminal, pass `--yes`, or pass `--capacity-id <id>` to create the workspace and backend without prompting.';
    case 'fabric-workspace-required':
      return 'Pass `--workspace <name>` or `--workspace-id <id>`, set `RAYFIN_WORKSPACE_ID`, or run `rayfin dev` in an interactive terminal to pick one.';
    case 'docker-unavailable':
      return 'Start Docker, then retry `rayfin dev --provider docker`.';
    case 'docker-compose-unavailable':
      return 'Install or enable Docker Compose, then retry `rayfin dev --provider docker`.';
    case 'docker-not-ready':
      return 'Run `rayfin dev status` to inspect the local services, then retry.';
    case 'invalid-connectors':
      return 'Fix the reported `connectors` entries in `rayfin/rayfin.yml`, then retry `rayfin dev`.';
    case 'invalid-request':
      return 'Fix the reported project configuration errors, then retry `rayfin dev`.';
    case 'functions-node-unsupported':
      return 'Upgrade Node.js to a supported version, then retry `rayfin dev`.';
    case 'functions-core-tools-missing':
      return 'Run `rayfin dev functions apply` once to install Azure Functions Core Tools with consent, then retry `rayfin dev`.';
    case 'functions-path-invalid':
      return 'Fix `services.functions.path` in `rayfin/rayfin.yml`, then retry `rayfin dev`.';
    case 'functions-port-unavailable':
      return 'Stop the process holding the reported functions port range, then retry `rayfin dev`.';
    case 'functions-inspector-port-unavailable':
      return 'Stop the process holding the reported inspector port range, then retry `rayfin dev`.';
    case 'functions-state-missing':
      return 'Restart `rayfin dev`; if the issue persists, report the failed functions reservation.';
    case 'functions-build-failed':
      return 'Fix the functions build error above, then retry `rayfin dev`.';
    case 'runtime-launch-failed':
      return 'Check that the reported runtime command is installed and runnable, then retry `rayfin dev`.';
    case 'runtime-exited':
      return 'Check the runtime output above, then retry `rayfin dev`.';
    case 'frontend-script-recursive':
      return 'Add a non-recursive `dev:frontend` script (for example, `"dev:frontend": "vite"`), then retry `rayfin dev`.';
    default:
      return 'Resolve the reported issue, then retry `rayfin dev`.';
  }
}

/** Render an error and abort the workflow path via {@link CliHandledError}. */
function fail(
  mode: OutputMode,
  message: string,
  hint: string,
  diagnosticLog?: string,
  cause?: unknown,
  code?: string
): never {
  if (mode === 'json') {
    emitJsonError(
      mode,
      message,
      { hint, diagnosticLog, ...(code && { code }) },
      cause
    );
  }
  modeError(mode, `❌ ${message}`);
  modeError(mode, `   ${hint}`);
  if (diagnosticLog) modeError(mode, `   Diagnostic log: ${diagnosticLog}`);
  throw new CliHandledError(cause ?? new Error(message));
}
