/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CheckResult } from '@microsoft/rayfin-tools-common/_internal/checks';
import * as l10n from '@vscode/l10n';
import { useCallback, useEffect, useState } from 'react';

import { useTrpcClient } from '../../../../api/webview-client/useTrpcClient';
import { useTrackedRequest } from '../../../../hooks/useTrackedRequest';
import {
  CHECKING_DETAIL,
  asFailedResult,
  getSectionStatus,
  withTimeout,
} from '../../../../utils/setupUtils';

const MODULES_BLOCKED_RESULT: CheckResult = {
  status: 'warn',
  name: 'npm install',
  detail: l10n.t('Complete tools and access setup first'),
};

export type ModulesPhase =
  | 'blocked'
  | 'blocked-no-folder'
  | 'checking'
  | 'needs-install'
  | 'ready';

export interface ModulesCheckState {
  nodeModulesResult: CheckResult;
  nodeModulesLoading: boolean;
  modulesUnlocked: boolean;
  npmInstallBusy: boolean;
  modulesPhase: ModulesPhase;
  modulesStatus: CheckResult['status'] | 'checking';
  refreshNodeModules: () => Promise<void>;
  runNpmInstall: () => void;
  setNpmInstallBusy: (busy: boolean) => void;
  start: () => void;
  reset: () => void;
}

export function useModulesCheck(folder: string | undefined): ModulesCheckState {
  const { trpcClient } = useTrpcClient();
  const [nodeModulesResult, setNodeModulesResult] = useState<CheckResult>(
    MODULES_BLOCKED_RESULT
  );
  const [modulesUnlocked, setModulesUnlocked] = useState(false);
  const [npmInstallBusy, setNpmInstallBusy] = useState(false);
  const [missingFolder, setMissingFolder] = useState(false);
  const tracker = useTrackedRequest();
  const { loading, run, abort, resetLoading } = tracker;

  const nodeModulesLoading = loading;
  const modulesPhase: ModulesPhase = nodeModulesLoading
    ? 'checking'
    : !modulesUnlocked
      ? 'blocked'
      : missingFolder
        ? 'blocked-no-folder'
        : nodeModulesResult.status === 'pass'
          ? 'ready'
          : 'needs-install';

  const modulesStatus = getSectionStatus(
    [nodeModulesResult],
    nodeModulesLoading
  );

  const refreshNodeModules = useCallback(async () => {
    if (!folder) {
      setMissingFolder(true);
      setNodeModulesResult({
        status: 'warn',
        name: 'npm install',
        detail: l10n.t('No folder open'),
      });
      resetLoading();
      return;
    }

    setMissingFolder(false);
    setNodeModulesResult({
      status: 'warn',
      name: 'npm install',
      detail: CHECKING_DETAIL,
    });

    try {
      const result = await run((_, signal) =>
        withTimeout(
          l10n.t('npm install'),
          (requestSignal) =>
            trpcClient.projectView.checkNodeModules.query(
              { folder },
              { signal: requestSignal }
            ),
          signal
        )
      );
      if (result.stale) return;
      setNodeModulesResult({
        status: result.value.exists ? 'pass' : 'fail',
        name: 'npm install',
        detail: result.value.exists
          ? l10n.t('Dependencies installed')
          : l10n.t('node_modules not found'),
      });
    } catch (error) {
      setNodeModulesResult(
        asFailedResult(
          'npm install',
          error instanceof Error ? error.message : l10n.t('Check failed')
        )
      );
    }
  }, [folder, resetLoading, run, trpcClient]);

  const runNpmInstall = useCallback(() => {
    if (!folder) {
      setMissingFolder(true);
      return;
    }

    setMissingFolder(false);
    setNpmInstallBusy(true);
    trpcClient.projectView.runNpmInstall.mutate({ folder });
  }, [folder, trpcClient]);

  const start = useCallback(() => {
    setModulesUnlocked(true);
    void refreshNodeModules();
  }, [refreshNodeModules]);

  const reset = useCallback(() => {
    abort();
    resetLoading();
    setModulesUnlocked(false);
    setMissingFolder(false);
    setNpmInstallBusy(false);
    setNodeModulesResult(MODULES_BLOCKED_RESULT);
  }, [abort, resetLoading]);

  // Listen for terminal action completions
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type !== 'actionComplete') return;
      if (event.data.action === 'npmInstall') {
        setNpmInstallBusy(false);
        void refreshNodeModules();
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [refreshNodeModules]);
  return {
    nodeModulesResult,
    nodeModulesLoading,
    modulesUnlocked,
    npmInstallBusy,
    modulesPhase,
    modulesStatus,
    refreshNodeModules,
    runNpmInstall,
    setNpmInstallBusy,
    start,
    reset,
  };
}
