/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  Badge,
  Body1,
  Button,
  ProgressBar,
  Spinner,
  Subtitle1,
} from '@fluentui/react-components';
import { PlayRegular, StopRegular } from '@fluentui/react-icons';
import * as l10n from '@vscode/l10n';
import { useCallback, useRef, useState } from 'react';

import { useTrpcClient } from '../../../../../api/webview-client/useTrpcClient';

type CountdownData = { current: number; total: number };

export const SubscriptionDemo: React.FC = () => {
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
   * For subscriptions, use `.subscribe(input, callbacks)` instead:
   * ```ts
   * const sub = trpcClient.mainView.countdown.subscribe(
   *     { from: 10, intervalMs: 1000 },
   *     { onData(data) { ... }, onComplete() { ... }, onError() { ... } },
   * );
   * ```
   *
   * @see useTrpcClient.ts — creates the client with `createTRPCClient<AppRouter>()`
   * @see vscodeLink.ts   — custom tRPC link that serializes calls to postMessage
   * @see appRouter.ts    — root router that bundles all view routers
   */
  const { trpcClient } = useTrpcClient();
  const [countdownValues, setCountdownValues] = useState<CountdownData[]>([]);
  const [subscriptionActive, setSubscriptionActive] = useState(false);
  const subscriptionRef = useRef<{ unsubscribe: () => void } | null>(null);

  const handleStartSubscription = useCallback(() => {
    setCountdownValues([]);
    setSubscriptionActive(true);

    const sub = trpcClient.mainView.countdown.subscribe(
      { from: 10, intervalMs: 1000 },
      {
        onData(data: CountdownData) {
          setCountdownValues((prev) => [...prev, data]);
        },
        onComplete() {
          setSubscriptionActive(false);
          subscriptionRef.current = null;
        },
        onError() {
          setSubscriptionActive(false);
          subscriptionRef.current = null;
        },
      }
    );

    subscriptionRef.current = sub;
  }, [trpcClient]);

  const handleStopSubscription = useCallback(() => {
    subscriptionRef.current?.unsubscribe();
    subscriptionRef.current = null;
    setSubscriptionActive(false);
  }, []);

  return (
    <div className="mainView__card">
      <div className="mainView__card-header">
        <Subtitle1>{l10n.t('Subscription (Streaming)')}</Subtitle1>
        <Badge appearance="tint" color="success">
          {l10n.t('Subscription')}
        </Badge>
      </div>
      <Body1>
        {l10n.t(
          'Streams a countdown from 10 to 0 using a tRPC subscription backed by an async generator on the server. Click Stop to unsubscribe early.'
        )}
      </Body1>
      <div className="mainView__card-content">
        <div className="mainView__button-row">
          <Button
            appearance="primary"
            icon={<PlayRegular />}
            onClick={handleStartSubscription}
            disabled={subscriptionActive}
          >
            {l10n.t('Start Countdown')}
          </Button>
          <Button
            appearance="secondary"
            icon={<StopRegular />}
            onClick={handleStopSubscription}
            disabled={!subscriptionActive}
          >
            {l10n.t('Stop')}
          </Button>
          {subscriptionActive && <Spinner size="tiny" />}
        </div>
        {countdownValues.length > 0 && (
          <div className="mainView__countdown-list">
            {countdownValues.map((val, idx) => (
              <Badge
                key={idx}
                appearance="filled"
                color={val.current === 0 ? 'success' : 'brand'}
                size="large"
              >
                {val.current}
              </Badge>
            ))}
          </div>
        )}
        {subscriptionActive && (
          <ProgressBar
            value={
              countdownValues.length > 0
                ? (countdownValues[0].total -
                    countdownValues[countdownValues.length - 1].current) /
                  countdownValues[0].total
                : 0
            }
            max={1}
          />
        )}
      </div>
    </div>
  );
};
