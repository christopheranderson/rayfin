/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  Button,
  Caption1,
  List,
  ListItem,
  Spinner,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  CheckmarkCircleFilled,
  CircleRegular,
  DismissCircleFilled,
  WarningFilled,
} from '@fluentui/react-icons';
import type { ComponentType } from 'react';

import { useSharedStyles } from '../hooks/useSharedStyles';

const useStyles = makeStyles({
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  listItem: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalSNudge}`,
    justifyContent: 'space-between',
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  buttonWrapper: {
    alignSelf: 'center',
    whiteSpace: 'nowrap',
  },
  button: {
    minWidth: 'auto',
    paddingLeft: tokens.spacingHorizontalSNudge,
    paddingRight: tokens.spacingHorizontalSNudge,
  },
  statusMedia: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
  },
  statusIcon: {
    fontSize: '18px',
    lineHeight: '18px',
  },
  statusIconPending: {
    color: tokens.colorNeutralForeground3,
  },
  statusIconPass: {
    color: tokens.colorStatusSuccessForeground1,
  },
  statusIconWarn: {
    color: tokens.colorStatusWarningForeground1,
  },
  statusIconFail: {
    color: tokens.colorPaletteRedForeground1,
  },
});

export type ChecklistStatus = 'pass' | 'warn' | 'fail' | 'checking' | 'pending';

export type ChecklistAction = {
  label: string;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
};

export type ChecklistRow = {
  key: string;
  name: string;
  status: ChecklistStatus;
  description: string;
  disabled?: boolean;
  action?: ChecklistAction;
};

function ChecklistStatusIndicator({ status }: { status: ChecklistStatus }) {
  const styles = useStyles();

  if (status === 'checking') {
    return (
      <span className={styles.statusMedia}>
        <Spinner size="tiny" />
      </span>
    );
  }

  const iconMap: Record<
    Exclude<ChecklistStatus, 'checking'>,
    { icon: ComponentType<{ className?: string }>; style: string }
  > = {
    pass: { icon: CheckmarkCircleFilled, style: styles.statusIconPass },
    pending: { icon: CircleRegular, style: styles.statusIconPending },
    fail: { icon: DismissCircleFilled, style: styles.statusIconFail },
    warn: { icon: WarningFilled, style: styles.statusIconWarn },
  };

  const { icon: Icon, style } = iconMap[status];
  return (
    <span className={styles.statusMedia}>
      <Icon className={mergeClasses(styles.statusIcon, style)} />
    </span>
  );
}

export function Checklist({
  rows,
  ariaLabel,
}: {
  rows: readonly ChecklistRow[];
  ariaLabel: string;
}) {
  const styles = useStyles();
  const shared = useSharedStyles();

  return (
    <List className={styles.list} aria-label={ariaLabel}>
      {rows.map((row) => {
        const actionDisabled =
          row.status === 'checking' ||
          row.disabled ||
          row.action?.disabled ||
          row.action?.busy;

        return (
          <ListItem
            key={row.key}
            className={styles.listItem}
            aria-label={row.name}
          >
            <ChecklistStatusIndicator status={row.status} />

            <div className={styles.content}>
              <Text>{row.name}</Text>
              <Caption1 className={shared.muted}>{row.description}</Caption1>
            </div>

            {row.action ? (
              <div className={styles.buttonWrapper}>
                <Button
                  className={styles.button}
                  appearance="primary"
                  size="small"
                  onClick={row.action.onClick}
                  disabled={actionDisabled}
                  icon={row.action.busy ? <Spinner size="tiny" /> : undefined}
                >
                  {row.action.label}
                </Button>
              </div>
            ) : null}
          </ListItem>
        );
      })}
    </List>
  );
}
