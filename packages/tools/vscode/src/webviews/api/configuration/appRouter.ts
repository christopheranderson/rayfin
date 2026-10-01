/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { z } from 'zod';

import { ext } from '../../../extensionVariables';
import { openUrl } from '../../../utils/openUrl';
import { gettingStartedViewRouter } from '../../gettingStartedView/gettingStartedViewRouter';
import { mainViewRouter } from '../../mainView/mainViewRouter';
import { projectViewRouter } from '../../projectView/projectViewRouter';
import { publicProcedure, router } from '../extension-server/trpc';

export type BaseRouterContext = {
  webviewName: string;
  telemetry?: {
    properties: Record<string, string>;
    measurements: Record<string, number>;
  };
  signal?: AbortSignal;
  /** Mutable session bag for correlating related telemetry events. */
  session?: { id: string };
};

const commonRouter = router({
  reportEvent: publicProcedure
    .input(
      z.object({
        eventName: z.string(),
        properties: z.optional(z.record(z.string(), z.string())),
        measurements: z.optional(z.record(z.string(), z.number())),
      })
    )
    .mutation(({ input, ctx }) => {
      const myCtx = ctx as BaseRouterContext;
      const eventName = `${myCtx.webviewName}.${input.eventName}`;
      ext.telemetryReporter?.sendActionEvent(
        eventName,
        input.properties,
        input.measurements
      );
    }),
  reportError: publicProcedure
    .input(
      z.object({
        message: z.string(),
        stack: z.string(),
        componentStack: z.optional(z.string()),
        properties: z.optional(z.record(z.string(), z.string())),
      })
    )
    .mutation(({ input, ctx }) => {
      const myCtx = ctx as BaseRouterContext;
      const eventName = `${myCtx.webviewName}/error`;
      ext.telemetryReporter?.sendErrorEvent(eventName, {
        message: input.message,
        ...(input.componentStack
          ? { componentStack: input.componentStack }
          : {}),
        ...input.properties,
      });
    }),
  displayErrorMessage: publicProcedure
    .input(
      z.object({
        message: z.string(),
        modal: z.boolean(),
        cause: z.string(),
      })
    )
    .mutation(({ input }) => {
      let message = input.message;
      if (input.cause && !input.modal) {
        message += ` (${input.cause})`;
      }

      void vscode.window.showErrorMessage(message, {
        modal: input.modal,
        detail: input.modal ? input.cause : undefined,
      });
    }),
  openUrl: publicProcedure
    .input(
      z.object({
        url: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      await openUrl(input.url);
    }),
});

export const appRouter = router({
  common: commonRouter,
  gettingStartedView: gettingStartedViewRouter,
  mainView: mainViewRouter,
  projectView: projectViewRouter,
});

// Export type router type signature, this is used by the client.
export type AppRouter = typeof appRouter;
