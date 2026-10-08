/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Body1, Subtitle1, Title1 } from '@fluentui/react-components';
import * as l10n from '@vscode/l10n';

export const Header: React.FC = () => {
  return (
    <div className="mainView__header">
      <Title1>{l10n.t('Project Rayfin')}</Title1>
      <Subtitle1>{l10n.t('Build rich, interactive webviews. Fast.')}</Subtitle1>
      <Body1>
        {l10n.t(
          'Type-safe RPC messaging, adaptive Fluent UI theming, and an embedded Monaco Editor. Everything you need to ship polished VS Code webviews.'
        )}
      </Body1>
    </div>
  );
};
