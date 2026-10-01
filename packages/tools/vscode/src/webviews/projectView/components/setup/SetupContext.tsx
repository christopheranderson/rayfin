/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CheckResult } from '@microsoft/rayfin-tools-common/_internal/checks';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';

import { useTrpcClient } from '../../../api/webview-client/useTrpcClient';
import { getSectionStatus } from '../../../utils/setupUtils';

import {
  useDockerGhcr,
  useModulesCheck,
  usePrereqChecks,
  useMicrosoftAuth,
  useDeployStep,
  useSetupWorkflow,
  type DeployStepState,
  type DockerGhcrState,
  type MicrosoftAuthState,
  type ModulesCheckState,
  type PrereqChecksState,
  type SetupSectionId,
  type SetupWorkflowSection,
} from './hooks';

export interface SetupContextValue {
  prereqs: PrereqChecksState;
  dockerGhcr: DockerGhcrState;
  modules: ModulesCheckState;
  microsoftAuth: MicrosoftAuthState;
  deploy: DeployStepState;
  folder?: string;
  /** Current step in the flat sequential pipeline, or STEP_DONE if complete. */
  currentStep: number;
  /** Current active section in the setup workflow. */
  currentSection: SetupWorkflowSection;
  /** Get the current visual state of an individual step. */
  getStepState: (step: number) => 'done' | 'active' | 'pending';
  /** Refresh one section and invalidate downstream sections. */
  refreshSection: (sectionId: SetupSectionId) => void;
  /** Whether a section refresh is currently allowed. */
  canRefreshSection: (sectionId: SetupSectionId) => boolean;
  /** Restart the entire workflow from step 0. */
  restart: () => void;
  setupStatus: CheckResult['status'] | 'checking';
  /** Open an external URL via the extension host. */
  openUrl: (url: string) => void;
  /** Open a workspace folder via the VS Code file picker. */
  openWorkspaceFolder: () => void;
}

const SetupContext = createContext<SetupContextValue | null>(null);

export function useSetupContext(): SetupContextValue {
  const ctx = useContext(SetupContext);
  if (!ctx)
    throw new Error('useSetupContext must be used within SetupProvider');
  return ctx;
}

export function SetupProvider({
  folder,
  autoDeployEnabled,
  children,
}: {
  folder?: string;
  autoDeployEnabled?: boolean;
  children: ReactNode;
}) {
  const { trpcClient } = useTrpcClient();
  const prereqs = usePrereqChecks();
  const dockerGhcr = useDockerGhcr();
  const modules = useModulesCheck(folder);
  const microsoftAuth = useMicrosoftAuth();
  const deploy = useDeployStep(folder);

  const {
    currentStep,
    currentSection,
    getStepState,
    refreshSection: rawRefreshSection,
    canRefreshSection,
    restart: rawRestart,
  } = useSetupWorkflow({
    prereqs,
    modules,
    microsoftAuth,
    deploy,
    folder,
    autoDeployEnabled,
  });

  // Wrap restart and refreshSection to rotate the telemetry session ID
  // so each user-initiated flow run is correlated under a new ID. We
  // must await the mutation before kicking off the next workflow
  // activity; otherwise subsequent RPCs can finalize on the server
  // before `session.id` is rotated and get tagged with the previous
  // session id.
  const refreshSection = useCallback(
    async (sectionId: SetupSectionId) => {
      try {
        await trpcClient.projectView.resetSession.mutate();
      } catch {
        // Telemetry correlation is best-effort; continue regardless.
      }
      rawRefreshSection(sectionId);
    },
    [trpcClient, rawRefreshSection]
  );

  const restart = useCallback(async () => {
    try {
      await trpcClient.projectView.resetSession.mutate();
    } catch {
      // Telemetry correlation is best-effort; continue regardless.
    }
    rawRestart();
  }, [trpcClient, rawRestart]);

  // ── Auto-check Container Registry when Docker is installed ──────────
  // GHCR auth is optional and outside the main pipeline, but should still
  // auto-check (not auto-fix) whenever Docker prereq passes. A ref tracks
  // whether we've already fired so the effect doesn't loop; the flag resets
  // when Docker goes back to checking (e.g. prereq section refresh).
  const ghcrAutoCheckFiredRef = useRef(false);
  useEffect(() => {
    if (prereqs.prereqChecking.has('Docker')) {
      ghcrAutoCheckFiredRef.current = false;
      return;
    }
    const dockerPrereq = prereqs.prereqs.find((p) => p.name === 'Docker');
    if (dockerPrereq?.status === 'pass' && !ghcrAutoCheckFiredRef.current) {
      ghcrAutoCheckFiredRef.current = true;
      void dockerGhcr.refreshDockerGhcr();
    }
  }, [prereqs.prereqs, prereqs.prereqChecking, dockerGhcr.refreshDockerGhcr]);

  // Only required checks contribute to the overall setup status.
  // Docker and Container Registry are optional (local backend) and excluded.
  const nodePrereq = prereqs.prereqs.find((p) => p.name === 'Node.js');
  const setupStatus = getSectionStatus(
    [
      ...(nodePrereq ? [nodePrereq] : []),
      modules.nodeModulesResult,
      microsoftAuth.microsoftAuth,
      deploy.deploy,
    ],
    prereqs.prereqsLoading ||
      modules.nodeModulesLoading ||
      modules.npmInstallBusy ||
      microsoftAuth.microsoftAuthLoading ||
      microsoftAuth.microsoftAuthBusy ||
      deploy.deployLoading ||
      deploy.deployBusy
  );

  const openUrl = useCallback(
    (url: string) => {
      trpcClient.common.openUrl.mutate({ url });
    },
    [trpcClient]
  );

  const openWorkspaceFolder = useCallback(() => {
    trpcClient.projectView.openWorkspaceFolder.mutate();
  }, [trpcClient]);

  const value = useMemo<SetupContextValue>(
    () => ({
      prereqs,
      dockerGhcr,
      modules,
      microsoftAuth,
      deploy,
      folder,
      currentStep,
      currentSection,
      getStepState,
      refreshSection,
      canRefreshSection,
      restart,
      setupStatus,
      openUrl,
      openWorkspaceFolder,
    }),
    [
      prereqs,
      dockerGhcr,
      modules,
      microsoftAuth,
      deploy,
      folder,
      currentStep,
      currentSection,
      getStepState,
      refreshSection,
      canRefreshSection,
      restart,
      setupStatus,
      openUrl,
      openWorkspaceFolder,
    ]
  );

  return (
    <SetupContext.Provider value={value}>{children}</SetupContext.Provider>
  );
}
