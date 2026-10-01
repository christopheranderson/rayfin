/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  Badge,
  Body1,
  Button,
  Caption1,
  ProgressBar,
  Subtitle1,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ArrowSyncRegular } from '@fluentui/react-icons';
import type { CheckResult } from '@microsoft/rayfin-tools-common/_internal/checks';
import * as l10n from '@vscode/l10n';

import type { ChecklistRow } from '../../../components/Checklist';
import { useSharedStyles } from '../../../hooks/useSharedStyles';
import { SetupProvider, useSetupContext } from '../setup/SetupContext';

import { SetupChecklist } from './SetupChecklist';
import { useSetupChecklistRows } from './useSetupChecklistRows';


const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalSNudge,
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  summary: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  progressBar: {
    marginTop: tokens.spacingVerticalXS,
  },
  summaryHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    marginTop: tokens.spacingVerticalXS,
  },
  summaryFooter: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  checklist: {
    paddingTop: tokens.spacingVerticalM,
  },
});

const STATUS_META: Record<
  string,
  { color: 'success' | 'informative' | 'danger' | 'warning'; label: string }
> = {
  pass: { color: 'success', label: l10n.t('Ready') },
  checking: { color: 'informative', label: l10n.t('Checking') },
  fail: { color: 'danger', label: l10n.t('Needs attention') },
  warn: { color: 'warning', label: l10n.t('Needs attention') },
};

function getStatusMessage(
  setupStatus: CheckResult['status'] | 'checking',
  rows: readonly ChecklistRow[]
): string {
  if (setupStatus === 'pass') {
    return l10n.t('Dependency checks complete');
  }

  const activeCheckName = rows.find((row) => row.status === 'checking')?.name;
  if (setupStatus === 'checking' && activeCheckName) {
    return l10n.t('Checking {name}\u2026', { name: activeCheckName });
  }

  const completed = rows.filter((row) => row.status === 'pass').length;
  return l10n.t('{completed} of {total} dependency checks complete', {
    completed,
    total: rows.length,
  });
}

export function SetupSection({
  folder,
  autoDeployEnabled,
}: {
  folder?: string;
  autoDeployEnabled?: boolean;
}) {
  return (
    <SetupProvider folder={folder} autoDeployEnabled={autoDeployEnabled}>
      <SetupSectionContent />
    </SetupProvider>
  );
}

function SetupSectionContent() {
  const styles = useStyles();
  const shared = useSharedStyles();
  const { setupStatus, restart } = useSetupContext();
  const { requiredRows } = useSetupChecklistRows();
  const isChecking = setupStatus === 'checking';

  const totalSteps = requiredRows.length;
  const completedSteps = requiredRows.filter((row) => row.status === 'pass').length;
  const progressValue = totalSteps === 0 ? 0 : completedSteps / totalSteps;

  const { color: badgeColor, label: badgeLabel } = STATUS_META[setupStatus] ?? STATUS_META.warn;
  const statusMessage = getStatusMessage(setupStatus, requiredRows);

  return (
    <div className={styles.root}>
      <div className={styles.cardHeader}>
        <Subtitle1>{l10n.t('Setting up app')}</Subtitle1>
        <Tooltip content={l10n.t('Restart setup checks')} relationship="label">
          <Button
            appearance="subtle"
            icon={<ArrowSyncRegular />}
            size="small"
            disabled={isChecking}
            onClick={restart}
          />
        </Tooltip>
      </div>
      <div className={styles.summary}>
        <div className={styles.summaryHeader}>
          <Body1>{statusMessage}</Body1>
          <Badge appearance="tint" color={badgeColor} size="small">
            {badgeLabel}
          </Badge>
        </div>

        <ProgressBar className={styles.progressBar} value={progressValue} max={1} />

        <div className={styles.summaryFooter}>
          <Caption1 className={shared.muted}>
            {l10n.t('{completed} of {total} complete', {
              completed: completedSteps,
              total: totalSteps,
            })}
          </Caption1>
        </div>
      </div>

      <div className={styles.checklist}>
        <SetupChecklist />
      </div>
    </div>
  );
}
