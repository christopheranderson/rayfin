/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  Caption1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import * as l10n from '@vscode/l10n';

import { Checklist } from '../../../components/Checklist';
import { useSharedStyles } from '../../../hooks/useSharedStyles';

import { useSetupChecklistRows } from './useSetupChecklistRows';

const useStyles = makeStyles({
  optionalHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalL,
    paddingBottom: tokens.spacingVerticalXS,
  },
});

export function SetupChecklist() {
  const { requiredRows, optionalRows } = useSetupChecklistRows();
  const styles = useStyles();
  const shared = useSharedStyles();

  return (
    <>
      <Checklist rows={requiredRows} ariaLabel={l10n.t('Setup checklist')} />

      <div className={styles.optionalHeader}>
        <Caption1 className={shared.muted}>
          {l10n.t('Optional - Local backend')}
        </Caption1>
      </div>
      <Checklist rows={optionalRows} ariaLabel={l10n.t('Optional setup checklist')} />
    </>
  );
}
