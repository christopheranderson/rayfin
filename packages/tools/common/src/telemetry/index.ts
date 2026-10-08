export { InvocationContext } from './invocationContext.js';

export { RAYFIN_APPINSIGHTS_CONNECTION_STRING } from './connectionString.js';

export { isTelemetryEnabled } from './policy.js';
export type { TelemetryPolicyOptions } from './policy.js';

export {
  boundField,
  extractSafeParamNames,
  sanitizeException,
  sanitizeTelemetryProperty,
} from './sanitize.js';

export { toOpenTelemetryAttributes } from './serialize.js';
export type { TelemetryAttributeValue } from './serialize.js';

export type {
  ClientSource,
  EnvironmentInfo,
  MicrosoftPackageVersion,
  ProductName,
  RayfinActionEvent,
  RayfinCommandEvent,
  RayfinFaultEvent,
  ResultCategory,
  SerializedMicrosoftPackages,
  TelemetryMeasurementKey,
  TelemetryEnvironment,
  TelemetryPropertyKey,
  TelemetryPropertyPolicy,
} from './schema.js';
export {
  APPROVED_MICROSOFT_PACKAGE_NAMES,
  getTelemetryPropertyMaxLength,
  getTelemetryPropertyPolicy,
  isTelemetryMeasurementKey,
  isTelemetryMeasurementValue,
  isFabricActivityId,
  isApprovedMicrosoftPackageName,
  isTelemetryPackageVersion,
  isTelemetryEnvironment,
  isTelemetryPropertyKey,
  isTelemetryPropertyValue,
  MAX_FABRIC_ACTIVITY_IDS,
  serializeFabricActivityIds,
  serializeMicrosoftPackages,
  TELEMETRY_MEASUREMENT_KEYS,
  TELEMETRY_ENVIRONMENTS,
  TELEMETRY_PROPERTY_KEYS,
} from './schema.js';
