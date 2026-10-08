/**
 * Pre-flight interactive prompts for `rayfin up`.
 *
 * These collect input *before* the workflow runs — keeping `runUpWorkflow`
 * free of inquirer and host TTY concerns (RFC Rule #2). The workflow's own
 * mid-flow consent (item reuse) is a separate `UserInteraction` dependency;
 * this module handles the up-front workspace strategy and accessible-workspace
 * selection used when no targeting context exists.
 */
import type { UserInteraction } from '@microsoft/rayfin-tools-common/_internal/adapters';
import inquirer from 'inquirer';

import {
  selectWorkspaceResolution,
  type WorkspaceResolutionChoice,
  WORKSPACE_RESOLUTION_CHOICES,
} from '../../utils/workspace-resolution.js';

/** A workspace offered in the {@link promptWorkspaceSelection} picker. */
export interface SelectableWorkspace {
  /** Workspace GUID, returned when the entry is chosen. */
  id: string;
  /** Human-readable workspace name shown in the picker. */
  displayName: string;
}

/**
 * Ask whether a first deployment should prepare a new workspace or use the
 * existing-workspace picker. The numbered raw list requires an explicit
 * answer because the selection determines whether capacity readiness runs.
 */
export async function promptWorkspaceResolution(
  ui?: UserInteraction
): Promise<WorkspaceResolutionChoice | undefined> {
  if (ui) {
    return selectWorkspaceResolution(ui);
  }
  const { workspaceResolution } = await inquirer.prompt<{
    workspaceResolution: WorkspaceResolutionChoice;
  }>([
    {
      type: 'rawlist',
      name: 'workspaceResolution',
      message: 'Choose a Fabric workspace for this deployment:',
      choices: WORKSPACE_RESOLUTION_CHOICES.map((choice) => ({
        name: choice.label,
        value: choice.value,
      })),
    },
  ]);
  return workspaceResolution;
}

/**
 * Present a numbered picker of accessible Fabric workspaces and resolve to the
 * chosen one. Entries are sorted case-insensitively by display name so the
 * list is stable and scannable, and rendered as a `rawlist` so the user
 * selects by typing a number.
 *
 * Only called on interactive hosts with a non-empty list: non-interactive
 * callers must pass explicit targeting flags, and the empty-list case is
 * handled by the caller before prompting.
 */
export async function promptWorkspaceSelection(
  workspaces: SelectableWorkspace[],
  ui?: UserInteraction
): Promise<SelectableWorkspace | undefined> {
  const sorted = [...workspaces].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, {
      sensitivity: 'base',
    })
  );
  const displayNameCounts = new Map<string, number>();
  for (const workspace of sorted) {
    const normalizedName = workspace.displayName.toLocaleLowerCase();
    displayNameCounts.set(
      normalizedName,
      (displayNameCounts.get(normalizedName) ?? 0) + 1
    );
  }
  const choices = sorted.map((workspace) => ({
    label:
      displayNameCounts.get(workspace.displayName.toLocaleLowerCase()) === 1
        ? workspace.displayName
        : `${workspace.displayName} (${workspace.id})`,
    value: workspace,
  }));
  if (ui) {
    return ui.select('Select a Fabric workspace to deploy to:', choices, {
      requireExplicitChoice: true,
    });
  }
  const { selectedWorkspace } = await inquirer.prompt<{
    selectedWorkspace: SelectableWorkspace;
  }>([
    {
      type: 'rawlist',
      name: 'selectedWorkspace',
      message: 'Select a Fabric workspace to deploy to:',
      choices: choices.map((choice) => ({
        name: choice.label,
        value: choice.value,
      })),
    },
  ]);
  return selectedWorkspace;
}
