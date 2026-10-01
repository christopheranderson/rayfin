import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import { describe, expect, it, vi } from 'vitest';

import { resolveStaticHostingPosture } from '../static-hosting-posture-preflight.js';

describe('resolveStaticHostingPosture', () => {
  it('collects an answer when the project authored none', async () => {
    const promptForPosture = vi.fn().mockResolvedValue('public');

    const result = await resolveStaticHostingPosture({
      config: makeConfig({ enabled: true }),
      enabled: true,
      interactive: true,
      promptForPosture,
    });

    expect(result).toEqual({ status: 'ok', posture: 'public' });
    expect(promptForPosture).toHaveBeenCalledTimes(1);
  });

  it('does not ask when the project already authored one', async () => {
    const promptForPosture = vi.fn();

    const result = await resolveStaticHostingPosture({
      config: makeConfig({ enabled: true, assetAccess: 'protected' }),
      enabled: true,
      interactive: true,
      promptForPosture,
    });

    expect(result).toEqual({ status: 'ok' });
    expect(promptForPosture).not.toHaveBeenCalled();
  });

  it('does not ask when the gate is off', async () => {
    const promptForPosture = vi.fn();

    const result = await resolveStaticHostingPosture({
      config: makeConfig({ enabled: true }),
      enabled: false,
      interactive: true,
      promptForPosture,
    });

    expect(result).toEqual({ status: 'ok' });
    expect(promptForPosture).not.toHaveBeenCalled();
  });

  it('does not ask when static hosting is off', async () => {
    const promptForPosture = vi.fn();

    const result = await resolveStaticHostingPosture({
      config: makeConfig({ enabled: false }),
      enabled: true,
      interactive: true,
      promptForPosture,
    });

    expect(result).toEqual({ status: 'ok' });
    expect(promptForPosture).not.toHaveBeenCalled();
  });

  it('defaults to protected when a run cannot prompt', async () => {
    const promptForPosture = vi.fn();

    const result = await resolveStaticHostingPosture({
      config: makeConfig({ enabled: true }),
      enabled: true,
      interactive: false,
      promptForPosture,
    });

    expect(result).toEqual({ status: 'ok', posture: 'protected' });
    expect(promptForPosture).not.toHaveBeenCalled();
  });

  it('fails an unsupported value without asking, even when it could ask', async () => {
    const promptForPosture = vi.fn();

    const result = await resolveStaticHostingPosture({
      config: makeConfig({ enabled: true, assetAccess: 'private' }),
      enabled: true,
      interactive: true,
      promptForPosture,
    });

    expect(result.status).toBe('failed');
    expect(promptForPosture).not.toHaveBeenCalled();
  });
});

function makeConfig(staticHosting: {
  enabled: boolean;
  assetAccess?: string;
}): RayfinConfig {
  return {
    id: 'proj',
    services: {
      auth: { enabled: true },
      data: { enabled: false },
      staticHosting,
    },
  } as unknown as RayfinConfig;
}
