/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  Badge,
  Body1,
  Button,
  Input,
  Label,
  Subtitle1,
} from '@fluentui/react-components';
import { BugRegular } from '@fluentui/react-icons';
import * as l10n from '@vscode/l10n';
import { useCallback, useState } from 'react';

import { useTrpcClient } from '../../../../../api/webview-client/useTrpcClient';

export const ReportErrorDemo: React.FC = () => {
  const { trpcClient } = useTrpcClient();
  const [errorMessage, setErrorMessage] = useState('Something went wrong');
  const [sent, setSent] = useState(false);
  const [lastResult, setLastResult] = useState<Record<string, unknown> | null>(
    null
  );

  /**
   * Reports an error to the extension host for logging/telemetry.
   *
   * In production, replace the `console.error` inside the `reportError`
   * procedure (appRouter.ts) with `callWithTelemetryAndErrorHandling`
   * from `@microsoft/vscode-azext-utils`:
   *
   * ```ts
   * void callWithTelemetryAndErrorHandling<void>(
   *     `myExtension.webview.error.${myCtx.webviewName}`,
   *     (context) => {
   *         context.errorHandling.suppressDisplay = true;
   *         Object.assign(context.telemetry.properties, input.properties ?? {});
   *
   *         const newError = new Error(input.message);
   *         // Swap stack with componentStack for React rendering errors
   *         newError.stack = input.componentStack ?? input.stack;
   *         throw newError;
   *     },
   * );
   * ```
   *
   * @see appRouter.ts — full production examples in the `commonRouter` JSDoc
   */
  const handleReportError = useCallback(async () => {
    const stack = new Error(errorMessage).stack ?? '';
    const payload = {
      message: errorMessage,
      stack: stack.split('\n')[0] ?? '',
      properties: { source: 'demo' },
    };

    try {
      await trpcClient.common.reportError.mutate({
        message: errorMessage,
        stack,
        properties: { source: 'demo' },
      });
      setLastResult({
        status: 'success',
        ...payload,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      setLastResult({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        ...payload,
        timestamp: new Date().toISOString(),
      });
    }

    setSent(true);
    setTimeout(() => setSent(false), 2000);
  }, [trpcClient, errorMessage]);

  return (
    <div className="mainView__card">
      <div className="mainView__card-header">
        <Subtitle1>{l10n.t('Report Error')}</Subtitle1>
        <Badge appearance="tint" color="danger">
          {l10n.t('Telemetry')}
        </Badge>
      </div>
      <Body1>
        {l10n.t(
          'Reports an error with a message and stack trace to the extension host. Errors are logged to the console by default. In production, wire this to your error tracking service to capture webview failures alongside extension-side errors.'
        )}
      </Body1>
      <div className="mainView__card-content">
        <div className="mainView__input-row">
          <Label htmlFor="error-message-input">{l10n.t('Error Message')}</Label>
          <Input
            id="error-message-input"
            value={errorMessage}
            onChange={(_, data) => setErrorMessage(data.value)}
            placeholder={l10n.t('e.g. Something went wrong')}
          />
        </div>
        <div className="mainView__button-row">
          <Button
            appearance="primary"
            icon={<BugRegular />}
            onClick={() => void handleReportError()}
          >
            {l10n.t('Report Error')}
          </Button>
          {sent && (
            <Badge appearance="filled" color="success">
              {l10n.t('Sent')}
            </Badge>
          )}
        </div>
        {lastResult && (
          <div className="mainView__result">
            {lastResult.status === 'success'
              ? l10n.t(
                  '✓ Error reported at {0}',
                  lastResult.timestamp as string
                )
              : l10n.t(
                  '✗ Failed at {0}: {1}',
                  lastResult.timestamp as string,
                  lastResult.error as string
                )}
            {'\n'}
            {JSON.stringify(lastResult, null, 2)}
          </div>
        )}
      </div>
    </div>
  );
};
