/**
 * NEGATIVE CASE: targetFields on a DATA-PATH relationship.
 *
 * `targetFields` lets a relationship reference a non-`id` column on the target.
 * The data-path DDL generator hardwires the referenced column to the target's
 * primary key (`id`), so this option must NOT be accepted on the data path.
 *
 * This file MUST FAIL to compile: the `@one`/`@many` overloads only offer the
 * custom-FK options when the target carries the `RayfinPrimaryKey` brand (i.e.
 * extends `Source(...)`). For a plain data-path target the call resolves to the
 * data-path overload (options typed `DataPathRelationshipOptions`, where
 * `sourceFields`/`targetFields` are `never`) and fails with `TS2769` (no overload matches this call). Wired into
 * `type-safety-runner.test.ts`, which asserts the compiler output names `CustomKeyEntityClass` — the branded entity kind the connector overload requires, so a case that fails for an unrelated reason cannot pass.
 */

import { entity, uuid, one } from '@microsoft/rayfin-core';

@entity()
class Region {
  @uuid()
  id!: string;

  @uuid()
  code!: string;
}

@entity()
class DataOrder {
  @uuid()
  id!: string;

  // ❌ Should cause a TypeScript compilation error: `targetFields` is
  // connector-only, and `Region` is a plain data-path entity.
  @one(() => Region, { targetFields: ['code'] })
  region!: Region;
}

export {};
