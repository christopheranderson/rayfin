/**
 * Ambient module declaration for `lz4js`, which ships without bundled types.
 *
 * This is a global (non-module) script: it intentionally has no top-level
 * `import`/`export`, so the `declare module 'lz4js'` block provides ambient
 * typings for the otherwise-untyped package. A standalone `.d.ts` file cannot
 * be used here because `packages/**\/*.d.ts` is git-ignored as a build
 * artifact, so this `.ts` shim is committed instead.
 */

declare module 'lz4js' {
  /** Decompress an LZ4 block/frame buffer. */
  export function decompress(data: Uint8Array): Uint8Array;
  /** Compress a buffer using LZ4. */
  export function compress(data: Uint8Array): Uint8Array;
}
