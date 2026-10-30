import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type); const bytes = Buffer.concat([name, data]); let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, bytes, checksum]);
}
export function pngFixture(size = 16, metadata = ''): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const rows = randomBytes(size * (size * 4 + 1)); for (let i = 0; i < size; i++) rows[i * (size * 4 + 1)] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    ...(metadata ? [chunk('tEXt', Buffer.from(`Comment\0${metadata}`))] : []), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
