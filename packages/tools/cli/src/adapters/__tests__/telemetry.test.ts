import { InvocationContext } from '@microsoft/rayfin-tools-common/_internal/telemetry';
import { describe, expect, it } from 'vitest';

import { CliTelemetryHandle } from '../telemetry.js';

describe('CliTelemetryHandle', () => {
  it('adds enrichment to the bound invocation context', () => {
    const context = new InvocationContext('rayfin-cli', '1.0.0');
    const telemetry = new CliTelemetryHandle(context);
    const originId = '9f970daa-6101-4df2-98f9-e0d86e975c61';

    telemetry.addProperty('project_origin_id', originId);
    telemetry.addMeasurement('microsoft_package_count', 3);

    const event = context.finalize({
      osType: 'linux',
      osVersion: '6.1',
      nodeVersion: 'v20.20.0',
    });
    expect(event.properties).toEqual({ project_origin_id: originId });
    expect(event.measurements).toEqual({ microsoft_package_count: 3 });
  });
});
