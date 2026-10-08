/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  Button,
  Caption1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ArrowSyncFilled } from '@fluentui/react-icons';
import * as l10n from '@vscode/l10n';
import { Component, type ErrorInfo, type ReactNode } from 'react';

import { useSharedStyles } from '../../hooks/useSharedStyles';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXL,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXL,
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingVerticalS,
  },
});

function ErrorFallback({ onRetry }: { onRetry: () => void }) {
  const styles = useStyles();
  const shared = useSharedStyles();
  return (
    <div className={styles.root}>
      <section className={styles.section}>
        <Caption1 className={shared.muted}>
          {l10n.t('Something went wrong while rendering this panel.')}
        </Caption1>
        <div className={styles.actions}>
          <Button
            icon={<ArrowSyncFilled />}
            appearance="primary"
            size="small"
            onClick={onRetry}
          >
            {l10n.t('Retry')}
          </Button>
        </div>
      </section>
    </div>
  );
}

interface PanelErrorBoundaryProps {
  children: ReactNode;
}

interface PanelErrorBoundaryState {
  hasError: boolean;
}

export class PanelErrorBoundary extends Component<
  PanelErrorBoundaryProps,
  PanelErrorBoundaryState
> {
  constructor(props: PanelErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): PanelErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[PanelErrorBoundary]', error, info.componentStack);
  }

  private handleRetry = () => {
    this.setState({ hasError: false });
  };

  override render(): ReactNode {
    if (this.state.hasError) {
      return <ErrorFallback onRetry={this.handleRetry} />;
    }

    return this.props.children;
  }
}
