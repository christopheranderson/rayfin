/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parseRayfinYaml } from '@microsoft/rayfin-tools-common/_internal/config';
import * as vscode from 'vscode';
import { z } from 'zod';

import { ext } from '../../extensionVariables';
import { ProjectViewService } from '../../services/ProjectViewService';
import { getFabricSession } from '../../services/auth';
import { getFabricSettings } from '../../services/fabric/constants';
import type { FabricSettings } from '../../services/fabric/constants';
import { RayfinItemClient } from '../../services/fabric/rayfinItem';
import { loadEnvironmentVariables } from '../../services/rayfin/config';
import {
  findExistingEnvFabricFiles,
  readLatestDeployment,
  writeDeploymentEnvFile,
} from '../../services/rayfin/envFabric';
import {
  consumePendingUriDeploy,
  isAutoOpenDismissed,
  setAutoOpenDismissed,
} from '../../utils/autoOpenState';
import { fileExists, readTextFile } from '../../utils/fs';
import { type BaseRouterContext } from '../api/configuration/appRouter';
import {
  publicProcedureWithTelemetry,
  router,
  type WithTelemetry,
} from '../api/extension-server/trpc';

export type ProjectRouterContext = BaseRouterContext & {
  service: ProjectViewService;
};

export const projectViewRouter = router({
  /**
   * Detect whether the selected workspace folder is a Rayfin project and return its config.
   */
  getProjectInfo: publicProcedureWithTelemetry
    .input(z.object({ folder: z.string().optional() }))
    .query(async ({ input }) => {
      const workspaceFolder =
        input.folder ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      if (!workspaceFolder) {
        return { found: false as const };
      }

      const folderUri = vscode.Uri.file(workspaceFolder);
      const configUri = vscode.Uri.joinPath(folderUri, 'rayfin', 'rayfin.yml');

      if (!(await fileExists(configUri))) {
        return { found: false as const };
      }

      const yamlContent = await readTextFile(configUri);
      const config = parseRayfinYaml(yamlContent);

      return {
        found: true as const,
        config,
        projectRoot: workspaceFolder,
        rawYaml: yamlContent,
      };
    }),

  /**
   * Check only prerequisites (Node.js, Docker).
   */
  checkPrerequisites: publicProcedureWithTelemetry.query(async ({ ctx }) => {
    const myCtx = ctx as WithTelemetry<ProjectRouterContext>;
    return myCtx.service.checkPrerequisites({ signal: myCtx.signal });
  }),

  /**
   * Check a single prerequisite by name.
   */
  checkPrerequisite: publicProcedureWithTelemetry
    .input(z.object({ name: z.string() }))
    .query(async ({ input, ctx }) => {
      const myCtx = ctx as WithTelemetry<ProjectRouterContext>;
      return myCtx.service.checkPrerequisite(input.name, {
        signal: myCtx.signal,
      });
    }),

  /**
   * Check Docker GHCR (GitHub Container Registry) authentication.
   */
  checkDockerGhcr: publicProcedureWithTelemetry.query(async ({ ctx }) => {
    const myCtx = ctx as WithTelemetry<ProjectRouterContext>;
    return myCtx.service.checkDockerGhcrAuth({ signal: myCtx.signal });
  }),

  /**
   * Log in to GitHub Container Registry (ghcr.io) via Docker.
   */
  loginDockerGhcr: publicProcedureWithTelemetry.mutation(async ({ ctx }) => {
    const myCtx = ctx as WithTelemetry<ProjectRouterContext>;
    return myCtx.service.loginDockerGhcr();
  }),

  openWorkspaceFolder: publicProcedureWithTelemetry.mutation(async () => {
    await vscode.commands.executeCommand('vscode.openFolder');
  }),

  createNewProject: publicProcedureWithTelemetry.mutation(async () => {
    await vscode.commands.executeCommand('rayfin.createProject');
  }),

  /**
   * Check whether a node_modules folder exists at the workspace root.
   */
  checkNodeModules: publicProcedureWithTelemetry
    .input(z.object({ folder: z.string() }))
    .query(async ({ input }) => {
      const folderUri = vscode.Uri.file(input.folder);
      const nodeModulesUri = vscode.Uri.joinPath(folderUri, 'node_modules');
      return { exists: await fileExists(nodeModulesUri) };
    }),

  /**
   * Open a terminal to run `npm install` in the workspace folder.
   */
  runNpmInstall: publicProcedureWithTelemetry
    .input(z.object({ folder: z.string() }))
    .mutation(({ input, ctx }) => {
      const myCtx = ctx as WithTelemetry<ProjectRouterContext>;
      myCtx.service.openNpmInstallTerminal(input.folder);
    }),

  /**
   * Check Microsoft Fabric auth via VS Code's built-in Microsoft auth.
   */
  checkMicrosoftAuth: publicProcedureWithTelemetry.query(async ({ ctx }) => {
    const myCtx = ctx as WithTelemetry<ProjectRouterContext>;
    return myCtx.service.checkMicrosoftAuth();
  }),

  /**
   * Sign in to Microsoft for Fabric access.
   */
  signInMicrosoft: publicProcedureWithTelemetry
    .input(z.object({ force: z.boolean().optional() }).optional())
    .mutation(async ({ input, ctx }) => {
      const myCtx = ctx as WithTelemetry<ProjectRouterContext>;
      return myCtx.service.signInMicrosoft(input?.force);
    }),

  /**
   * Check whether a deployment exists by reading the deployment registry.
   *
   * When a pre-seeded deployment record contains an item ID and workspace ID
   * but no publishable key, we query the deploy status API for the
   * artifact's `deployedCodeOrigin`.  If it is `Template` or `User`, the
   * backend has already been deployed so we fetch the remaining values
   * (BaaS endpoint, publishable key, portal URL) and persist them into
   * the registry so the project correctly shows as "Deployed".
   */
  checkDeploy: publicProcedureWithTelemetry
    .input(z.object({ folder: z.string() }))
    .query(async ({ input }) => {
      const folderUri = vscode.Uri.file(input.folder);
      const result = await readLatestDeployment(folderUri);
      if (!result) {
        ext.outputChannel.appendLine(
          `checkDeploy: no deployment record found in ${input.folder} — reporting not deployed`
        );
        return {
          deployed: false,
          deploying: false,
          workspaceName: null,
        };
      }

      // Always verify deployment status with the backend when we have
      // item+workspace IDs, so that refreshing re-checks deploy status
      // instead of relying solely on a cached publishable key in the
      // deployment registry.
      const { fabricItemId, fabricWorkspaceId } = result.deployment;
      if (fabricItemId && fabricWorkspaceId) {
        ext.outputChannel.appendLine(
          `checkDeploy: registry has item=${fabricItemId} workspace=${fabricWorkspaceId} — querying backend for deployedCodeOrigin`
        );
        try {
          const session = await getFabricSession({ silent: true });
          if (!session) {
            ext.outputChannel.appendLine(
              `checkDeploy: no Fabric session available (silent) — cannot query backend, reporting not deployed`
            );
            return {
              deployed: false,
              deploying: false,
              workspaceName: null,
            };
          }
          // Load project .env overrides so fabric settings (API URL,
          // portal URL) match the target environment.
          const envVars = await loadEnvironmentVariables({
            projectRoot: folderUri,
          });
          const fabricSettings: FabricSettings = getFabricSettings(
            Object.fromEntries(envVars)
          );
          const rayfinItemClient = new RayfinItemClient(
            session.accessToken,
            false,
            fabricSettings
          );

          const deployStatusResult = await rayfinItemClient.getDeployStatus(
            fabricWorkspaceId,
            fabricItemId
          );

          const origin = deployStatusResult.deployedCodeOrigin;
          const deployStatus = deployStatusResult.status;
          ext.outputChannel.appendLine(
            `checkDeploy: backend reports deployedCodeOrigin=${origin ?? '(none)'}, status=${deployStatus ?? '(none)'}`
          );

          // An active deployment is in flight — the backend has a template
          // deploy operation currently running.  Surface this as "deploying"
          // so the UX shows an in-progress state instead of "not deployed".
          if (deployStatus === 'InProgress') {
            const envFiles = await findExistingEnvFabricFiles(folderUri);
            return {
              deployed: false,
              deploying: true,
              workspaceName: envFiles[0]?.workspaceName ?? null,
            };
          }

          if (origin === 'Template' || origin === 'User') {
            let publishableKey: string | undefined;
            try {
              publishableKey = await rayfinItemClient.retrievePublishableKey(
                fabricWorkspaceId,
                fabricItemId
              );
            } catch {
              // Non-fatal — key may not be ready yet
            }

            // Fetch BaaSEndpoint from extended properties
            let baaSEndpoint: string | undefined;
            try {
              const extendedProps =
                await rayfinItemClient.getExtendedProperties(
                  fabricWorkspaceId,
                  fabricItemId
                );
              baaSEndpoint = extendedProps.BaaSEndpoint;
            } catch {
              // Non-fatal — endpoint may not be ready yet
            }

            const envFiles = await findExistingEnvFabricFiles(folderUri);
            const workspaceName = envFiles[0]?.workspaceName ?? undefined;

            await writeDeploymentEnvFile(folderUri, workspaceName, {
              fabricItemId,
              rayfinApiUrl: baaSEndpoint,
              fabricWorkspaceId,
              publishableKey: publishableKey || undefined,
              fabricPortalUrl: fabricSettings.fabricPortalUrl,
            });

            ext.outputChannel.appendLine(
              `checkDeploy: Updated deployment registry with full deployment info (origin: ${origin})`
            );

            return {
              deployed: true,
              deploying: false,
              workspaceName: workspaceName ?? null,
            };
          }

          // Backend did not report deployedCodeOrigin (some environments
          // may not have this set yet).  In that case, trust the locally
          // cached publishable key as evidence of a prior successful
          // deployment so refresh doesn't falsely flip to "not deployed".
          if (origin === undefined && result.deployment.publishableKey) {
            const envFiles = await findExistingEnvFabricFiles(folderUri);
            ext.outputChannel.appendLine(
              `checkDeploy: backend did not report deployedCodeOrigin — trusting cached publishable key`
            );
            return {
              deployed: true,
              deploying: false,
              workspaceName: envFiles[0]?.workspaceName ?? null,
            };
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          ext.outputChannel.appendLine(
            `checkDeploy: Could not fetch deployment info from API: ${msg}`
          );
          // On transient backend errors, fall back to the locally cached
          // publishable key so a flaky network doesn't flip the UI from
          // "Deployed" to "Not deployed".
          if (result.deployment.publishableKey) {
            const envFiles = await findExistingEnvFabricFiles(folderUri);
            return {
              deployed: true,
              deploying: false,
              workspaceName: envFiles[0]?.workspaceName ?? null,
            };
          }
        }
      } else {
        ext.outputChannel.appendLine(
          `checkDeploy: deployment record missing item or workspace id — reporting not deployed`
        );
      }

      return { deployed: false, deploying: false, workspaceName: null };
    }),

  /**
   * Execute the `rayfin.up` deployment command.
   *
   * When `folder` is provided the pending-URI-deploy flag is consumed so
   * it won't auto-fire again on the next workspace load.
   */
  runDeploy: publicProcedureWithTelemetry
    .input(z.object({ folder: z.string() }).optional())
    .mutation(async ({ input }) => {
      // Clear the pending-URI-deploy flag now that deployment has been
      // triggered, so it won't re-fire on the next workspace load.
      // If the flag carried a Fabric workspace ID from the portal, pass it
      // through so `up()` targets the correct workspace.
      let fabricWorkspaceId: string | undefined;
      if (input?.folder) {
        try {
          const folderUri = vscode.Uri.file(input.folder);
          const configUri = vscode.Uri.joinPath(
            folderUri,
            'rayfin',
            'rayfin.yml'
          );
          const yaml = await readTextFile(configUri);
          const config = parseRayfinYaml(yaml);
          const consumed = await consumePendingUriDeploy(
            ext.context,
            config.id
          );
          if (typeof consumed === 'string') {
            fabricWorkspaceId = consumed;
          }
        } catch {
          // Non-fatal — flag cleanup is best-effort
        }
      }

      try {
        await vscode.commands.executeCommand('rayfin.up', {
          fabricWorkspaceId,
        });
      } catch (error) {
        // Surface deploy-in-progress collisions as a warning instead of
        // the generic error dialog that rayfin.up shows.
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('deploy_in_progress')) {
          void vscode.window.showWarningMessage(
            vscode.l10n.t(
              'A deployment is in progress. Please wait for it to complete before deploying again.'
            )
          );
          return;
        }

        throw error;
      }
    }),

  /**
   * Execute the `rayfin.upStaticDeploy` command (static content only).
   */
  runStaticDeploy: publicProcedureWithTelemetry.mutation(async () => {
    await vscode.commands.executeCommand('rayfin.upStaticDeploy');
  }),

  /**
   * Check whether auto-open has been dismissed for a project.
   */
  getAutoOpenDismissed: publicProcedureWithTelemetry
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => {
      return { dismissed: isAutoOpenDismissed(ext.context, input.projectId) };
    }),

  /**
   * Set whether auto-open is dismissed for a project.
   */
  setAutoOpenDismissed: publicProcedureWithTelemetry
    .input(z.object({ projectId: z.string(), dismissed: z.boolean() }))
    .mutation(async ({ input }) => {
      await setAutoOpenDismissed(ext.context, input.projectId, input.dismissed);
    }),

  /**
   * Reset the session ID used to correlate telemetry events within a
   * single setup workflow run. Call this when the user restarts or
   * refreshes the setup flow so subsequent events are grouped under a
   * new session.
   */
  resetSession: publicProcedureWithTelemetry.mutation(({ ctx }) => {
    const myCtx = ctx as WithTelemetry<ProjectRouterContext>;
    const newId = crypto.randomUUID();
    // Mutate the shared session object so all future calls pick up the
    // new session ID via the trpcToTelemetry middleware.
    if (myCtx.session) {
      myCtx.session.id = newId;
    }
    return { sessionId: newId };
  }),
});
