/**
 * Spill oversized `connector invoke` results to a file.
 *
 * A DAX or KQL query has no upper bound on how much it returns, and the whole
 * payload used to be printed. That floods a terminal, and — since an agent
 * runs the CLI and reads its stdout — burns an agent's context window on a
 * result it cannot use. Past a size threshold the full payload is written to
 * disk and the envelope carries a pointer plus a small inline preview, so the
 * shape of the result is still visible without a second read.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Serialized payload size, in bytes, above which the result is written to a
 * file instead of being returned inline.
 *
 * Derived from a token budget rather than a byte intuition. Measured against
 * real connector output, JSON runs about 2.8 characters per token, and
 * numeric-dense table data as low as 1.8 — so 8 KB is roughly 3k–4.5k tokens,
 * a defensible cost for one probe result. Byte thresholds that "look small"
 * are badly misleading here: 256 KB of this data is 93k–144k tokens, which is
 * most of a context window.
 */
export const DEFAULT_MAX_INLINE_BYTES = 8 * 1024;

/** Elements retained per array when building the inline preview. */
export const PREVIEW_ARRAY_ITEMS = 20;

/**
 * Array caps to try, largest first, when the preferred preview does not fit.
 *
 * Without the step-down a modest threshold produces no preview at all: one
 * 20-row slice of a wide table is itself tens of KB. Losing the column names
 * *and* still having to open the file is the worst of both, so the preview
 * shrinks until something fits.
 */
const PREVIEW_ARRAY_STEPS = [PREVIEW_ARRAY_ITEMS, 10, 5, 2, 1] as const;

/**
 * Arrays this short are kept whole rather than sampled.
 *
 * Sampling every array alike silently corrupts metadata: a 24-entry column
 * list cut to 10 reports a partial schema with nothing marking it partial, and
 * a caller asking "what columns does this return?" gets a confident wrong
 * answer. Bulk data is long and worth sampling; a schema, a header, or one
 * row's worth of values is short and worth keeping.
 */
const PREVIEW_WHOLE_ARRAY_MAX = 50;

/** Characters retained per string when building the inline preview. */
const PREVIEW_STRING_CHARS = 2_000;

/** Retention for the default results directory, mirroring diagnostic logs. */
const MAX_RETAINED_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
const MAX_RETAINED_FILES = 20;

/**
 * Only files this module wrote are eligible for pruning, so a path the user
 * pointed `--output-file` at inside the results directory is never deleted.
 */
const RESULT_FILE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{6}\.\d{3}Z-[a-z0-9-]+-[0-9a-f]{8}\.json$/;

/** Outcome of deciding whether an invoke payload goes inline or to a file. */
export interface InvokeOutputPlacement {
  /** What belongs in the envelope's `output` — the preview when truncated. */
  output: unknown;
  /** Absolute path the full payload was written to, when one was written. */
  outputFile?: string;
  /** Serialized size of the full payload. */
  outputBytes?: number;
  /** `true` when `output` is a preview rather than the whole payload. */
  outputTruncated?: boolean;
  /**
   * Entries per array kept in the preview, or `0` when even a one-element
   * preview overflowed and `output` is `null`. Lets a caller say how much it
   * actually showed instead of quoting a constant.
   */
  previewItems?: number;
  /**
   * Why an automatic spill could not be written. Set only on the degraded
   * path, where the preview still protects the terminal but no file exists.
   */
  spillError?: string;
}

/**
 * Directory spilled results are written to, inside the project's existing
 * scratch area.
 *
 * `rayfin/.temp/` is already the CLI's ephemeral working directory (compiled
 * output, generated connectors, docker-compose, the runtime `.env`) and is
 * covered by `rayfin/.temp/` in the scaffolded `.gitignore`, so query results
 * — which are customer data — cannot be committed by a stray `git add`.
 * Keeping them in the project also means the path is workspace-relative for
 * an agent reading it back.
 */
function resultsDirFor(projectRoot: string): string {
  return join(projectRoot, 'rayfin', '.temp', 'invoke-results');
}

/** `2026-09-21T101500.123Z`, matching the diagnostic log naming scheme. */
function toFileTimestamp(date: Date): string {
  return date.toISOString().replace(/:/g, '');
}

function toSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug.length > 0 ? slug : 'connector';
}

/**
 * Serialize a payload, returning `undefined` when it has no JSON form.
 *
 * `undefined` payloads and (defensively) circular structures fall through to
 * being emitted inline unchanged, which is what happened before this module
 * existed.
 */
function serialize(payload: unknown): string | undefined {
  try {
    return JSON.stringify(payload);
  } catch {
    return undefined;
  }
}

/**
 * Shrink a payload to something an agent can read in one glance: long arrays
 * keep their first `arrayItems` entries and long strings are cut.
 *
 * Arrays of `wholeArrayMax` or fewer entries pass through intact, which is
 * what keeps a column list from being reported as shorter than it is. Passing
 * `0` disables that protection and samples every array — the last resort when
 * nothing else fits.
 *
 * Applied structurally rather than to a known result shape, so it degrades the
 * same way for a connector this CLI has never seen.
 */
function buildPreview(
  value: unknown,
  arrayItems: number,
  wholeArrayMax: number
): unknown {
  if (typeof value === 'string') {
    return value.length > PREVIEW_STRING_CHARS
      ? `${value.slice(0, PREVIEW_STRING_CHARS)}… [truncated]`
      : value;
  }

  if (Array.isArray(value)) {
    const kept =
      value.length <= wholeArrayMax ? value : value.slice(0, arrayItems);
    return kept.map((entry) => buildPreview(entry, arrayItems, wholeArrayMax));
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        buildPreview(entry, arrayItems, wholeArrayMax),
      ])
    );
  }

  return value;
}

/**
 * Build the largest preview that fits.
 *
 * Two passes. The first keeps short arrays whole and samples only the long
 * ones, stepping the sample down until it fits — this is what preserves the
 * column list. The second drops that protection, because a payload whose
 * arrays are *all* short but individually huge would otherwise get no preview
 * at all, which is worse than a clipped one.
 *
 * Trimming is still not a hard size bound — an object with a hundred thousand
 * keys survives every step intact — so a payload that fits at no setting
 * yields `{ preview: null, items: 0 }` and the pointer to the file stands alone.
 */
function buildBoundedPreview(
  payload: unknown,
  maxBytes: number
): { preview: unknown; items: number } {
  for (const wholeArrayMax of [PREVIEW_WHOLE_ARRAY_MAX, 0]) {
    for (const items of PREVIEW_ARRAY_STEPS) {
      const preview = buildPreview(payload, items, wholeArrayMax);
      const serialized = serialize(preview);
      if (
        serialized !== undefined &&
        Buffer.byteLength(serialized) <= maxBytes
      ) {
        return { preview, items };
      }
    }
  }

  return { preview: null, items: 0 };
}

/**
 * Delete this module's own older result files so the directory does not grow
 * without bound. Best-effort: a prune failure must never fail an invoke.
 */
async function pruneResultFiles(dir: string, now: number): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = (
    await Promise.all(
      entries
        .filter(
          (entry) => entry.isFile() && RESULT_FILE_PATTERN.test(entry.name)
        )
        .map(async (entry) => {
          const path = join(dir, entry.name);
          try {
            return { path, mtimeMs: (await stat(path)).mtimeMs };
          } catch {
            return undefined;
          }
        })
    )
  )
    .filter((file): file is { path: string; mtimeMs: number } => file != null)
    // Newest first, so the index doubles as "how many newer files exist".
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  await Promise.all(
    files
      .filter(
        (file, index) =>
          index >= MAX_RETAINED_FILES - 1 ||
          now - file.mtimeMs > MAX_RETAINED_AGE_MS
      )
      .map((file) => rm(file.path, { force: true }))
  );
}

/** Write `contents` to `path`, creating parents and keeping it owner-only. */
async function writeResultFile(
  path: string,
  contents: string,
  exclusive: boolean
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Results are customer data, so the file is never group- or world-readable.
  const handle = await open(path, exclusive ? 'wx' : 'w', 0o600);
  try {
    await handle.write(contents);
  } finally {
    await handle.close();
  }
}

export interface PrepareInvokeOutputOptions {
  /** The successful invoke payload. */
  payload: unknown;
  /** Connector name, used in the generated filename. */
  connector: string;
  /** Operation name, used in the generated filename. */
  operation: string;
  /** Threshold in bytes; `0` disables automatic spilling. */
  maxInlineBytes: number;
  /** Rayfin project root; spilled results go under its `rayfin/.temp`. */
  projectRoot: string;
  /** Explicit destination from `--output-file`, which always writes. */
  outputFile?: string;
  now?: () => Date;
}

/**
 * Decide whether an invoke payload is emitted inline or spilled to a file, and
 * write the file when it is.
 *
 * Throws only when an explicit `--output-file` cannot be written — the caller
 * asked for that path by name and silently ignoring it would be worse than
 * failing. An automatic spill that cannot be written degrades to a preview
 * with {@link InvokeOutputPlacement.spillError} set instead, because dumping
 * the full payload to the terminal is the exact harm this exists to prevent.
 */
export async function prepareInvokeOutput(
  options: PrepareInvokeOutputOptions
): Promise<InvokeOutputPlacement> {
  const { payload, maxInlineBytes, outputFile } = options;

  const serialized = serialize(payload);
  if (serialized === undefined) {
    return { output: payload };
  }

  const outputBytes = Buffer.byteLength(serialized);
  const truncated = maxInlineBytes > 0 && outputBytes > maxInlineBytes;

  if (!truncated && !outputFile) {
    return { output: payload };
  }

  // An explicit destination writes the payload whole, even when it would have
  // fit inline, and keeps the inline copy intact: the flag says where to put a
  // copy, not that the caller wants less on stdout.
  if (outputFile) {
    const path = resolve(outputFile);
    await writeResultFile(path, serialized, false);
    if (!truncated) {
      return { output: payload, outputFile: path, outputBytes };
    }

    const bounded = buildBoundedPreview(payload, maxInlineBytes);
    return {
      output: bounded.preview,
      outputFile: path,
      outputBytes,
      outputTruncated: true,
      previewItems: bounded.items,
    };
  }

  const now = options.now ?? (() => new Date());
  const dir = resultsDirFor(options.projectRoot);
  const filename = `${toFileTimestamp(now())}-${toSlug(
    `${options.connector}-${options.operation}`
  )}-${randomUUID().replace(/-/g, '').slice(0, 8)}.json`;
  const path = join(dir, filename);

  const preview = buildBoundedPreview(payload, maxInlineBytes);

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await pruneResultFiles(dir, now().getTime());
    } catch {
      // Retention is housekeeping; it must not block the current result.
    }
    await writeResultFile(path, serialized, true);
  } catch (error) {
    return {
      output: preview.preview,
      outputBytes,
      outputTruncated: true,
      previewItems: preview.items,
      spillError: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    output: preview.preview,
    outputFile: path,
    outputBytes,
    outputTruncated: true,
    previewItems: preview.items,
  };
}
