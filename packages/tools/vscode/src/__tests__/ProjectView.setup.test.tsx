/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ProjectView } from '../webviews/projectView/ProjectView';

const trpcClient = {
  common: {
    openUrl: {
      mutate: vi.fn(),
    },
  },
  projectView: {
    getAutoOpenDismissed: {
      query: vi.fn().mockResolvedValue({ dismissed: false }),
    },
    openWorkspaceFolder: {
      mutate: vi.fn(),
    },
    checkPrerequisite: {
      query: vi.fn().mockImplementation(({ name }: { name: string }) =>
        Promise.resolve({
          status: 'pass',
          name,
          detail: `${name} installed`,
        })
      ),
    },
    checkDockerGhcr: {
      query: vi.fn().mockResolvedValue({
        status: 'pass',
        name: 'Container Registry',
        detail: 'Signed in',
      }),
    },
    loginDockerGhcr: {
      mutate: vi.fn().mockResolvedValue({
        status: 'pass',
        name: 'Container Registry',
        detail: 'Signed in',
      }),
    },
    checkNodeModules: {
      query: vi.fn().mockResolvedValue({ exists: true }),
    },
    runNpmInstall: {
      mutate: vi.fn(),
    },
    runDeploy: {
      mutate: vi.fn(),
    },
    checkMicrosoftAuth: {
      query: vi.fn().mockResolvedValue({
        status: 'pass',
        name: 'Microsoft Account',
        detail: 'Signed in',
      }),
    },
    signInMicrosoft: {
      mutate: vi.fn().mockResolvedValue({
        status: 'pass',
        name: 'Microsoft Account',
        detail: 'Signed in',
      }),
    },
    getProjectInfo: {
      query: vi.fn(),
    },
    setAutoOpenDismissed: {
      mutate: vi.fn(),
    },
  },
};

vi.mock('../webviews/api/webview-client/useTrpcClient', () => ({
  useTrpcClient: () => ({ trpcClient }),
}));

vi.mock('../webviews/api/webview-client/useConfiguration', () => ({
  useConfiguration: () => ({ projectPath: '/ws' }),
}));

vi.mock('../webviews/projectView/hooks/useProjectDetection', () => ({
  useProjectDetection: () => ({
    detecting: false,
    workspaceFolder: '/ws',
    projectState: {
      mode: 'existing',
      config: {
        name: 'Test Project',
        version: '1.0.0',
        id: 'project-id',
        services: {
          auth: {
            enabled: true,
          },
          data: {
            enabled: true,
          },
          storage: {
            enabled: false,
          },
          staticHosting: {
            enabled: true,
            folder: 'dist',
          },
        },
      },
      projectRoot: '/ws',
      rawYaml: '',
    },
  }),
}));

describe('ProjectView setup load', () => {
  it('renders the project view without crashing on initial load', async () => {
    const { unmount } = render(<ProjectView />);

    // Verify the setup checklist renders with progress summary.
    await waitFor(() => {
      expect(screen.getByRole('progressbar')).toBeTruthy();
    });

    unmount();
  });
});
