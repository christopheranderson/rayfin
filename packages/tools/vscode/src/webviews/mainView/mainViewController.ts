/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ext } from '../../extensionVariables';
import { WebviewController } from '../api/extension-server/WebviewController';

import { type RouterContext } from './mainViewRouter';

export interface MainViewConfig {
  extensionVersion: string;
}

export class MainViewController extends WebviewController<MainViewConfig> {
  constructor() {
    const version =
      (ext.context.extension.packageJSON.version as string) ?? '0.0.0';

    const config: MainViewConfig = {
      extensionVersion: version,
    };

    super(ext.context, 'Project Rayfin', 'mainView', config);

    const trpcContext: RouterContext = {
      webviewName: 'mainView',
      extensionVersion: version,
    };

    this.setupTrpc(trpcContext);
  }
}
