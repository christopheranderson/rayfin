/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { z } from 'zod';

import { type BaseRouterContext } from '../api/configuration/appRouter';
import {
  publicProcedureWithTelemetry,
  router,
  type WithTelemetry,
} from '../api/extension-server/trpc';

export type RouterContext = BaseRouterContext & {
  extensionVersion: string;
};

export const mainViewRouter = router({
  hello: publicProcedureWithTelemetry.query(async () => {
    return {
      message: l10n.t('Hello from the extension host!'),
      timestamp: new Date().toISOString(),
    };
  }),

  longRunningQuery: publicProcedureWithTelemetry
    .input(
      z.object({
        durationMs: z.number().min(1000).max(30000),
      })
    )
    .query(async ({ input, ctx }) => {
      const myCtx = ctx as WithTelemetry<RouterContext>;
      const steps = Math.ceil(input.durationMs / 500);

      for (let i = 0; i < steps; i++) {
        if (myCtx.signal?.aborted) {
          return {
            result: l10n.t('Cancelled'),
            completed: false,
            elapsedMs: i * 500,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      return {
        result: l10n.t('Done! Operation completed successfully.'),
        completed: true,
        elapsedMs: input.durationMs,
      };
    }),

  countdown: publicProcedureWithTelemetry
    .input(z.object({ from: z.number(), intervalMs: z.number() }))
    .subscription(async function* ({ input, ctx }) {
      const myCtx = ctx as WithTelemetry<RouterContext>;

      for (let i = input.from; i >= 0; i--) {
        if (myCtx.signal?.aborted) {
          return;
        }

        yield { current: i, total: input.from };

        if (i > 0) {
          await new Promise((resolve) => setTimeout(resolve, input.intervalMs));
        }
      }
    }),

  throwOnDemand: publicProcedureWithTelemetry
    .input(
      z.object({
        shouldThrow: z.boolean(),
      })
    )
    .query(async ({ input }) => {
      if (input.shouldThrow) {
        throw new Error(
          l10n.t(
            'This is a deliberate error thrown by the extension host to demonstrate error handling.'
          )
        );
      }

      return {
        status: 'ok' as const,
        message: l10n.t('Success! The procedure completed without errors.'),
        timestamp: new Date().toISOString(),
      };
    }),
});
