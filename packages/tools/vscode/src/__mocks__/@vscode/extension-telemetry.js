/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Mock for `@vscode/extension-telemetry` used in vitest.
 *
 * Provides a no-op TelemetryReporter so tests don't need real
 * Application Insights infrastructure.
 */

import { vi } from 'vitest';

export class TelemetryReporter {
  constructor(_connectionString) {}
  sendTelemetryEvent = vi.fn();
  sendTelemetryErrorEvent = vi.fn();
  sendTelemetryException = vi.fn();
  sendDangerousTelemetryEvent = vi.fn();
  sendDangerousTelemetryErrorEvent = vi.fn();
  sendDangerousTelemetryException = vi.fn();
  dispose = vi.fn(() => Promise.resolve());
}

export default TelemetryReporter;
