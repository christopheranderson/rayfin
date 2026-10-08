/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  Badge,
  Body1,
  Button,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  ProgressBar,
  Subtitle1,
} from '@fluentui/react-components';
import { ArrowClockwiseRegular, DismissRegular } from '@fluentui/react-icons';
import * as l10n from '@vscode/l10n';
import { useCallback, useRef, useState } from 'react';

import { useTrpcClient } from '../../../../../api/webview-client/useTrpcClient';

type LongQueryResult = {
  result: string;
  completed: boolean;
  elapsedMs: number;
} | null;

export const LongQueryDemo: React.FC = () => {
  /**
   * `useTrpcClient` creates a fully-typed tRPC client scoped to this component.
   * The instance is stable across re-renders (via `useMemo`), but each component
   * that calls the hook gets its own client. The client communicates with the
   * extension host over `postMessage` using a custom `vscodeLink` tRPC link.
   *
   * Usage pattern:
   * ```ts
   * const result = await trpcClient.<namespace>.<router>.<procedure>.query(input);
   * ```
   *
   * For this demo the namespace is `demo`, the router is `mainView`, so:
   * ```ts
   * const result = await trpcClient.mainView.longRunningQuery.query({ durationMs: 5000 });
   * ```
   *
   * @see useTrpcClient.ts — creates the client with `createTRPCClient<AppRouter>()`
   * @see vscodeLink.ts   — custom tRPC link that serializes calls to postMessage
   * @see appRouter.ts    — root router that bundles all view routers
   */
  const { trpcClient } = useTrpcClient();
  const [longQueryResult, setLongQueryResult] = useState<LongQueryResult>(null);
  const [longQueryLoading, setLongQueryLoading] = useState(false);
  const longQueryAbortRef = useRef<AbortController | null>(null);

  const handleRunLongQuery = useCallback(async () => {
    longQueryAbortRef.current?.abort();

    const ac = new AbortController();
    longQueryAbortRef.current = ac;

    setLongQueryLoading(true);
    setLongQueryResult(null);
    try {
      const result = await trpcClient.mainView.longRunningQuery.query(
        { durationMs: 5000 },
        { signal: ac.signal }
      );
      setLongQueryResult(result);
    } catch (err) {
      if (ac.signal.aborted) {
        setLongQueryResult({
          result: l10n.t('Aborted by user'),
          completed: false,
          elapsedMs: 0,
        });
      } else {
        const errorMessage = err instanceof Error ? err.message : String(err);
        setLongQueryResult({
          result: `Error: ${errorMessage}`,
          completed: false,
          elapsedMs: 0,
        });
      }
    } finally {
      setLongQueryLoading(false);
      if (longQueryAbortRef.current === ac) {
        longQueryAbortRef.current = null;
      }
    }
  }, [trpcClient]);

  const handleCancelLongQuery = useCallback(() => {
    longQueryAbortRef.current?.abort();
  }, []);

  return (
    <div className="mainView__card">
      <div className="mainView__card-header">
        <Subtitle1>{l10n.t('Long-Running Query with Abort')}</Subtitle1>
        <Badge appearance="tint" color="important">
          {l10n.t('AbortSignal')}
        </Badge>
      </div>
      <Body1>
        {l10n.t(
          'Runs a 5-second operation on the extension host. Click Cancel to abort it mid-flight using an AbortController. The server checks ctx.signal?.aborted to respond to cancellation.'
        )}
      </Body1>
      <div className="mainView__card-content">
        <div className="mainView__button-row">
          <Button
            appearance="primary"
            icon={<ArrowClockwiseRegular />}
            onClick={() => void handleRunLongQuery()}
            disabled={longQueryLoading}
          >
            {l10n.t('Run Long Query (5s)')}
          </Button>
          <Button
            appearance="secondary"
            icon={<DismissRegular />}
            onClick={handleCancelLongQuery}
            disabled={!longQueryLoading}
          >
            {l10n.t('Cancel')}
          </Button>
        </div>
        {longQueryLoading && <ProgressBar />}
        {longQueryResult && (
          <MessageBar
            intent={longQueryResult.completed ? 'success' : 'warning'}
          >
            <MessageBarBody>
              <MessageBarTitle>
                {longQueryResult.completed
                  ? l10n.t('Completed')
                  : l10n.t('Interrupted')}
              </MessageBarTitle>
              {longQueryResult.result}
            </MessageBarBody>
          </MessageBar>
        )}
      </div>
    </div>
  );
};
