import { isDeepStrictEqual } from 'node:util';
import {
  collectiveParticipationStickerPrepareRequestSchema, findMessageSticker, messageStickerReference,
  type CollectiveMessageAttachment,
} from '../contracts/index.js';
import type { CollectiveMessageAttachmentOwnerPort } from '../contracts/message-attachment-owner.js';
import { CollectiveServiceError } from './errors.js';
import { requireMembership } from './identity-store.js';
import { denyAttachment } from './message-attachment-authority.js';
import { requireParticipationSource } from './participation-store.js';
import type { PersistentServiceState } from './persistence.js';
import type { ServiceState } from './state.js';

export interface CatalogueStickerUpload {
  serviceInstanceId: string; collectiveId: string; channelId: string; clientUploadId: string;
  fileName: string; mediaType: string; blobDigest: string; stickerId: string;
}

/** Exact public participation delegates only this immutable catalogue image, not arbitrary uploads or a Human session. */
export async function prepareParticipationSticker(persistence: PersistentServiceState,
  owner: CollectiveMessageAttachmentOwnerPort | undefined, token: string, unsafe: unknown, signal: AbortSignal,
  retain: (input: CatalogueStickerUpload, stream: AsyncIterable<Uint8Array>, actor: { humanId: string; revision: number },
    assertCurrent: (state: ServiceState) => void) => Promise<CollectiveMessageAttachment>) {
  const input = collectiveParticipationStickerPrepareRequestSchema.parse(unsafe);
  const initial = persistence.snapshot();
  const source = requireParticipationSource(initial, token, input);
  const humanId = initial.connections[input.connectionId]!.authorizedHumanId!;
  const actor = { humanId, revision: requireMembership(initial, input.collectiveId, humanId).revision };
  const entry = findMessageSticker(input.stickerId);
  if (!entry) throw new CollectiveServiceError('STICKER_CONTENT_MISMATCH', 'Unknown sticker catalogue image', 400);
  if (!owner?.catalogImage)
    throw new CollectiveServiceError('ATTACHMENT_OWNER_UNAVAILABLE', 'Original sticker images are unavailable on this Host', 503);
  const scope = { serviceInstanceId: input.serviceInstanceId, collectiveId: input.collectiveId, humanId,
    channelId: source.location.channelId };
  const assertCurrent = (state: ServiceState) => {
    signal.throwIfAborted();
    const fresh = requireParticipationSource(state, token, input);
    if (!isDeepStrictEqual(fresh, source) || state.connections[input.connectionId]?.authorizedHumanId !== humanId ||
      requireMembership(state, input.collectiveId, humanId).revision !== actor.revision) denyAttachment();
  };
  const reauthorize = async () => { assertCurrent(persistence.snapshot()); return scope; };
  await reauthorize();
  const result = await owner.catalogImage({ scope, stickerId: entry.id }, { reauthorize }, signal);
  try {
    await reauthorize();
    if (!isDeepStrictEqual(result.sticker, messageStickerReference(entry.id))) denyAttachment();
    return await retain({ serviceInstanceId: input.serviceInstanceId, collectiveId: input.collectiveId,
      channelId: source.location.channelId, clientUploadId: input.clientUploadId, fileName: entry.assetFile,
      mediaType: 'image/png', blobDigest: entry.blobDigest, stickerId: entry.id }, result.body, actor, assertCurrent);
  } finally { result.body.destroy(); }
}
