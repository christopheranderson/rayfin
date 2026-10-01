/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  Card,
  Checkbox,
  CompoundButton,
  Divider,
  Spinner,
  Title1,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { AddRegular, FolderOpenRegular } from '@fluentui/react-icons';
import * as l10n from '@vscode/l10n';
import { useCallback, useEffect, useState } from 'react';

import { useConfiguration } from '../api/webview-client/useConfiguration';
import { useTrpcClient } from '../api/webview-client/useTrpcClient';

import { PanelErrorBoundary } from './components';
import { SetupSection } from './components/build/SetupSection';
import { useProjectDetection } from './hooks/useProjectDetection';
import type { ProjectViewConfig } from './projectViewController';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXL,
    maxWidth: '760px',
    margin: '0 auto',
    padding: `${tokens.spacingVerticalXXL} ${tokens.spacingHorizontalL}`,
  },
  rootLoading: {
    justifyContent: 'center',
    minHeight: '240px',
  },
  content: {
    minWidth: 0,
    padding: tokens.spacingVerticalL,
  },
  actions: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    paddingTop: tokens.spacingVerticalM,
  },
});

export const ProjectView: React.FC = () => {
  const config = useConfiguration<ProjectViewConfig>();
  const { trpcClient } = useTrpcClient();
  const { projectState, detecting, workspaceFolder } =
    useProjectDetection(config);

  const mode = projectState.mode;
  const projectId = mode === 'existing' ? projectState.config.id : undefined;

  const [autoOpenDismissed, setAutoOpenDismissed] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    void trpcClient.projectView.getAutoOpenDismissed
      .query({ projectId })
      .then((result) => setAutoOpenDismissed(result.dismissed));
  }, [trpcClient, projectId]);

  const styles = useStyles();

  const handleOpenFolder = useCallback(
    () => trpcClient.projectView.openWorkspaceFolder.mutate(),
    [trpcClient]
  );

  const handleCreateProject = useCallback(
    () => trpcClient.projectView.createNewProject.mutate(),
    [trpcClient]
  );

  const handleAutoOpenChange = useCallback(
    (_: unknown, data: { checked: boolean | 'mixed' }) => {
      if (projectState.mode !== 'existing') return;
      const dismissed = !!data.checked;
      setAutoOpenDismissed(dismissed);
      void trpcClient.projectView.setAutoOpenDismissed.mutate({
        projectId: projectState.config.id,
        dismissed,
      });
    },
    [trpcClient, projectState]
  );

  if (detecting) {
    return (
      <div className={mergeClasses(styles.root, styles.rootLoading)}>
        <Spinner
          size="small"
          label={l10n.t('Detecting project…')}
          labelPosition="after"
        />
      </div>
    );
  }

  // No-project fallback — hoisted above tabs
  if (projectState.mode !== 'existing') {
    const fallbackTitle =
      projectState.mode === 'unrecognized'
        ? l10n.t('This workspace is not a Rayfin project')
        : l10n.t('Open a workspace to start with Rayfin');

    return (
      <div className={styles.root}>
        <Title1>{fallbackTitle}</Title1>
        <Divider />
        <div className={styles.actions}>
          <CompoundButton
            appearance="subtle"
            icon={<AddRegular />}
            secondaryContent={l10n.t('Scaffold a new Rayfin project.')}
            onClick={handleCreateProject}
          >
            {l10n.t('Create Rayfin Project')}
          </CompoundButton>
          <CompoundButton
            appearance="subtle"
            icon={<FolderOpenRegular />}
            secondaryContent={l10n.t('Open an existing project.')}
            onClick={handleOpenFolder}
          >
            {l10n.t('Open Folder')}
          </CompoundButton>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <Title1>{projectState.config.name}</Title1>

      <Divider />

      <Card className={styles.content}>
        <PanelErrorBoundary>
          <SetupSection
            folder={workspaceFolder}
            autoDeployEnabled={config.autoDeployEnabled}
          />
        </PanelErrorBoundary>
      </Card>

      <footer>
        <Checkbox
          checked={autoOpenDismissed}
          onChange={handleAutoOpenChange}
          label={l10n.t("Don't auto-open for this project again")}
        />
      </footer>
    </div>
  );
};
