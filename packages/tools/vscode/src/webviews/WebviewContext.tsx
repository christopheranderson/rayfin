/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { createContext } from 'react';

/**
 * Minimal type for the VS Code webview API provided by `acquireVsCodeApi()`.
 */
export interface WebviewApi<StateType> {
  postMessage(message: unknown): void;
  getState(): StateType | undefined;
  setState<T extends StateType | undefined>(newState: T): T;
}

export type WebviewState = object;

export type WebviewContextValue = {
  vscodeApi: WebviewApi<WebviewState>;
};

export const WebviewContext = createContext<WebviewContextValue>(
  {} as WebviewContextValue
);

export const WithWebviewContext = ({
  vscodeApi,
  children,
}: {
  vscodeApi: WebviewApi<WebviewState>;
  children: React.ReactNode;
}) => {
  return (
    <WebviewContext.Provider value={{ vscodeApi }}>
      {children}
    </WebviewContext.Provider>
  );
};
