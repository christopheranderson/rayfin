/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CheckResult } from '@microsoft/rayfin-tools-common/_internal/checks';
import * as l10n from '@vscode/l10n';
import { useCallback } from 'react';

import { useTrpcClient } from '../../../../api/webview-client/useTrpcClient';

import { useSetupCheck } from './useSetupCheck';

const MS_AUTH_BLOCKED_RESULT: CheckResult = {
  status: 'warn',
  name: 'Microsoft Account',
  detail: l10n.t('Waiting for previous steps'),
};

export type MicrosoftAuthPhase =
  | 'blocked'
  | 'checking'
  | 'needs-sign-in'
  | 'ready';

export interface MicrosoftAuthState {
  microsoftAuth: CheckResult;
  microsoftAuthLoading: boolean;
  microsoftAuthBusy: boolean;
  microsoftAuthPhase: MicrosoftAuthPhase;
  refreshMicrosoftAuth: () => Promise<void>;
  signInMicrosoft: () => Promise<void>;
  reset: () => void;
}

export function useMicrosoftAuth(): MicrosoftAuthState {
  const { trpcClient } = useTrpcClient();

  const check = useCallback(
    (signal: AbortSignal) =>
      trpcClient.projectView.checkMicrosoftAuth.query(undefined, { signal }),
    [trpcClient]
  );

  const action = useCallback(
    () => trpcClient.projectView.signInMicrosoft.mutate(),
    [trpcClient]
  );

  const core = useSetupCheck({
    name: 'Microsoft Account',
    blockedResult: MS_AUTH_BLOCKED_RESULT,
    check,
    action,
    actionFailLabel: l10n.t('Sign-in failed'),
  });

  const microsoftAuthPhase: MicrosoftAuthPhase = core.loading
    ? 'checking'
    : core.blocked
      ? 'blocked'
      : core.result.status === 'pass'
        ? 'ready'
        : 'needs-sign-in';

  return {
    microsoftAuth: core.result,
    microsoftAuthLoading: core.loading,
    microsoftAuthBusy: core.busy,
    microsoftAuthPhase,
    refreshMicrosoftAuth: core.refresh,
    signInMicrosoft: core.runAction,
    reset: core.reset,
  };
}
