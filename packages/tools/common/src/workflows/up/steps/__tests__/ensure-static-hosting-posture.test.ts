import { describe, expect, it, vi } from 'vitest';

import type { UserInteraction } from '../../../../adapters/index.js';
import type { RayfinConfig } from '../../../../config/index.js';
import type { StaticHostingService } from '../../../../services/static-hosting/index.js';
import {
  ASSET_ACCESS_YAML_PATH,
  STATIC_HOSTING_POSTURE_VALUES,
  describeMissingPostureError,
  ensureStaticHostingPosture,
  inspectStaticHostingPosture,
  withAssetAccess,
} from '../ensure-static-hosting-posture.js';

describe('inspectStaticHostingPosture', () => {
  it('is not applicable when static hosting is disabled', () => {
    expect(
      inspectStaticHostingPosture(makeServices({ enabled: false }))
    ).toEqual({ state: 'not-applicable' });
  });

  it('is not applicable when static hosting is absent', () => {
    expect(
      inspectStaticHostingPosture({} as unknown as RayfinConfig['services'])
    ).toEqual({ state: 'not-applicable' });
  });

  it('reports missing when assetAccess is not authored', () => {
    expect(inspectStaticHostingPosture(makeServices({}))).toEqual({
      state: 'missing',
    });
  });

  it('reports missing when only an embedded.only of false is authored', () => {
    expect(
      inspectStaticHostingPosture(makeServices({ embedded: { only: false } }))
    ).toEqual({ state: 'missing' });
  });

  it('reports missing when embedded.only is true and no posture is authored', () => {
    expect(
      inspectStaticHostingPosture(makeServices({ embedded: { only: true } }))
    ).toEqual({ state: 'missing' });
  });

  it.each(['protected', 'public'] as const)(
    'reports authored for an authored %s posture',
    (assetAccess) => {
      expect(
        inspectStaticHostingPosture(makeServices({ assetAccess }))
      ).toEqual({ state: 'authored', assetAccess });
    }
  );

  it('reports authored regardless of embedded.only', () => {
    expect(
      inspectStaticHostingPosture(
        makeServices({ assetAccess: 'protected', embedded: { only: true } })
      )
    ).toEqual({ state: 'authored', assetAccess: 'protected' });
  });

  it('reports authored for an explicitly illegal pair so the workload can reject it', () => {
    expect(
      inspectStaticHostingPosture(
        makeServices({ assetAccess: 'public', embedded: { only: true } })
      )
    ).toEqual({ state: 'authored', assetAccess: 'public' });
  });

  it.each([
    ['an unresolved interpolation', 'no ${MISSING}'],
    ['a quoted string', 'false'],
    ['a number', 0],
    ['null', null],
  ])('reports invalid for %s', (_label, value) => {
    expect(
      inspectStaticHostingPosture(makeServices({ assetAccess: value }))
    ).toEqual({ state: 'invalid', value });
  });
});

describe('posture mapping', () => {
  it('uses the supported asset-access values', () => {
    expect(STATIC_HOSTING_POSTURE_VALUES).toEqual(['protected', 'public']);
  });
});

describe('ensureStaticHostingPosture', () => {
  it('rejects an invalid authored value', async () => {
    const deps = fakeDeps();

    const result = await ensureStaticHostingPosture(
      {
        services: makeServices({ assetAccess: 'private' }),
        projectRoot: '/p',
      },
      deps
    );

    expect(result).toEqual({
      status: 'invalid-posture',
      value: 'private',
    });
    expect(deps.staticHosting.persistAssetAccess).not.toHaveBeenCalled();
    expect(deps.ui?.select).not.toHaveBeenCalled();
  });

  it('passes an authored posture through without writing', async () => {
    const deps = fakeDeps();

    const result = await ensureStaticHostingPosture(
      {
        services: makeServices({ assetAccess: 'public' }),
        projectRoot: '/p',
      },
      deps
    );

    expect(result).toEqual({
      status: 'resolved',
      assetAccess: 'public',
      persisted: false,
    });
    expect(deps.staticHosting.persistAssetAccess).not.toHaveBeenCalled();
  });

  it('persists a host-supplied answer without prompting', async () => {
    const deps = fakeDeps();

    const result = await ensureStaticHostingPosture(
      {
        services: makeServices({}),
        projectRoot: '/p',
        postureAnswer: 'public',
      },
      deps
    );

    expect(result).toEqual({
      status: 'resolved',
      assetAccess: 'public',
      persisted: true,
    });
    expect(deps.ui?.select).not.toHaveBeenCalled();
    expect(deps.staticHosting.persistAssetAccess).toHaveBeenCalledWith({
      projectRoot: '/p',
      assetAccess: 'public',
    });
  });

  it('defaults missing posture to protected without prompting', async () => {
    const deps = fakeDeps({ select: vi.fn().mockResolvedValue('public') });

    const result = await ensureStaticHostingPosture(
      { services: makeServices({}), projectRoot: '/p' },
      deps
    );

    expect(result).toEqual({
      status: 'resolved',
      assetAccess: 'protected',
      persisted: true,
    });
    expect(deps.ui?.select).not.toHaveBeenCalled();
    expect(deps.staticHosting.persistAssetAccess).toHaveBeenCalledWith({
      projectRoot: '/p',
      assetAccess: 'protected',
    });
  });

  it('still records asset access for an embedded-only project', async () => {
    const deps = fakeDeps();

    const result = await ensureStaticHostingPosture(
      {
        services: makeServices({ embedded: { only: true } }),
        projectRoot: '/p',
        postureAnswer: 'protected',
      },
      deps
    );

    expect(result).toEqual({
      status: 'resolved',
      assetAccess: 'protected',
      persisted: true,
    });
    expect(deps.staticHosting.persistAssetAccess).toHaveBeenCalledWith({
      projectRoot: '/p',
      assetAccess: 'protected',
    });
  });

  it('reports an authored value that is not a boolean', async () => {
    const result = await ensureStaticHostingPosture(
      {
        services: makeServices({ assetAccess: 'no ${MISSING}' }),
        projectRoot: '/p',
      },
      fakeDeps()
    );

    expect(result).toEqual({
      status: 'invalid-posture',
      value: 'no ${MISSING}',
    });
  });

  it('reports a failed write rather than proceeding', async () => {
    const deps = fakeDeps();
    vi.mocked(deps.staticHosting.persistAssetAccess).mockResolvedValue({
      status: 'failed',
      error: 'rayfin.yml is read-only',
    });

    const result = await ensureStaticHostingPosture(
      {
        services: makeServices({}),
        projectRoot: '/p',
        postureAnswer: 'protected',
      },
      deps
    );

    expect(result).toEqual({
      status: 'persist-failed',
      error: 'rayfin.yml is read-only',
    });
  });

  it('never mutates the services it was given', async () => {
    const services = makeServices({});

    await ensureStaticHostingPosture(
      { services, projectRoot: '/p', postureAnswer: 'public' },
      fakeDeps()
    );

    expect(services.staticHosting?.assetAccess).toBeUndefined();
  });
});

describe('withAssetAccess', () => {
  it('overlays the value onto a copy', () => {
    const services = makeServices({});

    const overlaid = withAssetAccess(services, 'protected');

    expect(overlaid.staticHosting?.assetAccess).toBe('protected');
    expect(services.staticHosting?.assetAccess).toBeUndefined();
    expect(overlaid.staticHosting?.folder).toBe('dist');
  });

  it('returns the input unchanged when there is no value to overlay', () => {
    const services = makeServices({});

    expect(withAssetAccess(services, undefined)).toBe(services);
  });
});

describe('describeMissingPostureError', () => {
  it('names the property and both remediation values', () => {
    expect(describeMissingPostureError()).toBe(
      [
        `Static hosting is enabled but ${ASSET_ACCESS_YAML_PATH} is not set in rayfin.yml`,
        '   An explicit access posture is required to publish a static-hosted app.',
        '   Add it under services.staticHosting:',
        '     assetAccess: protected   # Visitors must sign in with Fabric before hosted assets load (recommended)',
        '     assetAccess: public      # Anyone with the link can load the hosted assets',
        '   Or run `rayfin up` in an interactive terminal, without --yes or --json, to choose.',
      ].join('\n')
    );
  });
});

function makeServices(
  staticHosting: Record<string, unknown> & { enabled?: boolean }
): RayfinConfig['services'] {
  return {
    auth: { enabled: true },
    data: { enabled: false },
    storage: { enabled: false },
    staticHosting: { enabled: true, folder: 'dist', ...staticHosting },
  } as unknown as RayfinConfig['services'];
}

function fakeDeps(uiOverrides: Partial<UserInteraction> = {}): {
  staticHosting: StaticHostingService;
  ui?: UserInteraction;
} {
  return {
    staticHosting: {
      validateFolder: vi.fn(),
      runBuild: vi.fn(),
      packageFolder: vi.fn(),
      deploy: vi.fn(),
      persistHostingUrl: vi.fn(),
      persistAssetAccess: vi.fn().mockResolvedValue({ status: 'persisted' }),
    },
    ui: {
      prompt: vi.fn(),
      confirm: vi.fn(),
      select: vi.fn(),
      ...uiOverrides,
    } as unknown as UserInteraction,
  };
}
