import { getAmbientTenantId } from './ambient-env.js';

/**
 * Resolves the effective Entra ID tenant for an `up` invocation.
 *
 * Precedence (highest first):
 *   1. `--tenant` CLI flag (explicit user intent)
 *   2. `RAYFIN_TENANT_ID` env var (ambient / platform-provided)
 *   3. `authState.tenantId` (tenant the user is currently signed into)
 *
 * Returns `undefined` when no source supplies a value.
 */
export function resolveEffectiveTenantId(
  cmdOptionsTenant: string | undefined,
  authStateTenantId: string | undefined
): string | undefined {
  return cmdOptionsTenant ?? getAmbientTenantId() ?? authStateTenantId;
}
