import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UserInteraction } from '@microsoft/rayfin-tools-common/_internal/adapters';
import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import { toRuntimeSettingsServices } from '@microsoft/rayfin-tools-common/_internal/services/runtime-settings';
import { withAssetAccess } from '@microsoft/rayfin-tools-common/_internal/workflows/up';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { runAnonStaticPreflight } from '../anonstatic-preflight-legacy.js';
import { describeAnonStaticPreflight } from '../anonstatic-preflight-plan.js';
import {
  AUTH_SDK_PACKAGE,
  assertAuthSdkMinVersionResolved,
  inspectAuthSdk,
  upgradeRayfinPackages,
} from '../auth-sdk-preflight.js';

// Spied rather than replaced: the real floor is now a released version, so the
// integration branches below are reachable and each test picks the one it wants.
vi.mock('../auth-sdk-preflight.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../auth-sdk-preflight.js')>();
  return {
    ...actual,
    assertAuthSdkMinVersionResolved: vi.fn(),
    inspectAuthSdk: vi.fn(),
    upgradeRayfinPackages: vi.fn(),
  };
});

const assertFloorResolvedMock = vi.mocked(assertAuthSdkMinVersionResolved);
const inspectAuthSdkMock = vi.mocked(inspectAuthSdk);
const upgradeAuthSdkMock = vi.mocked(upgradeRayfinPackages);

const BASE_YAML = `id: test-project
name: test-project
version: 1.0.0
services:
  auth:
    enabled: true
  data:
    enabled: false
  storage:
    enabled: false
  staticHosting:
    enabled: true
    folder: dist
`;

describe('rayfin up static-hosting access preflight', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'rayfin-anonstatic-'));
    mkdirSync(join(projectRoot, 'rayfin'), { recursive: true });
    writeFileSync(join(projectRoot, 'rayfin', 'rayfin.yml'), BASE_YAML);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Default: floor resolved, project does not depend on the SDK.
    assertFloorResolvedMock.mockReturnValue(undefined);
    inspectAuthSdkMock.mockReturnValue({ state: 'absent' });
    upgradeAuthSdkMock.mockReturnValue({
      status: 'upgraded',
      packageManager: 'npm',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  describe('feature flag off', () => {
    it('does not inspect, prompt, or write anything', async () => {
      const ui = fakeUi();
      const config = makeConfig({});

      const result = await runAnonStaticPreflight({
        config,
        projectRoot,
        mode: 'plain',
        interactive: true,
        enabled: false,
        ui,
      });

      expect(result).toEqual({ status: 'ok' });
      expect(ui.select).not.toHaveBeenCalled();
      expect(
        readYaml(projectRoot).services.staticHosting.assetAccess
      ).toBeUndefined();
    });

    it('plans no actions for a dry run', () => {
      expect(
        describeAnonStaticPreflight(makeConfig({}), projectRoot, false, true)
      ).toEqual([]);
    });

    it('preserves legacy protected access in the workload payload', async () => {
      const config = makeConfig({ anonymousAccess: false });

      const result = await runAnonStaticPreflight({
        config,
        projectRoot,
        mode: 'plain',
        interactive: false,
        enabled: false,
      });

      expect(result).toEqual({ status: 'ok' });
      expect(
        toRuntimeSettingsServices(config.services).staticHosting
      ).toHaveProperty('anonymousAccess', false);
    });
  });

  describe('static hosting disabled', () => {
    it('skips the posture and auth SDK preflights entirely', async () => {
      const ui = fakeUi();

      const result = await runAnonStaticPreflight({
        config: makeConfig({ enabled: false }),
        projectRoot,
        mode: 'plain',
        interactive: true,
        enabled: true,
        ui,
      });

      expect(result).toEqual({ status: 'ok' });
      expect(ui.select).not.toHaveBeenCalled();
      expect(inspectAuthSdkMock).not.toHaveBeenCalled();
    });
  });

  describe('posture already authored', () => {
    it.each([
      ['protected', 'protected', false],
      ['public', 'public', false],
      ['protected embedded-only', 'protected', true],
      ['illegal pair left for the workload', 'public', true],
    ] as const)('does not prompt for %s', async (_label, assetAccess, only) => {
      const ui = fakeUi();
      const config = makeConfig({
        assetAccess,
        embedded: { only },
      });

      const result = await runAnonStaticPreflight({
        config,
        projectRoot,
        mode: 'plain',
        interactive: true,
        enabled: true,
        ui,
      });

      expect(result).toEqual({ status: 'ok', assetAccess });
      expect(ui.select).not.toHaveBeenCalled();
      expect(config.services.staticHosting?.assetAccess).toBe(assetAccess);
      expect(config.services.staticHosting?.embedded?.only).toBe(only);
    });
  });

  describe('posture missing and prompting allowed', () => {
    it('persists the chosen posture and returns it for the upload payload', async () => {
      const config = makeConfig({});
      const ui = fakeUi({ select: vi.fn().mockResolvedValue('public') });

      const result = await runAnonStaticPreflight({
        config,
        projectRoot,
        mode: 'plain',
        interactive: true,
        enabled: true,
        ui,
      });

      expect(result).toEqual({ status: 'ok', assetAccess: 'public' });
      expect(ui.select).toHaveBeenCalledTimes(1);
      const written = readYaml(projectRoot);
      expect(written.services.staticHosting.assetAccess).toBe('public');
      // The caller's config is left alone; the value travels as a result.
      expect(config.services.staticHosting?.assetAccess).toBeUndefined();
    });

    it('still records asset access for an embedded-only project', async () => {
      const config = makeConfig({ embedded: { only: true } });
      const ui = fakeUi({ select: vi.fn().mockResolvedValue('protected') });

      const result = await runAnonStaticPreflight({
        config,
        projectRoot,
        mode: 'plain',
        interactive: true,
        enabled: true,
        ui,
      });

      expect(result).toEqual({ status: 'ok', assetAccess: 'protected' });
      expect(ui.select).toHaveBeenCalledTimes(1);
      expect(readYaml(projectRoot).services.staticHosting.assetAccess).toBe(
        'protected'
      );
    });

    it('leaves embedded.only untouched when onboarding writes the posture', async () => {
      const config = makeConfig({});

      await runAnonStaticPreflight({
        config,
        projectRoot,
        mode: 'plain',
        interactive: true,
        enabled: true,
        ui: fakeUi({ select: vi.fn().mockResolvedValue('protected') }),
      });

      expect(
        readYaml(projectRoot).services.staticHosting.embedded
      ).toBeUndefined();
    });

    it('returns asset access for the runtime-settings upload payload', async () => {
      const config = makeConfig({});

      const result = await runAnonStaticPreflight({
        config,
        projectRoot,
        mode: 'plain',
        interactive: true,
        enabled: true,
        ui: fakeUi({ select: vi.fn().mockResolvedValue('protected') }),
      });

      expect(result).toEqual({ status: 'ok', assetAccess: 'protected' });
      // Overlaid explicitly by the caller rather than mutated in place.
      const payload = withAssetAccess(
        config.services,
        result.status === 'ok' ? result.assetAccess : undefined
      );
      expect(payload.staticHosting?.assetAccess).toBe('protected');
      expect(config.services.staticHosting?.assetAccess).toBeUndefined();
    });
  });

  describe('json output mode', () => {
    it('writes no progress or warning text to stdout', async () => {
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const config = makeConfig({});

      await runAnonStaticPreflight({
        config,
        projectRoot,
        mode: 'json',
        interactive: true,
        enabled: true,
        ui: fakeUi({ select: vi.fn().mockResolvedValue('protected') }),
      });

      expect(stdout).not.toHaveBeenCalled();
      expect(console.log).not.toHaveBeenCalled();
    });
  });

  describe('posture missing and prompting not allowed', () => {
    it('defaults to protected without prompting', async () => {
      const ui = fakeUi();
      const config = makeConfig({});

      const result = await runAnonStaticPreflight({
        config,
        projectRoot,
        mode: 'plain',
        interactive: false,
        enabled: true,
        ui,
      });

      expect(result).toEqual({ status: 'ok', assetAccess: 'protected' });
      expect(ui.select).not.toHaveBeenCalled();
      expect(readYaml(projectRoot).services.staticHosting.assetAccess).toBe(
        'protected'
      );
      expect(config.services.staticHosting?.assetAccess).toBeUndefined();
    });

    it('reports the protected default without mutating the loaded config', async () => {
      const result = await runAnonStaticPreflight({
        config: makeConfig({}),
        projectRoot,
        mode: 'plain',
        interactive: false,
        enabled: true,
        ui: fakeUi(),
      });

      expect(result).toEqual({ status: 'ok', assetAccess: 'protected' });
      expect(readYaml(projectRoot).services.staticHosting.assetAccess).toBe(
        'protected'
      );
      expect(result).not.toHaveProperty('message');
    });
  });

  describe('posture authored with an unsupported value', () => {
    it.each([
      ['an unresolved interpolation', 'no ${MISSING}'],
      ['a quoted string', 'false'],
      ['a number', 0],
      ['null', null],
    ])('fails without prompting or mutating for %s', async (_label, value) => {
      const ui = fakeUi();
      const config = makeConfig({ assetAccess: value });

      const result = await runAnonStaticPreflight({
        config,
        projectRoot,
        mode: 'plain',
        interactive: true,
        enabled: true,
        ui,
      });

      expect(result.status).toBe('failed');
      expect(ui.select).not.toHaveBeenCalled();
      expect(
        readYaml(projectRoot).services.staticHosting.assetAccess
      ).toBeUndefined();
    });

    it('names the property and echoes the offending value', async () => {
      const result = await runAnonStaticPreflight({
        config: makeConfig({ assetAccess: 'no ${MISSING}' }),
        projectRoot,
        mode: 'plain',
        interactive: true,
        enabled: true,
        ui: fakeUi(),
      });

      expect(result).toEqual({
        status: 'failed',
        message: [
          'services.staticHosting.assetAccess in rayfin.yml must be protected or public, but is "no ${MISSING}"',
          '   An access posture decides who can open your deployed app, so it cannot be guessed.',
          '   If this came from an environment variable, check that it resolves to protected or public.',
        ].join('\n'),
      });
    });

    it('plans a failure for a dry run', () => {
      expect(
        describeAnonStaticPreflight(
          makeConfig({ assetAccess: 'maybe' }),
          projectRoot,
          true,
          true
        )
      ).toEqual([
        {
          text: 'services.staticHosting.assetAccess in rayfin.yml is not protected or public',
          blocking: true,
        },
      ]);
    });
  });

  describe('auth SDK integration', () => {
    it('warns and continues while the minimum version is unresolved', async () => {
      assertFloorResolvedMock.mockReturnValue('floor not set');

      const result = await runAnonStaticPreflight({
        config: makeConfig({ assetAccess: 'protected' }),
        projectRoot,
        mode: 'plain',
        interactive: true,
        enabled: true,
        ui: fakeUi(),
      });

      expect(result).toEqual({ status: 'ok', assetAccess: 'protected' });
      expect(inspectAuthSdkMock).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalled();
    });

    it('suppresses that warning under json output', async () => {
      assertFloorResolvedMock.mockReturnValue('floor not set');
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      await runAnonStaticPreflight({
        config: makeConfig({ assetAccess: 'protected' }),
        projectRoot,
        mode: 'json',
        interactive: true,
        enabled: true,
        ui: fakeUi(),
      });

      expect(stdout).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
    });

    it('fails with an install-dependencies hint when the version cannot be resolved', async () => {
      inspectAuthSdkMock.mockReturnValue({
        state: 'unresolved',
        reason: 'it is declared but not installed',
      });

      const result = await runAnonStaticPreflight({
        config: makeConfig({ assetAccess: 'protected' }),
        projectRoot,
        mode: 'plain',
        interactive: true,
        enabled: true,
        ui: fakeUi(),
      });

      expect(result).toEqual({
        status: 'failed',
        message: [
          'it is declared but not installed.',
          "   Install the project's dependencies so the Rayfin auth packages can be checked, then re-run.",
        ].join('\n'),
      });
      expect(upgradeAuthSdkMock).not.toHaveBeenCalled();
    });

    it('runs the upgrade and reports success when the SDK is outdated', async () => {
      inspectAuthSdkMock.mockReturnValue({
        state: 'outdated',
        version: '1.0.0',
      });

      const result = await runAnonStaticPreflight({
        config: makeConfig({ assetAccess: 'protected' }),
        projectRoot,
        mode: 'plain',
        interactive: true,
        enabled: true,
        ui: fakeUi({ confirm: vi.fn().mockResolvedValue(true) }),
      });

      expect(result).toEqual({ status: 'ok', assetAccess: 'protected' });
      expect(upgradeAuthSdkMock).toHaveBeenCalledTimes(1);
      expect(upgradeAuthSdkMock).toHaveBeenCalledWith(projectRoot, [
        AUTH_SDK_PACKAGE,
      ]);
    });

    it('does not touch dependencies when the offer is declined', async () => {
      inspectAuthSdkMock.mockReturnValue({
        state: 'outdated',
        version: '1.0.0',
      });

      const result = await runAnonStaticPreflight({
        config: makeConfig({ assetAccess: 'protected' }),
        projectRoot,
        mode: 'plain',
        interactive: true,
        enabled: true,
        ui: fakeUi({ confirm: vi.fn().mockResolvedValue(false) }),
      });

      expect(result).toEqual({
        status: 'failed',
        message: [
          'Some packages are older than the ones static-hosting access control requires.',
          '   Rayfin packages ship as a set, so update these together \u2014 raising one on its own',
          '   leaves whatever depends on it behind:',
          `     \u2022 ${AUTH_SDK_PACKAGE}`,
          '   Update them to a supported version, then re-run.',
        ].join('\n'),
      });
      expect(upgradeAuthSdkMock).not.toHaveBeenCalled();
    });

    it('never upgrades without asking in a non-interactive run', async () => {
      inspectAuthSdkMock.mockReturnValue({
        state: 'outdated',
        version: '1.0.0',
      });
      const ui = fakeUi({ confirm: vi.fn().mockResolvedValue(true) });

      const result = await runAnonStaticPreflight({
        config: makeConfig({ assetAccess: 'protected' }),
        projectRoot,
        mode: 'plain',
        interactive: false,
        enabled: true,
        ui,
      });

      expect(result.status).toBe('failed');
      expect(ui.confirm).not.toHaveBeenCalled();
      expect(upgradeAuthSdkMock).not.toHaveBeenCalled();
    });

    it('rejects a static-hosting path outside the project before inspection', async () => {
      const config = makeConfig({
        assetAccess: 'protected',
        path: '..',
      });

      await expect(
        runAnonStaticPreflight({
          config,
          projectRoot,
          mode: 'plain',
          interactive: true,
          enabled: true,
          ui: fakeUi(),
        })
      ).rejects.toThrow();

      expect(inspectAuthSdkMock).not.toHaveBeenCalled();
      expect(upgradeAuthSdkMock).not.toHaveBeenCalled();
    });

    it('surfaces the package-manager error when the upgrade fails', async () => {
      inspectAuthSdkMock.mockReturnValue({
        state: 'outdated',
        version: '1.0.0',
      });
      upgradeAuthSdkMock.mockReturnValue({
        status: 'failed',
        error: 'npm exited with code 1',
      });

      const result = await runAnonStaticPreflight({
        config: makeConfig({ assetAccess: 'protected' }),
        projectRoot,
        mode: 'plain',
        interactive: true,
        enabled: true,
        ui: fakeUi({ confirm: vi.fn().mockResolvedValue(true) }),
      });

      expect(result).toEqual({
        status: 'failed',
        message: [
          'npm exited with code 1',
          'Some packages are older than the ones static-hosting access control requires.',
          '   Rayfin packages ship as a set, so update these together \u2014 raising one on its own',
          '   leaves whatever depends on it behind:',
          `     \u2022 ${AUTH_SDK_PACKAGE}`,
          '   Update them to a supported version, then re-run.',
        ].join('\n'),
      });
    });

    it('does nothing when the SDK is already current', async () => {
      inspectAuthSdkMock.mockReturnValue({
        state: 'current',
        version: '9.9.9',
      });

      const result = await runAnonStaticPreflight({
        config: makeConfig({ assetAccess: 'protected' }),
        projectRoot,
        mode: 'plain',
        interactive: true,
        enabled: true,
        ui: fakeUi(),
      });

      expect(result).toEqual({ status: 'ok', assetAccess: 'protected' });
      expect(upgradeAuthSdkMock).not.toHaveBeenCalled();
    });

    it('plans the upgrade in a dry run when the SDK is outdated', () => {
      inspectAuthSdkMock.mockReturnValue({
        state: 'outdated',
        version: '1.0.0',
      });

      expect(
        describeAnonStaticPreflight(
          makeConfig({ assetAccess: 'protected' }),
          projectRoot,
          true,
          true
        )
      ).toEqual([
        {
          text: `Ask to update ${AUTH_SDK_PACKAGE} to a supported version`,
          blocking: false,
        },
      ]);
      expect(upgradeAuthSdkMock).not.toHaveBeenCalled();
    });
  });

  describe('dry run', () => {
    it('reports the planned posture write without prompting or writing', () => {
      expect(
        describeAnonStaticPreflight(makeConfig({}), projectRoot, true, true)
      ).toEqual([
        {
          text: 'Prompt for the static-hosting access posture and write services.staticHosting.assetAccess to rayfin.yml',
          blocking: false,
        },
      ]);
      expect(
        readYaml(projectRoot).services.staticHosting.assetAccess
      ).toBeUndefined();
    });

    it('plans a protected default when the run cannot prompt', () => {
      expect(
        describeAnonStaticPreflight(makeConfig({}), projectRoot, true, false)
      ).toEqual([
        {
          text: 'Default services.staticHosting.assetAccess to protected and write it to rayfin.yml',
          blocking: false,
        },
      ]);
    });

    it('plans nothing when the posture is already authored', () => {
      const planned = describeAnonStaticPreflight(
        makeConfig({ assetAccess: 'protected', embedded: { only: false } }),
        projectRoot,
        true,
        true
      );

      expect(planned).toEqual([]);
    });
  });
});

function makeConfig(
  staticHosting: Record<string, unknown> & { enabled?: boolean }
): RayfinConfig {
  return {
    id: 'test-project',
    services: {
      auth: { enabled: true },
      data: { enabled: false },
      storage: { enabled: false },
      staticHosting: {
        enabled: true,
        folder: 'dist',
        ...staticHosting,
      },
    },
  } as unknown as RayfinConfig;
}

/** Interactive adapter stub; `select`/`confirm` stand in for the two prompts. */
function fakeUi(overrides: Partial<UserInteraction> = {}): UserInteraction {
  return {
    prompt: vi.fn(),
    confirm: vi.fn().mockResolvedValue(false),
    select: vi.fn(),
    ...overrides,
  } as unknown as UserInteraction;
}

function readYaml(root: string): any {
  return parse(readFileSync(join(root, 'rayfin', 'rayfin.yml'), 'utf-8'));
}
