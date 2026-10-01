/**
 * NEGATIVE CASE: sourceFields on a DATA-PATH relationship, passed via a
 * VARIABLE (not a fresh inline object literal).
 *
 * The fresh-literal cases are rejected by TypeScript's excess-property check.
 * That check does NOT fire when the options object comes from a variable (or a
 * spread) — assignability then falls back to structural compatibility. The
 * fallback `@one`/`@many` overloads therefore constrain the custom-FK keys to
 * `never`, so the rejection holds regardless of how the object is passed.
 *
 * This file MUST FAIL to compile: `Region` is a plain data-path entity, so the
 * call resolves to the data-path overload (options typed
 * `DataPathRelationshipOptions`, where `sourceFields`/`targetFields` are
 * `never`). The variable carries `sourceFields`, so it fails with `TS2769` (no overload matches this call). Wired into
 * `type-safety-runner.test.ts`, which asserts the compiler output names `CustomKeyEntityClass` — the branded entity kind the connector overload requires, so a case that fails for an unrelated reason cannot pass.
 */

import { entity, uuid, int, one } from '@microsoft/rayfin-core';

@entity()
class Region {
  @uuid()
  id!: string;
}

// A non-fresh options object: excess-property checking will NOT apply when this
// is passed to the decorator, so only the fallback overload's `never` constraint
// can reject the connector-only `sourceFields`.
const dataPathRelationshipOptions = {
  optional: true,
  sourceFields: ['regionId'],
};

@entity()
class DataOrder {
  @uuid()
  id!: string;

  @int()
  regionId!: number;

  // ❌ The custom-FK option is passed via a variable, so excess-property
  // checking does not apply — the `never` constraint on the fallback overload
  // must still reject it.
  @one(() => Region, dataPathRelationshipOptions)
  region!: Region;
}

export {};
