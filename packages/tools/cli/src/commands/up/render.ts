import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import type { FabricWorkspace } from '@microsoft/rayfin-tools-common/_internal/external/fabric';
import type { Result } from '@microsoft/rayfin-tools-common/_internal/workflows';
import type {
  CapacityAssignmentMode,
  PremiumCapacitySelectionPolicy,
} from '@microsoft/rayfin-tools-common/_internal/workflows/fabric-readiness';
import type {
  UpNotice,
  UpResult,
} from '@microsoft/rayfin-tools-common/_internal/workflows/up';

import {
  CliCancelledError,
  CliHandledError,
  getCliErrorPresentation,
} from '../../errors.js';
import { envBackupNoticeLines } from '../../utils/env-file-utils.js';
import {
  type OutputMode,
  emitJson,
  emitJsonError,
  modeError,
  modeLog,
  modeWarn,
} from '../../utils/output-mode.js';

import type { PreflightPlanEntry } from './anonstatic-preflight-plan.js';

export interface DryRunCapacityIntent {
  capacityId?: string;
  assignmentMode: CapacityAssignmentMode;
}

/** Render the workflow result and map failure to the CLI handled-error path. */
export function renderUpResult(
  result: Result<UpResult, UpNotice>,
  projectName: string,
  mode: OutputMode,
  preflightWarnings: string[] = [],
  cancelledByUser = false,
  diagnosticLog?: string
): void {
  if (result.status === 'cancelled') {
    const warnings = mergeWarnings(preflightWarnings, result.warnings ?? []);
    const operationCancelled =
      cancelledByUser ||
      result.notices?.some((notice) => notice.kind === 'operation-cancelled');
    if (mode === 'json') {
      emitJson({
        status: 'cancelled',
        reason: operationCancelled ? 'operation-cancelled' : 'reuse-declined',
        warnings,
        ...(result.notices && result.notices.length > 0
          ? { notices: result.notices }
          : {}),
      });
    } else {
      renderNotices(result.notices ?? [], mode);
      renderUpWarnings(withoutWarnings(warnings, preflightWarnings), mode);
      modeLog(
        mode,
        operationCancelled
          ? '\nDeployment cancelled.'
          : '\nDeployment cancelled — existing item was not reused.'
      );
    }
    if (operationCancelled) {
      throw new CliCancelledError();
    }
    return;
  }

  if (result.status === 'failed') {
    const warnings = mergeWarnings(preflightWarnings, result.warnings ?? []);
    const cause = result.error.cause ?? new Error(result.error.message);
    const presentation = getCliErrorPresentation(
      result.error.code,
      result.error.message
    );
    if (mode === 'json') {
      const extra: Record<string, unknown> = {
        code: result.error.code,
        ...(presentation.hint && { hint: presentation.hint }),
        ...(diagnosticLog && { diagnosticLog }),
      };
      if (result.notices && result.notices.length > 0) {
        extra.notices = result.notices;
      }
      extra.warnings = warnings;
      emitJsonError(mode, presentation.message, extra, cause);
    } else {
      renderNotices(result.notices ?? [], mode);
      renderUpWarnings(withoutWarnings(warnings, preflightWarnings), mode);
    }
    modeError(mode, `\n❌ Deployment failed: ${presentation.message}`);
    if (presentation.hint) {
      modeError(mode, `   ${presentation.hint}`);
    }
    if (diagnosticLog) modeError(mode, `   Diagnostic log: ${diagnosticLog}`);
    throw new CliHandledError(cause);
  }

  renderSuccess(
    result.data,
    mode === 'json'
      ? mergeWarnings(preflightWarnings, result.warnings ?? [])
      : withoutWarnings(result.warnings ?? [], preflightWarnings),
    projectName,
    mode
  );
}

/** Combine warning lists while preserving first-seen order. */
export function mergeWarnings(...groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}

/** Render workflow warnings after progress has stopped. */
export function renderUpWarnings(warnings: string[], mode: OutputMode): void {
  for (const warning of warnings) {
    modeWarn(mode, `⚠️  ${warning}`);
  }
}

/** Render a concise plan and its read-only resolved workspace target. */
export function renderUpDryRun(
  config: RayfinConfig,
  itemName: string,
  excludeStaticHosting: boolean,
  excludeFunctions: boolean,
  connectorsEnabled: boolean,
  mode: OutputMode,
  warnings: string[] = [],
  packageVersions: Record<string, string> = {},
  preflight: PreflightPlanEntry[] = [],
  diagnosticLog?: string,
  workspace?: Pick<FabricWorkspace, 'id' | 'displayName'>,
  hasExplicitWorkspace = false,
  premiumCapacitySelection: PremiumCapacitySelectionPolicy = 'fallback',
  capacityIntent?: DryRunCapacityIntent,
  reusesRecordedDeployment = false
): void {
  const services = config.services;
  const explicitCapacityId = capacityIntent?.capacityId;
  const fabricReadinessPlan = reusesRecordedDeployment
    ? {
        target: 'recorded-deployment' as const,
        checkCapacity: false,
        capacitySelection: 'skipped' as const,
        startTrialIfNeeded: false,
        createWorkspaceIfNeeded: false,
        assignCapacityIfNeeded: false,
      }
    : {
        target: hasExplicitWorkspace
          ? ('existing-workspace' as const)
          : ('conditional' as const),
        checkCapacity: true,
        capacitySelection: explicitCapacityId
          ? ('explicit' as const)
          : premiumCapacitySelection,
        ...(explicitCapacityId && { capacityId: explicitCapacityId }),
        ...(capacityIntent && {
          assignmentConsent: explicitCapacityId
            ? ('explicit-capacity' as const)
            : capacityIntent.assignmentMode === 'automatic'
              ? ('automatic' as const)
              : ('confirmation-required' as const),
        }),
        ...(capacityIntent?.assignmentMode === 'automatic' &&
          !explicitCapacityId && {
            ambiguousCapacitySelection: 'capacity-id-required' as const,
          }),
        startTrialIfNeeded: explicitCapacityId === undefined,
        createWorkspaceIfNeeded: !hasExplicitWorkspace,
        assignCapacityIfNeeded: true,
      };
  const staticHostingPlanned =
    (services.staticHosting?.enabled ?? false) && !excludeStaticHosting;
  const functionsPlanned =
    (services.functions?.enabled ?? false) && !excludeFunctions;
  const excludedServices = [
    ...(excludeStaticHosting ? ['staticHosting'] : []),
    ...(excludeFunctions ? ['functions'] : []),
  ];

  const blocked = preflight.some((entry) => entry.blocking);

  if (mode === 'json') {
    emitJson({
      status: 'dry-run',
      blocked,
      ...(blocked && diagnosticLog && { diagnosticLog }),
      plan: {
        projectName: config.id,
        itemName,
        ...(workspace && {
          workspaceId: workspace.id,
          workspaceName: workspace.displayName,
        }),
        services: {
          auth: services.auth.enabled,
          data: services.data.enabled,
          storage: services.storage?.enabled ?? false,
          staticHosting: staticHostingPlanned,
          functions: functionsPlanned,
        },
        configurationApplies: {
          data: services.data.enabled,
          storage: services.storage?.enabled ?? false,
        },
        connectors: connectorsEnabled
          ? (config.connectors ?? []).map(({ name, type }) => ({ name, type }))
          : [],
        excludedServices,
        packageVersions,
        preflight,
        targeting: { fabricReadiness: fabricReadinessPlan },
      },
      warnings,
    });
    if (blocked) throw new CliHandledError(new Error(DRY_RUN_BLOCKED_MESSAGE));
    return;
  }

  modeLog(
    mode,
    '\n🔍 DRY RUN MODE - No resources will be created or modified\n'
  );
  if (workspace) {
    modeLog(
      mode,
      `Workspace: "${workspace.displayName}" (ID: ${workspace.id})\n`
    );
  }
  modeLog(mode, 'Planned operations:');
  // The pre-flight resolves before anything remote exists, so it leads the plan
  // to match the order a real run would take.
  renderPreflightPlan(mode, preflight);
  if (reusesRecordedDeployment) {
    modeLog(
      mode,
      '  ✓ Reuse the recorded workspace and keep its current capacity'
    );
  } else {
    modeLog(
      mode,
      hasExplicitWorkspace
        ? '  ✓ Check whether the target workspace has usable Fabric capacity'
        : '  ✓ If no ambient or recorded target is selected, check for active Fabric capacity'
    );
    if (explicitCapacityId) {
      modeLog(
        mode,
        `  ✓ Use explicitly selected Fabric capacity ${explicitCapacityId}`
      );
    } else {
      modeLog(
        mode,
        premiumCapacitySelection === 'prompt'
          ? '  ✓ Select one premium capacity automatically or ask when several are available'
          : '  ✓ Select one premium capacity automatically; require interaction when several are available'
      );
      modeLog(mode, '  ✓ Start a Fabric trial if required');
    }
    if (!hasExplicitWorkspace) {
      modeLog(
        mode,
        '  ✓ Create a uniquely named Fabric workspace if targeting remains unresolved'
      );
    }
    modeLog(
      mode,
      explicitCapacityId
        ? '  ✓ Assign the explicitly selected capacity if required'
        : capacityIntent?.assignmentMode === 'automatic'
          ? '  ✓ Assign capacity automatically when selection is deterministic; require --capacity-id when multiple capacities are available'
          : capacityIntent
            ? '  ✓ Require confirmation before assigning the selected or trial capacity'
            : '  ✓ Assign the selected or trial capacity if required'
    );
  }
  modeLog(mode, `  ✓ Create or reuse Rayfin item "${itemName}" (AppBackend)`);
  const runtimeServices = [
    `auth=${services.auth.enabled}`,
    `data=${services.data.enabled}`,
  ];
  if (services.storage?.enabled) runtimeServices.push('storage=true');
  modeLog(mode, `  ✓ POST runtime settings (${runtimeServices.join(', ')})`);
  renderDeclaredPackageVersions(mode, packageVersions);
  if (services.data.enabled) {
    modeLog(mode, '  ✓ Generate and apply DAB configuration');
  }
  if (services.storage?.enabled) {
    modeLog(mode, '  ✓ Generate and apply storage configuration');
  }
  if (connectorsEnabled) {
    modeLog(mode, '  ✓ Generate and apply connector configs:');
    for (const connector of config.connectors ?? []) {
      modeLog(mode, `      • ${connector.name} (${connector.type})`);
    }
  }
  if (staticHostingPlanned) {
    modeLog(mode, '  ✓ Build, package, and deploy static content');
  }
  if (functionsPlanned) {
    modeLog(mode, '  ✓ Build, package, and deploy functions');
  }
  if (excludedServices.length > 0) {
    modeLog(mode, `  ⚠️  Excluded services: ${excludedServices.join(', ')}`);
  }
  modeLog(mode, '  ✓ Persist deployment metadata to rayfin/.deployments.json');
  if (blocked) {
    modeError(mode, `\n❌ ${DRY_RUN_BLOCKED_MESSAGE}`);
    if (diagnosticLog) modeError(mode, `   Diagnostic log: ${diagnosticLog}`);
    throw new CliHandledError(new Error(DRY_RUN_BLOCKED_MESSAGE));
  }
}

/** Explains a dry run that reported work a real `up` could not carry out. */
export const DRY_RUN_BLOCKED_MESSAGE =
  'Dry run found a blocking problem — `rayfin up` would fail.';

/** Render pre-flight entries, marking the ones that would stop a real run. */
export function renderPreflightPlan(
  mode: OutputMode,
  preflight: PreflightPlanEntry[]
): void {
  for (const entry of preflight) {
    modeLog(mode, `  ${entry.blocking ? '❌' : '✓'} ${entry.text}`);
  }
}

/**
 * List the `packageVersions` entries the deploy would declare.
 *
 * Not gated on any feature flag: the declaration itself is unconditional, so a
 * dry run has to show it even when posture onboarding is off.
 */
export function renderDeclaredPackageVersions(
  mode: OutputMode,
  packageVersions: Record<string, string>
): void {
  const entries = Object.entries(packageVersions);
  if (entries.length === 0) return;

  modeLog(mode, '  ✓ Declare package versions:');
  for (const [name, version] of entries) {
    modeLog(mode, `      • ${name} ${version}`);
  }
}

/** Render an error to the output mode and abort through the handled path. */
export function failUp(
  mode: OutputMode,
  message: string,
  extra?: Record<string, unknown>,
  cause?: unknown
): never {
  if (mode !== 'json') {
    modeError(mode, `❌ ${message}`);
    if (extra?.diagnosticLog)
      modeError(mode, `   Diagnostic log: ${extra.diagnosticLog}`);
  }
  return emitJsonError(mode, message, extra, cause);
}

/** Render or serialize pre-flight advisories before aborting targeting. */
export function failUpWithWarnings(
  mode: OutputMode,
  message: string,
  warnings: string[],
  notices: UpNotice[] = [],
  diagnosticLog?: string,
  cause?: unknown,
  extra: Record<string, unknown> = {}
): never {
  const uniqueWarnings = mergeWarnings(warnings);
  if (mode !== 'json') {
    renderUpWarnings(uniqueWarnings, mode);
  }
  return failUp(
    mode,
    message,
    {
      ...extra,
      warnings: uniqueWarnings,
      ...(notices.length > 0 ? { notices } : {}),
      ...(diagnosticLog && { diagnosticLog }),
    },
    cause
  );
}

function withoutWarnings(
  warnings: string[],
  alreadyRendered: string[]
): string[] {
  const rendered = new Set(alreadyRendered);
  return mergeWarnings(warnings).filter((warning) => !rendered.has(warning));
}

function renderNotices(notices: UpNotice[], mode: OutputMode): void {
  for (const notice of notices) {
    switch (notice.kind) {
      case 'env-backup':
        for (const line of envBackupNoticeLines(notice)) {
          modeLog(mode, line);
        }
        break;
      case 'workspace-created':
      case 'trial-started':
      case 'capacity-assigned':
        // Readiness logs these milestones immediately in text modes. The
        // structured notice remains available to JSON without duplicating text.
        break;
    }
  }
}

/**
 * Side effects a successful run performed on the Builder's behalf.
 *
 * Structured output includes every fact; text output omits readiness facts
 * because readiness logs each completed side effect immediately.
 */
function successNotices(data: UpResult): UpNotice[] {
  const notices: UpNotice[] = [...(data.readinessNotices ?? [])];
  if (data.envBackup) {
    notices.push({ kind: 'env-backup', ...data.envBackup });
  }
  if (data.workspaceCreated && !data.readinessNotices) {
    notices.push({
      kind: 'workspace-created',
      workspaceId: data.workspaceId,
      workspaceName: data.workspaceName,
    });
  }
  return notices;
}

function renderSuccess(
  data: UpResult,
  warnings: string[],
  projectName: string,
  mode: OutputMode
): void {
  const notices = successNotices(data);
  if (mode === 'json') {
    emitJson({
      status: 'success',
      deployment: {
        rayfinItemId: data.itemId,
        itemName: data.itemName,
        rayfinApiUrl: data.apiUrl,
        fabricWorkspaceId: data.workspaceId,
        fabricPortalUrl: data.portalUrl,
        publishableKey: data.publishableKey ?? null,
        hostingUrl: data.hostingUrl ?? null,
      },
      persistence: {
        workspaceKey: data.workspaceKey,
        configUpdated: data.configUpdated,
        envBackup: data.envBackup ?? null,
      },
      ...(notices.length > 0 ? { notices } : {}),
      excludedServices: data.excludedServices,
      generate: data.generate,
      skippedConnectors: data.generate.flatMap((result) =>
        result.status === 'skipped'
          ? [{ name: result.name, reason: result.reason }]
          : []
      ),
      warnings,
    });
    return;
  }

  if (data.configUpdated) {
    modeLog(mode, '✅ Updated rayfin.yml configuration');
  }
  renderNotices(
    notices.filter((notice) => notice.kind === 'env-backup'),
    mode
  );
  if (data.workspaceKey !== data.workspaceName) {
    modeLog(
      mode,
      `ℹ️  Workspace name sanitized: "${data.workspaceName}" → "${data.workspaceKey}"`
    );
  }

  renderUpWarnings(warnings, mode);
  modeLog(mode, '\n📝 Deployment details:');
  modeLog(mode, `  - Rayfin Item Name: ${data.itemName}`);
  modeLog(mode, `  - Rayfin Item ID: ${data.itemId}`);
  modeLog(mode, `  - Endpoint: ${data.apiUrl}`);
  modeLog(mode, `  - Fabric Workspace: ${data.workspaceId}`);
  modeLog(mode, `  - Portal: ${data.portalUrl}`);
  if (data.publishableKey) {
    modeLog(mode, `  - Publishable Key: ${data.publishableKey.slice(0, 8)}…`);
  }
  if (data.hostingUrl) {
    modeLog(mode, `  - Static Hosting URL: ${data.hostingUrl}`);
  }
  modeLog(mode, `\n🎉 Project "${projectName}" is now deployed to Fabric!`);
  modeLog(mode, `   • Open in Fabric portal: ${data.portalUrl}`);
  if (data.hostingUrl) {
    modeLog(mode, `   • Your app is live at: ${data.hostingUrl}`);
  }
}
