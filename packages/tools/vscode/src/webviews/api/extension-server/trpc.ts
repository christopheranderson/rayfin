/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * This is your entry point to setup the root configuration for tRPC on the server.
 * - `initTRPC` should only be used once per app.
 * - We export only the functionality that we use so we can enforce which base procedures should be used
 *
 * Learn how to create protected base procedures and other things below:
 * @see https://trpc.io/docs/v11/router
 * @see https://trpc.io/docs/v11/procedures
 */

import { InvocationContext } from '@microsoft/rayfin-tools-common/_internal/telemetry';
import { initTRPC } from '@trpc/server';

import { ext } from '../../../extensionVariables';
import { getEnvironmentInfo } from '../../../telemetry/env';
import { type BaseRouterContext } from '../configuration/appRouter';

/**
 * Telemetry context interface.
 *
 * Replace this with your telemetry library's context type. For example, if you
 * use `@microsoft/vscode-azext-utils` with Application Insights, you can import
 * `ITelemetryContext` from that package and use it directly here.
 */
export interface TelemetryContext {
  properties: Record<string, string>;
  measurements: Record<string, number>;
}

/**
 * Helper type: transforms a context type to have required (non-optional) telemetry.
 * Use with `publicProcedureWithTelemetry` to get type-safe telemetry access.
 */
export type WithTelemetry<T extends { telemetry?: unknown }> = T & {
  telemetry: TelemetryContext;
};

/**
 * Initialization of tRPC backend.
 *
 * Please note, this should be done only once per backend.
 */
const t = initTRPC.create();

/**
 * Unprotected procedure
 **/

export const createCallerFactory = t.createCallerFactory;

export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * Telemetry middleware — instruments every tRPC call with a
 * {@link RayfinCommandEvent} via the shared {@link InvocationContext}.
 *
 * Procedure handlers can still enrich the per-call {@link TelemetryContext}
 * bag (accessible as `ctx.telemetry.properties` / `ctx.telemetry.measurements`).
 * Any custom properties accumulated there are forwarded alongside the
 * command event.
 */
const trpcToTelemetry = t.middleware(async (opts) => {
  const telemetry: TelemetryContext = {
    properties: {},
    measurements: {},
  };

  const version: string =
    (ext.context?.extension?.packageJSON as { version?: string })?.version ??
    'unknown';
  const ctx = new InvocationContext('rayfin-vscode', version);
  ctx.setCommand(`trpc/${opts.path}`, []);

  const result = await opts.next({
    ctx: {
      ...opts.ctx,
      telemetry,
    },
  });

  const durationMs = Date.now() - ctx.startTime.getTime();
  telemetry.measurements.durationMs = durationMs;

  // Check if the operation was aborted via AbortSignal
  const signal = (opts.ctx as BaseRouterContext).signal;
  if (signal?.aborted) {
    ctx.markCanceled();
  }

  if (!result.ok) {
    if (!signal?.aborted) {
      ctx.markFailure(result.error);
    }
  } else {
    ctx.markSuccess();
  }

  // Emit telemetry event via the reporter.
  const event = ctx.finalize(getEnvironmentInfo());

  // Attach the mutable session ID from the router context so related
  // events (e.g. all steps in a setup workflow run) can be correlated.
  const session = (opts.ctx as BaseRouterContext).session;
  if (session) {
    telemetry.properties.sessionId = session.id;
  }

  ext.telemetryReporter?.sendCommandEvent(event, telemetry.properties);

  // Also forward any procedure-level custom properties as an action
  // event when handlers wrote extra data to ctx.telemetry.
  if (Object.keys(telemetry.properties).length > 0) {
    ext.telemetryReporter?.sendActionEvent(
      `trpc/${opts.path}`,
      telemetry.properties,
      telemetry.measurements
    );
  }

  return result;
});

/**
 * Base procedure that automatically attaches telemetry context.
 *
 * Use this instead of `publicProcedure` when you want every call to be
 * tracked. The `telemetry` object is available on `ctx` inside your
 * procedure handlers (cast with `WithTelemetry<YourContext>`).
 */
export const publicProcedureWithTelemetry =
  publicProcedure.use(trpcToTelemetry);
