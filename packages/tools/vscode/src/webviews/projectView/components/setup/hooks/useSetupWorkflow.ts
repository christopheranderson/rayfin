/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CheckResult } from '@microsoft/rayfin-tools-common/_internal/checks';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { PrereqChecksState } from '../../../../hooks/usePrereqChecks';

import {
  SECTION_DEPLOY,
  SECTION_INSTALL,
  SECTION_PREREQS,
  SECTION_STEPS,
  STEP_DEPLOY,
  STEP_DONE,
  STEP_MODULES,
  STEP_MS_AUTH,
  STEP_NODE,
  sectionForStep,
  stepState,
  type SetupSectionId,
  type SetupWorkflowSection,
} from './stepDescriptors';
import type { DeployStepState } from './useDeployStep';
import type { MicrosoftAuthState } from './useMicrosoftAuth';
import type { ModulesCheckState } from './useModulesCheck';

// ── Hook ────────────────────────────────────────────────────────────────

export interface SetupWorkflowResult {
  /** Index of the step currently being checked, or STEP_DONE if complete. */
  currentStep: number;
  /** Section currently driving the workflow. */
  currentSection: SetupWorkflowSection;
  /** Get the current UI state of a single step. */
  getStepState: (stepIndex: number) => 'done' | 'active' | 'pending';
  /** Refresh one section and invalidate dependent downstream sections. */
  refreshSection: (sectionId: SetupSectionId) => void;
  /** Whether a section refresh can currently be triggered. */
  canRefreshSection: (sectionId: SetupSectionId) => boolean;
  /** Restart the workflow from step 0. */
  restart: () => void;
}

/**
 * Flat sequential setup pipeline. One number drives everything.
 *
 * The workflow reads each step's check result and either:
 * - Advances (step passed → move to next)
 * - Waits (step is loading/busy)
 * - Auto-remediates (step failed → fire action once)
 *
 * Each step maps to one status block in the UI.
 */
export function useSetupWorkflow({
  prereqs,
  modules,
  microsoftAuth,
  deploy,
  folder,
  autoDeployEnabled,
}: {
  prereqs: PrereqChecksState;
  modules: ModulesCheckState;
  microsoftAuth: MicrosoftAuthState;
  deploy: DeployStepState;
  folder: string | undefined;
  /** When false (default), the deploy step will not auto-trigger. */
  autoDeployEnabled?: boolean;
}): SetupWorkflowResult {
  const [currentStep, setCurrentStep] = useState(STEP_NODE);
  const [currentSection, setCurrentSection] =
    useState<SetupWorkflowSection>(SECTION_PREREQS);
  const startedStepRef = useRef<number | undefined>(undefined);
  const autoActionFiredRef = useRef<number | undefined>(undefined);
  // Flips to true the first time STEP_DEPLOY is completed (either pass or fail). Once true,
  // auto-deploy can never fire again for this workflow instance.
  const deployAutoConsumedRef = useRef(false);

  const setWorkflowPosition = useCallback((step: number) => {
    if (step >= STEP_DONE) {
      startedStepRef.current = undefined;
      setCurrentStep(STEP_DONE);
      setCurrentSection('done');
      return;
    }

    startedStepRef.current = undefined;
    setCurrentStep(step);
    setCurrentSection(sectionForStep(step));
  }, []);

  const getRuntimeState = useCallback(
    (
      step: number
    ): {
      status: CheckResult['status'];
      loading: boolean;
      busy: boolean;
    } => {
      switch (step) {
        case STEP_NODE: {
          const node = prereqs.prereqs.find((p) => p.name === 'Node.js');
          return {
            status: node?.status ?? 'fail',
            loading: prereqs.prereqChecking.has('Node.js'),
            busy: false,
          };
        }
        case STEP_MODULES:
          return {
            status: modules.nodeModulesResult.status,
            loading: modules.nodeModulesLoading,
            busy: modules.npmInstallBusy,
          };
        case STEP_MS_AUTH:
          return {
            status: microsoftAuth.microsoftAuth.status,
            loading: microsoftAuth.microsoftAuthLoading,
            busy: microsoftAuth.microsoftAuthBusy,
          };
        case STEP_DEPLOY:
          return {
            status: deploy.deploy.status,
            loading: deploy.deployLoading,
            busy: deploy.deployBusy,
          };
        default:
          return { status: 'pass', loading: false, busy: false };
      }
    },
    [prereqs, modules, microsoftAuth, deploy]
  );

  const getStepState = useCallback(
    (step: number) => stepState(step, currentStep),
    [currentStep]
  );

  const isSectionComplete = useCallback(
    (sectionId: SetupSectionId) =>
      SECTION_STEPS[sectionId].every(
        (step) => getRuntimeState(step).status === 'pass'
      ),
    [getRuntimeState]
  );

  const canRefreshSection = useCallback(
    (sectionId: SetupSectionId) => {
      switch (sectionId) {
        case SECTION_PREREQS:
          return true;
        case SECTION_INSTALL:
          return isSectionComplete(SECTION_PREREQS);
        case SECTION_DEPLOY:
          return isSectionComplete(SECTION_INSTALL);
        default:
          return false;
      }
    },
    [isSectionComplete]
  );

  // Start the check for a step (only called when that step becomes active)
  const startStep = useCallback(
    (step: number) => {
      switch (step) {
        case STEP_NODE:
          // Prereqs auto-start on mount via usePrereqChecks
          break;
        case STEP_MODULES:
          modules.start();
          break;
        case STEP_MS_AUTH:
          void microsoftAuth.refreshMicrosoftAuth();
          break;
        case STEP_DEPLOY:
          void deploy.refreshDeploy();
          break;
      }
    },
    [modules, microsoftAuth, deploy, folder]
  );

  const fireAutoAction = useCallback(
    (step: number) => {
      switch (step) {
        case STEP_MODULES:
          if (folder) {
            modules.runNpmInstall();
          }
          break;
        case STEP_MS_AUTH:
          void microsoftAuth.signInMicrosoft();
          break;
        case STEP_DEPLOY:
          // Only auto-trigger deployment when opened via the "Open in
          // VS Code" URI handler flow. Regular workspace opens require
          // the user to click Deploy manually.
          if (autoDeployEnabled && !deployAutoConsumedRef.current) {
            void deploy.runDeploy();
          }
          break;
      }
    },
    [modules, microsoftAuth, deploy, folder, autoDeployEnabled]
  );

  const resetInstallSection = useCallback(() => {
    modules.reset();
  }, [modules]);

  const resetDeploySection = useCallback(() => {
    microsoftAuth.reset();
    deploy.reset();
  }, [microsoftAuth, deploy]);

  const refreshSection = useCallback(
    (sectionId: SetupSectionId) => {
      autoActionFiredRef.current = undefined;
      switch (sectionId) {
        case SECTION_PREREQS:
          resetInstallSection();
          resetDeploySection();
          setWorkflowPosition(STEP_NODE);
          void prereqs.refreshPrereqs(true);
          break;
        case SECTION_INSTALL:
          resetInstallSection();
          resetDeploySection();
          setWorkflowPosition(STEP_MODULES);
          break;
        case SECTION_DEPLOY:
          resetDeploySection();
          setWorkflowPosition(STEP_MS_AUTH);
          break;
      }
    },
    [prereqs, resetInstallSection, resetDeploySection, setWorkflowPosition]
  );

  // ── The one effect that drives everything ──────────────────────────────
  useEffect(() => {
    if (currentStep >= STEP_DONE) return;

    if (startedStepRef.current !== currentStep) {
      startedStepRef.current = currentStep;
      startStep(currentStep);
    }

    const { status, loading, busy } = getRuntimeState(currentStep);

    // Still checking — wait
    if (loading || busy) return;

    // Passed — advance to next step
    if (status === 'pass') {
      autoActionFiredRef.current = undefined;
      const next = currentStep + 1;
      setWorkflowPosition(next);
    }

    // Failed — fire auto-remediation once (warn also blocks but without
    // auto-action, giving the user a chance to act on the install link)
    if (status === 'fail' && autoActionFiredRef.current !== currentStep) {
      autoActionFiredRef.current = currentStep;
      fireAutoAction(currentStep);
    }

    // Mark STEP_DEPLOY as consumed after the first settled observation
    // (pass or fail or warn). This ensures a refresh can never re-trigger
    // auto-deploy — even if the first observation was "deploying" (warn)
    // and a later refresh finds "not deployed" (fail).
    if (currentStep === STEP_DEPLOY) {
      deployAutoConsumedRef.current = true;
    }
  }, [
    currentStep,
    fireAutoAction,
    getRuntimeState,
    setWorkflowPosition,
    startStep,
  ]);

  const restart = useCallback(() => {
    refreshSection(SECTION_PREREQS);
  }, [refreshSection]);

  return {
    currentStep,
    currentSection,
    getStepState,
    refreshSection,
    canRefreshSection,
    restart,
  };
}
