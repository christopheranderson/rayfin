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
  Spinner,
  Subtitle1,
  Switch,
} from '@fluentui/react-components';
import { ErrorCircleRegular } from '@fluentui/react-icons';
import * as l10n from '@vscode/l10n';
import { useCallback, useState } from 'react';

import { useTrpcClient } from '../../../../../api/webview-client/useTrpcClient';

type ErrorDemoResult = {
  success: boolean;
  message: string;
  timestamp: string;
} | null;

export const ErrorHandlingDemo: React.FC = () => {
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
   * const result = await trpcClient.mainView.throwOnDemand.query({ shouldThrow });
   * ```
   *
   * @see useTrpcClient.ts — creates the client with `createTRPCClient<AppRouter>()`
   * @see vscodeLink.ts   — custom tRPC link that serializes calls to postMessage
   * @see appRouter.ts    — root router that bundles all view routers
   */
  const { trpcClient } = useTrpcClient();
  const [shouldThrow, setShouldThrow] = useState(true);
  const [errorDemoResult, setErrorDemoResult] = useState<ErrorDemoResult>(null);
  const [errorDemoLoading, setErrorDemoLoading] = useState(false);

  const handleErrorDemo = useCallback(async () => {
    setErrorDemoLoading(true);
    setErrorDemoResult(null);
    try {
      const result = await trpcClient.mainView.throwOnDemand.query({
        shouldThrow,
      });
      setErrorDemoResult({
        success: true,
        message: result.message,
        timestamp: result.timestamp,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setErrorDemoResult({
        success: false,
        message: errorMessage,
        timestamp: new Date().toISOString(),
      });
    } finally {
      setErrorDemoLoading(false);
    }
  }, [trpcClient, shouldThrow]);

  return (
    <div className="mainView__card">
      <div className="mainView__card-header">
        <Subtitle1>{l10n.t('Error Handling')}</Subtitle1>
        <Badge appearance="tint" color="danger">
          {l10n.t('Try/Catch')}
        </Badge>
      </div>
      <Body1>
        {l10n.t(
          'Demonstrates how errors thrown on the extension host propagate back to the webview through tRPC. Toggle the switch to control whether the server throws an error or returns a success result.'
        )}
      </Body1>
      <div className="mainView__card-content">
        <Switch
          label={
            shouldThrow
              ? l10n.t('Server will throw an error')
              : l10n.t('Server will return success')
          }
          checked={shouldThrow}
          onChange={(_, data) => setShouldThrow(data.checked)}
        />
        <div className="mainView__button-row">
          <Button
            appearance="primary"
            icon={<ErrorCircleRegular />}
            onClick={() => void handleErrorDemo()}
            disabled={errorDemoLoading}
          >
            {l10n.t('Call Procedure')}
          </Button>
          {errorDemoLoading && (
            <Spinner size="tiny" label={l10n.t('Loading...')} />
          )}
        </div>
        {errorDemoResult && (
          <MessageBar intent={errorDemoResult.success ? 'success' : 'error'}>
            <MessageBarBody>
              <MessageBarTitle>
                {errorDemoResult.success
                  ? l10n.t('Success')
                  : l10n.t('Error Caught')}
              </MessageBarTitle>
              {errorDemoResult.message}
            </MessageBarBody>
          </MessageBar>
        )}
        {errorDemoResult && (
          <div className="mainView__result">
            {JSON.stringify(errorDemoResult, null, 2)}
          </div>
        )}
      </div>
    </div>
  );
};
