/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CheckResult } from '@microsoft/rayfin-tools-common/_internal/checks';
import * as l10n from '@vscode/l10n';
import { useCallback, useState } from 'react';

import { useTrackedRequest } from '../../../../hooks/useTrackedRequest';
import { asFailedResult, withTimeout } from '../../../../utils/setupUtils';

export interface SetupCheckConfig {
  /** Display name for the check (used in error messages). */
  name: string;
  /** The result to show while the step is blocked by an upstream dependency. */
  blockedResult: CheckResult;
  /** Run the check query. Receives the abort signal from the tracker. */
  check: (signal: AbortSignal) => Promise<CheckResult>;
  /** Run the remediation action (e.g. sign-in, configure). */
  action?: () => Promise<CheckResult>;
  /** User-facing label for the action failure message. */
  actionFailLabel?: string;
}

export interface SetupCheckState {
  result: CheckResult;
  loading: boolean;
  busy: boolean;
  blocked: boolean;
  refresh: () => Promise<void>;
  runAction: () => Promise<void>;
  /** Run a custom async operation through the tracker (sets loading). */
  runTracked: <T>(
    fn: (signal: AbortSignal) => Promise<T>,
    options?: { skipAbortPrevious?: boolean }
  ) => Promise<
    { value: T; stale: boolean } | { value: undefined; stale: true }
  >;
  setResult: (result: CheckResult) => void;
  setBlocked: () => void;
  reset: () => void;
}

/**
 * Generic hook that encapsulates the shared lifecycle of a setup check:
 * blocked state, tracked request for loading/abort, refresh via a check
 * query, an optional remediation action, and reset/setBlocked helpers.
 */
export function useSetupCheck({
  name,
  blockedResult,
  check,
  action,
  actionFailLabel,
}: SetupCheckConfig): SetupCheckState {
  const [result, setResult] = useState<CheckResult>(blockedResult);
  const [blocked, setBlockedFlag] = useState(true);
  const [busy, setBusy] = useState(false);
  const tracker = useTrackedRequest();
  const { loading, run, abort, resetLoading } = tracker;

  const refresh = useCallback(async () => {
    setBlockedFlag(false);
    try {
      const tracked = await run((_, signal) =>
        withTimeout(name, (s) => check(s), signal)
      );
      if (!tracked.stale) setResult(tracked.value);
    } catch (error) {
      setBlockedFlag(false);
      setResult(
        asFailedResult(
          name,
          error instanceof Error ? error.message : l10n.t('Check failed')
        )
      );
    }
  }, [name, check, run]);

  const runAction = useCallback(async () => {
    if (!action) return;
    setBusy(true);
    setBlockedFlag(false);
    try {
      const tracked = await run(() => action(), {
        skipAbortPrevious: true,
      });
      if (!tracked.stale) setResult(tracked.value);
    } catch (error) {
      setBlockedFlag(false);
      setResult(
        asFailedResult(
          name,
          error instanceof Error
            ? error.message
            : (actionFailLabel ?? l10n.t('Action failed'))
        )
      );
    } finally {
      setBusy(false);
    }
  }, [name, action, actionFailLabel, run]);

  const setBlocked = useCallback(() => {
    resetLoading();
    setBlockedFlag(true);
    setResult(blockedResult);
  }, [blockedResult, resetLoading]);

  const reset = useCallback(() => {
    abort();
    resetLoading();
    setBlockedFlag(true);
    setBusy(false);
    setResult(blockedResult);
  }, [blockedResult, abort, resetLoading]);

  const runTracked = useCallback(
    async <T>(
      fn: (signal: AbortSignal) => Promise<T>,
      options?: { skipAbortPrevious?: boolean }
    ) => {
      setBlockedFlag(false);
      return run((_, signal) => fn(signal), options);
    },
    [run]
  );

  return {
    result,
    loading,
    busy,
    blocked,
    refresh,
    runAction,
    runTracked,
    setResult,
    setBlocked,
    reset,
  };
}
