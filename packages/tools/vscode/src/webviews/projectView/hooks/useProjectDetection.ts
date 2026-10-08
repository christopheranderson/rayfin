/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import { useCallback, useEffect, useState } from 'react';

import type { TrpcClient } from '../../api/webview-client/useTrpcClient';
import { useTrpcClient } from '../../api/webview-client/useTrpcClient';
import type { ProjectViewConfig } from '../projectViewController';

export type ProjectState =
  | { mode: 'no-workspace' }
  | { mode: 'unrecognized' }
  | {
      mode: 'existing';
      config: RayfinConfig;
      projectRoot: string;
      rawYaml: string;
    };

async function detectProjectInWorkspace(
  trpcClient: TrpcClient,
  workspaceFolder?: string
): Promise<ProjectState> {
  if (!workspaceFolder) {
    return { mode: 'no-workspace' };
  }

  const result = await trpcClient.projectView.getProjectInfo.query({
    folder: workspaceFolder,
  });

  if (!result.found) {
    return { mode: 'unrecognized' };
  }

  return {
    mode: 'existing',
    config: result.config,
    projectRoot: result.projectRoot,
    rawYaml: result.rawYaml,
  };
}

export function useProjectDetection(config: ProjectViewConfig | undefined) {
  const { trpcClient } = useTrpcClient();
  const workspaceFolder = config?.workspaceFolder;

  const initialProjectState: ProjectState =
    config?.mode === 'existing' && config.rayfinConfig && config.projectRoot
      ? {
          mode: 'existing',
          config: config.rayfinConfig,
          projectRoot: config.projectRoot,
          rawYaml: '',
        }
      : config?.mode === 'unrecognized'
        ? { mode: 'unrecognized' }
        : { mode: 'no-workspace' };

  const [projectState, setProjectState] =
    useState<ProjectState>(initialProjectState);
  const [detecting, setDetecting] = useState(Boolean(workspaceFolder));

  const detectProject = useCallback(async () => {
    setDetecting(true);
    try {
      setProjectState(
        await detectProjectInWorkspace(trpcClient, workspaceFolder)
      );
    } catch {
      setProjectState(
        workspaceFolder ? { mode: 'unrecognized' } : { mode: 'no-workspace' }
      );
    } finally {
      setDetecting(false);
    }
  }, [trpcClient, workspaceFolder]);

  useEffect(() => {
    if (!workspaceFolder) {
      setProjectState({ mode: 'no-workspace' });
      return;
    }
    void detectProject();
  }, [detectProject, workspaceFolder]);

  // Listen for config file changes from extension host
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'configChanged') {
        void detectProject();
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [detectProject]);

  return { projectState, detecting, workspaceFolder };
}
