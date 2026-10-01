/**
 * Pre-flight targeting resolution for the v2 `rayfin up` path (Layer 1).
 *
 * Resolves the targeting flags, ambient env, the recorded deployment registry,
 * or the interactive workspace picker into a concrete Fabric workspace id (and
 * any recorded deployment for the redeployment short-circuit) before the
 * workflow runs. Extracted from the thin `up-v2.ts` wrapper so that file stays
 * focused on flag parsing, host wiring, and rendering. Error rendering is
 * delegated to `render.ts`'s `failUp`/`failUpWithWarnings` so the whole
 * pre-flight shares one "render and abort" primitive.
 */
import {
  cancellationTokenFromSignal,
  type Diagnostics,
  type Logger,
  type Progress,
  type UserInteraction,
} from '@microsoft/rayfin-tools-common/_internal/adapters';
import { sanitizeWorkspaceName } from '@microsoft/rayfin-tools-common/_internal/config';
import {
  type CapacityAssignmentMode,
  type FabricCapacitySource,
  type FabricReadinessNotice,
  type PremiumCapacitySelectionPolicy,
  readinessHint,
  readinessHintForReason,
  runFabricReadinessWorkflow,
} from '@microsoft/rayfin-tools-common/_internal/workflows/fabric-readiness';

import { createCliFabricReadinessClient } from '../../external-services/fabric/index.js';
import { getAmbientWorkspaceId } from '../../utils/ambient-env.js';
import {
  type DeploymentRecord,
  listDeploymentsState,
} from '../../utils/deployments-registry.js';
import { type DeploymentEnvVars } from '../../utils/env-fabric-utils.js';
import { type OutputMode, modeWarn } from '../../utils/output-mode.js';
import {
  type ResolvedWorkspace,
  resolveWorkspaceFromList,
} from '../../utils/resolve-workspace-name.js';

import {
  promptWorkspaceResolution,
  promptWorkspaceSelection,
} from './prompts.js';
import { failUp, failUpWithWarnings, mergeWarnings } from './render.js';
import type { UpCommandOptions } from './up-v2.js';

/**
 * What the readiness pre-flight needs that the targeting chain does not
 * otherwise carry: the workspace name used when readiness needs to create a
 * target.
 */
export interface FabricReadinessContext {
  projectId: string;
  capacityId?: string;
  capacityAssignmentMode: CapacityAssignmentMode;
  premiumCapacitySelection: PremiumCapacitySelectionPolicy;
}

/** Resolve assignment consent consistently for execution and dry-run plans. */
export function resolveCapacityAssignmentMode(options: {
  capacityId?: string;
  autoConfirm: boolean;
  automaticWorkspaceResolution: boolean;
}): CapacityAssignmentMode {
  return options.capacityId ||
    options.autoConfirm ||
    options.automaticWorkspaceResolution
    ? 'automatic'
    : 'confirm';
}

/** Host adapters readiness reuses so output and prompts share one console. */
export interface TargetingHost {
  diagnostics: Diagnostics;
  logger: Logger;
  progress: Progress;
  ui?: UserInteraction;
}

/**
 * Resolve only targeting facts that are already available locally. Dry-run
 * uses this phase before authentication so recorded item names and registry
 * warnings are available for deterministic validation failures; successful
 * previews still perform the normal read-only workspace resolution.
 */
export function resolveLocalTargeting(
  options: Pick<UpCommandOptions, 'workspace' | 'workspaceId'>,
  projectRoot: string,
  interactive: boolean
): {
  existingDeployment: DeploymentEnvVars | null;
  hasWorkspaceTarget: boolean;
  warnings: string[];
} {
  if (options.workspaceId) {
    const existing = findDeploymentByWorkspaceId(
      projectRoot,
      options.workspaceId
    );
    return {
      existingDeployment: existing.deployment,
      hasWorkspaceTarget: true,
      warnings: existing.warnings,
    };
  }

  if (options.workspace) {
    const registry = listDeploymentsState(projectRoot);
    const workspaceKey = sanitizeWorkspaceName(options.workspace);
    const selected = registry.deployments.find(
      (deployment) => deployment.workspaceName === workspaceKey
    );
    return {
      existingDeployment: selected
        ? toDeploymentEnvVars(selected.record)
        : null,
      hasWorkspaceTarget: true,
      warnings: registry.warnings,
    };
  }

  const ambient = getAmbientWorkspaceId();
  if (ambient) {
    const existing = findDeploymentByWorkspaceId(projectRoot, ambient);
    return {
      existingDeployment: existing.deployment,
      hasWorkspaceTarget: true,
      warnings: existing.warnings,
    };
  }

  const registry = listDeploymentsState(projectRoot);
  const selected =
    registry.deployments.find((deployment) => deployment.active) ??
    (registry.deployments.length === 1 || !interactive
      ? registry.deployments[0]
      : undefined);

  return {
    existingDeployment: selected ? toDeploymentEnvVars(selected.record) : null,
    hasWorkspaceTarget:
      selected !== undefined ||
      (registry.deployments.length === 0 &&
        Boolean(process.env.RAYFIN_WORKSPACE_NAME)),
    warnings: registry.warnings,
  };
}

/**
 * Resolve a concrete target workspace id (and any recorded deployment for the
 * redeployment short-circuit) from the targeting flags, ambient env, the
 * deployment registry, Fabric readiness, or an interactive prompt — mirroring
 * the legacy pre-flight precedence. Always resolves names to ids so a recorded
 * deployment can be matched. Registry read warnings (e.g. a malformed
 * `.deployments.json`) are threaded back so the wrapper can surface or
 * serialize them.
 */
export async function resolveTargeting(
  options: UpCommandOptions,
  accessToken: string,
  mode: OutputMode,
  interactive: boolean,
  projectRoot: string,
  preflightWarnings: string[],
  readiness?: FabricReadinessContext,
  signal?: AbortSignal,
  diagnosticLog?: string,
  host?: TargetingHost
): Promise<
  | {
      workspaceId: string;
      existingDeployment: DeploymentEnvVars | null;
      warnings: string[];
      notices: FabricReadinessNotice[];
      workspaceCreated?: boolean;
      capacitySource?: FabricCapacitySource;
    }
  | {
      cancelled: true;
      notices: FabricReadinessNotice[];
    }
> {
  // `--workspace <name>` resolves to an id up front, the same way
  // `--workspace-uri` is normalized in `up-v2.ts`, so every explicitly
  // targeted workspace takes one path.
  const workspaceId =
    options.workspaceId ??
    (options.workspace
      ? await resolveNameToId(
          options.workspace,
          accessToken,
          mode,
          signal,
          diagnosticLog,
          host?.diagnostics
        ).catch((error: unknown) => {
          if (signal?.aborted) return undefined;
          throw error;
        })
      : undefined);
  if (signal?.aborted) {
    return { cancelled: true, notices: [] };
  }

  if (workspaceId) {
    const existing = findDeploymentByWorkspaceId(projectRoot, workspaceId);
    if (existing.deployment) {
      return {
        workspaceId,
        existingDeployment: existing.deployment,
        warnings: withIgnoredCapacityWarning(
          existing.warnings,
          options.capacityId
        ),
        notices: [],
      };
    }
    // Readiness runs here too, for one reason: a workspace carrying no
    // capacity cannot host a Rayfin item, and Fabric only says so at item
    // creation, as an opaque `400 The operation is not supported over the
    // capacity SKU`. Handed the id, `ensureFabricTarget` attaches a trial in
    // that case — and leaves capacity the workspace already has alone.
    // A failure is not fatal: the Builder targeted this workspace, so it stays
    // the target and the run proceeds as it would have without readiness.
    const attempt = readiness
      ? await prepareFabricTarget(
          readiness,
          accessToken,
          mode,
          host,
          workspaceId,
          signal
        )
      : undefined;
    if (attempt?.status === 'cancelled') return attempt;
    if (attempt?.status === 'action-required') {
      failReadinessActionRequired(
        attempt,
        mode,
        mergeWarnings(preflightWarnings, existing.warnings),
        diagnosticLog
      );
    }
    if (attempt?.status === 'declined') {
      return selectWorkspaceFallback(
        accessToken,
        mode,
        projectRoot,
        existing.warnings,
        attempt.notices,
        signal,
        diagnosticLog,
        host
      );
    }
    // Preserve whether readiness created the workspace so the workflow can
    // report that side effect in its structured result.
    const prepared =
      attempt?.status === 'ready' ? attempt.targeting : undefined;
    return {
      workspaceId,
      existingDeployment: existing.deployment,
      warnings:
        attempt?.status === 'unavailable'
          ? mergeWarnings(existing.warnings, attempt.warnings)
          : existing.warnings,
      workspaceCreated: prepared?.workspaceCreated,
      capacitySource: prepared?.capacitySource,
      notices: attempt?.notices ?? [],
    };
  }

  const ambient = getAmbientWorkspaceId();
  if (ambient) {
    const existing = findDeploymentByWorkspaceId(projectRoot, ambient);
    if (existing.deployment) {
      return {
        workspaceId: ambient,
        existingDeployment: existing.deployment,
        warnings: withIgnoredCapacityWarning(
          existing.warnings,
          options.capacityId
        ),
        notices: [],
      };
    }
    const attempt = readiness
      ? await prepareFabricTarget(
          readiness,
          accessToken,
          mode,
          host,
          ambient,
          signal
        )
      : undefined;
    if (attempt?.status === 'cancelled') return attempt;
    if (attempt?.status === 'action-required') {
      failReadinessActionRequired(
        attempt,
        mode,
        mergeWarnings(preflightWarnings, existing.warnings),
        diagnosticLog
      );
    }
    if (attempt?.status === 'declined') {
      return selectWorkspaceFallback(
        accessToken,
        mode,
        projectRoot,
        existing.warnings,
        attempt.notices,
        signal,
        diagnosticLog,
        host
      );
    }
    const prepared =
      attempt?.status === 'ready' ? attempt.targeting : undefined;
    return {
      workspaceId: ambient,
      existingDeployment: existing.deployment,
      warnings:
        attempt?.status === 'unavailable'
          ? mergeWarnings(existing.warnings, attempt.warnings)
          : existing.warnings,
      workspaceCreated: prepared?.workspaceCreated,
      capacitySource: prepared?.capacitySource,
      notices: attempt?.notices ?? [],
    };
  }

  const registry = listDeploymentsState(projectRoot);
  const selected =
    registry.deployments.find((deployment) => deployment.active) ??
    (registry.deployments.length === 1 || !interactive
      ? registry.deployments[0]
      : undefined);
  if (selected) {
    return {
      workspaceId: selected.record.workspaceId,
      existingDeployment: toDeploymentEnvVars(selected.record),
      warnings: withIgnoredCapacityWarning(
        registry.warnings,
        options.capacityId
      ),
      notices: [],
    };
  }

  if (interactive && registry.deployments.length > 1) {
    const selectedWorkspace = await host?.ui?.select(
      'Multiple Fabric workspace deployments found. Which one?',
      registry.deployments.map((deployment) => ({
        label: deployment.workspaceName,
        value: deployment.workspaceName,
      }))
    );
    const selectedDeployment = registry.deployments.find(
      (deployment) => deployment.workspaceName === selectedWorkspace
    );
    if (selectedDeployment) {
      return {
        workspaceId: selectedDeployment.record.workspaceId,
        existingDeployment: toDeploymentEnvVars(selectedDeployment.record),
        warnings: withIgnoredCapacityWarning(
          registry.warnings,
          options.capacityId
        ),
        notices: [],
      };
    }
  }

  const scaffoldWorkspaceName = process.env.RAYFIN_WORKSPACE_NAME;
  if (registry.deployments.length === 0 && scaffoldWorkspaceName) {
    const workspaceId = await resolveNameToId(
      scaffoldWorkspaceName,
      accessToken,
      mode,
      signal,
      diagnosticLog,
      host?.diagnostics
    ).catch((error: unknown) => {
      if (signal?.aborted) return undefined;
      throw error;
    });
    if (signal?.aborted || !workspaceId) {
      return { cancelled: true, notices: [] };
    }
    const attempt = readiness
      ? await prepareFabricTarget(
          readiness,
          accessToken,
          mode,
          host,
          workspaceId,
          signal
        )
      : undefined;
    if (attempt?.status === 'cancelled') return attempt;
    if (attempt?.status === 'action-required') {
      failReadinessActionRequired(
        attempt,
        mode,
        mergeWarnings(preflightWarnings, registry.warnings),
        diagnosticLog
      );
    }
    if (attempt?.status === 'declined') {
      return selectWorkspaceFallback(
        accessToken,
        mode,
        projectRoot,
        registry.warnings,
        attempt.notices,
        signal,
        diagnosticLog,
        host
      );
    }
    const prepared =
      attempt?.status === 'ready' ? attempt.targeting : undefined;
    return {
      workspaceId,
      existingDeployment: null,
      warnings:
        attempt?.status === 'unavailable'
          ? mergeWarnings(registry.warnings, attempt.warnings)
          : registry.warnings,
      notices: attempt?.notices ?? [],
      workspaceCreated: prepared?.workspaceCreated,
      capacitySource: prepared?.capacitySource,
    };
  }

  // Warnings carried into the fall-through paths below. Readiness failures are
  // appended here so `--json` still reports why auto-provisioning was skipped;
  // in text modes they are also rendered live, as they happen.
  const carriedWarnings = [...registry.warnings];
  const carriedNotices: FabricReadinessNotice[] = [];

  const shouldPromptWorkspaceResolution =
    readiness !== undefined && interactive && !readiness.capacityId;
  const workspaceResolution = shouldPromptWorkspaceResolution
    ? await promptWorkspaceResolution(host?.ui)
    : undefined;
  if (shouldPromptWorkspaceResolution && !workspaceResolution) {
    return { cancelled: true, notices: carriedNotices };
  }
  const shouldRunReadiness =
    readiness !== undefined && workspaceResolution !== 'existing';
  const readinessForAttempt = readiness
    ? {
        ...readiness,
        capacityAssignmentMode: resolveCapacityAssignmentMode({
          capacityId: readiness.capacityId,
          autoConfirm: readiness.capacityAssignmentMode === 'automatic',
          automaticWorkspaceResolution: !interactive,
        }),
      }
    : undefined;

  if (readinessForAttempt && shouldRunReadiness) {
    const attempt = await prepareFabricTarget(
      readinessForAttempt,
      accessToken,
      mode,
      host,
      undefined,
      signal
    );
    if (attempt.status === 'cancelled') return attempt;
    if (attempt.status === 'action-required') {
      failReadinessActionRequired(
        attempt,
        mode,
        mergeWarnings(preflightWarnings, carriedWarnings),
        diagnosticLog
      );
    } else if (attempt.status === 'declined') {
      carriedNotices.push(...attempt.notices);
    } else if (attempt.status === 'ready') {
      return {
        ...attempt.targeting,
        warnings: carriedWarnings,
        notices: attempt.notices,
      };
    } else {
      // A readiness problem is reported, not fatal: the Builder may still own a
      // workspace that can host the deployment, so fall through to the same
      // targeting chain a run without readiness would have taken.
      for (const warning of attempt.warnings) {
        if (!carriedWarnings.includes(warning)) carriedWarnings.push(warning);
      }
      carriedNotices.push(...attempt.notices);
    }
  }

  if (!interactive) {
    failUpWithWarnings(
      mode,
      'No workspace targeting context. Pass --workspace <name> (or ' +
        '--workspace-id <id> / --workspace-uri <url>), or run `rayfin up` ' +
        'once interactively to record a deployment.',
      mergeWarnings(preflightWarnings, carriedWarnings),
      carriedNotices,
      diagnosticLog
    );
  }

  // No targeting flags, ambient env, or recorded deployment: present the
  // caller's accessible Fabric workspaces as a numbered picker and deploy the
  // chosen one. The picker yields a workspace id directly, so no name→id
  // round-trip is needed.
  const choices = await listWorkspacesForPicker(
    accessToken,
    mode,
    signal,
    diagnosticLog,
    host?.diagnostics
  ).catch((error: unknown) => {
    if (signal?.aborted) return undefined;
    throw error;
  });
  if (!choices || signal?.aborted) {
    return { cancelled: true, notices: carriedNotices };
  }
  const chosen = await promptWorkspaceSelection(choices, host?.ui);
  if (!chosen) {
    return { cancelled: true, notices: carriedNotices };
  }
  const existing = findDeploymentByWorkspaceId(projectRoot, chosen.id);
  return {
    workspaceId: chosen.id,
    existingDeployment: existing.deployment,
    warnings: withIgnoredCapacityWarning(
      mergeWarnings(carriedWarnings, existing.warnings),
      options.capacityId
    ),
    notices: carriedNotices,
  };
}

/**
 * Run Fabric readiness as a pre-flight so a failure can fall back to the
 * ordinary targeting chain.
 *
 * Readiness is a convenience — it provisions a workspace and trial capacity
 * for a Builder who has neither. Running it inside the workflow made every
 * failure terminal, which is wrong for a convenience: a Builder whose tenant
 * blocks trials, or who signed in as a service principal, may still own a
 * perfectly good workspace. Attempting it here lets the caller keep walking
 * its own chain (the non-interactive guard, then the picker) on failure.
 * An explicit capacity is different: it is a strict target, so a failure to
 * use it must stop targeting rather than silently switching to a workspace
 * that does not use the requested capacity.
 *
 * Given a `workspaceId` it adopts that workspace instead of creating one:
 * capacity is attached only when the workspace has none, and an existing
 * assignment is never replaced.
 *
 * A newly created workspace is logged immediately and retained if a later
 * readiness operation fails, leaving cleanup as an explicit user decision.
 */
async function prepareFabricTarget(
  readiness: FabricReadinessContext,
  accessToken: string,
  mode: OutputMode,
  host: TargetingHost | undefined,
  workspaceId?: string,
  signal?: AbortSignal
): Promise<
  | {
      status: 'ready';
      targeting: {
        workspaceId: string;
        existingDeployment: null;
        workspaceCreated: boolean;
        capacitySource: FabricCapacitySource;
      };
      notices: FabricReadinessNotice[];
    }
  | {
      status: 'unavailable';
      warnings: string[];
      notices: FabricReadinessNotice[];
    }
  | {
      status: 'declined';
      notices: FabricReadinessNotice[];
    }
  | {
      status: 'action-required';
      problem: {
        reason: string;
        message: string;
        retryable: boolean;
      };
      notices: FabricReadinessNotice[];
    }
  | {
      status: 'cancelled';
      cancelled: true;
      notices: FabricReadinessNotice[];
    }
> {
  const logger = host?.logger;
  const completionLogger =
    mode === 'interactive' && logger
      ? {
          ...logger,
          log: (message: string) => logger.log(`✅ ${message}`),
        }
      : logger;
  const workflowResult = await runFabricReadinessWorkflow(
    {
      projectId: readiness.projectId,
      workspaceId,
      capacityId: readiness.capacityId,
      capacityAssignmentMode: readiness.capacityAssignmentMode,
    },
    {
      fabric: createCliFabricReadinessClient(accessToken, {
        diagnostics: host?.diagnostics,
        signal,
      }),
      logger: completionLogger,
      progress: host?.progress,
      ui: host?.ui,
      premiumCapacitySelection: readiness.premiumCapacitySelection,
      signal: signal ? cancellationTokenFromSignal(signal) : undefined,
    }
  );

  if (workflowResult.status === 'failed') {
    if (readiness.capacityId) {
      return {
        status: 'action-required',
        problem: {
          reason: workflowResult.error.code,
          message: workflowResult.error.message,
          retryable: true,
        },
        notices: workflowResult.notices ?? [],
      };
    }
    return {
      status: 'unavailable',
      warnings: [
        `Could not prepare a Fabric workspace automatically: ${workflowResult.error.message}`,
      ],
      notices: workflowResult.notices ?? [],
    };
  }
  if (workflowResult.status === 'cancelled') {
    return {
      status: 'cancelled',
      cancelled: true,
      notices: workflowResult.notices ?? [],
    };
  }

  const { result, notices } = workflowResult.data;
  if (result.status === 'assignment-declined') {
    return { status: 'declined', notices };
  }
  if (result.status !== 'ready' && readiness.capacityId) {
    return { status: 'action-required', problem: result, notices };
  }
  if (
    result.status !== 'ready' &&
    (result.reason === 'capacity_assignment_confirmation_required' ||
      (result.reason === 'capacity_selection_required' && !host?.ui))
  ) {
    return { status: 'action-required', problem: result, notices };
  }
  if (result.status !== 'ready') {
    const hint = readinessHint(result);
    const warning = `Could not prepare a Fabric workspace automatically: ${result.message}`;
    const warningPrefix = mode === 'interactive' ? '⚠️  ' : '';
    modeWarn(
      mode,
      `${warningPrefix}Could not prepare a Fabric workspace automatically.`
    );
    modeWarn(mode, `   ${result.message}`);
    modeWarn(mode, `   ${hint}`);
    return {
      status: 'unavailable',
      warnings:
        mode === 'json' || mode === 'silent' ? [`${warning} ${hint}`] : [],
      notices,
    };
  }

  return {
    status: 'ready',
    targeting: {
      workspaceId: result.workspace.id,
      existingDeployment: null,
      workspaceCreated: result.workspaceCreated,
      capacitySource: result.capacitySource,
    },
    notices,
  };
}

function failReadinessActionRequired(
  attempt: {
    problem: { reason: string; message: string; retryable: boolean };
    notices: FabricReadinessNotice[];
  },
  mode: OutputMode,
  warnings: string[],
  diagnosticLog?: string
): never {
  const hint = readinessHintForReason(attempt.problem.reason);
  failUpWithWarnings(
    mode,
    mode === 'json'
      ? attempt.problem.message
      : `${attempt.problem.message}\n   ${hint}`,
    warnings,
    attempt.notices,
    diagnosticLog,
    undefined,
    {
      status: 'action_required',
      code: attempt.problem.reason,
      reason: attempt.problem.reason,
      retryable: attempt.problem.retryable,
      hint,
    }
  );
}

function withIgnoredCapacityWarning(
  warnings: string[],
  capacityId: string | undefined
): string[] {
  if (!capacityId) return warnings;
  return mergeWarnings(warnings, [
    'Ignoring --capacity-id because an existing deployment keeps its current workspace capacity.',
  ]);
}

async function selectWorkspaceFallback(
  accessToken: string,
  mode: OutputMode,
  projectRoot: string,
  warnings: string[],
  notices: FabricReadinessNotice[],
  signal?: AbortSignal,
  diagnosticLog?: string,
  host?: TargetingHost
): Promise<
  | {
      workspaceId: string;
      existingDeployment: DeploymentEnvVars | null;
      warnings: string[];
      notices: FabricReadinessNotice[];
    }
  | { cancelled: true; notices: FabricReadinessNotice[] }
> {
  const choices = await listWorkspacesForPicker(
    accessToken,
    mode,
    signal,
    diagnosticLog,
    host?.diagnostics
  );
  if (signal?.aborted) return { cancelled: true, notices };
  const chosen = await promptWorkspaceSelection(choices, host?.ui);
  if (!chosen) return { cancelled: true, notices };
  const existing = findDeploymentByWorkspaceId(projectRoot, chosen.id);
  return {
    workspaceId: chosen.id,
    existingDeployment: existing.deployment,
    warnings: mergeWarnings(warnings, existing.warnings),
    notices,
  };
}

/**
 * Fetch the accessible workspaces for the interactive picker, rendering an
 * actionable failure when the Fabric list call errors or the account has none
 * (the picker would have nothing to offer). Fabric's list endpoint is paged, so
 * `listAccessibleWorkspaces` follows every continuation page — the picker
 * offers the caller's full set of workspaces, not just the first page.
 */
async function listWorkspacesForPicker(
  accessToken: string,
  mode: OutputMode,
  signal?: AbortSignal,
  diagnosticLog?: string,
  diagnostics?: Diagnostics
): Promise<ResolvedWorkspace[]> {
  let workspaces: ResolvedWorkspace[];
  try {
    workspaces = await createCliFabricReadinessClient(accessToken, {
      diagnostics,
      signal,
    }).listWorkspaces();
  } catch (err) {
    if (signal?.aborted) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    failUp(
      mode,
      'Unable to list Fabric workspaces.\n' +
        `   ${detail}\n` +
        '   Run `rayfin login` and retry, or pass --workspace-id <id> to skip the picker.',
      { diagnosticLog },
      err
    );
  }
  if (workspaces.length === 0) {
    failUp(
      mode,
      'No accessible Fabric workspaces found.\n' +
        '   Create a workspace in the Fabric portal, then re-run `rayfin up`.',
      { diagnosticLog }
    );
  }
  return workspaces;
}

/** Resolve a workspace display name to its GUID, rendering a failure on miss. */
async function resolveNameToId(
  name: string,
  accessToken: string,
  mode: OutputMode,
  signal?: AbortSignal,
  diagnosticLog?: string,
  diagnostics?: Diagnostics
): Promise<string> {
  try {
    const workspaces = await createCliFabricReadinessClient(accessToken, {
      diagnostics,
      signal,
    }).listWorkspaces();
    const resolved = resolveWorkspaceFromList(name, workspaces);
    return resolved.id;
  } catch (err) {
    if (signal?.aborted) throw err;
    failUp(
      mode,
      err instanceof Error ? err.message : String(err),
      { diagnosticLog },
      err
    );
  }
}

/** Find a recorded deployment for a workspace id by scanning the registry. */
function findDeploymentByWorkspaceId(
  projectRoot: string,
  workspaceId: string
): { deployment: DeploymentEnvVars | null; warnings: string[] } {
  const result = listDeploymentsState(projectRoot);
  const deployment = result.deployments.find(
    (entry) => entry.record.workspaceId === workspaceId
  );
  return {
    deployment: deployment ? toDeploymentEnvVars(deployment.record) : null,
    warnings: result.warnings,
  };
}

/** Map the storage-neutral registry record to the legacy Layer 1 shape. */
function toDeploymentEnvVars(record: DeploymentRecord): DeploymentEnvVars {
  return {
    rayfinItemId: record.itemId,
    rayfinItemName: record.itemName,
    rayfinApiUrl: record.apiUrl,
    fabricWorkspaceId: record.workspaceId,
    fabricTenantId: record.tenantId,
    publishableKey: record.publishableKey,
    fabricPortalUrl: record.portalUrl,
    hostingUrl: record.hostingUrl,
  };
}
