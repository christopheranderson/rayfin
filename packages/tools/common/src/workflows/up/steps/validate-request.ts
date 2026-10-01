/**
 * `up` workflow step: validate the normalized request before any work begins.
 *
 * Replaces the inline guards scattered through the legacy `up.ts` action. The
 * raw flag mutual-exclusion checks (`--workspace` vs `--workspace-id`) and
 * `--exclude-services` parsing stay in Layer 1; this step validates the
 * product-level invariants the workflow itself depends on. Failures are
 * returned as a typed `invalid` outcome (with all messages collected) so the
 * entrypoint maps them to a single stable `Result.failed`.
 */
import { validateServiceDependencies } from '../../../config/index.js';
import type { Step } from '../../types.js';
import type { UpRequest } from '../types.js';

/** Outcome of {@link validateRequest}. */
export type ValidateRequestResult =
  | { status: 'valid' }
  | { status: 'invalid'; errors: string[] };

/**
 * Validate the {@link UpRequest}. Never throws — invalid input is a typed
 * outcome, not an exception.
 */
export const validateRequest: Step<
  UpRequest,
  ValidateRequestResult,
  Record<string, never>
> = async (req) => {
  const errors: string[] = [];

  if (!req.config?.id || req.config.id.trim().length === 0) {
    errors.push(
      "Project name not found in rayfin.yml configuration. Ensure rayfin.yml has a project 'id' field, or run 'rayfin init'."
    );
  }

  if (!req.itemName || req.itemName.trim().length === 0) {
    errors.push(
      'Fabric item name cannot be empty. Pass a non-empty value with --item-name <name>.'
    );
  }

  if (!req.workspaceId && !req.workspaceName) {
    errors.push(
      'No workspace targeting context. Provide --workspace, --workspace-id, or --workspace-uri.'
    );
  }

  if (req.config?.services) {
    errors.push(
      ...validateServiceDependencies({
        dataEnabled: req.config.services.data?.enabled === true,
        storageEnabled: req.config.services.storage?.enabled === true,
      }).map(({ message, hint }) => `${message}\n   ${hint}`)
    );
  }

  return errors.length > 0
    ? { status: 'invalid', errors }
    : { status: 'valid' };
};
