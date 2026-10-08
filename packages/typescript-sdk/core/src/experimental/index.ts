/**
 * Experimental / preview surface of `@microsoft/rayfin-core`.
 *
 * Symbols re-exported from this entry point are not yet part of the stable
 * public API. They may change behavior, signatures, or be removed without
 * a major-version bump.
 */
export { blob } from '../decorators/experimental.js';

// Storage (experimental) — base class and constraint helpers.
export { StorageObject } from '../storage-object.js';
export { bytes, kb, mb, gb, ContentTypes } from '../storage-constraints.js';
export type { BlobFolderOptions, ByteSize, MimeGlob } from '../options.js';
