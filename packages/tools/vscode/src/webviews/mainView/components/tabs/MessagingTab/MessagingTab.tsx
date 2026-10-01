/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Divider } from '@fluentui/react-components';

import { ErrorHandlingDemo } from './components/ErrorHandlingDemo';
import { LongQueryDemo } from './components/LongQueryDemo';
import { QueryDemo } from './components/QueryDemo';
import { SubscriptionDemo } from './components/SubscriptionDemo';

export const MessagingTab: React.FC = () => {
  return (
    <div className="mainView__tab-panel">
      <QueryDemo />
      <Divider className="mainView__divider" />
      <LongQueryDemo />
      <Divider className="mainView__divider" />
      <SubscriptionDemo />
      <Divider className="mainView__divider" />
      <ErrorHandlingDemo />
    </div>
  );
};
