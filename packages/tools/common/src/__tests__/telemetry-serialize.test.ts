import { describe, expect, it } from 'vitest';

import {
  InvocationContext,
  toOpenTelemetryAttributes,
} from '../telemetry/index.js';
import type { RayfinCommandEvent } from '../telemetry/index.js';

const ORIGIN_ID = '9f970daa-6101-4df2-98f9-e0d86e975c61';

describe('toOpenTelemetryAttributes', () => {
  it('preserves the command event wire contract', () => {
    const context = new InvocationContext('rayfin-cli', '1.2.3');
    context.setCommand('up', ['--force']);
    context.markSuccess();

    const attributes = toOpenTelemetryAttributes(
      context.finalize({
        osType: 'linux',
        osVersion: '6.1',
        nodeVersion: 'v20.20.0',
        shellType: 'bash',
      })
    );

    expect(attributes).toEqual({
      'event.name': 'rayfin/command',
      'ai.operation.name': 'rayfin/command',
      'rayfin.schema_version': 2,
      'rayfin.correlation_id': expect.any(String),
      'rayfin.product_name': 'rayfin-cli',
      'rayfin.product_version': '1.2.3',
      'rayfin.client_source': 'cli',
      'rayfin.command_name': 'up',
      'rayfin.safe_parameter_names': '--force',
      'rayfin.template_name': '',
      'rayfin.result_category': 'Success',
      'rayfin.result_summary': '',
      'rayfin.duration_ms': expect.any(Number),
      'rayfin.os_type': 'linux',
      'rayfin.os_version': '6.1',
      'rayfin.node_version': 'v20.20.0',
      'rayfin.shell_type': 'bash',
      'rayfin.dev_device_id': '',
      'rayfin.error_type': '',
      'rayfin.error_name': '',
    });
  });

  it('adds namespaced properties and measurements', () => {
    const context = new InvocationContext('create-rayfin', '1.2.3');
    context.recordFabricActivityId('activity-1');
    context.addProperty('project_origin_id', ORIGIN_ID);
    context.addProperty('telemetry_environment', 'github-actions');
    context.addMeasurement('microsoft_package_count', 3);

    const attributes = toOpenTelemetryAttributes(
      context.finalize({
        osType: 'linux',
        osVersion: '6.1',
        nodeVersion: 'v20.20.0',
      })
    );

    expect(attributes['rayfin.fabric_activity_ids']).toBe('["activity-1"]');
    expect(attributes['rayfin.project_origin_id']).toBe(ORIGIN_ID);
    expect(attributes['rayfin.telemetry_environment']).toBe('github-actions');
    expect(attributes['rayfin.microsoft_package_count']).toBe(3);
  });

  it('does not let property or measurement enrichment replace core fields', () => {
    const context = new InvocationContext('rayfin-cli', '1.2.3');
    const event = context.finalize({
      osType: 'linux',
      osVersion: '6.1',
      nodeVersion: 'v20.20.0',
    });

    const attributes = toOpenTelemetryAttributes({
      ...event,
      properties: { correlation_id: 'spoofed' },
      measurements: { duration_ms: -1 },
    } as RayfinCommandEvent);

    expect(attributes['rayfin.correlation_id']).toBe(event.correlationId);
    expect(attributes['rayfin.duration_ms']).toBe(event.durationMs);
  });

  it('drops malformed enrichment from manually constructed events', () => {
    const context = new InvocationContext('rayfin-cli', '1.2.3');
    const event = context.finalize({
      osType: 'linux',
      osVersion: '6.1',
      nodeVersion: 'v20.20.0',
    });

    const attributes = toOpenTelemetryAttributes({
      ...event,
      properties: { project_origin_id: 'secret-token-value' },
      measurements: { microsoft_package_count: -1 },
    });

    expect(attributes).not.toHaveProperty('rayfin.project_origin_id');
    expect(attributes).not.toHaveProperty('rayfin.microsoft_package_count');
  });

  it('drops a malformed package inventory at the transport boundary', () => {
    const context = new InvocationContext('rayfin-cli', '1.2.3');
    const event = context.finalize({
      osType: 'linux',
      osVersion: '6.1',
      nodeVersion: 'v20.20.0',
    });

    const attributes = toOpenTelemetryAttributes({
      ...event,
      properties: {
        microsoft_packages: '[{"name":"nope"}]',
      },
    });

    expect(attributes).not.toHaveProperty('rayfin.microsoft_packages');
  });

  it('omits enrichment whose runtime value violates the event shape', () => {
    const context = new InvocationContext('rayfin-cli', '1.2.3');
    context.setCommand('up', ['--force']);
    context.markSuccess();
    const event = context.finalize({
      osType: 'linux',
      osVersion: '6.1',
      nodeVersion: 'v20.20.0',
    });

    const attributes = toOpenTelemetryAttributes({
      ...event,
      properties: { project_origin_id: Symbol('malformed') },
      measurements: { microsoft_package_count: '3' },
    } as unknown as RayfinCommandEvent);

    expect(attributes).not.toHaveProperty('rayfin.project_origin_id');
    expect(attributes).not.toHaveProperty('rayfin.microsoft_package_count');
    expect(attributes['rayfin.correlation_id']).toBe(event.correlationId);
    expect(attributes['rayfin.command_name']).toBe('up');
    expect(attributes['rayfin.result_category']).toBe('Success');
  });
});
