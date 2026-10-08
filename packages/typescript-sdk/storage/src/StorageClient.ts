import type { ApiClient as ApiClientType } from '@microsoft/rayfin-lib';
import { ApiClient, ServicePlugin } from '@microsoft/rayfin-lib';

import {
  StorageFolderClient,
  type StorageCustomFields,
  type StorageObjectRef,
} from './StorageFolderClient';
import { normalizeContainerName } from './naming';

/**
 * Maps each storage folder name to the `@blob` class declared for it.
 *
 * The universal {@link StorageObjectRef} envelope (`id`, `path`, `size`,
 * `contentType`, `etag`, ...) is added automatically by the client types, so
 * builders write `{ ProfileImage: ProfileImage }` - never
 * `{ ProfileImage: StorageObjectRef & ProfileImage }`. Custom metadata fields
 * are derived from the blob class and are optional on each returned object.
 * This mirrors the data schema shape (`{ Todo: Todo }`) and keeps large schemas
 * free of repeated envelope boilerplate.
 */
export type StorageSchema = Record<string, object>;

/**
 * StorageApi provides a typed, proxy-based access pattern for storage locations
 * mirroring the DataApi entity access patterns (rest/gql) for consistency.
 * Storage locations are accessed directly as properties: storage.albumcover.upload()
 */
export class StorageApi<
  TSchema extends StorageSchema = StorageSchema,
> extends ServicePlugin {
  private folderCache = new Map<string, StorageFolderClient<any>>();

  constructor(apiClient: ApiClientType) {
    super(apiClient as ApiClient);
  }

  /** Get (and cache) a strongly typed folder client. */
  getFolderClient<K extends keyof TSchema & string>(
    folderName: K
  ): StorageFolderClient<
    StorageObjectRef & Partial<StorageCustomFields<TSchema[K]>>
  > {
    // Normalize folder name to align with server/CLI container naming rules
    const key = normalizeContainerName(String(folderName));
    if (!this.folderCache.has(key)) {
      this.folderCache.set(key, new StorageFolderClient(this.apiClient, key));
    }
    return this.folderCache.get(key)! as StorageFolderClient<
      StorageObjectRef & Partial<StorageCustomFields<TSchema[K]>>
    >;
  }

  /** Returns names of instantiated folder clients (for diagnostics / introspection). */
  getInstantiatedFolderNames(): (keyof TSchema)[] {
    return Array.from(this.folderCache.keys()) as (keyof TSchema)[];
  }
}

export type StorageClient<TSchema extends StorageSchema> = {
  [K in keyof TSchema]: StorageFolderClient<
    StorageObjectRef & Partial<StorageCustomFields<TSchema[K]>>
  >;
} & StorageApi<TSchema>;

/**
 * Create a StorageApi with direct access to storage locations.
 * This factory function returns a proxied instance that provides direct property access.
 */
export function createStorageClient<
  TSchema extends StorageSchema = StorageSchema,
>(apiClient: ApiClientType): StorageClient<TSchema> {
  const instance = new StorageApi<TSchema>(apiClient);

  return new Proxy(instance, {
    get(target, prop) {
      // Handle existing methods/properties
      if (prop in target || typeof prop === 'symbol') {
        return target[prop as keyof StorageApi<TSchema>];
      }

      // Handle direct storage location access
      if (typeof prop === 'string') {
        return target.getFolderClient(prop as keyof TSchema & string);
      }

      return undefined;
    },

    ownKeys(target) {
      // Return all cached storage location names for Object.keys() etc.
      return target.getInstantiatedFolderNames() as string[];
    },

    has(target, prop) {
      // Always return true for string properties (storage location names)
      return typeof prop === 'string' || prop in target;
    },

    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'string') {
        return {
          enumerable: true,
          configurable: true,
          value: target.getFolderClient(prop as keyof TSchema & string),
        };
      }
      return Object.getOwnPropertyDescriptor(target, prop);
    },
  }) as StorageClient<TSchema>;
}
