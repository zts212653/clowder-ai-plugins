const signature = Buffer.from('89504e470d0a1a0a', 'hex');
/** Retain only pixel/transparency chunks; text, EXIF, profiles and trailing data cannot leave the device. */
export function pngWithoutMetadata(bytes: Buffer): Buffer {
  if (!bytes.subarray(0, 8).equals(signature)) throw new Error('发送副本必须先在本地重编码为 PNG');
  const chunks: Buffer[] = [signature]; let offset = 8; let header = false; let pixels = false; let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset); const end = offset + 12 + length;
    if (end > bytes.length) throw new Error('PNG 图片结构无效');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!header && type !== 'IHDR') throw new Error('PNG 缺少像素头');
    if (type === 'IHDR') {
      if (header || length !== 13) throw new Error('PNG 图片头无效');
      const width = bytes.readUInt32BE(offset + 8); const height = bytes.readUInt32BE(offset + 12);
      if (!width || !height || width * height > 16_000_000) throw new Error('图片尺寸超限，请先裁剪');
      header = true;
    }
    if (type === 'IDAT') pixels = true;
    if (['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(type)) chunks.push(bytes.subarray(offset, end));
    if (type === 'IEND') { if (length !== 0) throw new Error('PNG 结束块无效'); ended = true; break; }
    offset = end;
  }
  if (!header || !pixels || !ended) throw new Error('PNG 图片不完整');
  return Buffer.concat(chunks);
}
