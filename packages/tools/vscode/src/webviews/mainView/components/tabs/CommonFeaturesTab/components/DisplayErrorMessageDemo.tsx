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
  Switch,
} from '@fluentui/react-components';
import { DismissCircleRegular } from '@fluentui/react-icons';
import * as l10n from '@vscode/l10n';
import { useCallback, useState } from 'react';

import { useTrpcClient } from '../../../../../api/webview-client/useTrpcClient';

export const DisplayErrorMessageDemo: React.FC = () => {
  const { trpcClient } = useTrpcClient();
  const [message, setMessage] = useState('An error occurred');
  const [cause, setCause] = useState('Connection timed out');
  const [modal, setModal] = useState(true);

  const handleDisplayError = useCallback(async () => {
    await trpcClient.common.displayErrorMessage.mutate({
      message,
      modal,
      cause,
    });
  }, [trpcClient, message, modal, cause]);

  return (
    <div className="mainView__card">
      <div className="mainView__card-header">
        <Subtitle1>{l10n.t('Display Error Message')}</Subtitle1>
        <Badge appearance="tint" color="warning">
          {l10n.t('UI')}
        </Badge>
      </div>
      <Body1>
        {l10n.t(
          'Shows a VS Code error notification from the webview. Uses vscode.window.showErrorMessage on the extension host. Toggle "Modal" to display a blocking dialog with a detail section instead of a toast notification.'
        )}
      </Body1>
      <div className="mainView__card-content">
        <div className="mainView__input-row">
          <Label htmlFor="display-error-msg">{l10n.t('Message')}</Label>
          <Input
            id="display-error-msg"
            value={message}
            onChange={(_, data) => setMessage(data.value)}
            placeholder={l10n.t('e.g. An error occurred')}
          />
        </div>
        <div className="mainView__input-row">
          <Label htmlFor="display-error-cause">
            {l10n.t('Cause / Detail')}
          </Label>
          <Input
            id="display-error-cause"
            value={cause}
            onChange={(_, data) => setCause(data.value)}
            placeholder={l10n.t('e.g. Connection timed out')}
          />
        </div>
        <Switch
          label={l10n.t('Modal dialog')}
          checked={modal}
          onChange={(_, data) => setModal(data.checked)}
        />
        <div className="mainView__button-row">
          <Button
            appearance="primary"
            icon={<DismissCircleRegular />}
            onClick={() => void handleDisplayError()}
          >
            {l10n.t('Show Error')}
          </Button>
        </div>
      </div>
    </div>
  );
};
