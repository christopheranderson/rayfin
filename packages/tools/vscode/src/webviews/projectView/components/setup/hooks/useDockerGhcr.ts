/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CheckResult } from '@microsoft/rayfin-tools-common/_internal/checks';
import * as l10n from '@vscode/l10n';
import { useCallback } from 'react';

import { useTrpcClient } from '../../../../api/webview-client/useTrpcClient';

import { useSetupCheck } from './useSetupCheck';

const GHCR_BLOCKED_RESULT: CheckResult = {
  status: 'warn',
  name: 'Container Registry',
  detail: l10n.t('Install Docker and sign in to continue'),
};

export type DockerGhcrPhase = 'blocked' | 'checking' | 'needs-login' | 'ready';

export interface DockerGhcrState {
  dockerGhcr: CheckResult;
  dockerGhcrLoading: boolean;
  dockerGhcrBusy: boolean;
  dockerGhcrPhase: DockerGhcrPhase;
  refreshDockerGhcr: () => Promise<void>;
  loginDockerGhcr: () => Promise<void>;
  reset: () => void;
}

export function useDockerGhcr(): DockerGhcrState {
  const { trpcClient } = useTrpcClient();

  const check = useCallback(
    (signal: AbortSignal) =>
      trpcClient.projectView.checkDockerGhcr.query(undefined, { signal }),
    [trpcClient]
  );

  const action = useCallback(
    () => trpcClient.projectView.loginDockerGhcr.mutate(),
    [trpcClient]
  );

  const core = useSetupCheck({
    name: 'Container Registry',
    blockedResult: GHCR_BLOCKED_RESULT,
    check,
    action,
    actionFailLabel: l10n.t('Login failed'),
  });

  const dockerGhcrPhase: DockerGhcrPhase = core.loading
    ? 'checking'
    : core.blocked
      ? 'blocked'
      : core.result.status === 'pass'
        ? 'ready'
        : 'needs-login';

  return {
    dockerGhcr: core.result,
    dockerGhcrLoading: core.loading,
    dockerGhcrBusy: core.busy,
    dockerGhcrPhase,
    refreshDockerGhcr: core.refresh,
    loginDockerGhcr: core.runAction,
    reset: core.reset,
  };
}
