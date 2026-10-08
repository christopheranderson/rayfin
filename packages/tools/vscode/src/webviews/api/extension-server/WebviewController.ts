/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getTRPCErrorFromUnknown } from '@trpc/server';
import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';

import { type WebviewName } from '../configuration/WebviewRegistry';
import { appRouter, type BaseRouterContext } from '../configuration/appRouter';
import { type VsCodeLinkRequestMessage } from '../webview-client/vscodeLink';

import { createCallerFactory } from './trpc';

/**
 * Generates a cryptographically-random nonce string using the Web Crypto API,
 * which is available in both Node.js and browser/web-worker environments.
 */
function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * WebviewController manages a vscode.WebviewPanel and provides tRPC-based communication
 * with the React webview. It handles incoming requests (queries, mutations, and subscriptions)
 * from the webview, routing them to server-side procedures defined in the `appRouter`.
 *
 * @typeParam Configuration - The type of the configuration object that the webview will receive.
 */
export class WebviewController<Configuration> implements vscode.Disposable {
  private _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _isDisposed = false;
  private _onDisposed: vscode.EventEmitter<void> =
    new vscode.EventEmitter<void>();
  public readonly onDisposed: vscode.Event<void> = this._onDisposed.event;

  private _activeSubscriptions = new Map<string, AbortController>();
  private _activeOperations = new Map<string, AbortController>();

  constructor(
    protected extensionContext: vscode.ExtensionContext,
    title: string,
    private _webviewName: WebviewName,
    private configuration: Configuration,
    viewColumn: vscode.ViewColumn = vscode.ViewColumn.One,
    private _iconPath?:
      | vscode.Uri
      | {
          readonly light: vscode.Uri;
          readonly dark: vscode.Uri;
        }
  ) {
    this._panel = vscode.window.createWebviewPanel(
      'react-webview-' + _webviewName,
      title,
      viewColumn,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionContext.extensionUri],
      }
    );

    this._panel.webview.html = this.getDocumentTemplate(this._panel.webview);
    this._panel.iconPath = this._iconPath;

    this.registerDisposable(
      this._panel.onDidDispose(() => {
        this.dispose();
      })
    );
  }

  protected setupTrpc(context: BaseRouterContext): void {
    this.registerDisposable(
      this._panel.webview.onDidReceiveMessage(
        async (message: VsCodeLinkRequestMessage) => {
          switch (message.op.type) {
            case 'subscription':
              await this.handleSubscriptionMessage(message, context);
              break;

            case 'subscription.stop':
              this.handleSubscriptionStopMessage(message);
              break;

            case 'abort':
              this.handleAbortMessage(message);
              break;

            default:
              await this.handleDefaultMessage(message, context);
              break;
          }
        }
      )
    );
  }

  private async handleSubscriptionMessage(
    message: VsCodeLinkRequestMessage,
    context: BaseRouterContext
  ) {
    try {
      const abortController = new AbortController();
      this._activeSubscriptions.set(message.id, abortController);

      const opContext: BaseRouterContext = {
        ...context,
        signal: abortController.signal,
      };

      const callerFactory = createCallerFactory(appRouter);
      const caller = callerFactory(opContext);

      // @ts-expect-error — dynamic path lookup on typed router
      const procedure = caller[message.op.path];

      if (typeof procedure !== 'function') {
        throw new Error(
          l10n.t('Procedure not found: {name}', { name: message.op.path })
        );
      }

      const asyncIter = await procedure(message.op.input);

      void (async () => {
        try {
          for await (const value of asyncIter) {
            this._panel.webview.postMessage({ id: message.id, result: value });
          }
          this._panel.webview.postMessage({ id: message.id, complete: true });
        } catch (error) {
          const trpcErrorMessage = this.wrapInTrpcErrorMessage(
            error,
            message.id
          );
          this._panel.webview.postMessage(trpcErrorMessage);
        } finally {
          this._activeSubscriptions.delete(message.id);
        }
      })();
    } catch (error) {
      const trpcErrorMessage = this.wrapInTrpcErrorMessage(error, message.id);
      this._panel.webview.postMessage(trpcErrorMessage);
    }
  }

  private handleSubscriptionStopMessage(message: VsCodeLinkRequestMessage) {
    const abortController = this._activeSubscriptions.get(message.id);
    if (abortController) {
      abortController.abort();
      this._activeSubscriptions.delete(message.id);
    }
  }

  private handleAbortMessage(message: VsCodeLinkRequestMessage) {
    const abortController = this._activeOperations.get(message.id);
    if (abortController) {
      abortController.abort();
      this._activeOperations.delete(message.id);
    }
  }

  private async handleDefaultMessage(
    message: VsCodeLinkRequestMessage,
    context: BaseRouterContext
  ) {
    const abortController = new AbortController();
    this._activeOperations.set(message.id, abortController);

    try {
      const opContext: BaseRouterContext = {
        ...context,
        signal: abortController.signal,
      };

      const callerFactory = createCallerFactory(appRouter);
      const caller = callerFactory(opContext);

      // @ts-expect-error — dynamic path lookup on typed router
      const procedure = caller[message.op.path];

      if (typeof procedure !== 'function') {
        throw new Error(
          l10n.t('Procedure not found: {name}', { name: message.op.path })
        );
      }

      const result = await procedure(message.op.input);

      if (!abortController.signal.aborted) {
        const response = { id: message.id, result: result ?? null };
        this._panel.webview.postMessage(response);
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        const trpcErrorMessage = this.wrapInTrpcErrorMessage(error, message.id);
        this._panel.webview.postMessage(trpcErrorMessage);
      }
    } finally {
      this._activeOperations.delete(message.id);
    }
  }

  private wrapInTrpcErrorMessage(error: unknown, operationId: string) {
    const errorEntry = getTRPCErrorFromUnknown(error);

    return {
      id: operationId,
      error: {
        code: errorEntry.code,
        name: errorEntry.name,
        message: errorEntry.message,
        stack: errorEntry.stack,
        cause: errorEntry.cause,
      },
    };
  }

  private getDocumentTemplate(webview?: vscode.Webview): string {
    const nonce = generateNonce();

    const dir = 'dist';
    const filename = 'views.js';
    const cssFilename = 'views.css';
    const uri = (...parts: string[]) =>
      webview
        ?.asWebviewUri(
          vscode.Uri.joinPath(this.extensionContext.extensionUri, dir, ...parts)
        )
        .toString(true);

    const srcUri = uri(filename);
    const cssUri = uri(cssFilename);

    const csp = [
      `form-action 'none';`,
      `default-src ${webview?.cspSource};`,
      `script-src ${webview?.cspSource} 'nonce-${nonce}';`,
      `style-src ${webview?.cspSource} vscode-resource: 'unsafe-inline';`,
      `img-src ${webview?.cspSource} data: vscode-resource:;`,
      `connect-src ${webview?.cspSource};`,
      `font-src ${webview?.cspSource};`,
      `worker-src ${webview?.cspSource} blob:;`,
    ].join(' ');

    return `<!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <meta http-equiv="Content-Security-Policy" content="${csp}" />
                    <link rel="stylesheet" href="${cssUri}" />
                </head>
                    <body>
                        <div id="root"></div>
                            <script nonce="${nonce}">
                                globalThis.l10n_bundle = ${JSON.stringify(vscode.l10n.bundle ?? {})};
                            </script>
                            <script type="module" nonce="${nonce}">
                                window.config = {
                                    ...window.config,
                                    __initialData: '${encodeURIComponent(JSON.stringify(this.configuration))}'
                                };

                                import { render } from "${srcUri}";
                                render('${this._webviewName}', acquireVsCodeApi());
                            </script>

                    </body>
                </html>`;
  }

  protected registerDisposable(disposable: vscode.Disposable): void {
    this._disposables.push(disposable);
  }

  public get isDisposed(): boolean {
    return this._isDisposed;
  }

  public get panel(): vscode.WebviewPanel {
    return this._panel;
  }

  public revealToForeground(
    viewColumn: vscode.ViewColumn = vscode.ViewColumn.One
  ): void {
    this._panel.reveal(viewColumn, true);
  }

  public dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;

    this._onDisposed.fire();

    for (const controller of this._activeOperations.values()) {
      controller.abort();
    }
    this._activeOperations.clear();

    for (const controller of this._activeSubscriptions.values()) {
      controller.abort();
    }
    this._activeSubscriptions.clear();

    this._disposables.forEach((d) => {
      d.dispose();
    });
  }
}
