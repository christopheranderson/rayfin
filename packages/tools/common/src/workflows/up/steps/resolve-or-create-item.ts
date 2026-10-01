/**
 * `up` workflow step: resolve the target Rayfin item, creating it when absent.
 *
 * Looks for an existing same-named item in the resolved workspace. A new
 * project name has no match and an item is created. A name that already maps
 * to a remote item requires consent to reuse (the deployment overwrites that
 * item's config): `autoConfirmReuse` grants it up front (`--yes`); otherwise
 * the user is asked via {@link UserInteraction}. When no interactive capability
 * is wired (non-interactive host), an unconsented reuse is returned as a typed
 * requirement rather than silently overwriting the item.
 *
 * The step is registry-free and takes resolved identifiers as typed input.
 * Outcomes are returned as a typed result — a declined reuse is a user
 * cancellation, not a failure, so the workflow entrypoint can map it to
 * `Result.cancelled` without inspecting thrown errors.
 */
import type { UserInteraction } from '../../../adapters/index.js';
import {
  FabricError,
  type FabricClient,
  type FabricItem,
} from '../../../external/fabric/index.js';
import type { Step } from '../../types.js';

/** Identifiers for the target item, resolved upstream in the workflow. */
export interface ResolveOrCreateItemInput {
  /** GUID of the workspace the item belongs to. */
  workspaceId: string;
  /** Item display name (the project name). */
  displayName: string;
  /** Workspace display name, used only to make reuse messages actionable. */
  workspaceDisplayName?: string;
  /**
   * When true, reuse an existing same-named item without prompting (wired to
   * `--yes`). Has no effect when no matching item exists.
   */
  autoConfirmReuse?: boolean;
}

/** Outcome of {@link resolveOrCreateItem}. */
export type ResolveOrCreateItemResult =
  | {
      status: 'resolved';
      /** The item to deploy to. */
      item: FabricItem;
      /** True when the item was created by this step, false when reused. */
      created: boolean;
    }
  | {
      /** The user declined to reuse the existing same-named item. */
      status: 'reuse-declined';
    }
  | {
      /** Reuse requires consent, but this host cannot prompt for it. */
      status: 'reuse-required';
      /** The existing item that requires explicit reuse consent. */
      item: FabricItem;
    }
  | {
      /** The workspace capacity cannot accept another Rayfin item. */
      status: 'capacity-exhausted';
      /** Original structured Fabric error retained for diagnostics. */
      cause: FabricError;
    };

/** Capabilities {@link resolveOrCreateItem} composes. */
export interface ResolveOrCreateItemDeps {
  fabric: FabricClient;
  /** Absent on non-interactive hosts; its absence forbids unconsented reuse. */
  ui?: UserInteraction;
}

/**
 * Resolve {@link ResolveOrCreateItemInput} to a concrete {@link FabricItem},
 * creating one when the workspace has no same-named item.
 *
 * A same-named item without pre-approval or interactive input is returned as
 * `reuse-required`; callers own command-specific recovery guidance.
 */
export const resolveOrCreateItem: Step<
  ResolveOrCreateItemInput,
  ResolveOrCreateItemResult,
  ResolveOrCreateItemDeps
> = async (input, { fabric, ui }) => {
  const { workspaceId, displayName } = input;

  const existing = await fabric.getItemByName(workspaceId, displayName);
  if (!existing) {
    try {
      const item = await fabric.createItem(workspaceId, displayName);
      return { status: 'resolved', item, created: true };
    } catch (error) {
      if (
        error instanceof FabricError &&
        error.errorCode?.toLowerCase() === 'capacitylimitexceeded'
      ) {
        return { status: 'capacity-exhausted', cause: error };
      }
      throw error;
    }
  }

  if (input.autoConfirmReuse) {
    return { status: 'resolved', item: existing, created: false };
  }

  if (!ui) {
    return { status: 'reuse-required', item: existing };
  }

  const confirmed = await ui.confirm(
    reuseConfirmMessage(displayName, existing.id, input.workspaceDisplayName),
    { default: false }
  );
  if (!confirmed) {
    return { status: 'reuse-declined' };
  }

  return { status: 'resolved', item: existing, created: false };
};

/** Label for the target workspace in user-facing reuse messages. */
function workspaceLabel(workspaceDisplayName?: string): string {
  return workspaceDisplayName ?? 'the target workspace';
}

/** Confirmation message asking whether to reuse and overwrite an existing item. */
function reuseConfirmMessage(
  displayName: string,
  itemId: string,
  workspaceDisplayName?: string
): string {
  return (
    `A Rayfin item named "${displayName}" already exists in ` +
    `"${workspaceLabel(workspaceDisplayName)}" (ID: ${itemId}) and this ` +
    `project has not been deployed there before. Use the existing item and ` +
    `overwrite its config?`
  );
}
