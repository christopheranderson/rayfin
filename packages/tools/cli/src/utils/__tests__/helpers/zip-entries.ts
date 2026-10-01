import { inflateRawSync } from 'zlib';

/** Read the central directory and payloads of the small, non-ZIP64 test archives. */
export function readZipEntries(
  buffer: Buffer
): { name: string; content: Buffer }[] {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('Missing ZIP end record');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries: { name: string; content: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Invalid ZIP central directory entry');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const dataOffset =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    const compressed = buffer.subarray(dataOffset, dataOffset + size);
    if (method !== 0 && method !== 8) {
      throw new Error(`Unsupported ZIP compression method: ${method}`);
    }
    const content = method === 8 ? inflateRawSync(compressed) : compressed;
    if (content.length !== buffer.readUInt32LE(offset + 24)) {
      throw new Error(`Invalid uncompressed size for ${name}`);
    }
    entries.push({ name, content });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
