import type { UserInteraction } from '@microsoft/rayfin-tools-common/_internal/adapters';

/** How an interactive first deployment should resolve its Fabric workspace. */
export type WorkspaceResolutionChoice = 'new' | 'existing';

/** Shared choices for first-run Fabric workspace resolution. */
export const WORKSPACE_RESOLUTION_CHOICES = [
  { label: 'Use new workspace [Recommended]', value: 'new' },
  { label: 'Select existing workspace', value: 'existing' },
] as const;

/** Ask an interactive host whether to create or select a Fabric workspace. */
export async function selectWorkspaceResolution(
  ui: UserInteraction
): Promise<WorkspaceResolutionChoice | undefined> {
  return ui.select(
    'Choose a Fabric workspace for this deployment:',
    [...WORKSPACE_RESOLUTION_CHOICES],
    { requireExplicitChoice: true }
  );
}
