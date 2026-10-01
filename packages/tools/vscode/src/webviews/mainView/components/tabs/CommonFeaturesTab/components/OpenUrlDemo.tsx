/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  Badge,
  Body1,
  Button,
  Input,
  Label,
  Subtitle1,
} from '@fluentui/react-components';
import { OpenRegular } from '@fluentui/react-icons';
import * as l10n from '@vscode/l10n';
import { useCallback, useState } from 'react';

import { useTrpcClient } from '../../../../../api/webview-client/useTrpcClient';

export const OpenUrlDemo: React.FC = () => {
  const { trpcClient } = useTrpcClient();
  const [url, setUrl] = useState(
    'https://github.com/microsoft/vscode-documentdb'
  );

  const handleOpenUrl = useCallback(async () => {
    await trpcClient.common.openUrl.mutate({ url });
  }, [trpcClient, url]);

  return (
    <div className="mainView__card">
      <div className="mainView__card-header">
        <Subtitle1>{l10n.t('Open URL')}</Subtitle1>
        <Badge appearance="tint" color="informative">
          {l10n.t('Navigation')}
        </Badge>
      </div>
      <Body1>
        {l10n.t(
          'Opens an external URL in the default browser via vscode.env.openExternal. Useful for linking to documentation, issue trackers, or any external resource from your webview.'
        )}
      </Body1>
      <div className="mainView__card-content">
        <div className="mainView__input-row">
          <Label htmlFor="open-url-input">{l10n.t('URL')}</Label>
          <Input
            id="open-url-input"
            value={url}
            onChange={(_, data) => setUrl(data.value)}
            placeholder={l10n.t('https://example.com')}
          />
        </div>
        <div className="mainView__button-row">
          <Button
            appearance="primary"
            icon={<OpenRegular />}
            onClick={() => void handleOpenUrl()}
          >
            {l10n.t('Open in Browser')}
          </Button>
        </div>
      </div>
    </div>
  );
};
