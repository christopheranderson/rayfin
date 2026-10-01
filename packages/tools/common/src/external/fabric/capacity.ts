/** Normalized Fabric capacity consumed by readiness workflows. */
export interface FabricCapacity {
  id: string;
  displayName: string;
  sku: string;
  state: string;
  type?: string;
  expirationDateTime?: string;
}

/**
 * Known Fabric trial capacity SKUs, used when `type` is absent.
 *
 * Fabric is migrating callers onto the `type` discriminator
 * (`FabricTrialCapacity`, `FSkuCapacity`, `PSkuCapacity`); until every tenant
 * reports it, SKU remains the fallback. The SKU fallback is an allowlist
 * rather than an `FT` prefix test so an unrelated future `FT*` SKU cannot be
 * mistaken for a trial.
 */
export const TRIAL_CAPACITY_SKUS: readonly string[] = ['FT1', 'FTL4', 'FTL64'];

const TRIAL_CAPACITY_TYPES = new Set(['trial', 'fabrictrialcapacity']);
// TODO: Consolidate this allowlist with the Fabric capacity SKU catalog from
// `dev/chcaruso/feat-rayfin-capacity-ops` after that branch merges into `main`.
export const PREMIUM_CAPACITY_SKUS = [
  'P1',
  'P2',
  'P3',
  'P4',
  'P5',
  'F2',
  'F4',
  'F8',
  'F16',
  'F32',
  'F64',
  'F128',
  'F256',
  'F512',
  'F1024',
  'F2048',
  'F4096',
  'F8192',
] as const;
const SUPPORTED_PREMIUM_CAPACITY_SKUS = new Set<string>(PREMIUM_CAPACITY_SKUS);

/**
 * Whether Rayfin may deploy onto an existing capacity: it must be active and
 * either a recognized trial or an explicitly supported premium SKU.
 */
export function isUsableCapacity(capacity: FabricCapacity): boolean {
  return (
    isActiveCapacity(capacity) &&
    (matchesTrial(capacity, TRIAL_CAPACITY_SKUS) ||
      isSupportedPremiumCapacitySku(capacity.sku))
  );
}

/**
 * Whether a usable capacity is a Fabric trial.
 *
 * `trialSkus` exists so a host can track new trial SKUs without a code change;
 * pass a call site an explicit arrow (not a bare reference) so `Array.find`
 * never supplies its index argument here.
 */
export function isTrialCapacity(
  capacity: FabricCapacity,
  trialSkus: readonly string[] = TRIAL_CAPACITY_SKUS
): boolean {
  return isActiveCapacity(capacity) && matchesTrial(capacity, trialSkus);
}

/**
 * Whether Rayfin may assign a premium capacity to a workspace.
 *
 * Selection is intentionally narrower than {@link isUsableCapacity}: only
 * active capacity from the explicit P1-P5 and Fabric F-SKU allowlist is
 * eligible. Trial capacity follows the separate trial flow, and unknown future
 * SKUs are not selected automatically.
 */
export function isSelectablePaidCapacity(capacity: FabricCapacity): boolean {
  if (!isActiveCapacity(capacity) || isTrialCapacity(capacity)) return false;

  return isSupportedPremiumCapacitySku(capacity.sku);
}

/** Whether Fabric reports a capacity as active. */
export function isActiveCapacity(capacity: FabricCapacity): boolean {
  return capacity.state.toLowerCase() === 'active';
}

/** Whether a SKU is in the explicit premium-capacity allowlist. */
export function isSupportedPremiumCapacitySku(sku: string): boolean {
  return SUPPORTED_PREMIUM_CAPACITY_SKUS.has(sku.toUpperCase());
}

function matchesTrial(
  capacity: FabricCapacity,
  trialSkus: readonly string[]
): boolean {
  if (isTrialType(capacity)) return true;
  const sku = capacity.sku.toUpperCase();
  return trialSkus.some((allowed) => allowed.toUpperCase() === sku);
}

function isTrialType(capacity: FabricCapacity): boolean {
  return TRIAL_CAPACITY_TYPES.has(capacity.type?.toLowerCase() ?? '');
}

/**
 * Documented outcomes returned by the Fabric trial eligibility API.
 *
 * These are the public `EligibilityReason` values. Fabric maps its internal
 * `TrialCapacityCreationResult` onto them, so the internal spelling
 * `ActiveTrialExists` never reaches the wire — it surfaces as
 * `TrialAlreadyExists`, matching the error code Start Trial returns for the
 * same situation.
 */
export type TrialEligibilityReason =
  | 'Eligible'
  | 'TrialAlreadyExists'
  | 'TrialsDisabled'
  | 'TrialLimitExceeded'
  | 'IneligibleForTrial';

/** Normalized Fabric trial eligibility result. */
export interface TrialEligibility {
  eligible: boolean;
  reason: TrialEligibilityReason;
}

/** Normalized status returned by a Fabric long-running operation. */
export interface FabricOperationStatus {
  status: 'Running' | 'Succeeded' | 'Failed' | 'Canceled' | 'Cancelled';
  error?: unknown;
  /**
   * Pacing hint from the status response's `Retry-After` header, in
   * milliseconds. Fabric refreshes it on every poll, so a caller running its
   * own poll loop should prefer this over the value carried by the original
   * `202 Accepted`.
   */
  retryAfterMs?: number;
}
