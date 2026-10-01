/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';

import type {
  ChecklistAction,
  ChecklistRow,
  ChecklistStatus,
} from '../../../components/Checklist';
import { CHECKING_DETAIL } from '../../../utils/setupUtils';
import { useSetupContext } from '../setup/SetupContext';
import {
  STEP_DEPLOY,
  STEP_MODULES,
  STEP_MS_AUTH,
  STEP_NODE,
} from '../setup/hooks';

export interface SetupChecklistRows {
  requiredRows: readonly ChecklistRow[];
  optionalRows: readonly ChecklistRow[];
}

/**
 * Build a single checklist row, encapsulating the pending/checking/actual
 * resolution that every row repeats.
 */
function resolveChecklistRow(opts: {
  key: string;
  name: string;
  stepState: 'done' | 'active' | 'pending';
  isLoading: boolean;
  result: { status: ChecklistStatus; detail: string };
  pendingDescription?: string;
  action?: ChecklistAction;
}): ChecklistRow {
  const isPending = opts.stepState === 'pending';
  const isChecking = opts.stepState === 'active' && opts.isLoading;
  const isBusy = opts.stepState === 'active' && (opts.action?.busy ?? false);

  return {
    key: opts.key,
    name: opts.name,
    status: isPending ? 'pending' : (isChecking || isBusy) ? 'checking' : opts.result.status,
    disabled: isPending,
    description: isPending
      ? (opts.pendingDescription ?? l10n.t('Waiting for previous step'))
      : isChecking
        ? CHECKING_DETAIL
        : opts.result.detail,
    action: opts.action,
  };
}

export function useSetupChecklistRows(): SetupChecklistRows {
  const {
    prereqs: prereqState,
    dockerGhcr: dockerGhcrState,
    modules,
    microsoftAuth: microsoftAuthState,
    deploy: deployState,
    folder,
    getStepState,
    openUrl,
  } = useSetupContext();

  const { prereqs, prereqChecking } = prereqState;
  const { dockerGhcr, dockerGhcrBusy, dockerGhcrPhase, loginDockerGhcr } =
    dockerGhcrState;
  const { nodeModulesResult, npmInstallBusy, modulesPhase, runNpmInstall } =
    modules;
  const { microsoftAuth, microsoftAuthBusy, microsoftAuthPhase, signInMicrosoft } =
    microsoftAuthState;
  const { deploy, deployBusy, deployPhase, runDeploy } = deployState;

  // ── Required rows (main pipeline) ─────────────────────────────────────

  const nodePrereq = prereqs.find((p) => p.name === 'Node.js');
  const prereqRows: readonly ChecklistRow[] = nodePrereq
    ? [
        resolveChecklistRow({
          key: nodePrereq.name,
          name: nodePrereq.name,
          stepState: getStepState(STEP_NODE),
          isLoading: prereqChecking.has(nodePrereq.name),
          result: nodePrereq,
          action:
            nodePrereq.status !== 'pass' && nodePrereq.installUrl
              ? {
                  label: l10n.t('Install'),
                  onClick: () => {
                    openUrl(nodePrereq.installUrl!);
                  },
                }
              : undefined,
        }),
      ]
    : [];

  const installRows: readonly ChecklistRow[] = [
    resolveChecklistRow({
      key: 'install',
      name: l10n.t('NPM Install'),
      stepState: getStepState(STEP_MODULES),
      isLoading: modules.nodeModulesLoading,
      result: {
        status: nodeModulesResult.status,
        detail:
          modulesPhase === 'blocked-no-folder'
            ? l10n.t('No folder open')
            : nodeModulesResult.detail,
      },
      action: folder
        ? {
            label: modulesPhase === 'ready' ? l10n.t('Reinstall') : l10n.t('Install'),
            onClick: runNpmInstall,
            busy: npmInstallBusy,
          }
        : undefined,
    }),
  ];

  const deployRows: readonly ChecklistRow[] = [
    resolveChecklistRow({
      key: 'ms-auth',
      name: l10n.t('Auth in Fabric'),
      stepState: getStepState(STEP_MS_AUTH),
      isLoading: microsoftAuthState.microsoftAuthLoading,
      result: {
        status: microsoftAuth.status,
        detail: microsoftAuth.detail,
      },
      pendingDescription: l10n.t('Waiting for setup to complete'),
      action:
        microsoftAuthPhase !== 'ready'
          ? {
              label: l10n.t('Sign in'),
              onClick: () => {
                void signInMicrosoft();
              },
              busy: microsoftAuthBusy,
            }
          : undefined,
    }),
    resolveChecklistRow({
      key: 'deploy',
      name: l10n.t('Deploy App'),
      stepState: getStepState(STEP_DEPLOY),
      isLoading: deployState.deployLoading,
      result: {
        status: deploy.status,
        detail: deploy.detail,
      },
      pendingDescription: l10n.t('Waiting for Microsoft sign-in'),
      action:
        deployPhase === 'deploying'
          ? undefined
          : {
              label:
                deployPhase === 'ready'
                  ? l10n.t('Redeploy')
                  : l10n.t('Deploy'),
              onClick: () => {
                void runDeploy();
              },
              busy: deployBusy,
            },
    }),
  ];

  const requiredRows = [...prereqRows, ...installRows, ...deployRows];

  // ── Optional rows (local backend) ─────────────────────────────────────
  // Docker and Container Registry run independently of the main pipeline.

  const dockerPrereq = prereqs.find((p) => p.name === 'Docker');
  const isDockerChecking = prereqChecking.has('Docker');

  const dockerRow: ChecklistRow = {
    key: 'docker',
    name: l10n.t('Docker'),
    status: isDockerChecking ? 'checking' : (dockerPrereq?.status ?? 'fail'),
    description: isDockerChecking
      ? CHECKING_DETAIL
      : (dockerPrereq?.detail ?? l10n.t('Not found')),
    action:
      dockerPrereq && dockerPrereq.status !== 'pass' && dockerPrereq.installUrl
        ? {
            label: l10n.t('Install'),
            onClick: () => {
              openUrl(dockerPrereq.installUrl!);
            },
          }
        : undefined,
  };

  const ghcrRow: ChecklistRow = {
    key: 'ghcr',
    name: l10n.t('Container Registry'),
    status: dockerGhcrState.dockerGhcrLoading
      ? 'checking'
      : dockerGhcr.status,
    description: dockerGhcrState.dockerGhcrLoading
      ? CHECKING_DETAIL
      : dockerGhcrPhase === 'blocked'
        ? l10n.t('Install Docker and sign in to continue')
        : `Docker → ${dockerGhcr.detail}`,
    action:
      dockerGhcrPhase !== 'ready'
        ? {
            label: l10n.t('Configure'),
            onClick: () => {
              void loginDockerGhcr();
            },
            busy: dockerGhcrBusy,
          }
        : undefined,
  };

  const optionalRows: readonly ChecklistRow[] = [dockerRow, ghcrRow];

  return { requiredRows, optionalRows };
}
