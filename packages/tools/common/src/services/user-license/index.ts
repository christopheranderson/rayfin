export { FabricLicenseProbe } from './fabric-probe.js';
export type { FabricLicenseProbeOptions } from './fabric-probe.js';
export {
  BoundedPollingLicenseResolutionStrategy,
  FabricUserLicenseService,
  ManualLicenseResolutionStrategy,
  noOpUserLicenseService,
  systemLicenseClock,
} from './service.js';
export type {
  BoundedPollingOptions,
  FabricUserLicenseServiceOptions,
} from './service.js';
export type {
  EnsureUserHasLicenseOutcome,
  EnsureUserHasLicenseRequest,
  ExternalNavigation,
  LicenseClock,
  LicenseProbe,
  LicenseProbeOptions,
  LicenseProbeOutcome,
  LicenseResolutionStrategy,
  UserLicenseService,
} from './types.js';
export { UserLicenseError } from './types.js';
