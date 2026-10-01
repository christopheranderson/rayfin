/**
 * Helpers and constants for the `@blob` folder content constraints
 * (`maxSize`, `allowedContentTypes`).
 *
 * These exist so builders pick values from editor autocomplete instead of
 * hand-typing strings, eliminating a class of typos the build-time validator
 * would otherwise have to catch. The size helpers return a plain byte count
 * (a `number`), so they are fully type-checked with no string parsing.
 *
 * @experimental Part of the preview storage surface; may change before GA
 * (see https://github.com/microsoft/project-rayfin/issues/1523).
 */

import type { MimeGlob } from './options.js';

/** Bytes, unchanged. `bytes(1024) === 1024`. */
export const bytes = (n: number): number => n;

/** Kibibytes → bytes. `kb(2) === 2048`. */
export const kb = (n: number): number => Math.round(n * 1024);

/** Mebibytes → bytes. `mb(2) === 2097152`. */
export const mb = (n: number): number => Math.round(n * 1024 * 1024);

/** Gibibytes → bytes. `gb(1) === 1073741824`. */
export const gb = (n: number): number => Math.round(n * 1024 * 1024 * 1024);

/**
 * Common content types for `@blob({ allowedContentTypes })`. Use these for
 * discoverability and typo-safety; pass a raw {@link MimeGlob} string for any
 * type not listed here.
 */
export const ContentTypes = {
  AnyImage: 'image/*',
  AnyVideo: 'video/*',
  AnyAudio: 'audio/*',
  AnyText: 'text/*',
  Png: 'image/png',
  Jpeg: 'image/jpeg',
  Webp: 'image/webp',
  Gif: 'image/gif',
  Svg: 'image/svg+xml',
  Pdf: 'application/pdf',
  Json: 'application/json',
  Csv: 'text/csv',
  Zip: 'application/zip',
} as const satisfies Record<string, MimeGlob>;
