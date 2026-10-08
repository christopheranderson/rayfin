/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateProjectSlug } from '@microsoft/rayfin-tools-common/_internal/templates/universal';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useTrpcClient } from '../../api/webview-client/useTrpcClient';
import type { FolderKind } from '../gettingStartedViewRouter';

export type FolderState = {
  status: 'none' | 'checking' | 'empty' | 'rayfin' | 'non-rayfin';
  parentPath?: string;
  projectPath?: string;
  exists?: boolean;
};

export function useFolderSelection(projectName?: string) {
  const { trpcClient } = useTrpcClient();
  const [folderState, setFolderState] = useState<FolderState>({
    status: 'none',
  });
  const [parentPath, setParentPath] = useState<string>();
  const didAutoSet = useRef(false);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  const classifyAndSet = useCallback(
    async (nextParentPath: string, name?: string) => {
      const id = ++requestIdRef.current;
      const childSlug = name
        ? (generateProjectSlug(name) ?? undefined)
        : undefined;

      // Without a child slug we're just selecting a parent directory —
      // there's nothing to classify yet.
      if (!childSlug) {
        setFolderState({
          status: 'empty',
          parentPath: nextParentPath,
          projectPath: undefined,
          exists: undefined,
        });
        return;
      }

      setFolderState({
        status: 'checking',
        parentPath: nextParentPath,
        projectPath: undefined,
        exists: undefined,
      });

      try {
        const result =
          await trpcClient.gettingStartedView.resolveAndClassify.query({
            parentPath: nextParentPath,
            childSlug,
          });
        if (requestIdRef.current !== id || !mountedRef.current) return;
        setFolderState({
          status: result.kind as FolderKind,
          parentPath: nextParentPath,
          projectPath: result.projectPath ?? undefined,
          exists: result.exists,
        });
      } catch {
        if (requestIdRef.current !== id || !mountedRef.current) return;
        setFolderState({
          status: 'non-rayfin',
          parentPath: nextParentPath,
          projectPath: undefined,
          exists: true,
        });
      }
    },
    [trpcClient]
  );

  useEffect(() => {
    if (!parentPath) {
      setFolderState({ status: 'none' });
      return;
    }
    void classifyAndSet(parentPath, projectName);
  }, [parentPath, projectName, classifyAndSet]);

  const selectFolder = useCallback(async () => {
    const result = await trpcClient.gettingStartedView.pickFolder.mutate();

    if (!result) {
      return;
    }

    setParentPath(result.folderPath);
  }, [trpcClient]);

  // Seed the default parent folder (~/RayfinApps) once on mount.
  useEffect(() => {
    if (didAutoSet.current) {
      return;
    }
    didAutoSet.current = true;

    void (async () => {
      try {
        const result =
          await trpcClient.gettingStartedView.getDefaultProjectPath.query();
        if (result && mountedRef.current) {
          setParentPath(result.folderPath);
        }
      } catch {
        // Default path unavailable — stay on 'none'.
      }
    })();
  }, [trpcClient]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return { folderState, selectFolder };
}
