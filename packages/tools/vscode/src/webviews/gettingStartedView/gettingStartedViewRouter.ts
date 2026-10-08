/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { z } from 'zod';

import { classifyFolder } from '../../utils/classifyFolder';
import { askOpenFolderChoice, executeOpenFolder } from '../../utils/openFolder';
import { getDefaultProjectParentUri } from '../../utils/projectLocation';
import { type BaseRouterContext } from '../api/configuration/appRouter';
import {
  publicProcedureWithTelemetry,
  router,
} from '../api/extension-server/trpc';

export type GettingStartedRouterContext = BaseRouterContext;

export type { FolderKind } from '../../utils/classifyFolder';

/**
 * The template name that is auto-selected when creating a new project from
 * the Getting Started view.  This is the "Getting Started with Auth"
 * template.
 */
const AUTO_TEMPLATE_NAME = 'getting-started-auth';

/**
 * Maps portal-side template IDs (no hyphens) to the VS Code extension's
 * bundled template names (kebab-case).  When the user clicks "Edit in
 * VS Code" from the portal after deploying a template, the URI payload
 * carries the portal ID so we can pre-select the matching local template.
 */
const PORTAL_TEMPLATE_MAP: Record<string, string> = {
  gettingstartedauth: 'getting-started-auth',
};

export const gettingStartedViewRouter = router({
  /**
   * Return the default parent directory for new projects (`~/RayfinApps`).
   * Returns `null` when no reasonable default can be determined (web host
   * with no workspace open).
   */
  getDefaultProjectPath: publicProcedureWithTelemetry.query(() => {
    const folderUri = getDefaultProjectParentUri();
    if (!folderUri) {
      return null;
    }
    return { folderPath: folderUri.fsPath };
  }),

  /**
   * Show an OS folder-picker dialog and return the selected path.
   */
  pickFolder: publicProcedureWithTelemetry.mutation(async () => {
    const result = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: vscode.l10n.t('Select Folder'),
      title: vscode.l10n.t('Choose a project folder'),
    });

    if (!result || result.length === 0) {
      return null;
    }

    return { folderPath: result[0].fsPath };
  }),

  /**
   * Resolve a project path from a parent directory + optional child slug,
   * then classify the target folder in a single round-trip.
   *
   * When `childSlug` is provided the inspected path is
   * `parentPath / childSlug`; otherwise `parentPath` itself is classified.
   * Non-existent folders are treated as `empty` (valid for new projects).
   */
  resolveAndClassify: publicProcedureWithTelemetry
    .input(
      z.object({ parentPath: z.string(), childSlug: z.string().optional() })
    )
    .query(async ({ input }) => {
      const projectPath = input.childSlug
        ? vscode.Uri.joinPath(
            vscode.Uri.file(input.parentPath),
            input.childSlug
          ).fsPath
        : undefined;
      const inspectedPath = projectPath ?? input.parentPath;
      const folderUri = vscode.Uri.file(inspectedPath);

      const result = await classifyFolder(folderUri);
      return { ...result, projectPath };
    }),

  /**
   * Open a folder picker and open the selected folder as the workspace.
   * If `folderPath` is provided, skips the picker and opens that folder
   * directly.
   */
  openExistingProject: publicProcedureWithTelemetry
    .input(z.object({ folderPath: z.string().optional() }).optional())
    .mutation(async ({ input }) => {
      let targetUri: vscode.Uri;

      if (input?.folderPath) {
        targetUri = vscode.Uri.file(input.folderPath);

        // If the folder is already open, just show the Project View.
        const alreadyOpen = vscode.workspace.workspaceFolders?.some(
          (f) => f.uri.toString() === targetUri.toString()
        );
        if (alreadyOpen) {
          await vscode.commands.executeCommand('rayfin.openProjectView');
          return;
        }

        // Open directly in the current window — the user already chose to
        // open this specific project, no need for a "how to open" prompt.
        await vscode.commands.executeCommand(
          'vscode.openFolder',
          targetUri,
          false
        );
        return;
      }

      // No folderPath provided — show a folder picker and then ask how to open.
      const folderSelection = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: vscode.l10n.t('Select Folder'),
        title: vscode.l10n.t('Choose the project folder to open'),
      });

      if (!folderSelection || folderSelection.length === 0) {
        return;
      }
      targetUri = folderSelection[0];

      const choice = await askOpenFolderChoice(targetUri);
      if (!choice) {
        return;
      }
      await executeOpenFolder(targetUri, '', choice);
    }),

  /**
   * Create a new project using the auto-selected template (auth + UI
   * components).  Accepts optional metadata from the URI handler payload.
   *
   * When `portalTemplateId` is provided (e.g. from a portal "Edit in
   * VS Code" deep link) the matching local template is used instead of the
   * default.  If the portal ID doesn't map to a known template, the
   * default (`getting-started-auth`) is used.
   */
  createNewProject: publicProcedureWithTelemetry
    .input(
      z
        .object({
          name: z.string().optional(),
          fabricItemId: z.string().optional(),
          fabricWorkspaceId: z.string().optional(),
          targetFolder: z.string().optional(),
          portalTemplateId: z.string().optional(),
          deployedCodeOrigin: z.enum(['None', 'Template', 'User']).optional(),
          fabricApiUrl: z.string().url().optional(),
          fabricPortalUrl: z.string().url().optional(),
          fabricEnvironment: z.string().optional(),
        })
        .optional()
    )
    .mutation(async ({ input }) => {
      let templateName = AUTO_TEMPLATE_NAME;
      if (input?.portalTemplateId) {
        const mapped = PORTAL_TEMPLATE_MAP[input.portalTemplateId];
        if (mapped) {
          templateName = mapped;
        } else {
          // Unknown portal template ID — log a warning so the mismatch is
          // visible in telemetry, then fall back to the default template.
          // This avoids silently scaffolding the wrong project when the
          // portal adds a new template before the extension is updated.
          const channel = vscode.window.createOutputChannel('Rayfin', {
            log: true,
          });
          channel.warn(
            `Unknown portal template ID "${input.portalTemplateId}". ` +
              `Known IDs: ${Object.keys(PORTAL_TEMPLATE_MAP).join(', ')}. ` +
              `Falling back to default template "${AUTO_TEMPLATE_NAME}".`
          );
          void vscode.window.showWarningMessage(
            vscode.l10n.t(
              'The template "{0}" is not recognized by this version of the extension. Using default template instead.',
              input.portalTemplateId
            )
          );
        }
      }

      await vscode.commands.executeCommand('rayfin.createProject', {
        name: input?.name,
        fabricItemId: input?.fabricItemId,
        fabricWorkspaceId: input?.fabricWorkspaceId,
        targetFolder: input?.targetFolder,
        templateName,
        deployedCodeOrigin: input?.deployedCodeOrigin,
        fabricApiUrl: input?.fabricApiUrl,
        fabricPortalUrl: input?.fabricPortalUrl,
        fabricEnvironment: input?.fabricEnvironment,
      });
    }),
});
