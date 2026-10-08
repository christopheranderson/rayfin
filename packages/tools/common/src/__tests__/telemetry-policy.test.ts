import { describe, expect, it } from 'vitest';

import { isTelemetryEnabled } from '../telemetry/index.js';

describe('isTelemetryEnabled', () => {
  it('returns true when all conditions are clear', () => {
    expect(
      isTelemetryEnabled({
        userOptOut: false,
      })
    ).toBe(true);
  });

  it('returns false when user has opted out', () => {
    expect(
      isTelemetryEnabled({
        userOptOut: true,
      })
    ).toBe(false);
  });

  it('returns false when host setting is explicitly disabled', () => {
    expect(
      isTelemetryEnabled({
        userOptOut: false,
        hostSettingEnabled: false,
      })
    ).toBe(false);
  });

  it('returns true when host setting is explicitly enabled', () => {
    expect(
      isTelemetryEnabled({
        userOptOut: false,
        hostSettingEnabled: true,
      })
    ).toBe(true);
  });

  it('user opt-out takes priority over host setting enabled', () => {
    expect(
      isTelemetryEnabled({
        userOptOut: true,
        hostSettingEnabled: true,
      })
    ).toBe(false);
  });
});
