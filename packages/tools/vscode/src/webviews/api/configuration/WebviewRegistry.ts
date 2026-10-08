/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GettingStartedView } from '../../gettingStartedView/GettingStartedView';
import { MainView } from '../../mainView/MainView';
import { ProjectView } from '../../projectView/ProjectView';

export const WebviewRegistry = {
  gettingStartedView: GettingStartedView,
  mainView: MainView,
  projectView: ProjectView,
} as const;

export type WebviewName = keyof typeof WebviewRegistry;
