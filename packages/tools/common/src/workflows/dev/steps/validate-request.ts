/**
 * `dev` workflow step: validate the normalized request before any work begins.
 *
 * Layer 1 owns raw flag parsing (`--provider` value, `--purge`); this step
 * validates the product-level invariants the workflow depends on. Failures are
 * returned as a typed `invalid` outcome (with all messages collected) so the
 * entrypoint maps them to a single stable `Result.failed`.
 */
import type { Step } from '../../types.js';
import type { DevRequest } from '../types.js';

/** Outcome of {@link validateRequest}. */
export type ValidateRequestResult =
  | { status: 'valid' }
  | { status: 'invalid'; errors: string[] };

/**
 * Validate the {@link DevRequest}. Never throws — invalid input is a typed
 * outcome, not an exception.
 */
export const validateRequest: Step<
  DevRequest,
  ValidateRequestResult,
  Record<string, never>
> = async (req) => {
  const errors: string[] = [];

  if (!req.config?.id || req.config.id.trim().length === 0) {
    errors.push(
      "Project name not found in rayfin.yml configuration. Ensure rayfin.yml has a project 'id' field, or run 'rayfin init'."
    );
  }

  if (!req.provider || req.provider.trim().length === 0) {
    errors.push('No backend provider selected.');
  }

  return errors.length > 0
    ? { status: 'invalid', errors }
    : { status: 'valid' };
};
