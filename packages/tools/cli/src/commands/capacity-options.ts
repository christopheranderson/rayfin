const GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CapacityOptionError {
  code:
    | 'invalid-capacity-id'
    | 'capacity-target-conflict'
    | 'capacity-provider-conflict';
  message: string;
  recoveryHint: string;
}

/** Validate capacity flags shared by `rayfin up` and Fabric-backed `rayfin dev`. */
export function validateCapacityOptions(options: {
  capacityId?: string;
  workspace?: string;
  workspaceId?: string;
  workspaceUri?: string;
  ambientWorkspaceId?: string;
  provider?: string;
}): CapacityOptionError[] {
  const errors: CapacityOptionError[] = [];
  if (
    options.capacityId !== undefined &&
    !GUID_PATTERN.test(options.capacityId)
  ) {
    errors.push({
      code: 'invalid-capacity-id',
      message: '--capacity-id must be a GUID.',
      recoveryHint: 'Pass the Fabric capacity GUID shown in the Fabric portal.',
    });
  }
  const workspaceOption = options.workspace
    ? '--workspace'
    : options.workspaceId
      ? '--workspace-id'
      : options.workspaceUri
        ? '--workspace-uri'
        : undefined;
  if (workspaceOption && options.capacityId) {
    errors.push({
      code: 'capacity-target-conflict',
      message: `${workspaceOption} and --capacity-id cannot be used together.`,
      recoveryHint:
        'Remove one option so Rayfin resolves either the workspace or the capacity.',
    });
  }
  if (options.ambientWorkspaceId && options.capacityId) {
    errors.push({
      code: 'capacity-target-conflict',
      message: 'RAYFIN_WORKSPACE_ID and --capacity-id cannot be used together.',
      recoveryHint:
        'Unset RAYFIN_WORKSPACE_ID or remove --capacity-id so Rayfin targets either the workspace or the capacity.',
    });
  }
  if (
    options.provider?.toLowerCase() === 'docker' &&
    options.capacityId !== undefined
  ) {
    errors.push({
      code: 'capacity-provider-conflict',
      message:
        'Capacity assignment options are only available with the Fabric provider.',
      recoveryHint: 'Remove --capacity-id, or use --provider fabric.',
    });
  }
  return errors;
}
