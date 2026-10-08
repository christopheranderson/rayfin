/**
 * Storage product-service contract (Layer 3).
 *
 * Generates the storage configuration from a project's TypeScript `@blob`
 * decorators and applies it to the deployed remote workload. Workflows declare
 * this in their `Deps` and never touch the filesystem, endpoints, or output
 * rendering directly.
 *
 * The implementation that performs filesystem and network IO lives in the host
 * (`cli/src/rayfin-services/storage.ts`).
 */
import type { WorkloadTarget } from '../../external/fabric/index.js';

/** Inputs for {@link StorageService.applyStorageConfig}. */
export interface ApplyStorageConfigRequest {
  /** Absolute path to the Rayfin project root. */
  projectRoot: string;
  /** Resolved workload coordinates for the deployed item. */
  target: WorkloadTarget;
  /**
   * Allow the storage controller to accept configuration that may result in
   * data loss (e.g. removing folders that still contain objects).
   */
  force?: boolean;
}

/** Stable failure categories for storage configuration apply. */
export type StorageApplyErrorCode = 'removal-blocked' | 'request-failed';

/**
 * Typed storage apply failure surfaced by host implementations.
 *
 * Workflows use {@link status} and {@link code} for policy decisions instead
 * of parsing human-readable error messages.
 */
export class StorageApplyError extends Error {
  override readonly name = 'StorageApplyError';

  constructor(
    message: string,
    readonly status: number,
    readonly code: StorageApplyErrorCode,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

/** Determine whether an unknown failure is a typed storage apply error. */
export function isStorageApplyError(
  error: unknown
): error is StorageApplyError {
  return error instanceof StorageApplyError;
}

export interface StorageService {
  /**
   * Regenerate the storage configuration from the project's `@blob` classes
   * and apply it to the remote workload. A project with no storage folders is
   * a no-op. Rejects when generation or the apply request fails.
   */
  applyStorageConfig(request: ApplyStorageConfigRequest): Promise<void>;
}
