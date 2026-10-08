/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment jsdom

import { render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SetupChecklist } from '../webviews/projectView/components/build/SetupChecklist';

const openUrl = vi.fn();
const openWorkspaceFolder = vi.fn();

vi.mock('../webviews/api/webview-client/useTrpcClient', () => ({
  useTrpcClient: () => ({
    trpcClient: {
      common: {
        openUrl: {
          mutate: openUrl,
        },
      },
      projectView: {
        openWorkspaceFolder: {
          mutate: openWorkspaceFolder,
        },
      },
    },
  }),
}));

const useSetupContextMock = vi.fn();

vi.mock('../webviews/projectView/components/setup/SetupContext', () => ({
  useSetupContext: () => useSetupContextMock(),
}));

function createBaseSetupContext() {
  return {
    prereqs: {
      prereqs: [
        {
          status: 'pass',
          name: 'Node.js',
          detail: 'Installed',
        },
        {
          status: 'pass',
          name: 'Docker',
          detail: 'Installed',
        },
      ],
      prereqChecking: new Set<string>(),
    },
    dockerGhcr: {
      dockerGhcr: {
        status: 'pass',
        name: 'Container Registry',
        detail: 'Ready',
      },
      dockerGhcrLoading: false,
      dockerGhcrBusy: false,
      dockerGhcrPhase: 'ready',
      loginDockerGhcr: vi.fn(),
    },
    modules: {
      nodeModulesResult: {
        status: 'pass',
        name: 'npm install',
        detail: 'node_modules found',
      },
      nodeModulesLoading: false,
      npmInstallBusy: false,
      modulesPhase: 'ready',
      runNpmInstall: vi.fn(),
    },
    microsoftAuth: {
      microsoftAuth: {
        status: 'pass',
        name: 'Microsoft Account',
        detail: 'Signed in',
      },
      microsoftAuthLoading: false,
      microsoftAuthBusy: false,
      microsoftAuthPhase: 'ready',
      signInMicrosoft: vi.fn(),
    },
    deploy: {
      deploy: {
        status: 'pass',
        name: 'Deploy',
        detail: 'Deployed',
      },
      deployLoading: false,
      deployBusy: false,
      deployPhase: 'ready',
      runDeploy: vi.fn(),
    },
    folder: '/ws',
    getStepState: () => 'done',
    refreshSection: vi.fn(),
    canRefreshSection: () => true,
    openUrl,
    openWorkspaceFolder,
  };
}

describe('setup action visibility', () => {
  it('shows a disabled prereq action while waiting', () => {
    useSetupContextMock.mockReturnValue({
      ...createBaseSetupContext(),
      prereqs: {
        prereqs: [
          {
            status: 'warn',
            name: 'Node.js',
            detail: 'Version too old',
            installUrl: 'https://nodejs.org',
          },
          {
            status: 'pass',
            name: 'Docker',
            detail: 'Installed',
          },
        ],
        prereqChecking: new Set<string>(),
      },
      getStepState: () => 'pending',
    });

    const { container } = render(<SetupChecklist />);

    expect(
      within(container)
        .getAllByRole('button', {
          name: 'Install',
        })[0]
        .hasAttribute('disabled')
    ).toBe(true);
  });

  it('shows a disabled modules action while waiting', () => {
    useSetupContextMock.mockReturnValue({
      ...createBaseSetupContext(),
      modules: {
        nodeModulesResult: {
          status: 'warn',
          name: 'npm install',
          detail: 'node_modules not found',
        },
        nodeModulesLoading: false,
        npmInstallBusy: false,
        modulesPhase: 'needs-install',
        runNpmInstall: vi.fn(),
      },
      getStepState: () => 'pending',
    });

    const { container } = render(<SetupChecklist />);

    expect(
      within(container)
        .getByRole('button', {
          name: 'Install',
        })
        .hasAttribute('disabled')
    ).toBe(true);
  });
});
