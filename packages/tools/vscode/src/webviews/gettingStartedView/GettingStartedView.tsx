/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  Body1,
  Button,
  Caption1,
  Card,
  Divider,
  Input,
  Label,
  Link,
  makeStyles,
  mergeClasses,
  Spinner,
  Subtitle1,
  Title1,
  tokens,
} from '@fluentui/react-components';
import { ErrorCircleRegular, FolderOpenRegular } from '@fluentui/react-icons';
import * as l10n from '@vscode/l10n';
import { useCallback } from 'react';

import { useConfiguration } from '../api/webview-client/useConfiguration';
import { useTrpcClient } from '../api/webview-client/useTrpcClient';

import type { GettingStartedViewConfig } from './gettingStartedViewController';
import { useFolderSelection } from './hooks';
import type { FolderState } from './hooks/useFolderSelection';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXL,
    maxWidth: '760px',
    margin: '0 auto',
    padding: `${tokens.spacingVerticalXXL} ${tokens.spacingHorizontalL}`,
  },
  createSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
  },
  sectionHeader: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  locationField: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  locationRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
  },
  locationInput: {
    flex: 1,
    minWidth: 0,
  },
  statusHint: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
  },
  statusWarning: {
    color: tokens.colorPaletteDarkOrangeForeground1,
  },
  statusInfo: {
    color: tokens.colorNeutralForeground3,
  },
  card: {
    padding: tokens.spacingVerticalL,
  },
  primaryAction: {
    width: '100%',
  },
  existingSection: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalL,
    flexWrap: 'wrap',
  },
  existingContent: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    minWidth: 0,
  },
});

function LocationStatus({
  folderState,
  onOpenProject,
}: {
  folderState: FolderState;
  onOpenProject: () => void;
}) {
  const styles = useStyles();

  switch (folderState.status) {
    case 'checking':
      return (
        <div className={mergeClasses(styles.statusHint, styles.statusInfo)}>
          <Spinner size="extra-tiny" />
          <Caption1>{l10n.t('Checking location…')}</Caption1>
        </div>
      );
    case 'rayfin':
      return (
        <div className={mergeClasses(styles.statusHint, styles.statusInfo)}>
          <ErrorCircleRegular fontSize={14} />
          <Caption1>
            {l10n.t('This location already contains a Rayfin project, ')}{' '}
            <Link inline onClick={onOpenProject}>
              {l10n.t('open it?')}
            </Link>
          </Caption1>
        </div>
      );
    case 'non-rayfin':
      return (
        <div className={mergeClasses(styles.statusHint, styles.statusWarning)}>
          <ErrorCircleRegular fontSize={14} />
          <Caption1>{l10n.t('This folder is not empty.')}</Caption1>
        </div>
      );
    default:
      return null;
  }
}

export const GettingStartedView: React.FC = () => {
  const config = useConfiguration<GettingStartedViewConfig>();
  const { folderState, selectFolder } = useFolderSelection(
    config.payload?.artifactName
  );
  const styles = useStyles();
  const { trpcClient } = useTrpcClient();
  const payload = config.payload;

  const handleCreateNew = useCallback(() => {
    void trpcClient.gettingStartedView.createNewProject.mutate({
      name: payload?.artifactName,
      fabricItemId: payload?.rayfinItemId,
      fabricWorkspaceId: payload?.fabricWorkspaceId,
      targetFolder: folderState.parentPath ?? undefined,
      portalTemplateId: payload?.templateId,
      deployedCodeOrigin: payload?.deployedCodeOrigin,
      fabricApiUrl: payload?.apiURL,
      fabricPortalUrl: payload?.portalURL,
      fabricEnvironment: payload?.environment,
    });
  }, [trpcClient, payload, folderState.parentPath]);

  const handleOpenExisting = useCallback(() => {
    if (folderState.projectPath && folderState.status === 'rayfin') {
      void trpcClient.gettingStartedView.openExistingProject.mutate({
        folderPath: folderState.projectPath,
      });
    } else {
      void trpcClient.gettingStartedView.openExistingProject.mutate();
    }
  }, [trpcClient, folderState.projectPath, folderState.status]);

  const displayPath = folderState.projectPath ?? folderState.parentPath ?? '';
  const hasResolvedProject = Boolean(folderState.projectPath);
  const existingResolvedFolder =
    hasResolvedProject && Boolean(folderState.exists);

  return (
    <div className={styles.root}>
      <Title1>{l10n.t('Project Rayfin')}</Title1>

      <Divider />

      <Card className={styles.card}>
        <section className={styles.createSection}>
          <div className={styles.sectionHeader}>
            <Subtitle1>{l10n.t('Create new project')}</Subtitle1>
            <Body1>
              {l10n.t(
                'Set up a new Rayfin project in your preferred location.'
              )}
            </Body1>
          </div>

          <div className={styles.locationField}>
            <Label>{l10n.t('Project location')}</Label>
            <div className={styles.locationRow}>
              <Input
                className={styles.locationInput}
                readOnly
                value={displayPath}
              />
              <Button appearance="outline" onClick={selectFolder}>
                {l10n.t('Change')}
              </Button>
            </div>
            <LocationStatus
              folderState={folderState}
              onOpenProject={handleOpenExisting}
            />
          </div>

          <div>
            <Button
              className={styles.primaryAction}
              appearance="primary"
              onClick={handleCreateNew}
              disabled={existingResolvedFolder}
            >
              {l10n.t('Create Project')}
            </Button>
          </div>
        </section>
      </Card>

      <Card className={styles.card}>
        <section className={styles.existingSection}>
          <div className={styles.existingContent}>
            <FolderOpenRegular />
            <Body1>{l10n.t('Want to use an existing project?')}</Body1>
          </div>
          <Button appearance="outline" onClick={handleOpenExisting}>
            {l10n.t('Choose Folder')}
          </Button>
        </section>
      </Card>
    </div>
  );
};
