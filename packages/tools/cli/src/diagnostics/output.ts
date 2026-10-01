import { StringDecoder } from 'node:string_decoder';

import type { Diagnostics } from '@microsoft/rayfin-tools-common/_internal/adapters';

export function createDiagnosticOutput(diagnostics: Diagnostics, area: string) {
  const decoder = new StringDecoder('utf8');
  const maxBytes = 1024 * 1024;
  let remaining = maxBytes;
  let pending = '';
  let discardLine = false;
  let ended = false;

  const emitLine = (): void => {
    if (discardLine || pending.trim()) {
      diagnostics.debug({
        area,
        message: discardLine ? '[Output line truncated]' : pending,
      });
    }
    pending = '';
    discardLine = false;
  };

  const consume = (text: string): void => {
    const lines = text.split('\n');
    for (const [index, fragment] of lines.entries()) {
      if (!discardLine) pending += fragment;
      if (Buffer.byteLength(pending) > 16 * 1024) {
        pending = '';
        discardLine = true;
      }
      if (index < lines.length - 1) {
        emitLine();
      }
    }
  };

  const write = (chunk: Buffer): void => {
    if (ended) return;
    const droppedBytes = chunk.byteLength > remaining;
    consume(decoder.write(chunk.subarray(0, remaining)));
    remaining -= Math.min(chunk.byteLength, remaining);
    if (droppedBytes) {
      ended = true;
      pending = '';
      discardLine = false;
      decoder.end();
      diagnostics.debug({
        area,
        message: '[Output capture truncated at 1 MiB]',
      });
    }
  };

  return {
    write,
    writeText(text: string): void {
      if (ended) return;
      const byteLength = Buffer.byteLength(text);
      if (byteLength > remaining) {
        write(Buffer.from(text));
        return;
      }
      consume(decoder.end());
      consume(text);
      remaining -= byteLength;
    },
    end(): void {
      if (ended) return;
      ended = true;
      consume(decoder.end());
      emitLine();
    },
  };
}
