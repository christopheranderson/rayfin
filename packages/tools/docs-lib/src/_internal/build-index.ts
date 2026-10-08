/**
 * Internal subpath export for build tooling that needs the lower-level
 * docs index primitives (loader + index-builder + serializer) — for
 * example, build-time compatibility tooling that emits a static search
 * index from package docs.
 *
 * Not part of the public API. Subject to change between minor versions.
 * Library consumers should use `DocsService` from the package root.
 */
export { loadDocs } from '../loader.js';
export {
  createDocsIndex,
  serializeDocsIndex,
  DOCS_INDEX_SCHEMA_VERSION,
  DOCS_SEARCH_CONFIG_FINGERPRINT,
} from '../search.js';
export { DOCS_DEFAULT_MODULES } from '../index.js';
export type { DocModule } from '../types.js';
