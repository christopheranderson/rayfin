import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_INLINE_BYTES,
  PREVIEW_ARRAY_ITEMS,
  prepareInvokeOutput,
} from '../invoke-result-file.js';

let workDir: string;

function resultsDir(): string {
  return join(workDir, 'rayfin', '.temp', 'invoke-results');
}

/** A payload whose serialized form comfortably exceeds any small threshold. */
function largePayload(rows = 100) {
  return {
    status: 'success',
    table: {
      columns: Array.from({ length: 24 }, (_, index) => ({
        name: `col${index}`,
        dataType: 'String',
      })),
      rows: Array.from({ length: rows }, (_, index) => [
        index,
        'x'.repeat(200),
      ]),
    },
  };
}

function invoke(overrides: Partial<Parameters<typeof prepareInvokeOutput>[0]>) {
  return prepareInvokeOutput({
    payload: { ok: true },
    connector: 'salesmodel',
    operation: 'executeQuery',
    maxInlineBytes: DEFAULT_MAX_INLINE_BYTES,
    projectRoot: workDir,
    ...overrides,
  });
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'rayfin-invoke-result-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('prepareInvokeOutput', () => {
  it('returns the payload untouched when it fits inline', async () => {
    const payload = largePayload(2);

    const placement = await invoke({ payload });

    expect(placement.output).toBe(payload);
    expect(placement.outputFile).toBeUndefined();
    expect(placement.outputTruncated).toBeUndefined();
    await expect(readdir(resultsDir())).rejects.toThrow();
  });

  it('writes the full payload to a file and previews it inline when oversized', async () => {
    const payload = largePayload();

    const placement = await invoke({ payload, maxInlineBytes: 8_000 });

    expect(placement.outputTruncated).toBe(true);
    expect(placement.outputFile).toBeDefined();
    expect(placement.outputBytes).toBe(
      Buffer.byteLength(JSON.stringify(payload))
    );

    // The file holds everything; only the inline copy is reduced.
    const written = JSON.parse(readFileSync(placement.outputFile!, 'utf8'));
    expect(written).toEqual(payload);

    const preview = placement.output as typeof payload;
    expect(preview.table.rows).toHaveLength(PREVIEW_ARRAY_ITEMS);
    expect(preview.table.rows[0]).toEqual(payload.table.rows[0]);
    expect(placement.previewItems).toBe(PREVIEW_ARRAY_ITEMS);
  });

  it('shrinks the preview instead of dropping it when the threshold is tight', async () => {
    const payload = largePayload();

    // Too small for a 20-row slice of 200-char rows, but not for a few.
    const placement = await invoke({ payload, maxInlineBytes: 1_500 });

    const preview = placement.output as typeof payload;
    expect(preview).not.toBeNull();
    expect(preview.table.rows.length).toBeGreaterThan(0);
    expect(preview.table.rows.length).toBeLessThan(PREVIEW_ARRAY_ITEMS);
    expect(placement.previewItems).toBe(preview.table.rows.length);

    // Whatever it kept, the inline copy respects the budget it was given.
    expect(
      Buffer.byteLength(JSON.stringify(placement.output))
    ).toBeLessThanOrEqual(1_500);

    // Column names survive, which is the whole point of keeping a preview.
    expect(preview.table.columns[0]?.name).toBe('col0');
  });

  it('keeps short arrays whole so a column list is never reported as partial', async () => {
    const payload = largePayload();

    const placement = await invoke({ payload, maxInlineBytes: 8_000 });

    const preview = placement.output as typeof payload;
    // Sampling the column list would hand back a confident wrong schema.
    expect(preview.table.columns).toHaveLength(payload.table.columns.length);
    // The row set is bulk data, so it is still sampled.
    expect(preview.table.rows.length).toBeLessThan(payload.table.rows.length);
  });

  it('samples every array when the floor makes no preview possible', async () => {
    // All arrays are short enough to be kept whole, but the values are large,
    // so honouring the floor would yield no preview at all.
    const payload = {
      rows: Array.from({ length: 30 }, () => 'y'.repeat(1_000)),
    };

    const placement = await invoke({ payload, maxInlineBytes: 8_000 });

    const preview = placement.output as typeof payload;
    expect(preview).not.toBeNull();
    expect(preview.rows.length).toBeLessThan(payload.rows.length);
  });

  it('names the file after the connector and operation', async () => {
    const placement = await invoke({
      payload: largePayload(),
      maxInlineBytes: 1_000,
      connector: 'Daily Semantic',
      operation: 'executeQuery',
    });

    expect(placement.outputFile).toMatch(/daily-semantic-executequery/);
    expect(placement.outputFile?.endsWith('.json')).toBe(true);
  });

  it('writes into the project scratch directory, not the user home', async () => {
    const placement = await invoke({
      payload: largePayload(),
      maxInlineBytes: 1_000,
    });

    // rayfin/.temp is already gitignored, so customer data cannot be committed.
    expect(placement.outputFile).toBe(
      join(resultsDir(), placement.outputFile!.split(/[\\/]/).pop()!)
    );
  });

  it('never spills when the threshold is disabled with 0', async () => {
    const payload = largePayload();

    const placement = await invoke({ payload, maxInlineBytes: 0 });

    expect(placement.output).toBe(payload);
    expect(placement.outputFile).toBeUndefined();
  });

  it('truncates long strings in the preview', async () => {
    const payload = { note: 'y'.repeat(50_000) };

    const placement = await invoke({ payload, maxInlineBytes: 8_000 });

    const preview = placement.output as { note: string };
    expect(preview.note).toMatch(/\[truncated\]$/);
    expect(preview.note.length).toBeLessThan(payload.note.length);
  });

  it('drops the preview entirely when no array cap can make it fit', async () => {
    // Trimming bounds arrays and strings, not key count, so an object this wide
    // survives every step intact and has to fall back to the pointer alone.
    const payload = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, index) => [`key-${index}`, index])
    );

    const placement = await invoke({ payload, maxInlineBytes: 8_000 });

    expect(placement.output).toBeNull();
    expect(placement.previewItems).toBe(0);
    expect(placement.outputFile).toBeDefined();
  });

  it('writes an explicit --output-file even when the payload fits inline', async () => {
    const payload = largePayload(2);
    const outputFile = join(workDir, 'nested', 'result.json');

    const placement = await invoke({ payload, outputFile });

    // The flag says where to put a copy, not that the caller wants less inline.
    expect(placement.output).toBe(payload);
    expect(placement.outputTruncated).toBeUndefined();
    expect(JSON.parse(readFileSync(outputFile, 'utf8'))).toEqual(payload);
  });

  it('overwrites an existing --output-file so the path stays deterministic', async () => {
    const outputFile = join(workDir, 'result.json');
    writeFileSync(outputFile, 'stale');

    await invoke({ payload: { fresh: true }, outputFile });

    expect(JSON.parse(readFileSync(outputFile, 'utf8'))).toEqual({
      fresh: true,
    });
  });

  it('throws when an explicit --output-file cannot be written', async () => {
    // A file where the parent directory has to go: mkdir fails on every OS.
    const blocker = join(workDir, 'blocker');
    writeFileSync(blocker, '');

    await expect(
      invoke({ payload: { a: 1 }, outputFile: join(blocker, 'result.json') })
    ).rejects.toThrow();
  });

  it('degrades to a preview when an automatic spill cannot be written', async () => {
    // Dumping the full payload to the terminal is the harm this prevents, so a
    // write failure must still shrink the inline copy rather than give up.
    mkdirSync(join(workDir, 'rayfin', '.temp'), { recursive: true });
    writeFileSync(resultsDir(), '');

    const placement = await invoke({
      payload: largePayload(),
      maxInlineBytes: 8_000,
    });

    expect(placement.outputTruncated).toBe(true);
    expect(placement.outputFile).toBeUndefined();
    expect(placement.spillError).toBeTruthy();
    expect(
      (placement.output as ReturnType<typeof largePayload>).table.rows
    ).toHaveLength(PREVIEW_ARRAY_ITEMS);
  });

  it('prunes results older than the retention window', async () => {
    const first = await invoke({
      payload: largePayload(),
      maxInlineBytes: 1_000,
    });

    const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
    await utimes(first.outputFile!, ancient, ancient);

    await invoke({ payload: largePayload(), maxInlineBytes: 1_000 });

    const remaining = await readdir(resultsDir());
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).not.toBe(first.outputFile!.split(/[\\/]/).pop());
  });

  it('leaves unrecognized files in the results directory alone', async () => {
    await invoke({ payload: largePayload(), maxInlineBytes: 1_000 });
    const keeper = join(resultsDir(), 'my-saved-result.json');
    writeFileSync(keeper, '{}');
    const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
    await utimes(keeper, ancient, ancient);

    await invoke({ payload: largePayload(), maxInlineBytes: 1_000 });

    expect(readFileSync(keeper, 'utf8')).toBe('{}');
  });
});
