/**
 * Runtime companion for the `fabric-semanticmodel` connector marker.
 *
 * Connector markers are type-only, so behaviour that must run at runtime is
 * supplied here as a {@link ConnectorRuntime}: a single `invoke` middleware for
 * the `executeQuery` operation that selects an execution path based on where
 * the app is running, decodes the response, and returns the connector's public
 * result. Pass the result of {@link fabricSemanticModel} to
 * `ConnectorsRayfinClient` (or `createConnectorsApi`) under the same connector
 * name used in the typed schema.
 */

import type {
  ConnectorRuntime,
  InvokeContext,
  InvokeNext,
} from '@microsoft/rayfin-connectors';

import { parseArrowStream } from './arrow';
import {
  executeDaxDirect,
  resolveTarget,
  type FabricSemanticModelRuntimeOptions,
} from './directExecute';
import { toQueryResult, type SemanticModelQueryResult } from './queryResult';
import type {
  ExecuteQueryInput,
  FabricSemanticModelTabularResponse,
} from './types';

/**
 * Options accepted by {@link fabricSemanticModel}.
 */
export type FabricSemanticModelOptions = FabricSemanticModelRuntimeOptions;

/**
 * Is this a value Analysis Services can use as a row cap?
 *
 * The input is often composed by an agent, so a limit is only honoured when it
 * is a positive integer.
 */
function isUsableRowLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Drop a `resultSetRowCountLimit` that is not usable, so no transport reached
 * through this middleware sees it.
 *
 * This runs before the host check rather than inside the CLI branch, because
 * the documented contract is that an unusable limit is ignored, and the
 * delegated paths forward the input to BaaS verbatim. Validating only on the
 * branch that happens to read the value would leave that promise true in one
 * environment and false in every other one.
 *
 * It stops an agent sending a nonsensical limit by accident; it is not a
 * security boundary. A client that registers no runtime, or that calls
 * `invoke()` directly, bypasses this middleware entirely, so the service
 * remains the only place the value can be rejected for good.
 *
 * The context is copied rather than mutated: it belongs to the connectors
 * layer, and a middleware that edits it in place would change what later hooks
 * observe.
 */
function withValidatedRowLimit(ctx: InvokeContext): InvokeContext {
  const input = ctx.input as ExecuteQueryInput | undefined;
  if (input === null || typeof input !== 'object') {
    return ctx;
  }

  const limit = input.resultSetRowCountLimit;
  if (limit === undefined || isUsableRowLimit(limit)) {
    return ctx;
  }

  const { resultSetRowCountLimit: _ignored, ...rest } = input;
  return { ...ctx, input: rest } as InvokeContext;
}

/**
 * Decode whatever a transport returned into the connector's JSON wire shape.
 *
 * The delegated transport negotiates Apache Arrow but stays JSON-compatible,
 * so it returns either raw bytes or an already-decoded envelope, and the CLI
 * branch always returns the latter (it decodes internally because it needs the
 * response headers for the request id). Sniffing the value keeps both shapes
 * working without asking the caller which one it has.
 *
 * This is the work the `decodeBinary` hook used to do. It moved here because
 * the connectors layer applies that hook *after* `invoke` returns, which is too
 * late for a middleware that has to normalise the response itself: it would
 * otherwise be handed undecoded bytes on the delegated path.
 */
function decodeResponse(payload: unknown): FabricSemanticModelTabularResponse {
  if (payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)) {
    return parseArrowStream(
      payload instanceof ArrayBuffer
        ? payload
        : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
    );
  }
  return payload as FabricSemanticModelTabularResponse;
}

/**
 * Select a transport for a single `executeQuery` call and return its response
 * in the connector's JSON wire shape.
 *
 * - `'cli'`: the Rayfin inner loop, where no app is deployed and therefore no
 *   User Data Function exists to call. Queries the public Power BI endpoint
 *   directly under the developer's own identity.
 * - anything else: delegate to `next`, the default standalone transport
 *   (BaaS, then User Data Function, then connector).
 *
 * The CLI branch also delegates whenever it is not fully equipped to service
 * the call: no pre-authenticated HTTP client, no configured target, or no query
 * in the input. Falling through keeps the connector working in every
 * environment rather than failing in the ones this branch does not cover.
 *
 * Per-query options carried on the input (`resultSetRowCountLimit`) override
 * the runtime options for that call only. An unusable limit is stripped from
 * the input before any transport this middleware hands off to, including the
 * delegated ones.
 */
async function executeOnBestTransport(
  ctx: InvokeContext,
  next: InvokeNext,
  options: FabricSemanticModelOptions
): Promise<FabricSemanticModelTabularResponse> {
  if (ctx.host.type !== 'cli') {
    return decodeResponse(await next(ctx));
  }

  // `http` is only populated for transports that can supply one; the contract
  // is to fall through when it is absent.
  if (!ctx.http) {
    return decodeResponse(await next(ctx));
  }

  const target = resolveTarget(options.target);
  if (!target) {
    return decodeResponse(await next(ctx));
  }

  const input = ctx.input as ExecuteQueryInput | undefined;

  const query = input?.query;
  if (typeof query !== 'string' || query.length === 0) {
    return decodeResponse(await next(ctx));
  }

  // Any limit still present has already been validated, so a per-call value
  // simply overrides the runtime option.
  const requestedLimit = input?.resultSetRowCountLimit;
  const effectiveOptions =
    requestedLimit === undefined
      ? options
      : { ...options, resultSetRowCountLimit: requestedLimit };

  return executeDaxDirect(ctx.http, target, query, effectiveOptions);
}

/**
 * Run one `executeQuery` call and return the connector's public result.
 *
 * Every path converges here, so the operation resolves to the same
 * `SemanticModelQueryResult` no matter which transport served it and no matter
 * who is calling. Normalising at this single boundary is what makes that true:
 * a caller downstream of the middleware cannot tell a CLI response from a
 * deployed one, and does not have to.
 *
 * It also removes a trap. This connector reports DAX syntax errors and
 * row-limit overflows inside a `status: 'Succeeded'` envelope, so a resolved
 * promise is not success. Reading that correctly needs the connector's own
 * knowledge of the envelope, which is exactly what a generic caller lacks.
 * Returning the discriminated result means the check is `result.status`
 * everywhere, rather than something each caller has to rediscover.
 */
async function routeExecuteQuery(
  rawCtx: InvokeContext,
  next: InvokeNext,
  options: FabricSemanticModelOptions
): Promise<SemanticModelQueryResult> {
  const ctx = withValidatedRowLimit(rawCtx);
  return toQueryResult(await executeOnBestTransport(ctx, next, options));
}

/**
 * Build the runtime hooks for a `fabric-semanticmodel` connector instance.
 *
 * Registers one hook for the `executeQuery` operation:
 *
 * - `invoke`: selects the execution path for the current host, decodes the
 *   response, and returns a `SemanticModelQueryResult` (see
 *   `routeExecuteQuery`).
 *
 * A single hook is deliberate. The operation's public result is the same
 * discriminated union on every path and for every caller, so there is no
 * connector-specific post-processing left for anyone downstream to apply, and
 * no way to end up with a half-processed response by forgetting a step.
 *
 * Decoding lives inside `invoke` rather than in the layer's `decodeBinary`
 * hook because that hook runs *after* `invoke` returns. A middleware that
 * normalises its own response has to decode first, so the hook would arrive too
 * late to be useful here.
 *
 * To query more than one semantic model, register one runtime per model under
 * its own connector name. The connectors layer already keys instances by name,
 * so a second lookup table inside a single runtime would only duplicate it.
 *
 * @example
 * ```ts
 * import { ConnectorsRayfinClient } from '@microsoft/rayfin-client';
 * import {
 *   fabricSemanticModel,
 *   parseSemanticModelUrl,
 *   type FabricSemanticModel,
 * } from '@microsoft/rayfin-connector-fabric-semanticmodel';
 *
 * type AppConnectorsSchema = {
 *   salesModel: FabricSemanticModel<'executeQuery'>;
 * };
 *
 * const salesModel = fabricSemanticModel({
 *   target: parseSemanticModelUrl(process.env.SALES_MODEL_URL!),
 *   resultSetRowCountLimit: 1000,
 * });
 *
 * const client = new ConnectorsRayfinClient<
 *   DataSchema,
 *   FunctionsSchema,
 *   AppConnectorsSchema
 * >(config, { salesModel });
 * ```
 *
 * @param options - Target model, endpoint, token provider, and DAX query
 *   options for the CLI path. Omit them to keep the previous behaviour, where
 *   every call goes to the standalone transport.
 * @returns The connector runtime hooks.
 */
export function fabricSemanticModel(
  options: FabricSemanticModelOptions = {}
): ConnectorRuntime {
  return {
    operations: {
      executeQuery: {
        invoke: (ctx, next) => routeExecuteQuery(ctx, next, options),
      },
    },
  };
}
