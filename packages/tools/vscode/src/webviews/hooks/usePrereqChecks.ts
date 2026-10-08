/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  PREREQ_DEFINITIONS,
  type CheckResult,
} from '@microsoft/rayfin-tools-common/_internal/checks';
import * as l10n from '@vscode/l10n';
import { useCallback, useEffect, useState } from 'react';

import { useTrpcClient } from '../api/webview-client/useTrpcClient';
import {
  CHECKING_DETAIL,
  asFailedResult,
  getSectionStatus,
  isAbortError,
  withTimeout,
} from '../utils/setupUtils';

import { useTrackedRequest } from './useTrackedRequest';

export interface PrereqChecksState {
  prereqs: CheckResult[];
  prereqChecking: Set<string>;
  prereqsLoading: boolean;
  allPrereqsPass: boolean;
  requiredToolsStatus: CheckResult['status'] | 'checking';
  refreshPrereqs: (force?: boolean) => Promise<void>;
  refreshPrereq: (name: string) => Promise<void>;
}

function createPendingPrereq(
  definition: (typeof PREREQ_DEFINITIONS)[number]
): CheckResult {
  return {
    status: 'warn' as const,
    name: definition.name,
    detail: CHECKING_DETAIL,
    installUrl: definition.installUrl,
  };
}

export function usePrereqChecks(): PrereqChecksState {
  const { trpcClient } = useTrpcClient();
  const [prereqs, setPrereqs] = useState<CheckResult[]>(() =>
    PREREQ_DEFINITIONS.map(createPendingPrereq)
  );
  const [prereqChecking, setPrereqChecking] = useState<Set<string>>(
    () => new Set(PREREQ_DEFINITIONS.map((d) => d.name))
  );

  // Destructure trackers so callbacks depend only on stable useCallback refs,
  // NOT on the tracker object (whose identity changes when `loading` changes).
  const bulkTracker = useTrackedRequest();
  const {
    loading: bulkLoading,
    run: bulkRun,
    isCurrent: bulkIsCurrent,
    abort: bulkAbort,
    resetLoading: bulkResetLoading,
    isLoading: bulkIsLoading,
  } = bulkTracker;

  const singleTracker = useTrackedRequest();
  const {
    run: singleRun,
    isCurrent: singleIsCurrent,
    abort: singleAbort,
    resetLoading: singleResetLoading,
  } = singleTracker;

  const prereqsLoading = bulkLoading;
  const allPrereqsPass = prereqs.every((p) => p.status === 'pass');
  const requiredToolsStatus = getSectionStatus(prereqs, prereqsLoading);

  const resetPrereqState = useCallback(() => {
    setPrereqChecking(new Set(PREREQ_DEFINITIONS.map((d) => d.name)));
    setPrereqs(PREREQ_DEFINITIONS.map(createPendingPrereq));
  }, []);

  const runPrereqCheck = useCallback(
    async (
      definition: (typeof PREREQ_DEFINITIONS)[number],
      signal?: AbortSignal
    ): Promise<CheckResult> => {
      try {
        return await withTimeout(
          definition.name,
          (requestSignal) =>
            trpcClient.projectView.checkPrerequisite.query(
              { name: definition.name },
              { signal: requestSignal }
            ),
          signal
        );
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }

        return {
          ...asFailedResult(
            definition.name,
            error instanceof Error ? error.message : l10n.t('Check failed')
          ),
          installUrl: definition.installUrl,
        };
      }
    },
    [trpcClient]
  );

  const refreshPrereqs = useCallback(
    async (force = false) => {
      if (!force && bulkIsLoading()) {
        return;
      }
      singleAbort();
      resetPrereqState();
      try {
        await bulkRun(async (requestId, signal) => {
          for (const definition of PREREQ_DEFINITIONS) {
            try {
              const result = await runPrereqCheck(definition, signal);
              if (!bulkIsCurrent(requestId)) return;
              setPrereqs((prev) =>
                prev.map((prereq) =>
                  prereq.name === definition.name ? result : prereq
                )
              );
            } catch (error) {
              if (!bulkIsCurrent(requestId) || isAbortError(error)) {
                return;
              }
            } finally {
              if (bulkIsCurrent(requestId)) {
                setPrereqChecking((prev) => {
                  const next = new Set(prev);
                  next.delete(definition.name);
                  return next;
                });
              }
            }
          }
        });
      } catch {
        // Individual prerequisite failures are handled inline.
      }
    },
    [
      bulkIsCurrent,
      bulkIsLoading,
      bulkRun,
      singleAbort,
      resetPrereqState,
      runPrereqCheck,
    ]
  );

  const refreshPrereq = useCallback(
    async (name: string) => {
      const definition = PREREQ_DEFINITIONS.find(
        (candidate) => candidate.name === name
      );
      if (!definition) return;

      // Skip if a bulk refresh is running or this prereq is already checking.
      if (bulkIsLoading()) return;

      setPrereqChecking((prev) => new Set(prev).add(name));
      setPrereqs((prev) =>
        prev.map((prereq) =>
          prereq.name === name ? { ...prereq, detail: CHECKING_DETAIL } : prereq
        )
      );

      try {
        await singleRun(async (requestId, signal) => {
          const result = await runPrereqCheck(definition, signal);
          if (!singleIsCurrent(requestId)) return;

          setPrereqs((prev) =>
            prev.map((prereq) => (prereq.name === name ? result : prereq))
          );
        });
      } catch (error) {
        if (isAbortError(error)) return;
      } finally {
        setPrereqChecking((prev) => {
          const next = new Set(prev);
          next.delete(name);
          return next;
        });
      }
    },
    [bulkIsLoading, singleRun, singleIsCurrent, runPrereqCheck]
  );

  useEffect(() => {
    void refreshPrereqs(false);
  }, [refreshPrereqs]);

  useEffect(() => {
    return () => {
      bulkAbort();
      singleAbort();
      bulkResetLoading();
      singleResetLoading();
    };
  }, []);

  return {
    prereqs,
    prereqChecking,
    prereqsLoading,
    allPrereqsPass,
    requiredToolsStatus,
    refreshPrereqs,
    refreshPrereq,
  };
}
