/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment jsdom

import type { CheckResult } from '@microsoft/rayfin-tools-common/_internal/checks';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrereqChecksState } from '../webviews/hooks/usePrereqChecks';
import {
  STEP_DEPLOY,
  STEP_DONE,
  STEP_MODULES,
  STEP_NODE,
} from '../webviews/projectView/components/setup/hooks/stepDescriptors';
import type { DeployStepState } from '../webviews/projectView/components/setup/hooks/useDeployStep';
import type { MicrosoftAuthState } from '../webviews/projectView/components/setup/hooks/useMicrosoftAuth';
import type { ModulesCheckState } from '../webviews/projectView/components/setup/hooks/useModulesCheck';
import { useSetupWorkflow } from '../webviews/projectView/components/setup/hooks/useSetupWorkflow';

// ── Helpers ─────────────────────────────────────────────────────────────

function cr(status: CheckResult['status'], name = 'test'): CheckResult {
  return { status, name, detail: `${name} detail` };
}

function makePrereqs(
  overrides: Partial<PrereqChecksState> = {}
): PrereqChecksState {
  return {
    prereqs: [cr('warn', 'Node.js'), cr('warn', 'Docker')],
    prereqChecking: new Set(['Node.js', 'Docker']),
    prereqsLoading: true,
    allPrereqsPass: false,
    requiredToolsStatus: 'checking',
    refreshPrereqs: vi.fn(),
    refreshPrereq: vi.fn(),
    ...overrides,
  };
}

function makeModules(o: Partial<ModulesCheckState> = {}): ModulesCheckState {
  return {
    nodeModulesResult: cr('fail', 'npm install'),
    nodeModulesLoading: false,
    modulesUnlocked: false,
    npmInstallBusy: false,
    modulesPhase: 'needs-install',
    modulesStatus: 'warn',
    refreshNodeModules: vi.fn(),
    runNpmInstall: vi.fn(),
    setNpmInstallBusy: vi.fn(),
    start: vi.fn(),
    reset: vi.fn(),
    ...o,
  };
}

function makeMicrosoftAuth(
  o: Partial<MicrosoftAuthState> = {}
): MicrosoftAuthState {
  return {
    microsoftAuth: cr('fail', 'Microsoft Account'),
    microsoftAuthLoading: false,
    microsoftAuthBusy: false,
    microsoftAuthPhase: 'needs-sign-in',
    refreshMicrosoftAuth: vi.fn(),
    signInMicrosoft: vi.fn(),
    reset: vi.fn(),
    ...o,
  };
}

function makeDeploy(o: Partial<DeployStepState> = {}): DeployStepState {
  return {
    deploy: cr('fail', 'Deploy'),
    deployLoading: false,
    deployBusy: false,
    deployPhase: 'needs-deploy',
    refreshDeploy: vi.fn(),
    runDeploy: vi.fn(),
    reset: vi.fn(),
    ...o,
  };
}

type Props = Parameters<typeof useSetupWorkflow>[0];

function makeProps(o: Partial<Props> = {}): Props {
  return {
    prereqs: makePrereqs(),
    modules: makeModules(),
    microsoftAuth: makeMicrosoftAuth(),
    deploy: makeDeploy(),
    folder: '/ws',
    ...o,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('useSetupWorkflow (section-aware pipeline)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts at STEP_NODE', () => {
    const props = makeProps();
    const { result } = renderHook(() => useSetupWorkflow(props));

    expect(result.current.currentStep).toBe(STEP_NODE);
    expect(result.current.currentSection).toBe('prereqs');
    expect(result.current.getStepState(STEP_NODE)).toBe('active');
  });

  it('advances to STEP_MODULES when Node.js passes', () => {
    const modulesStart = vi.fn();
    const props = makeProps({
      prereqs: makePrereqs({
        prereqs: [cr('pass', 'Node.js'), cr('warn', 'Docker')],
        prereqChecking: new Set(),
        prereqsLoading: false,
        allPrereqsPass: false,
      }),
      modules: makeModules({ start: modulesStart }),
    });

    const { result } = renderHook(() => useSetupWorkflow(props));

    expect(result.current.currentStep).toBe(STEP_MODULES);
    expect(result.current.getStepState(STEP_NODE)).toBe('done');
    expect(result.current.currentSection).toBe('install');
    expect(modulesStart).toHaveBeenCalled();
  });

  it('advances to STEP_MODULES when both prereqs pass', () => {
    const modulesStart = vi.fn();
    const props = makeProps({
      prereqs: makePrereqs({
        prereqs: [cr('pass', 'Node.js'), cr('pass', 'Docker')],
        prereqChecking: new Set(),
        prereqsLoading: false,
        allPrereqsPass: true,
      }),
      modules: makeModules({ start: modulesStart }),
    });

    const { result } = renderHook(() => useSetupWorkflow(props));

    expect(result.current.currentStep).toBe(STEP_MODULES);
    expect(result.current.currentSection).toBe('install');
    expect(modulesStart).toHaveBeenCalled();
  });

  it('auto-triggers npm install when modules check fails', () => {
    const runNpmInstall = vi.fn();
    const props = makeProps({
      prereqs: makePrereqs({
        prereqs: [cr('pass', 'Node.js'), cr('pass', 'Docker')],
        prereqChecking: new Set(),
        prereqsLoading: false,
        allPrereqsPass: true,
      }),
      modules: makeModules({
        nodeModulesResult: cr('fail', 'npm install'),
        runNpmInstall,
      }),
      folder: '/ws',
    });

    renderHook(() => useSetupWorkflow(props));

    expect(runNpmInstall).toHaveBeenCalledTimes(1);
  });

  it('advances past STEP_MODULES when modules pass', () => {
    const props = makeProps({
      prereqs: makePrereqs({
        prereqs: [cr('pass', 'Node.js'), cr('pass', 'Docker')],
        prereqChecking: new Set(),
        prereqsLoading: false,
        allPrereqsPass: true,
      }),
      modules: makeModules({
        nodeModulesResult: cr('pass', 'npm install'),
      }),
    });

    const { result } = renderHook(() => useSetupWorkflow(props));

    expect(result.current.currentStep).toBeGreaterThan(STEP_MODULES);
  });

  it('completes the pipeline when all steps pass', () => {
    const props = makeProps({
      prereqs: makePrereqs({
        prereqs: [cr('pass', 'Node.js'), cr('pass', 'Docker')],
        prereqChecking: new Set(),
        prereqsLoading: false,
        allPrereqsPass: true,
      }),
      modules: makeModules({
        nodeModulesResult: cr('pass', 'npm install'),
      }),
      microsoftAuth: makeMicrosoftAuth({
        microsoftAuth: cr('pass', 'Microsoft Account'),
      }),
      deploy: makeDeploy({
        deploy: cr('pass', 'Deploy'),
      }),
    });

    const { result } = renderHook(() => useSetupWorkflow(props));

    expect(result.current.currentStep).toBe(STEP_DONE);
    expect(result.current.currentSection).toBe('done');
  });

  it('restarts from prerequisites and resets downstream sections', () => {
    const props = makeProps({
      prereqs: makePrereqs(),
    });

    const { result } = renderHook(() => useSetupWorkflow(props));

    act(() => result.current.restart());

    expect(props.modules.reset).toHaveBeenCalled();
    expect(props.microsoftAuth.reset).toHaveBeenCalled();
    expect(props.deploy.reset).toHaveBeenCalled();
    expect(props.prereqs.refreshPrereqs).toHaveBeenCalledWith(true);
  });

  it('advances to STEP_MODULES when folder is undefined', () => {
    const modulesStart = vi.fn();
    const props = makeProps({
      prereqs: makePrereqs({
        prereqs: [cr('pass', 'Node.js'), cr('pass', 'Docker')],
        prereqChecking: new Set(),
        prereqsLoading: false,
        allPrereqsPass: true,
      }),
      modules: makeModules({ start: modulesStart }),
      folder: undefined,
    });

    const { result } = renderHook(() => useSetupWorkflow(props));

    expect(result.current.currentStep).toBe(STEP_MODULES);
    expect(modulesStart).toHaveBeenCalled();
  });

  it('refreshes the install section and invalidates deploy', () => {
    const props = makeProps({
      prereqs: makePrereqs({
        prereqs: [cr('pass', 'Node.js'), cr('pass', 'Docker')],
        prereqChecking: new Set(),
        prereqsLoading: false,
        allPrereqsPass: true,
      }),
    });

    const { result } = renderHook(() => useSetupWorkflow(props));

    act(() => result.current.refreshSection('install'));

    expect(props.modules.reset).toHaveBeenCalled();
    expect(props.microsoftAuth.reset).toHaveBeenCalled();
    expect(props.deploy.reset).toHaveBeenCalled();
    expect(result.current.currentStep).toBe(STEP_MODULES);
    expect(result.current.currentSection).toBe('install');
  });

  it('does not fire the same auto action twice for one failed step', () => {
    const runNpmInstall = vi.fn();
    const props = makeProps({
      prereqs: makePrereqs({
        prereqs: [cr('pass', 'Node.js'), cr('pass', 'Docker')],
        prereqChecking: new Set(),
        prereqsLoading: false,
        allPrereqsPass: true,
      }),
      modules: makeModules({
        nodeModulesResult: cr('fail', 'npm install'),
        runNpmInstall,
      }),
    });

    const { rerender } = renderHook(
      (currentProps: Props) => useSetupWorkflow(currentProps),
      {
        initialProps: props,
      }
    );

    expect(runNpmInstall).toHaveBeenCalledTimes(1);

    rerender(props);

    expect(runNpmInstall).toHaveBeenCalledTimes(1);
  });

  it('refreshes only the modules section when asked', () => {
    const props = makeProps({
      prereqs: makePrereqs({
        prereqs: [cr('pass', 'Node.js'), cr('pass', 'Docker')],
        prereqChecking: new Set(),
        prereqsLoading: false,
        allPrereqsPass: true,
      }),
      modules: makeModules({
        nodeModulesResult: cr('fail', 'npm install'),
        nodeModulesLoading: true,
      }),
    });

    const { result } = renderHook(() => useSetupWorkflow(props));

    act(() => result.current.refreshSection('install'));

    expect(props.modules.reset).toHaveBeenCalled();
    expect(props.microsoftAuth.reset).toHaveBeenCalled();
    expect(props.deploy.reset).toHaveBeenCalled();
    expect(result.current.currentStep).toBe(STEP_MODULES);
    expect(result.current.currentSection).toBe('install');
  });

  it('only allows refreshing dependent sections after upstream completion', () => {
    const { result: pendingResult } = renderHook(() =>
      useSetupWorkflow(makeProps())
    );

    expect(pendingResult.current.canRefreshSection('prereqs')).toBe(true);
    expect(pendingResult.current.canRefreshSection('install')).toBe(false);

    const props = makeProps({
      prereqs: makePrereqs({
        prereqs: [cr('pass', 'Node.js'), cr('pass', 'Docker')],
        prereqChecking: new Set(),
        prereqsLoading: false,
        allPrereqsPass: true,
      }),
    });

    const { result } = renderHook(() => useSetupWorkflow(props));

    expect(result.current.canRefreshSection('install')).toBe(true);
  });

  // ── Auto-deploy gating ──────────────────────────────────────────────

  /** Build props where all steps before STEP_DEPLOY have passed. */
  function propsAtDeployStep(
    deployOverrides: Partial<DeployStepState> = {},
    extra: Partial<Props> = {}
  ): Props {
    return makeProps({
      prereqs: makePrereqs({
        prereqs: [cr('pass', 'Node.js'), cr('pass', 'Docker')],
        prereqChecking: new Set(),
        prereqsLoading: false,
        allPrereqsPass: true,
      }),
      modules: makeModules({
        nodeModulesResult: cr('pass', 'npm install'),
      }),
      microsoftAuth: makeMicrosoftAuth({
        microsoftAuth: cr('pass', 'Microsoft Account'),
      }),
      deploy: makeDeploy(deployOverrides),
      ...extra,
    });
  }

  it('does not auto-trigger deploy when autoDeployEnabled is false (default)', () => {
    const runDeploy = vi.fn();
    const props = propsAtDeployStep({ runDeploy });

    const { result } = renderHook(() => useSetupWorkflow(props));

    expect(result.current.currentStep).toBe(STEP_DEPLOY);
    expect(runDeploy).not.toHaveBeenCalled();
  });

  it('auto-triggers deploy when autoDeployEnabled is true', () => {
    const runDeploy = vi.fn();
    const props = propsAtDeployStep({ runDeploy }, { autoDeployEnabled: true });

    renderHook(() => useSetupWorkflow(props));

    expect(runDeploy).toHaveBeenCalledTimes(1);
  });

  it('does not auto-trigger deploy when already deployed (autoDeployEnabled true)', () => {
    const runDeploy = vi.fn();
    const props = propsAtDeployStep(
      { deploy: cr('pass', 'Deploy'), runDeploy },
      { autoDeployEnabled: true }
    );

    const { result } = renderHook(() => useSetupWorkflow(props));

    expect(runDeploy).not.toHaveBeenCalled();
    expect(result.current.currentStep).toBe(STEP_DONE);
  });

  it('does not auto-trigger deploy when first observed state is deploying (warn)', () => {
    const runDeploy = vi.fn();
    const props = propsAtDeployStep(
      { deploy: cr('warn', 'Deploy'), runDeploy },
      { autoDeployEnabled: true }
    );

    const { result } = renderHook(() => useSetupWorkflow(props));

    expect(runDeploy).not.toHaveBeenCalled();
    expect(result.current.currentStep).toBe(STEP_DEPLOY);
  });

  it('does not auto-trigger deploy after a refresh (autoDeployEnabled true)', () => {
    const runDeploy = vi.fn();
    const props = propsAtDeployStep({ runDeploy }, { autoDeployEnabled: true });

    const { result, rerender } = renderHook(() => useSetupWorkflow(props));

    // Initial mount fires auto-deploy exactly once.
    expect(runDeploy).toHaveBeenCalledTimes(1);

    // User clicks refresh on the Deploy section.
    act(() => {
      result.current.refreshSection('deploy');
    });
    rerender();

    // Even though autoDeployEnabled is still true and the deploy check
    // again resolves to 'fail' (not deployed), auto-deploy must NOT
    // fire a second time.
    expect(runDeploy).toHaveBeenCalledTimes(1);
  });

  it('does not auto-trigger deploy after a prereqs refresh (autoDeployEnabled true)', () => {
    const runDeploy = vi.fn();
    const props = propsAtDeployStep(
      { deploy: cr('pass', 'Deploy'), runDeploy },
      { autoDeployEnabled: true }
    );

    const { result, rerender } = renderHook(() => useSetupWorkflow(props));

    // Initial observation was 'deployed' → auto-deploy consumed.
    expect(runDeploy).not.toHaveBeenCalled();

    // User refreshes prereqs; when the workflow arrives back at the
    // Deploy step later we must still not auto-deploy.
    act(() => {
      result.current.refreshSection('prereqs');
    });
    rerender();

    expect(runDeploy).not.toHaveBeenCalled();
  });
});
