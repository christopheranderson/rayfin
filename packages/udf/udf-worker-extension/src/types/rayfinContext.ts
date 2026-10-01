import type { HttpRequest } from '@azure/functions';
import { RayfinServerClient } from '@microsoft/rayfin-client';

import {
  UserDataFunctionInternalError,
  UserDataFunctionInvalidInputError,
} from '../errors/udfErrors.js';

import { AudienceType } from './connection.js';
import type { RegisteredSecretNames } from './secretsRegistry.js';

/** Header name containing Rayfin connection info. */
const RAYFIN_INFO_HEADER = 'x-ms-rayfin-info';
/** Header name containing per-invocation secret values. */
const RAYFIN_SECRETS_HEADER = 'x-ms-rayfin-secrets';

/** Secrets payload shape from the `x-ms-rayfin-secrets` header. */
type RayfinSecrets = Record<string, string>;

/** Shape of the JSON inside the `x-ms-rayfin-info` header. */
export interface RayfinInfo {
  rayfinToken: string;
  publishableKey: string;
  rayFinEndpoint: string;
}

/**
 * Thin wrapper around {@link RayfinServerClient}. Reads auth from the
 * `x-ms-rayfin-info` header (prod) or `RAYFIN_*` env vars (local debug).
 *
 * `TokenTypes` is the union of audiences this context may request a token for.
 * It defaults to `never`, so a handler that declares no generic connections
 * cannot call {@link getToken} at all — the mistake is caught at compile time
 * instead of throwing on invoke.
 *
 * ```ts
 * udf.func("listTodos", async (ctx: RayfinContext<TodoAppSchema>) => {
 *   return await ctx.getDataClient().Todo.select(["id", "title"]).execute();
 * }, []);
 *
 * udf.func("syncData", async (ctx: RayfinContext<TodoAppSchema, AudienceType.Fabric>) => {
 *   const fabricToken = ctx.Tokens.Fabric;
 * }, []);
 * ```
 */
export class RayfinContext<
  TSchema extends Record<string, any> = Record<string, any>,
  TokenTypes extends AudienceType = never,
  TSecretNames extends string = RegisteredSecretNames,
> {
  /**
   * Phantom field — `declare` means it is erased entirely and never exists at
   * runtime. It is here purely to make `TokenTypes` *contravariant*.
   *
   * Without it, `getToken` is the only member mentioning `TokenTypes`, and
   * method parameters are compared bivariantly even under `strictFunctionTypes`.
   * That would make `RayfinContext<S, never>` assignable to
   * `RayfinContext<S, AudienceType.Sql>`, so a handler annotated with audiences
   * it never declared would type-check and then fail at invoke time. A
   * function-typed *property* is checked contravariantly, which closes that gap.
   */
  declare readonly __audienceVariance?: (audiences: TokenTypes) => void;

  public readonly baseUrl: string;
  public readonly accessToken: string;
  public readonly publishableKey: string;
  /**
   * Generic OBO tokens for this invocation, keyed by audience.
   *
   * Narrowed to the audiences declared on this function's context annotation,
   * so reading an undeclared audience is a compile error:
   *
   * ```ts
   * async (ctx: RayfinContext<DataModel, AudienceType.Sql>) => {
   *   ctx.Tokens.AzureAI;   // compile error — not declared
   *   const token: string = ctx.Tokens.Sql;
   * }
   * ```
   *
   * Values are typed `string`, not `string | undefined`, because declaring an
   * audience is what causes its binding to be registered. A declared audience
   * can still fail to mint at runtime; rather than let the type lie, those
   * entries are installed as accessors that throw the same diagnosable error
   * {@link getToken} does. See {@link buildTokenView}.
   */
  public readonly Tokens: Readonly<Record<TokenTypes, string>>;
  /**
   * Secret values for this invocation, keyed by the names declared in
   * `rayfin.yml`:
   *
   * ```ts
   * async (ctx: RayfinContext<TodoAppSchema>) => {
   *   ctx.Secrets.NOT_DECLARED;   // compile error
   *   return ctx.Secrets.API_KEY; // string
   * }
   * ```
   *
   * The names come from `RayfinSecretRegistry`, which the CLI's generated
   * `secrets.generated.ts` augments — so this is typed without any change to
   * the function's declaration or to the data schema. Override the third type
   * parameter to narrow a single function to a subset.
   *
   * Typed `string` rather than `string | undefined`, for the same reason as
   * {@link Tokens}: the name was declared, so the value is modelled as
   * present. Reading a declared secret that was not supplied throws a
   * diagnosable error rather than yielding `undefined` from a `string`-typed
   * property.
   *
   * Resolution matches {@link getSecret} exactly — the `x-ms-rayfin-secrets`
   * header first, then `process.env` — so secrets injected as environment
   * variables during local development work identically.
   */
  public readonly Secrets: Readonly<Record<TSecretNames, string>>;
  /** Raw token values, used for lookups that must not trigger the accessors. */
  private readonly tokenValues: Record<string, string>;
  private readonly secrets: RayfinSecrets;
  private readonly client: RayfinServerClient<TSchema>;

  /**
   * @param declaredAudiences - Audiences the function declared, whether or not
   *   the host produced a token for each. Defaults to the audiences actually
   *   present, which is the right behaviour when a context is constructed
   *   directly (tests, local tooling) rather than from a request.
   */
  constructor(
    info: RayfinInfo,
    tokens: Record<string, string> = {},
    secrets: RayfinSecrets = {},
    declaredAudiences: readonly string[] = Object.keys(tokens)
  ) {
    // The platform-provided rayFinEndpoint may include a trailing `/graphql`
    // path segment. The SDK's GraphQLClient appends `/graphql` itself, so we
    // remove it here
    const baseUrl = info.rayFinEndpoint.replace(/\/graphql\/?$/i, '');
    this.baseUrl = baseUrl;
    this.accessToken = info.rayfinToken;
    this.publishableKey = info.publishableKey;
    this.secrets = { ...secrets };
    this.Secrets = RayfinContext.buildSecretsView(this.secrets) as Readonly<
      Record<TSecretNames, string>
    >;
    this.tokenValues = { ...tokens };
    this.Tokens = RayfinContext.buildTokenView(
      this.tokenValues,
      declaredAudiences
    ) as Readonly<Record<TokenTypes, string>>;
    const tokenAudiences = Object.keys(this.Tokens);
    console.log(
      `[RayfinContext] Initialized: rayfinTokenPresent=${Boolean(this.accessToken)}, genericTokenCount=${tokenAudiences.length}, genericTokenAudiences=${tokenAudiences.join(',') || '(none)'}`
    );
    this.client = new RayfinServerClient<TSchema>({
      baseUrl,
      publishableKey: info.publishableKey,
      // Function form so the SDK re-reads the token per request.
      accessToken: () => info.rayfinToken || null,
    });
  }

  /**
   * Property names the JavaScript runtime probes on arbitrary objects.
   *
   * These must never be treated as secret lookups. `JSON.stringify` probes
   * `toJSON`, and — more dangerously — resolving a promise probes `then`, so
   * returning or awaiting the secrets object would throw if these were
   * intercepted. Anything on `Object.prototype` is covered separately.
   */
  private static readonly SECRET_PASSTHROUGH_PROPERTIES: ReadonlySet<string> =
    new Set(['then', 'toJSON', 'inspect', 'constructor']);

  /**
   * Build the object behind {@link Secrets}.
   *
   * A plain object cannot work here: `getSecret` falls back to `process.env`,
   * which is how secrets are supplied during local development, and those names
   * are not known when the context is constructed. A proxy resolves each read
   * through the same header-then-environment path instead of snapshotting only
   * the header.
   *
   * Reads that are not secret lookups — symbols, `Object.prototype` members and
   * runtime protocol probes — are delegated untouched, so logging, awaiting or
   * serialising the object cannot throw.
   */
  private static buildSecretsView(
    secrets: RayfinSecrets
  ): Readonly<Record<string, string>> {
    const target = Object.freeze({ ...secrets }) as Record<string, string>;

    const isPassthrough = (property: string): boolean =>
      RayfinContext.SECRET_PASSTHROUGH_PROPERTIES.has(property) ||
      property in Object.prototype;

    return new Proxy(target, {
      get(proxyTarget, property, receiver) {
        if (typeof property !== 'string') {
          return Reflect.get(proxyTarget, property, receiver);
        }
        if (
          !Object.prototype.hasOwnProperty.call(proxyTarget, property) &&
          isPassthrough(property)
        ) {
          return Reflect.get(proxyTarget, property, receiver);
        }
        // `??` rather than `||`: an empty-string secret is a real value and
        // must not fall through to the environment. Matches getSecret.
        const value = proxyTarget[property] ?? process.env[property];
        if (value === undefined) {
          console.log(
            `[RayfinContext][Error] Missing secret '${property}'. availableSecrets=${Object.keys(proxyTarget).join(',') || '(none)'}`
          );
          throw new UserDataFunctionInvalidInputError(
            `No value available for secret '${property}'. Ensure it is declared in rayfin.yml and set with 'rayfin secret set'.`
          );
        }
        return value;
      },
      has(proxyTarget, property) {
        if (typeof property !== 'string') {
          return Reflect.has(proxyTarget, property);
        }
        return property in proxyTarget || process.env[property] !== undefined;
      },
    });
  }

  /** Shared wording so property access and {@link getToken} fail identically. */
  private static missingTokenMessage(
    audienceType: string,
    availableAudiences: string[]
  ): string {
    console.log(
      `[RayfinContext][Error] Missing generic token for audience='${audienceType}'. availableAudiences=${availableAudiences.join(',') || '(none)'}`
    );
    return `No token available for audience '${audienceType}'. Ensure a connection with this audience type is declared.`;
  }

  /**
   * Build the object behind {@link Tokens}.
   *
   * - **Minted** audiences become ordinary enumerable data properties, so
   *   `Object.keys`, spreading and `JSON.stringify` behave normally and report
   *   exactly the tokens that exist.
   * - **Declared but unminted** audiences become non-enumerable throwing
   *   accessors. Non-enumerable matters: a token that did not mint is not
   *   "present", so it must not appear in `Object.keys`, and inspecting or
   *   serialising the object must not detonate. Only a direct read throws —
   *   which is precisely the read that would otherwise hand back `undefined`
   *   from a `string`-typed property.
   */
  private static buildTokenView(
    tokens: Record<string, string>,
    declaredAudiences: readonly string[]
  ): Readonly<Record<string, string>> {
    const view: Record<string, string> = {};

    for (const [audienceType, token] of Object.entries(tokens)) {
      Object.defineProperty(view, audienceType, {
        value: token,
        enumerable: true,
        writable: false,
      });
    }

    for (const audienceType of declaredAudiences) {
      if (Object.prototype.hasOwnProperty.call(view, audienceType)) continue;
      Object.defineProperty(view, audienceType, {
        enumerable: false,
        get: () => {
          throw new UserDataFunctionInvalidInputError(
            RayfinContext.missingTokenMessage(audienceType, Object.keys(tokens))
          );
        },
      });
    }

    return Object.freeze(view);
  }

  /**
   * Retrieve the access token for a generic connection by audience type.
   *
   * Superseded by the `Tokens` property, which is bounded by the same audience
   * union, returns the same `string`, and throws the same error when a declared
   * audience produced no token:
   *
   * ```ts
   * const token = ctx.getToken(AudienceType.Sql); // before
   * const token = ctx.Tokens.Sql;                 // after
   * ```
   *
   * Tokens are resolved by the host extension from either:
   * - Production: OBO-exchanged tokens delivered via the binding pipeline
   * - Local dev: tokens acquired by the host extension's LocalTokenProvider
   *
   * @throws Throws `UserDataFunctionInvalidInputError` if no token is available for the audience.
   * @deprecated Use `ctx.Tokens.<Audience>` instead, e.g. `ctx.Tokens.Sql`.
   */
  getToken(audienceType: TokenTypes): string {
    const token = this.tokenValues[audienceType as string];
    if (!token) {
      throw new UserDataFunctionInvalidInputError(
        RayfinContext.missingTokenMessage(
          audienceType as string,
          Object.keys(this.tokenValues)
        )
      );
    }
    return token;
  }

  /**
   * Parse raw FabricItem binding results into a token map.
   *
   * Each binding result is the JSON returned by the host extension:
   *
   * ```json
   * {
   *   "Endpoints": {
   *     "<key>": {
   *       "AccessToken": "..."
   *     }
   *   }
   * }
   * ```
   *
   * Currently keys by audienceType; will extend to support named and alias
   * connections in the future.
   */
  private static parseTokens(
    bindings: Array<{ audienceType: string; data: unknown }>
  ): Record<string, string> {
    const tokens: Record<string, string> = {};
    let populatedCount = 0;
    for (const { audienceType, data } of bindings) {
      if (!data) continue;
      try {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
        const endpoints = parsed?.Endpoints ?? parsed?.endpoints;
        if (endpoints) {
          const endpoint = endpoints[audienceType];
          if (endpoint?.AccessToken || endpoint?.accessToken) {
            tokens[audienceType] = endpoint.AccessToken ?? endpoint.accessToken;
            populatedCount++;
          }
        }
      } catch {
        console.log(
          `[RayfinContext][Error] Failed to parse binding token payload for audience='${audienceType}'.`
        );
      }
    }
    const tokenAudiences = Object.keys(tokens);
    console.log(
      `[RayfinContext] Parsed generic tokens: bindings=${bindings.length}, populated=${populatedCount}, tokenCount=${tokenAudiences.length}, tokenAudiences=${tokenAudiences.join(',') || '(none)'}`
    );
    return tokens;
  }

  /**
   * Build a `RayfinContext` for the current invocation.
   * - Prod: everything (incl. token) from the `x-ms-rayfin-info` header.
   * - Dev:  endpoint + publishable key from `RAYFIN_*` env vars; token from
   *        the `Authorization` bearer, falling back to `RAYFIN_ACCESS_TOKEN`.
   *
   * @param genericBindings - Raw binding results from `context.extraInputs`
   *   for each registered generic connection. Each entry pairs an audienceType
   *   with the raw data returned by the host extension. Token parsing is handled
   *   internally.
   */
  static fromRequest<
    T extends Record<string, any> = Record<string, any>,
    K extends AudienceType = AudienceType,
  >(
    request: HttpRequest,
    genericBindings: Array<{ audienceType: string; data: unknown }> = []
  ): RayfinContext<T, K> {
    const isDev = process.env.AZURE_FUNCTIONS_ENVIRONMENT === 'Development';

    let rayFinEndpoint = '';
    let publishableKey = '';
    let rayfinToken = '';

    if (isDev) {
      rayFinEndpoint = process.env.RAYFIN_API_URL || '';
      publishableKey = process.env.RAYFIN_PUBLISHABLE_KEY || '';

      // Dev: bearer from Authorization wins, env var is the fallback.
      const authHeader = request.headers.get('authorization') || '';
      const bearer = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : '';
      rayfinToken = bearer || process.env.RAYFIN_ACCESS_TOKEN || '';
    } else {
      const raw = request.headers.get(RAYFIN_INFO_HEADER);
      if (!raw) {
        throw new UserDataFunctionInternalError(
          `Missing required header '${RAYFIN_INFO_HEADER}'.`
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new UserDataFunctionInternalError(
          `Header '${RAYFIN_INFO_HEADER}' contains invalid JSON.`
        );
      }
      if (!parsed || typeof parsed !== 'object') {
        throw new UserDataFunctionInternalError(
          `Header '${RAYFIN_INFO_HEADER}' contains invalid JSON.`
        );
      }
      const info = parsed as Partial<RayfinInfo>;
      rayFinEndpoint = info.rayFinEndpoint || '';
      publishableKey = info.publishableKey || '';
      rayfinToken = info.rayfinToken || '';
    }

    if (!rayFinEndpoint) {
      throw new UserDataFunctionInternalError(
        isDev
          ? 'Missing RAYFIN_API_URL env var (local.settings.json).'
          : `Missing 'rayFinEndpoint' in '${RAYFIN_INFO_HEADER}' header.`
      );
    }
    if (!publishableKey) {
      throw new UserDataFunctionInternalError(
        isDev
          ? 'Missing RAYFIN_PUBLISHABLE_KEY env var (local.settings.json).'
          : `Missing 'publishableKey' in '${RAYFIN_INFO_HEADER}' header.`
      );
    }

    const secrets = RayfinContext.parseSecretsHeader(request);
    const tokens = RayfinContext.parseTokens(genericBindings);
    if (isDev) {
      // Fill tokens not provided by host bindings from CLI-injected env vars.
      // Ideally when the host extension is updated, we don't need to do this
      const ENV_TOKEN_MAP: Record<string, string> = {
        Storage: 'RAYFIN_DELEGATED_STORAGE_TOKEN',
        Sql: 'RAYFIN_DELEGATED_SQL_TOKEN',
        AI: 'RAYFIN_DELEGATED_AI_TOKEN',
      };
      for (const [audience, envVar] of Object.entries(ENV_TOKEN_MAP)) {
        if (!tokens[audience] && process.env[envVar]) {
          tokens[audience] = process.env[envVar]!;
          console.log(
            `[RayfinContext] Using CLI-provided delegated token for audience='${audience}' (env: ${envVar})`
          );
        }
      }
    }

    return new RayfinContext<T, K>(
      { rayfinToken, publishableKey, rayFinEndpoint },
      tokens,
      secrets,
      // Every binding the function declared, including any the host could not
      // mint — those become throwing accessors rather than silent `undefined`.
      genericBindings.map((binding) => binding.audienceType)
    );
  }

  private static parseSecretsHeader(request: HttpRequest): RayfinSecrets {
    const raw = request.headers.get(RAYFIN_SECRETS_HEADER);
    if (!raw) {
      return {};
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new UserDataFunctionInternalError(
        `Header '${RAYFIN_SECRETS_HEADER}' contains invalid JSON.`
      );
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new UserDataFunctionInternalError(
        `Header '${RAYFIN_SECRETS_HEADER}' must be a JSON object mapping secret names to string values.`
      );
    }

    const parsedSecrets: RayfinSecrets = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') {
        throw new UserDataFunctionInternalError(
          `Header '${RAYFIN_SECRETS_HEADER}' contains a non-string value for secret '${key}'.`
        );
      }
      parsedSecrets[key] = value;
    }

    return parsedSecrets;
  }

  /**
   * Returns a per-invocation secret value from the `x-ms-rayfin-secrets`
   * header, falling back to `process.env`.
   *
   * Superseded by the `Secrets` property, which is typed from the secrets
   * declared in `rayfin.yml`: a name that was never declared is a compile
   * error, and the value is `string` rather than `string | undefined`.
   *
   * ```ts
   * const key = ctx.getSecret('API_KEY') ?? ''; // before
   * const key = ctx.Secrets.API_KEY;            // after
   * ```
   *
   * Still valid for a secret deliberately not modelled in `rayfin.yml`;
   * suppress the deprecation locally in that case.
   *
   * @deprecated Use `ctx.Secrets.<NAME>` instead, e.g. `ctx.Secrets.API_KEY`.
   */
  getSecret(secretName: string): string | undefined {
    return this.secrets[secretName] ?? process.env[secretName];
  }

  /** Returns the SDK's typed entity API, e.g. `getDataClient().Todo.select([...]).execute()`. */
  getDataClient(): RayfinServerClient<TSchema>['data'] {
    return this.client.data;
  }
}
