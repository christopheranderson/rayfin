import {
  validateFunctionsConfig,
  type FunctionsAuthConfig,
  type FunctionsConfig,
} from '@microsoft/rayfin-tools-common/_internal/config';

/** @internal */
export function createFunctionsAuthConfig(
  functions?: FunctionsConfig
): FunctionsAuthConfig {
  // Only an absent auth block gets a scaffold default. Explicit values,
  // including null and malformed mappings, must pass the shared contract.
  const auth: FunctionsAuthConfig =
    functions?.auth === undefined ? { type: 'application' } : functions.auth;
  const candidate =
    functions !== undefined &&
    functions !== null &&
    (typeof functions !== 'object' || Array.isArray(functions))
      ? functions
      : { ...functions, enabled: true, auth };
  const errors = validateFunctionsConfig(candidate);
  if (errors.length > 0) {
    throw new Error(errors.map(({ message }) => message).join('\n'));
  }
  return auth;
}
