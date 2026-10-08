import { role } from '@microsoft/rayfin-core';
import { blob } from '@microsoft/rayfin-core/experimental';

/** Todo exports available to authenticated users. */
@blob({ name: 'shared-exports' })
@role('authenticated', ['create', 'read', 'update', 'delete'])
export class SharedExport {}
