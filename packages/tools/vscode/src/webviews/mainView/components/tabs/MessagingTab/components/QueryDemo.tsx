/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  Badge,
  Body1,
  Button,
  Spinner,
  Subtitle1,
} from '@fluentui/react-components';
import { PlayRegular } from '@fluentui/react-icons';
import * as l10n from '@vscode/l10n';
import { useCallback, useState } from 'react';

import { useTrpcClient } from '../../../../../api/webview-client/useTrpcClient';

type QueryResult = { message: string; timestamp: string } | null;

export const QueryDemo: React.FC = () => {
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
   * const result = await trpcClient.mainView.hello.query();
   * ```
   *
   * @see useTrpcClient.ts — creates the client with `createTRPCClient<AppRouter>()`
   * @see vscodeLink.ts   — custom tRPC link that serializes calls to postMessage
   * @see appRouter.ts    — root router that bundles all view routers
   */
  const { trpcClient } = useTrpcClient();
  const [queryResult, setQueryResult] = useState<QueryResult>(null);
  const [queryLoading, setQueryLoading] = useState(false);

  const handleRunQuery = useCallback(async () => {
    setQueryLoading(true);
    setQueryResult(null);
    try {
      const result = await trpcClient.mainView.hello.query();
      setQueryResult(result);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setQueryResult({
        message: `Error: ${errorMessage}`,
        timestamp: new Date().toISOString(),
      });
    } finally {
      setQueryLoading(false);
    }
  }, [trpcClient]);

  return (
    <div className="mainView__card">
      <div className="mainView__card-header">
        <Subtitle1>{l10n.t('Basic Query')}</Subtitle1>
        <Badge appearance="tint" color="brand">
          {l10n.t('Query')}
        </Badge>
      </div>
      <Body1>
        {l10n.t(
          'Calls a basic tRPC query on the extension host and displays the JSON result. This is the most basic tRPC pattern — a single request/response round-trip over postMessage.'
        )}
      </Body1>
      <div className="mainView__card-content">
        <div className="mainView__button-row">
          <Button
            appearance="primary"
            icon={<PlayRegular />}
            onClick={() => void handleRunQuery()}
            disabled={queryLoading}
          >
            {l10n.t('Run Query')}
          </Button>
          {queryLoading && <Spinner size="tiny" label={l10n.t('Loading...')} />}
        </div>
        {queryResult && (
          <div className="mainView__result">
            {JSON.stringify(queryResult, null, 2)}
          </div>
        )}
      </div>
    </div>
  );
};
