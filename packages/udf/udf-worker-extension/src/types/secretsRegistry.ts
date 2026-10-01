/**
 * Typed access to an application's secrets.
 *
 * Secrets are declared once with `rayfin secret set`, recorded in `rayfin.yml`,
 * and are therefore a property of the *application* rather than of any one
 * function. They reach the type system through declaration merging: the CLI
 * generates a file that augments {@link RayfinSecretRegistry}, and
 * `RayfinContext`'s secret type parameter defaults to whatever is registered.
 *
 * The consequence is that **nothing about a function's declaration changes**:
 *
 * ```ts
 * // rayfin/functions/src/secrets.generated.ts — AUTO-GENERATED, imported by nothing
 * declare module '@microsoft/fabric-user-data-functions' {
 *   interface RayfinSecretRegistry {
 *     STRIPE_API_KEY: string;
 *   }
 * }
 * export {};
 *
 * // any function, annotation untouched
 * udf.func('charge', async (ctx: RayfinContext<TodoAppSchema>) => {
 *   ctx.Secrets.STRIPE_API_KEY; // string
 *   ctx.Secrets.NOT_DECLARED;   // compile error
 * });
 * ```
 *
 * The generated file only has to be part of the compilation — the functions
 * `tsconfig.json` already includes `src/**` — it never needs importing.
 *
 * Only names are modelled. Values are supplied per invocation and are never
 * written to disk.
 */

/**
 * Registry of the application's secret names.
 *
 * Deliberately empty. Each app's generated file merges one property per secret
 * into it; an app that has declared none leaves it empty, which makes
 * `ctx.Secrets` an empty object type and any property access a compile error.
 */
export interface RayfinSecretRegistry {}

/**
 * Secret names currently registered, or `never` when nothing has augmented
 * {@link RayfinSecretRegistry}.
 *
 * `Extract<..., string>` guards against a stray symbol or numeric key ever
 * being merged in, which would otherwise widen the `Record` key type.
 */
export type RegisteredSecretNames = Extract<keyof RayfinSecretRegistry, string>;
