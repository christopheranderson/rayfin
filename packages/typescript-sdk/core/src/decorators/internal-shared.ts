/**
 * Internal helpers shared between the stable decorators and the experimental
 * ones. This module is deliberately absent from both the root barrel and the
 * package `exports` map, so nothing here widens the public API surface.
 */

import {
  RayfinEntity,
  RayfinEntityMarker,
  RayfinStorageFolder,
  type EntityMetadata,
  type StorageFolderMetadata,
} from '../schema.js';

export type RayfinDecoratorContext = DecoratorContext & {
  metadata?: DecoratorMetadataObject & {
    [RayfinEntity]?: EntityMetadata;
    [RayfinEntityMarker]?: boolean;
    [RayfinStorageFolder]?: StorageFolderMetadata;
  };
};

/** Shared by `@role()` in `decorators.ts` and by the experimental `@blob()`. */
export function getStorageFolderMetadataFromContext(
  context: RayfinDecoratorContext
) {
  if (context.metadata !== undefined) {
    if (!context.metadata[RayfinStorageFolder]) {
      context.metadata[RayfinStorageFolder] = {
        name: context.kind === 'class' ? context.name!.toString() : 'Unknown',
        folderName: context.kind === 'class' ? context.name!.toString() : '',
        onConflict: 'error',
        permissions: {},
        roles: [],
        fields: {},
      };
    }

    // Ensure name is set if we learned it later
    if (
      context.kind === 'class' &&
      context.metadata[RayfinStorageFolder]!.name === 'Unknown'
    ) {
      context.metadata[RayfinStorageFolder]!.name = context.name!.toString();
    }

    return context.metadata[RayfinStorageFolder] as StorageFolderMetadata;
  }

  throw new Error(
    'Decorator metadata is not supported in this environment. Ensure that the TypeScript compiler is configured to emit decorator metadata.'
  );
}
