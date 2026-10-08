export enum AudienceType {
  Sql = 'Sql',
  Storage = 'Storage',
  Fabric = 'Fabric',
  AzureAI = 'AzureAI',
  ADO = 'ADO',
}

export interface AliasConnectionOptions {
  alias: string;
  argName?: string;
}

export interface GenericConnectionOptions<TokenType extends AudienceType> {
  audienceType: TokenType;
}

export type ConnectionOptions<TokenType extends AudienceType> =
  | AliasConnectionOptions
  | GenericConnectionOptions<TokenType>;

/**
 * A declared connection.
 *
 * `TokenType` is a phantom type parameter: it carries the declared audience at
 * the type level so `func()` can compute which audiences a handler's
 * `RayfinContext` is allowed to request. It defaults to `never` so that alias
 * connections — which grant no generic audience token — contribute no audiences.
 */
export class Connection<TokenType extends AudienceType = never> {
  public readonly alias?: string;
  public readonly argName?: string;
  public readonly audienceType?: TokenType;

  constructor(options: ConnectionOptions<TokenType>) {
    if ('alias' in options) {
      this.alias = options.alias;
      this.argName = options.argName ?? options.alias;
    } else {
      this.audienceType = options.audienceType;
    }
  }

  get isGeneric(): boolean {
    return this.audienceType !== undefined;
  }
}

/** Any connection, regardless of the audience it declares. */
export type AnyConnection = Connection<AudienceType>;

/**
 * The union of audience types declared by an array of connections.
 *
 * Alias connections resolve to `Connection<never>` and so contribute nothing,
 * which is what lets `func()` reject `ctx.getToken(...)` on a handler whose
 * connections are alias-only.
 *
 * ```ts
 * type A = AudiencesOf<[Connection<AudienceType.Sql>, Connection<AudienceType.Fabric>]>;
 * //   ^? AudienceType.Sql | AudienceType.Fabric
 * ```
 */
export type AudiencesOf<TConnections> =
  TConnections extends readonly (infer E)[]
    ? E extends Connection<infer A>
      ? A
      : never
    : never;
