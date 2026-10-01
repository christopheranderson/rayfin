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
import { PulseRegular } from '@fluentui/react-icons';
import * as l10n from '@vscode/l10n';
import { useCallback, useState } from 'react';

import { useTrpcClient } from '../../../../../api/webview-client/useTrpcClient';

export const ReportEventDemo: React.FC = () => {
  const { trpcClient } = useTrpcClient();
  const [eventName, setEventName] = useState('buttonClicked');
  const [sent, setSent] = useState(false);
  const [lastResult, setLastResult] = useState<Record<string, unknown> | null>(
    null
  );

  /**
   * Fires a telemetry event via the common router.
   *
   * In production, replace the `console.log` inside the `reportEvent`
   * procedure (appRouter.ts) with `callWithTelemetryAndErrorHandling`
   * from `@microsoft/vscode-azext-utils`:
   *
   * ```ts
   * void callWithTelemetryAndErrorHandling<void>(
   *     `myExtension.webview.event.${myCtx.webviewName}.${input.eventName}`,
   *     (context) => {
   *         context.errorHandling.suppressDisplay = true;
   *         Object.assign(context.telemetry.properties, input.properties ?? {});
   *         Object.assign(context.telemetry.measurements, input.measurements ?? {});
   *     },
   * );
   * ```
   *
   * @see appRouter.ts — full production examples in the `commonRouter` JSDoc
   */
  const handleReportEvent = useCallback(async () => {
    const payload = {
      eventName,
      properties: { source: 'demo' },
      measurements: { clickCount: 1 },
    };

    try {
      await trpcClient.common.reportEvent.mutate(payload);
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
  }, [trpcClient, eventName]);

  return (
    <div className="mainView__card">
      <div className="mainView__card-header">
        <Subtitle1>{l10n.t('Report Event')}</Subtitle1>
        <Badge appearance="tint" color="brand">
          {l10n.t('Telemetry')}
        </Badge>
      </div>
      <Body1>
        {l10n.t(
          'Sends a named telemetry event with optional properties and measurements to the extension host via the common router. Events are logged to the console by default. Replace the handler with your telemetry library (e.g. Application Insights) for production use.'
        )}
      </Body1>
      <div className="mainView__card-content">
        <div className="mainView__input-row">
          <Label htmlFor="event-name-input">{l10n.t('Event Name')}</Label>
          <Input
            id="event-name-input"
            value={eventName}
            onChange={(_, data) => setEventName(data.value)}
            placeholder={l10n.t('e.g. buttonClicked')}
          />
        </div>
        <div className="mainView__button-row">
          <Button
            appearance="primary"
            icon={<PulseRegular />}
            onClick={() => void handleReportEvent()}
          >
            {l10n.t('Send Event')}
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
                  '✓ Event reported at {0}',
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
