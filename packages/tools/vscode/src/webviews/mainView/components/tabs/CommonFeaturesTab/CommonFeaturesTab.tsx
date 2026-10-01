/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Divider } from '@fluentui/react-components';

import { DisplayErrorMessageDemo } from './components/DisplayErrorMessageDemo';
import { OpenUrlDemo } from './components/OpenUrlDemo';
import { ReportErrorDemo } from './components/ReportErrorDemo';
import { ReportEventDemo } from './components/ReportEventDemo';

export const CommonFeaturesTab: React.FC = () => {
  return (
    <div className="mainView__tab-panel">
      <ReportEventDemo />
      <Divider className="mainView__divider" />
      <ReportErrorDemo />
      <Divider className="mainView__divider" />
      <DisplayErrorMessageDemo />
      <Divider className="mainView__divider" />
      <OpenUrlDemo />
    </div>
  );
};
