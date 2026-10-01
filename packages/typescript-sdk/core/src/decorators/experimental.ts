import type { BlobFolderOptions } from '../options.js';
import {
  EntityMetadata,
  RayfinEntity,
  RayfinEntityMarker,
  constructor,
  upsertPermissions,
} from '../schema.js';

import { getStorageFolderMetadataFromContext } from './internal-shared.js';

/**
 * Normalizes a raw folder name into a valid storage container name.
 * @internal
 */
function normalizeContainerName(input: string): string {
  let name = (input ?? '').toLowerCase();
  name = name.replace(/[^a-z0-9-]/g, '-');
  // Collapse consecutive hyphens to single hyphen (linear time complexity)
  name = name.replace(/-+/g, '-');

  // Trim leading/trailing hyphens using string methods to avoid ReDoS
  // vulnerability from polynomial regex patterns like /^-+/ and /-+$/
  let start = 0;
  while (start < name.length && name[start] === '-') {
    start++;
  }
  let end = name.length;
  while (end > start && name[end - 1] === '-') {
    end--;
  }
  name = name.slice(start, end);

  if (name.length === 0) {
    name = 'container';
  }

  if (name.length < 3) {
    name = name.padEnd(3, '0');
  }
  if (name.length > 63) {
    name = name.substring(0, 63);
  }

  // Trim trailing hyphens again after potential truncation (using string method)
  while (name.length > 0 && name[name.length - 1] === '-') {
    name = name.slice(0, -1);
  }
  if (name.length < 3) {
    name = (name + '000').substring(0, 3);
  }

  return name;
}

/**
 * Storage folder decorator for blob storage management.
 *
 * Marks a class as representing a storage folder configuration.
 * The decorator accepts either a folder name string or a
 * {@link BlobFolderOptions} object. Permissions are inferred from sibling
 * `@role()` decorators. `onConflict` defaults to `'error'`.
 *
 * Import from `@microsoft/rayfin-core/experimental` to opt into the preview
 * surface. Rayfin storage is not enabled in the Fabric service; this
 * decorator generates configuration that the platform does not yet honor.
 *
 * @param folderNameOrOptions - Optional folder name or full options object.
 * @example
 * ```typescript
 * import { blob } from '@microsoft/rayfin-core/experimental';
 *
 * @blob({
 *   name: 'uploads',
 *   onConflict: 'error',
 * })
 * @role('authenticated', '*')
 * export class FileModel {
 *   @uuid()
 *   id!: string;
 *
 *   @text()
 *   fileName!: string;
 * }
 * ```
 *
 * @alpha
 */
export function blob(folderNameOrOptions?: string | BlobFolderOptions) {
  const options: BlobFolderOptions =
    typeof folderNameOrOptions === 'string'
      ? { name: folderNameOrOptions }
      : (folderNameOrOptions ?? {});

  if (
    options.onConflict !== undefined &&
    options.onConflict !== 'error' &&
    options.onConflict !== 'overwrite'
  ) {
    throw new Error("@blob: onConflict must be 'error' or 'overwrite'");
  }

  if (
    options.maxSize !== undefined &&
    typeof options.maxSize !== 'number' &&
    typeof options.maxSize !== 'string'
  ) {
    throw new Error(
      '@blob: maxSize must be a number (bytes) or a size string like "2mb"'
    );
  }

  if (
    options.allowedContentTypes !== undefined &&
    !Array.isArray(options.allowedContentTypes)
  ) {
    throw new Error(
      '@blob: allowedContentTypes must be an array of MIME globs'
    );
  }

  return function <T extends constructor<unknown>>(
    _target: T,
    context: ClassDecoratorContext<T>
  ) {
    if (context.kind !== 'class') {
      throw new Error('@blob() decorator can only be applied to classes');
    }

    if (context.metadata?.[RayfinEntityMarker]) {
      throw new Error(
        '@entity() and @blob() decorators cannot be used on the same class'
      );
    }

    const storageConfig = getStorageFolderMetadataFromContext(context);
    storageConfig.name = context.name!.toString();
    storageConfig.folderName = normalizeContainerName(
      options.name || storageConfig.name
    );
    if (options.onConflict !== undefined) {
      storageConfig.onConflict = options.onConflict;
    }
    if (options.maxSize !== undefined) {
      storageConfig.maxSize = options.maxSize;
    }
    if (options.allowedContentTypes !== undefined) {
      storageConfig.allowedContentTypes = options.allowedContentTypes;
    }

    // If @role() ran earlier (common due to decorator application order),
    // permissions will have been recorded into the entity metadata store.
    // Copy them into storage metadata so storage analysis can read them.
    const entityMeta = context.metadata?.[RayfinEntity] as
      | EntityMetadata
      | undefined;
    if (entityMeta) {
      if (Object.keys(entityMeta.permissions || {}).length > 0) {
        storageConfig.permissions = upsertPermissions(
          storageConfig.permissions,
          entityMeta.permissions
        );
      }
      if (entityMeta.roles && entityMeta.roles.length > 0) {
        storageConfig.roles = entityMeta.roles;
      }
      if (entityMeta.fields && Object.keys(entityMeta.fields).length > 0) {
        storageConfig.fields = { ...entityMeta.fields };
      }
    }
  };
}
