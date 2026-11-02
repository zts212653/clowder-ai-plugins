import { createHash } from 'node:crypto';
import { record, text } from './config.js';
import type { Attachment, ImageBytes } from './types.js';
import { pngWithoutMetadata } from './png.js';

export function attachments(value: unknown): Attachment[] {
  if (!Array.isArray(value) || value.length > 4) throw new Error('最多添加 4 张图片');
  let total = 0; let originals = 0;
  return value.map((item, index) => {
    const raw = record(item); const main = image(raw, index, true);
    total += Buffer.byteLength(main.base64, 'base64'); if (total > 8_000_000) throw new Error('发送图片总大小不能超过 8 MB');
    const original = raw.original ? image(record(raw.original), index, false) : undefined;
    if (original) { originals += Buffer.byteLength(original.base64, 'base64'); if (originals > 8_000_000) throw new Error('原图总大小不能超过 8 MB'); }
    return { ...main, ...(original ? { original } : {}) };
  });
}
function image(raw: Record<string, unknown>, index: number, normalize: boolean): ImageBytes {
  const base64 = text(raw.base64, 5_600_000); let bytes: Buffer = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > 4_000_000 || bytes.toString('base64') !== base64) throw new Error('图片格式或大小无效（单张上限 4 MB）');
  const mime = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
    : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : undefined;
  if (!mime || mime !== raw.mime) throw new Error('仅接受实际的 PNG、JPEG 或 WebP 图片');
  if (normalize) bytes = pngWithoutMetadata(bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { id: sha256, sha256, base64: bytes.toString('base64'), mime, name: `screenshot-${index + 1}.${mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]}` };
}
