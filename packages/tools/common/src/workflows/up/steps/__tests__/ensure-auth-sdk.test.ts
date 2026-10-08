import { describe, expect, it, vi } from 'vitest';

import type { UserInteraction } from '../../../../adapters/index.js';
import type { RayfinConfig } from '../../../../config/index.js';
import type { AuthSdkService } from '../../../../services/auth-sdk/index.js';
import { describeOutdatedAuthSdk, ensureAuthSdk } from '../ensure-auth-sdk.js';

const services = {
  staticHosting: { enabled: true, path: 'frontend' },
} as unknown as RayfinConfig['services'];

const input = { services, projectRoot: '/p' };

describe('ensureAuthSdk', () => {
  it('does nothing when the deploy has no static-hosting surface', async () => {
    const deps = fakeDeps();

    const result = await ensureAuthSdk(
      {
        ...input,
        services: {
          staticHosting: { enabled: false },
        } as unknown as RayfinConfig['services'],
      },
      deps
    );

    expect(result).toEqual({ status: 'ok' });
    expect(deps.authSdk.inspect).not.toHaveBeenCalled();
  });

  it('passes a satisfied inspection through silently', async () => {
    const deps = fakeDeps();

    expect(await ensureAuthSdk(input, deps)).toEqual({ status: 'ok' });
    expect(deps.authSdk.upgrade).not.toHaveBeenCalled();
  });

  it('reports an unknown floor as a notice rather than a pass', async () => {
    const deps = fakeDeps();
    vi.mocked(deps.authSdk.inspect).mockResolvedValue({
      state: 'unknown-floor',
      reason: 'floor not set',
    });

    expect(await ensureAuthSdk(input, deps)).toEqual({
      status: 'ok',
      notice: 'floor not set',
    });
    expect(deps.authSdk.upgrade).not.toHaveBeenCalled();
  });

  it('reports an unresolved version without upgrading', async () => {
    const deps = fakeDeps();
    vi.mocked(deps.authSdk.inspect).mockResolvedValue({
      state: 'unresolved',
      reason: 'declared but not installed',
    });

    expect(await ensureAuthSdk(input, deps)).toEqual({
      status: 'unresolved',
      reason: 'declared but not installed',
    });
    expect(deps.authSdk.upgrade).not.toHaveBeenCalled();
  });

  it('upgrades the whole outdated set once consent is given', async () => {
    const deps = fakeDeps({ confirm: vi.fn().mockResolvedValue(true) });
    vi.mocked(deps.authSdk.inspect).mockResolvedValue({
      state: 'outdated',
      packages: ['@microsoft/rayfin-auth', '@microsoft/rayfin-client'],
    });

    const result = await ensureAuthSdk(input, deps);

    expect(result).toEqual({
      status: 'upgraded',
      packages: ['@microsoft/rayfin-auth', '@microsoft/rayfin-client'],
    });
    expect(deps.authSdk.upgrade).toHaveBeenCalledWith({
      projectRoot: '/p',
      services,
      packages: ['@microsoft/rayfin-auth', '@microsoft/rayfin-client'],
    });
  });

  it('uses a host-supplied approval without asking', async () => {
    const deps = fakeDeps();
    vi.mocked(deps.authSdk.inspect).mockResolvedValue({
      state: 'outdated',
      packages: ['@microsoft/rayfin-auth'],
    });

    const result = await ensureAuthSdk(
      { ...input, upgradeApproved: true },
      deps
    );

    expect(result.status).toBe('upgraded');
    expect(deps.ui?.confirm).not.toHaveBeenCalled();
  });

  it('leaves dependencies alone when consent is withheld', async () => {
    const deps = fakeDeps({ confirm: vi.fn().mockResolvedValue(false) });
    vi.mocked(deps.authSdk.inspect).mockResolvedValue({
      state: 'outdated',
      packages: ['@microsoft/rayfin-auth'],
    });

    expect(await ensureAuthSdk(input, deps)).toEqual({
      status: 'outdated',
      packages: ['@microsoft/rayfin-auth'],
    });
    expect(deps.authSdk.upgrade).not.toHaveBeenCalled();
  });

  it('never upgrades on a host that cannot ask', async () => {
    const deps = { ...fakeDeps(), ui: undefined };
    vi.mocked(deps.authSdk.inspect).mockResolvedValue({
      state: 'outdated',
      packages: ['@microsoft/rayfin-auth'],
    });

    expect(await ensureAuthSdk(input, deps)).toEqual({
      status: 'outdated',
      packages: ['@microsoft/rayfin-auth'],
    });
    expect(deps.authSdk.upgrade).not.toHaveBeenCalled();
  });

  it('carries the package-manager error when the upgrade fails', async () => {
    const deps = fakeDeps({ confirm: vi.fn().mockResolvedValue(true) });
    vi.mocked(deps.authSdk.inspect).mockResolvedValue({
      state: 'outdated',
      packages: ['@microsoft/rayfin-auth'],
    });
    vi.mocked(deps.authSdk.upgrade).mockResolvedValue({
      status: 'failed',
      error: 'npm exited with code 1',
    });

    expect(await ensureAuthSdk(input, deps)).toEqual({
      status: 'outdated',
      packages: ['@microsoft/rayfin-auth'],
      error: 'npm exited with code 1',
    });
  });
});

describe('describeOutdatedAuthSdk', () => {
  it('names every package that has to move', () => {
    expect(
      describeOutdatedAuthSdk([
        '@microsoft/rayfin-auth',
        '@microsoft/rayfin-client',
      ])
    ).toBe(
      [
        'Some packages are older than the ones static-hosting access control requires.',
        '   Rayfin packages ship as a set, so update these together \u2014 raising one on its own',
        '   leaves whatever depends on it behind:',
        '     \u2022 @microsoft/rayfin-auth',
        '     \u2022 @microsoft/rayfin-client',
        '   Update them to a supported version, then re-run.',
      ].join('\n')
    );
  });

  it('leads with the package-manager error when there was one', () => {
    expect(
      describeOutdatedAuthSdk(['@microsoft/rayfin-auth'], 'npm exited with 1')
    ).toBe(
      [
        'npm exited with 1',
        'Some packages are older than the ones static-hosting access control requires.',
        '   Rayfin packages ship as a set, so update these together \u2014 raising one on its own',
        '   leaves whatever depends on it behind:',
        '     \u2022 @microsoft/rayfin-auth',
        '   Update them to a supported version, then re-run.',
      ].join('\n')
    );
  });
});

function fakeDeps(uiOverrides: Partial<UserInteraction> = {}): {
  authSdk: AuthSdkService;
  ui?: UserInteraction;
} {
  return {
    authSdk: {
      inspect: vi.fn().mockResolvedValue({ state: 'satisfied' }),
      upgrade: vi.fn().mockResolvedValue({ status: 'upgraded' }),
    },
    ui: {
      prompt: vi.fn(),
      confirm: vi.fn(),
      select: vi.fn(),
      ...uiOverrides,
    } as unknown as UserInteraction,
  };
}
