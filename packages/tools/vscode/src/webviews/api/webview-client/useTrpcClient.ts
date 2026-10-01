/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  type CreateTRPCClient,
  createTRPCClient,
  loggerLink,
} from '@trpc/client';
import { useContext, useMemo } from 'react';

import { WebviewContext } from '../../WebviewContext';
import { type AppRouter } from '../configuration/appRouter';

import {
  vscodeLink,
  type VsCodeLinkRequestMessage,
  type VsCodeLinkResponseMessage,
} from './vscodeLink';

export type TrpcClient = CreateTRPCClient<AppRouter>;

/**
 * Custom React hook that creates a tRPC client for communication between the webview and VS Code extension.
 *
 * Each component that calls this hook receives its own client instance, stable across
 * re-renders (via `useMemo`). This keeps components self-contained and easy to reason about.
 * For views with many components (\>10) consider sharing a single client via React context
 * instead — see the "Advanced" section of the README.
 *
 * @returns An object containing the tRPC client (`trpcClient`)
 *
 * @example
 * ```tsx
 * // In your component:
 * import { useTrpcClient } from 'useTrpcClient';
 *
 * export const MyComponent = () => {
 *   const { trpcClient } = useTrpcClient();
 *
 *   // Use the tRPC client to make queries and mutations
 *   useEffect(() => {
 *     trpcClient.myProcedure.query().then((result) => {
 *       console.log('Procedure result:', result);
 *     });
 *   }, [trpcClient]);
 *
 *   return (
 *     <>
 *       {/* Your component's JSX *\/}
 *     </>
 *   );
 * };
 * ```
 */
export function useTrpcClient() {
  const { vscodeApi } = useContext(WebviewContext);

  /**
   * Function to send messages to the VSCode extension.
   *
   * @param message - The message to send, following the VsCodeLinkRequestMessage format.
   */
  function send(message: VsCodeLinkRequestMessage) {
    vscodeApi.postMessage(message);
  }

  /**
   * Function to handle incoming messages from the VSCode extension.
   * This function is provided to the tRPC client and is used internally to manage tRPC responses.
   *
   * @param callback - The callback to invoke when a tRPC response message is received.
   * @returns A function to unsubscribe the event listener.
   *
   * Note to code maintainers:
   * The tRPC client expects this `onReceive` function to handle the subscription and unsubscription
   * of the event listener for tRPC responses. It registers the handler when a tRPC request is made,
   * and unregisters it after the response is received.
   * Be cautious when modifying this function, as it could affect the tRPC client's ability to
   * receive responses correctly.
   */
  function onReceive(
    callback: (message: VsCodeLinkResponseMessage) => void
  ): () => void {
    const handler = (event: MessageEvent) => {
      // a basic type guard here
      if ((event.data as VsCodeLinkResponseMessage).id) {
        const message = event.data as VsCodeLinkResponseMessage;
        callback(message);
      }
    };

    window.addEventListener('message', handler);
    return () => {
      window.removeEventListener('message', handler);
    };
  }

  // Each component that calls `useTrpcClient()` gets its own client instance.
  // `useMemo` keeps the instance stable across re-renders of that component,
  // but different components will hold separate clients. This is intentional:
  // it keeps every component self-contained and easy to understand.
  // For views with many components (>10) sharing a client via React context
  // may be preferable — see the "Advanced" section of the README.
  const trpcClient = useMemo(
    () =>
      createTRPCClient<AppRouter>({
        links: [loggerLink(), vscodeLink({ send, onReceive })],
      }),
    [vscodeApi]
  );

  // Return the tRPC client
  return { trpcClient: trpcClient };
}
