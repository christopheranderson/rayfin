/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CheckResult } from '@microsoft/rayfin-tools-common/_internal/checks';
import * as l10n from '@vscode/l10n';
import { useCallback } from 'react';

import { useTrpcClient } from '../../../../api/webview-client/useTrpcClient';

import { useSetupCheck } from './useSetupCheck';

const DEPLOY_BLOCKED_RESULT: CheckResult = {
  status: 'warn',
  name: 'Deploy',
  detail: l10n.t('Waiting for previous steps'),
};

export type DeployPhase =
  | 'blocked'
  | 'checking'
  | 'needs-deploy'
  | 'deploying'
  | 'ready';

export interface DeployStepState {
  deploy: CheckResult;
  deployLoading: boolean;
  deployBusy: boolean;
  deployPhase: DeployPhase;
  refreshDeploy: () => Promise<void>;
  runDeploy: () => Promise<void>;
  reset: () => void;
}

export function useDeployStep(folder: string | undefined): DeployStepState {
  const { trpcClient } = useTrpcClient();

  const check = useCallback(
    async (_signal: AbortSignal): Promise<CheckResult> => {
      if (!folder) {
        return {
          status: 'fail',
          name: 'Deploy',
          detail: l10n.t('No folder open'),
        };
      }
      const result = await trpcClient.projectView.checkDeploy.query({ folder });
      if (result.deployed) {
        return {
          status: 'pass',
          name: 'Deploy',
          detail: result.workspaceName
            ? l10n.t('Deployed to {0}', result.workspaceName)
            : l10n.t('Deployed'),
        };
      }
      if (result.deploying) {
        return {
          status: 'warn',
          name: 'Deploy',
          detail: result.workspaceName
            ? l10n.t('Deploying to {0}…', result.workspaceName)
            : l10n.t('Deploying…'),
        };
      }
      return {
        status: 'fail',
        name: 'Deploy',
        detail: l10n.t('Not deployed'),
      };
    },
    [folder, trpcClient]
  );

  const action = useCallback(async (): Promise<CheckResult> => {
    await trpcClient.projectView.runDeploy.mutate(
      folder ? { folder } : undefined
    );
    // Re-check deployment status after deploy completes
    if (folder) {
      const result = await trpcClient.projectView.checkDeploy.query({ folder });
      if (result.deployed) {
        return {
          status: 'pass',
          name: 'Deploy',
          detail: result.workspaceName
            ? l10n.t('Deployed to {0}', result.workspaceName)
            : l10n.t('Deployed'),
        };
      }
      if (result.deploying) {
        return {
          status: 'warn',
          name: 'Deploy',
          detail: result.workspaceName
            ? l10n.t('Deploying to {0}…', result.workspaceName)
            : l10n.t('Deploying…'),
        };
      }
    }
    return {
      status: 'pass',
      name: 'Deploy',
      detail: l10n.t('Deploy started'),
    };
  }, [trpcClient, folder]);

  const core = useSetupCheck({
    name: 'Deploy',
    blockedResult: DEPLOY_BLOCKED_RESULT,
    check,
    action,
    actionFailLabel: l10n.t('Deploy failed'),
  });

  // Determine phase from the current result.  A `warn` status with a
  // non-blocked result is the in-progress deploying state.
  const isDeploying =
    !core.blocked && !core.loading && core.result.status === 'warn';

  const deployPhase: DeployPhase = core.loading
    ? 'checking'
    : core.blocked
      ? 'blocked'
      : core.result.status === 'pass'
        ? 'ready'
        : isDeploying
          ? 'deploying'
          : 'needs-deploy';

  return {
    deploy: core.result,
    deployLoading: core.loading,
    deployBusy: core.busy,
    deployPhase,
    refreshDeploy: core.refresh,
    runDeploy: core.runAction,
    reset: core.reset,
  };
}
