/**
 * Per-connector function-bridge (Category B) client.
 *
 * Backs `client.connectors.<name>` for connectors whose operations are
 * served by the function-invoke endpoint
 * (`${CONNECTOR_INVOKE_BASE_PATH}/<name>`).
 *
 * The constructor returns a Proxy so `client.connectors.<name>.<op>(input)`
 * dispatches as `invoke('<op>', input)` without each operation needing to
 * be declared as a class method (mirrors the `DataApi` /
 * `ExtendableRayfinClient` pattern in this codebase). `invoke()` remains
 * available for programmatic callers and tests.
 *
 * The operation proxy (`<op>(...)`) applies any registered runtime decoder
 * (e.g. the Arrow decoder for `executeQuery`), whereas `invoke()` is the
 * lower-level call that returns the raw, *undecoded* payload — so the two are
 * only interchangeable for connectors/operations with no decoder registered.
 *
 * @example
 * ```ts
 * // Decoded through the registered runtime (e.g. Arrow -> rows):
 * const res = await client.connectors.salesModel.executeQuery({ query: 'EVALUATE ...' });
 *
 * // Same request, but returns the raw undecoded payload (no decoder runs):
 * const raw = await client.connectors.salesModel.invoke('executeQuery', { query: 'EVALUATE ...' });
 * ```
 */

import {
  ApiClient,
  CONNECTOR_INVOKE_BASE_PATH,
  NetworkError,
  SdkError,
} from '@microsoft/rayfin-lib';

import {
  ConnectorsError,
  detectHost,
  type ConnectorRuntime,
  type HostEnvironment,
  type InvokeContext,
  type InvokeHttpClient,
} from '../Connectors';
import type { ConnectorConfig, InvokeOptions } from '../ConnectorsSchema';
import { asArrayBuffer } from '../utils';

/**
 * Promise-protocol keys we short-circuit on the operation proxy so
 * `await client.connectors.<name>` does not synthesize a POST with
 * `operation: 'then'` (or `'catch'` / `'finally'`). Centralizing the
 * list keeps the `get` and `has` traps in agreement — the proxy is
 * uniformly *not* a thenable.
 */
const THENABLE_KEYS = new Set(['then', 'catch', 'finally']);

/**
 * Normalize a `HeadersInit` (the union `fetch` accepts) into the plain
 * `Record<string, string>` shape {@link ApiClient.requestRaw} expects. Returns
 * `undefined` when there are no headers so we don't send an empty object.
 */
function toHeaderRecord(
  headers?: HeadersInit
): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

export class SemanticConnectorClient {
  private readonly apiClient: ApiClient;
  private readonly connectorName: string;
  private readonly runtime?: ConnectorRuntime;
  private readonly host: HostEnvironment;
  private readonly config?: ConnectorConfig;
  private readonly http: InvokeHttpClient;

  constructor(
    apiClient: ApiClient,
    connectorName: string,
    runtime?: ConnectorRuntime,
    host: HostEnvironment = detectHost(),
    config?: ConnectorConfig
  ) {
    this.apiClient = apiClient;
    this.connectorName = connectorName;
    this.runtime = runtime;
    this.host = host;
    this.config = config;
    this.http = this.createHttpClient();

    return this.createProxy();
  }

  /**
   * Build the pre-authenticated {@link InvokeHttpClient} handed to middleware
   * via {@link InvokeContext.http}. It adapts the global `fetch` signature onto
   * {@link ApiClient.requestRaw}, which injects auth headers and reuses the
   * SDK's token-refresh behaviour, so middleware never handles the token.
   */
  private createHttpClient(): InvokeHttpClient {
    const apiClient = this.apiClient;
    return {
      fetch(
        input: Request | string | URL,
        init?: RequestInit
      ): Promise<Response> {
        const path =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        return apiClient.requestRaw(path, {
          method: init?.method,
          headers: toHeaderRecord(init?.headers),
          body: init?.body ?? undefined,
          signal: init?.signal ?? undefined,
        });
      },
    };
  }

  /**
   * Build the {@link InvokeContext} for a single operation call, stamping in
   * the connector name and hosting environment so invoke middleware can branch
   * on them.
   */
  private buildContext(
    operation: string,
    input?: unknown,
    options?: InvokeOptions
  ): InvokeContext {
    return {
      connectorName: this.connectorName,
      operation,
      input,
      options,
      host: this.host,
      connectorConfig: this.config,
      http: this.http,
    };
  }

  /**
   * The default standalone transport: POST the operation to the BaaS Connector
   * Invoke endpoint, negotiating Apache Arrow while staying JSON-compatible.
   * This is the `next` continuation handed to invoke middleware, and the path
   * taken directly when no middleware is registered.
   *
   * Returns the raw, *undecoded* payload; the caller applies any registered
   * `decodeBinary` hook afterwards.
   *
   * @param ctx - The invocation context (connector, operation, input, options).
   * @returns Whatever the server returns for the operation, undecoded.
   */
  private standaloneTransport = async (
    ctx: InvokeContext
  ): Promise<unknown> => {
    const { operation, input, options } = ctx;
    try {
      if (!operation || typeof operation !== 'string') {
        throw new ConnectorsError(
          'Operation name is required.',
          'INVALID_OPERATION'
        );
      }

      const url = `${CONNECTOR_INVOKE_BASE_PATH}/${this.connectorName}`;

      // Negotiate Apache Arrow while remaining compatible with JSON-only
      // workers: the `Accept` header advertises both formats and
      // `responseType: 'arraybuffer'` tells the transport it may surface raw
      // bytes. The actual decode path is selected from the *response*
      // Content-Type by `ApiClient`, so a JSON worker still yields parsed JSON
      // and an Arrow worker yields an `ArrayBuffer` for a connector-specific
      // decoder to interpret. This client stays connector-agnostic.
      const response = await this.apiClient.post<unknown>(
        url,
        { operation, input: input ?? null },
        {
          headers: {
            Accept: 'application/vnd.apache.arrow.stream, application/json',
            ...(options?.headers ?? {}),
          },
          responseType: 'arraybuffer',
        }
      );

      return response;
    } catch (error: any) {
      if (
        error instanceof ConnectorsError ||
        error instanceof NetworkError ||
        error instanceof SdkError
      ) {
        throw error;
      }

      throw new ConnectorsError(
        `An unexpected error occurred during connector invocation: ${error.message || error}`,
        'UNKNOWN_CONNECTOR_ERROR'
      );
    }
  };

  /**
   * Invoke a connector operation.
   *
   * This is the lower-level entry point: it runs the default standalone
   * transport and returns the raw, *undecoded* payload. It does not run
   * invoke middleware or apply `decodeBinary` — those apply on the operation
   * proxy (`client.connectors.<name>.<op>(input)`). Programmatic callers and
   * tests can use it directly.
   *
   * @param operation - The operation name (e.g. `'executeQuery'`).
   * @param input     - The operation's typed input payload.
   * @param options   - Optional per-call settings (extra headers, etc.).
   * @returns Whatever the server returns for `<operation>`.
   *
   * @throws {@link ConnectorsError} if the invocation fails or the server reports a non-success status.
   * @throws `NetworkError` for network-related issues.
   * @throws `SdkError` for any other unexpected SDK errors.
   */
  public async invoke<TOutput = unknown>(
    operation: string,
    input?: unknown,
    options?: InvokeOptions
  ): Promise<TOutput> {
    const ctx = this.buildContext(operation, input, options);
    return (await this.standaloneTransport(ctx)) as TOutput;
  }

  /**
   * Wrap `this` in a Proxy that forwards each property access to an operation
   * call. The target is an empty object (not `this`) so unknown property
   * accesses do not collide with class members; programmatic callers can still
   * use the `SemanticConnectorClient` instance's `invoke()` method directly
   * before wrapping.
   *
   * The operation call selects the transport: when the connector package
   * registered an `invoke` middleware for the operation, it is called as
   * `middleware(ctx, standaloneTransport)` so it can short-circuit or delegate
   * to the default transport via `next`. Otherwise the default standalone
   * transport runs directly. Either way, a registered `decodeBinary` hook is
   * applied to whatever the transport returns.
   */
  private createProxy(): this {
    return new Proxy(Object.create(null), {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        // Short-circuit promise-protocol keys so `await client.connectors.x`
        // does not accidentally fire a POST with operation: 'then'.
        if (THENABLE_KEYS.has(prop)) return undefined;
        // Keep `invoke` callable on the proxy itself for programmatic use
        // and tests; everything else is treated as an operation name.
        if (prop === 'invoke') return this.invoke.bind(this);
        return async (input?: unknown, options?: InvokeOptions) => {
          const ctx = this.buildContext(prop, input, options);
          const middleware = this.runtime?.operations?.[prop]?.invoke;
          // Delegate the whole call to the middleware when one is registered,
          // handing it the default standalone transport as `next`. With no
          // middleware, hit the standalone transport directly — byte-for-byte
          // the same request as before this extension point existed.
          const result = middleware
            ? await middleware(ctx, this.standaloneTransport)
            : await this.standaloneTransport(ctx);
          // When the transport returned a binary stream and the connector
          // package registered a decoder for this operation, decode it into
          // the typed output shape. Otherwise (JSON responses, or no decoder)
          // pass the payload through untouched so JSON operations keep working.
          const decode = this.runtime?.operations?.[prop]?.decodeBinary;
          if (decode) {
            const buffer = asArrayBuffer(result);
            if (buffer !== undefined) {
              return decode(buffer);
            }
          }
          return result;
        };
      },
      has: (_target, prop) =>
        typeof prop === 'string' && !THENABLE_KEYS.has(prop),
    }) as this;
  }
}
