import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  collectiveStickerScopeSchema, findMessageSticker, messageStickerReference, messageStickerSchema,
} from '../contracts/index.js';
import type { CollectiveMessageAttachmentOwnerPort } from '../contracts/message-attachment-owner.js';
import { CollectiveServiceError } from './errors.js';
import { attachmentHuman, denyAttachment } from './message-attachment-authority.js';
import type { PersistentServiceState } from './persistence.js';

const catalogRequestSchema = collectiveStickerScopeSchema.omit({ humanId: true }).extend({
  stickerId: z.string().min(1).max(80),
}).strict();

/** A sticker is still an ordinary retained image. Its optional identity must name these exact original bytes. */
export function stickerForUpload(input: { stickerId?: string; blobDigest: string; mediaType: string }) {
  if (!input.stickerId) return undefined;
  const entry = findMessageSticker(input.stickerId);
  if (!entry || input.mediaType !== 'image/png' || input.blobDigest !== entry.blobDigest)
    throw new CollectiveServiceError('STICKER_CONTENT_MISMATCH', 'Sticker does not name its original catalogue image', 400);
  return messageStickerReference(entry.id);
}

export async function readMessageStickerCatalog(persistence: PersistentServiceState,
  owner: CollectiveMessageAttachmentOwnerPort | undefined, token: string, unsafe: unknown, signal: AbortSignal) {
  const input = catalogRequestSchema.parse(unsafe);
  const actor = attachmentHuman(persistence.snapshot(), token, input);
  const entry = findMessageSticker(input.stickerId);
  if (!entry) throw new CollectiveServiceError('STICKER_CONTENT_MISMATCH', 'Unknown sticker catalogue image', 400);
  if (!owner?.catalogImage)
    throw new CollectiveServiceError('ATTACHMENT_OWNER_UNAVAILABLE', 'The original sticker images are unavailable on this Host', 503);
  const { stickerId, ...coordinates } = input;
  const scope = { ...coordinates, humanId: actor.humanId };
  const reauthorize = async () => {
    signal.throwIfAborted();
    if (!isDeepStrictEqual(attachmentHuman(persistence.snapshot(), token, input), actor)) denyAttachment();
    return scope;
  };
  await reauthorize();
  const result = await owner.catalogImage({ scope, stickerId }, { reauthorize }, signal);
  try {
    await reauthorize();
    if (!isDeepStrictEqual(messageStickerSchema.parse(result.sticker), messageStickerReference(stickerId))) denyAttachment();
  } catch (error) { result.body.destroy(); throw error; }
  return { ...result, byteLength: entry.byteLength };
}
