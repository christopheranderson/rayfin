// Storage client exports
export { StorageFolderClient } from './StorageFolderClient';
export { StorageApi, createStorageClient } from './StorageClient';

// Type exports
export type {
  StorageError,
  StorageCustomFields,
  StorageObjectRef,
  StorageUploadResult,
  StorageDownloadResult,
  StorageDeleteResult,
  StorageListResult,
  UploadOptions,
  DownloadOptions,
  DeleteOptions,
  ListOptions,
} from './StorageFolderClient';

export type { StorageSchema, StorageClient } from './StorageClient';

// Error code exports
export {
  STORAGE_ERROR_CODES,
  isStorageError,
  type StorageErrorCode,
} from './storageErrorCodes';
