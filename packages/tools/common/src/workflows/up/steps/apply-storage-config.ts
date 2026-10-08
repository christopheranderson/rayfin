/**
 * `up` workflow step: apply the storage configuration to the deployed workload.
 *
 * Delegates generation + remote apply to the {@link StorageService}. Fatality
 * mirrors the data step: all failures are **non-fatal** (returned as a typed
 * warning so a transient workload hiccup doesn't kill the rest of the
 * deployment). The user can re-run `rayfin up storage apply` afterwards.
 */
import type { WorkloadTarget } from '../../../external/fabric/index.js';
import {
  isStorageApplyError,
  type StorageService,
} from '../../../services/storage/index.js';
import type { Step } from '../../types.js';

/** Inputs for {@link applyStorageConfig}. */
export interface ApplyStorageConfigInput {
  /** Resolved workload coordinates for the deployed item. */
  target: WorkloadTarget;
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
  /** Allow destructive storage changes (`--force`). */
  force?: boolean;
}

/** Outcome of {@link applyStorageConfig}. */
export type ApplyStorageConfigResult =
  | { status: 'applied' }
  | { status: 'failed-nonfatal'; message: string };

/** Capabilities {@link applyStorageConfig} composes. */
export interface ApplyStorageConfigDeps {
  storage: StorageService;
}

/**
 * Apply the storage configuration to the remote workload.
 */
export const applyStorageConfig: Step<
  ApplyStorageConfigInput,
  ApplyStorageConfigResult,
  ApplyStorageConfigDeps
> = async (input, { storage }) => {
  try {
    await storage.applyStorageConfig({
      projectRoot: input.projectRoot,
      target: input.target,
      force: input.force,
    });
    return { status: 'applied' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      isStorageApplyError(error) &&
      (error.status === 409 || error.code === 'removal-blocked')
    ) {
      throw error;
    }
    return { status: 'failed-nonfatal', message };
  }
};
