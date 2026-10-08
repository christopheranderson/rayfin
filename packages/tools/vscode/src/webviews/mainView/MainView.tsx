/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Tab, TabList } from '@fluentui/react-components';
import * as l10n from '@vscode/l10n';
import { useState } from 'react';

import { Header } from './components/Header';
import { CommonFeaturesTab } from './components/tabs/CommonFeaturesTab/CommonFeaturesTab';
import { MessagingTab } from './components/tabs/MessagingTab/MessagingTab';
import { ThemeTab } from './components/tabs/ThemeTab/ThemeTab';
import './mainView.scss';

const TAB_MESSAGING = 'messaging';
const TAB_COMMON = 'common';
const TAB_THEME = 'theme';

export const MainView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<string>(TAB_MESSAGING);

  return (
    <div className="mainView">
      <Header />
      <p>Hot reload test!!!</p>
      <TabList
        selectedValue={activeTab}
        onTabSelect={(_, data) => setActiveTab(data.value as string)}
        size="large"
      >
        <Tab value={TAB_MESSAGING}>{l10n.t('Webview Messaging')}</Tab>
        <Tab value={TAB_COMMON}>{l10n.t('Common Features')}</Tab>
        <Tab value={TAB_THEME}>{l10n.t('Theme & Fluent UI')}</Tab>
      </TabList>

      <div className="mainView__tab-content">
        {activeTab === TAB_MESSAGING && <MessagingTab />}
        {activeTab === TAB_COMMON && <CommonFeaturesTab />}
        {activeTab === TAB_THEME && <ThemeTab />}
      </div>
    </div>
  );
};
