import { role, text } from '@microsoft/rayfin-core';
import { blob, StorageObject } from '@microsoft/rayfin-core/experimental';

/**
 * Team documents with writes scoped by a policy that references the intrinsic
 * `owner_id` (available because the class extends `StorageObject`, emitting a
 * `check` AST). `overwrite` is allowed because the role grants all actions
 * (satisfying the update requirement).
 */
@blob({ name: 'team-documents', onConflict: 'overwrite' })
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.owner_id),
})
export class TeamDocument extends StorageObject {
  @text() team_id!: string;
}
