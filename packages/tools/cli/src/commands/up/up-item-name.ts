import { type OutputMode } from '../../utils/output-mode.js';

import { failUp } from './render.js';

export interface ResolveItemNameOptions {
  explicitItemName?: string;
  recordedItemName?: string;
  hasRecordedItemId: boolean;
  fallbackItemName: string;
  mode: OutputMode;
  workspaceDisplayName?: string;
  fail?: (message: string) => never;
}

/**
 * Resolve the effective Fabric item name and protect recorded deployments from
 * being retargeted by a conflicting override.
 */
export function resolveItemName(options: ResolveItemNameOptions): string {
  const {
    explicitItemName,
    recordedItemName,
    hasRecordedItemId,
    fallbackItemName,
    mode,
    workspaceDisplayName,
    fail = (message) => failUp(mode, message),
  } = options;

  if (explicitItemName && hasRecordedItemId && !recordedItemName) {
    fail(
      'This workspace already has a recorded deployment, but its Fabric item name was not recorded.\n' +
        '   Omit --item-name to redeploy the existing item, or deploy to a different workspace.'
    );
  }

  if (
    explicitItemName &&
    recordedItemName &&
    explicitItemName.toLowerCase() !== recordedItemName.toLowerCase()
  ) {
    const workspaceSuffix = workspaceDisplayName
      ? ` in workspace "${workspaceDisplayName}"`
      : ' in the target workspace';
    fail(
      `This project already deploys to "${recordedItemName}"${workspaceSuffix}.\n` +
        '   Omit --item-name to redeploy the existing item, or deploy to a different workspace.'
    );
  }

  return recordedItemName ?? explicitItemName ?? fallbackItemName;
}
