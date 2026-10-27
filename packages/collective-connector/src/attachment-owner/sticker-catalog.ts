import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { findMessageSticker, messageStickerReference } from '../business/contracts/index.js';
import { authorizedAttachmentStream } from './authorized-stream.js';
import { attachmentDigest } from './file-store.js';

/** Provisioned approved artwork is data, separate from the public npm package and from shared Work originals. */
export type StickerDirectories = Readonly<Record<'memory' | 'collaboration', string>>;

export async function openSticker(
  directories: StickerDirectories,
  stickerId: string,
  authorize: () => Promise<void>,
  signal: AbortSignal,
) {
  const entry = findMessageSticker(stickerId);
  if (!entry) throw new Error('Unknown sticker catalogue image');
  await authorize();
  const file = await open(join(directories[entry.source], entry.assetFile), constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== entry.byteLength)
      throw new Error('Sticker catalogue bytes do not match their immutable revision');
    bytes = await file.readFile();
  } finally {
    await file.close();
  }
  if (attachmentDigest(bytes) !== entry.blobDigest)
    throw new Error('Sticker catalogue bytes do not match their immutable revision');
  await authorize();
  return {
    sticker: messageStickerReference(entry.id),
    body: authorizedAttachmentStream(Readable.from([bytes]), authorize, signal),
  };
}
