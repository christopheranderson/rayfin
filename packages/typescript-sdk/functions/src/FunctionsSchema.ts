/**
 * Maps function names to their input/output type pairs.
 *
 * Users define a concrete schema type in their
 * `rayfin/functions/src/types.ts` file, then pass it as the second type
 * parameter of `RayfinClient` so that `client.functions.<name>.invoke()`
 * calls are fully type-checked.
 *
 * Use an object type for named params, or `void` for no params.
 *
 * @example
 * ```typescript
 * export type MyFunctionsSchema = {
 *   helloWorld: { input: { firstName: string; lastName: string }; output: string };
 *   add: { input: { a: number; b: number }; output: number };
 *   noParams: { input: void; output: string };  // use void or {} for no-input functions
 * };
 * ```
 */
export type FunctionsSchema = Record<string, { input: any; output: any }>;
