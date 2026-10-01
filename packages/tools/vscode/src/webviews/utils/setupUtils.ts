/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CheckResult } from '@microsoft/rayfin-tools-common/_internal/checks';
import * as l10n from '@vscode/l10n';

export const SETUP_CHECK_TIMEOUT_MS = 20_000;
export const CHECKING_DETAIL = l10n.t('Checking…');

export function asFailedResult(name: string, detail: string): CheckResult {
  return { status: 'fail', name, detail };
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || /aborted/i.test(error.message))
  );
}

export async function withTimeout<T>(
  label: string,
  run: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal
): Promise<T> {
  const abortController = new AbortController();
  let removeExternalAbortListener: (() => void) | undefined;

  if (externalSignal !== undefined) {
    if (externalSignal.aborted) {
      abortController.abort(externalSignal.reason);
    } else {
      const onExternalAbort = () => {
        abortController.abort(externalSignal.reason);
      };
      externalSignal.addEventListener('abort', onExternalAbort, {
        once: true,
      });
      removeExternalAbortListener = () => {
        externalSignal.removeEventListener('abort', onExternalAbort);
      };
    }
  }

  const timeout = globalThis.setTimeout(() => {
    abortController.abort();
  }, SETUP_CHECK_TIMEOUT_MS);

  try {
    return await run(abortController.signal);
  } catch (error) {
    if (abortController.signal.aborted && !externalSignal?.aborted) {
      throw new Error(l10n.t('{label} check timed out', { label }));
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    removeExternalAbortListener?.();
  }
}

export function getSectionStatus(
  results: CheckResult[],
  loading: boolean
): CheckResult['status'] | 'checking' {
  if (loading) return 'checking';
  if (results.some((r) => r.status === 'fail')) return 'fail';
  if (results.some((r) => r.status === 'warn')) return 'warn';
  return 'pass';
}
