/**
 * NEGATIVE CASE: sourceFields on a DATA-PATH relationship.
 *
 * `sourceFields` / `targetFields` are connector-only custom-FK options. On the
 * data path a relationship always references the target entity's `id`, so these
 * options must NOT be accepted.
 *
 * This file MUST FAIL to compile: the `@one`/`@many` overloads only offer the
 * custom-FK options when the relationship target carries the `RayfinPrimaryKey`
 * brand (i.e. extends `Source(...)`). `Region` is a plain data-path entity, so
 * the call resolves to the data-path overload (options typed
 * `DataPathRelationshipOptions`, where `sourceFields`/`targetFields` are
 * `never`) and fails with `TS2769` (no overload matches this call). Wired into
 * `type-safety-runner.test.ts`, which asserts the compiler output names `CustomKeyEntityClass` — the branded entity kind the connector overload requires, so a case that fails for an unrelated reason cannot pass.
 */

import { entity, uuid, int, one } from '@microsoft/rayfin-core';

@entity()
class Region {
  @uuid()
  id!: string;
}

@entity()
class DataOrder {
  @uuid()
  id!: string;

  @int()
  regionId!: number;

  // ❌ Should cause a TypeScript compilation error: `sourceFields` is
  // connector-only, and `Region` is a plain data-path entity.
  @one(() => Region, { sourceFields: ['regionId'] })
  region!: Region;
}

export {};
