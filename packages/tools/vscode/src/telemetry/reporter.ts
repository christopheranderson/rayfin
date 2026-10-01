/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Thin wrapper around `@vscode/extension-telemetry` that exposes a
 * simplified interface for emitting telemetry events and error events.
 *
 * The wrapper owns the underlying {@link VsCodeTelemetryReporter}
 * lifecycle and is registered as a disposable in `activate()`.
 */

import type { RayfinCommandEvent } from '@microsoft/rayfin-tools-common/_internal/telemetry';
import {
  TelemetryReporter as VsCodeTelemetryReporter,
  type TelemetryEventProperties,
} from '@vscode/extension-telemetry';
import { TelemetryTrustedValue } from 'vscode';

/**
 * Default 1DS (One Data Strategy) ingestion key for the VS Code
 * extension telemetry pipeline. This is a **write-only key** — it can
 * only be used to *send* telemetry, not to read or query data — so it
 * is safe to embed in source.
 *
 * Override at runtime via the `RAYFIN_APPINSIGHTS_CONNECTION_STRING`
 * environment variable to route to a different endpoint (e.g. a test
 * App Insights instance).
 */
const RAYFIN_VSCODE_1DS_KEY =
  '0c6ae279ed8443289764825290e4f9e2-1a736e7c-1324-4338-be46-fc2a58ae4d14-7255';

export class TelemetryReporter {
  private readonly _reporter: VsCodeTelemetryReporter;

  constructor(connectionString?: string) {
    const envCs = (
      (globalThis as any).process as
        | { env: Record<string, string | undefined> }
        | undefined
    )?.env['RAYFIN_APPINSIGHTS_CONNECTION_STRING'];
    const cs = connectionString ?? envCs ?? RAYFIN_VSCODE_1DS_KEY;
    this._reporter = new VsCodeTelemetryReporter(cs);
  }

  /**
   * Send a command-level telemetry event produced by
   * {@link InvocationContext.finalize}.
   */
  sendCommandEvent(
    event: RayfinCommandEvent,
    extraProperties?: Record<string, string>
  ): void {
    const properties: TelemetryEventProperties = {
      ...flattenProperties(event),
      ...extraProperties,
    };
    const measurements = flattenMeasurements(event);
    if (event.resultCategory === 'Failure') {
      this._reporter.sendTelemetryErrorEvent(
        event.eventName,
        properties,
        measurements
      );
    } else {
      this._reporter.sendTelemetryEvent(
        event.eventName,
        properties,
        measurements
      );
    }
  }

  /**
   * Send a generic action event (e.g. UI interaction from a webview).
   */
  sendActionEvent(
    eventName: string,
    properties?: Record<string, string>,
    measurements?: Record<string, number>
  ): void {
    this._reporter.sendTelemetryEvent(eventName, properties, measurements);
  }

  /**
   * Send an error event (e.g. unhandled exception from a webview).
   */
  sendErrorEvent(
    eventName: string,
    properties?: Record<string, string>,
    measurements?: Record<string, number>
  ): void {
    this._reporter.sendTelemetryErrorEvent(eventName, properties, measurements);
  }

  dispose(): void {
    void this._reporter.dispose();
  }
}

/** Map a {@link RayfinCommandEvent} to string properties for Application Insights. */
function flattenProperties(
  event: RayfinCommandEvent
): TelemetryEventProperties {
  return {
    schemaVersion: String(event.schemaVersion),
    correlationId: event.correlationId,
    productName: event.productName,
    productVersion: event.productVersion,
    clientSource: event.clientSource,
    // commandName contains tRPC paths with "/" and "." (e.g.
    // "trpc/projectView.checkRepoAccess") which the sanitizer
    // misidentifies as file paths. Mark it as trusted.
    commandName: new TelemetryTrustedValue(event.commandName),
    safeParameterNames: event.safeParameterNames.join(','),
    resultCategory: event.resultCategory,
    ...(event.resultSummary ? { resultSummary: event.resultSummary } : {}),
    startTimeIso: event.startTimeIso,
    osType: event.osType,
    osVersion: event.osVersion,
    nodeVersion: event.nodeVersion,
    ...(event.shellType ? { shellType: event.shellType } : {}),
    ...(event.errorType ? { errorType: event.errorType } : {}),
    ...(event.errorName ? { errorName: event.errorName } : {}),
  };
}

/** Map a {@link RayfinCommandEvent} to numeric measurements for Application Insights. */
function flattenMeasurements(
  event: RayfinCommandEvent
): Record<string, number> {
  return {
    durationMs: event.durationMs,
  };
}
