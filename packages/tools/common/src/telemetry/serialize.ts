/**
 * OpenTelemetry serialization for Rayfin command events.
 *
 * Node hosts use this module to preserve one stable wire mapping while the
 * universal invocation context remains transport-independent.
 */
import {
  isTelemetryMeasurementKey,
  isTelemetryMeasurementValue,
  isTelemetryPropertyKey,
  isTelemetryPropertyValue,
  type RayfinCommandEvent,
} from './schema.js';

/** Attribute values supported by the OpenTelemetry log transport. */
export type TelemetryAttributeValue = string | number;

/**
 * Flatten a command event into the attributes emitted by Rayfin's Node hosts.
 * Core fields win over custom enrichment when names collide.
 */
export function toOpenTelemetryAttributes(
  event: RayfinCommandEvent
): Record<string, TelemetryAttributeValue> {
  const enrichment: Record<string, TelemetryAttributeValue> = {};
  for (const [key, value] of Object.entries(event.properties ?? {})) {
    if (isTelemetryPropertyKey(key) && isTelemetryPropertyValue(key, value)) {
      enrichment[`rayfin.${key}`] = value;
    }
  }
  for (const [key, value] of Object.entries(event.measurements ?? {})) {
    if (
      isTelemetryMeasurementKey(key) &&
      isTelemetryMeasurementValue(key, value)
    ) {
      enrichment[`rayfin.${key}`] = value;
    }
  }

  return {
    ...enrichment,
    'event.name': event.eventName,
    'ai.operation.name': event.eventName,
    'rayfin.schema_version': event.schemaVersion,
    'rayfin.correlation_id': event.correlationId,
    'rayfin.product_name': event.productName,
    'rayfin.product_version': event.productVersion,
    'rayfin.client_source': event.clientSource,
    'rayfin.command_name': event.commandName,
    'rayfin.safe_parameter_names': event.safeParameterNames.join(','),
    'rayfin.template_name': event.templateName ?? '',
    'rayfin.result_category': event.resultCategory,
    'rayfin.result_summary': event.resultSummary ?? '',
    'rayfin.duration_ms': event.durationMs,
    'rayfin.os_type': event.osType,
    'rayfin.os_version': event.osVersion,
    'rayfin.node_version': event.nodeVersion,
    'rayfin.shell_type': event.shellType ?? '',
    'rayfin.dev_device_id': event.devDeviceId ?? '',
    'rayfin.error_type': event.errorType ?? '',
    'rayfin.error_name': event.errorName ?? '',
  };
}
