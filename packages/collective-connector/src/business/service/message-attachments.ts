import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CollectiveMessageAttachmentOwnerPort } from '../contracts/message-attachment-owner.js';
import { z } from 'zod';
import { collectiveAttachmentScopeSchema, collectiveMessageAttachmentSchema } from '../contracts/index.js';
import { CollectiveServiceError } from './errors.js';
import { attachmentHuman, authorizeAttachmentRead, denyAttachment } from './message-attachment-authority.js';
import type { PersistentServiceState } from './persistence.js';

const uploadSchema = collectiveAttachmentScopeSchema.omit({ humanId: true, attachmentId: true }).extend({
  clientUploadId: z.string().trim().min(1).max(200),
  fileName: collectiveMessageAttachmentSchema.shape.fileName,
  mediaType: collectiveMessageAttachmentSchema.shape.mediaType,
  blobDigest: collectiveMessageAttachmentSchema.shape.blobDigest,
}).strict();
const readSchema = collectiveAttachmentScopeSchema.omit({ humanId: true, channelId: true }).extend({
  sourceEventId: z.string().min(1).max(160).optional(), range: z.string().max(256).optional(),
}).strict();

/** Service holds only intent, ownership and publication references. Original content owner retains all bytes. */
export class CollectiveMessageAttachments {
  private uploads = 0;
  constructor(private readonly persistence: PersistentServiceState, private readonly now: () => number,
    private readonly owner?: CollectiveMessageAttachmentOwnerPort) {}

  async upload(token: string, unsafe: unknown, stream: AsyncIterable<Uint8Array>, signal: AbortSignal) {
    const input = uploadSchema.parse(unsafe);
    const actor = attachmentHuman(this.persistence.snapshot(), token, input);
    const owner = this.requireOwner();
    if (this.uploads >= 2) throw new CollectiveServiceError('ATTACHMENT_BUSY', 'Two uploads are already in progress', 429);
    this.uploads++;
    try {
      let byteLength = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        signal.throwIfAborted();
        byteLength += chunk.byteLength;
        if (byteLength > 50 * 1024 * 1024) throw new CollectiveServiceError('ATTACHMENT_TOO_LARGE', 'File exceeds 50 MiB', 413);
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      if (!bytes.length || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== input.blobDigest)
        throw new CollectiveServiceError('ATTACHMENT_DIGEST_MISMATCH', 'Upload bytes do not match their digest', 400);
      const attachmentId = `att_${createHash('sha256').update(JSON.stringify([input.serviceInstanceId,
        input.collectiveId, actor.humanId, actor.revision, input.clientUploadId])).digest('hex')}`;
      const scope = { serviceInstanceId: input.serviceInstanceId, collectiveId: input.collectiveId,
        humanId: actor.humanId, channelId: input.channelId, attachmentId };
      const expected = { scope, clientUploadId: input.clientUploadId, membershipRevision: actor.revision,
        fileName: input.fileName, mediaType: input.mediaType, blobDigest: input.blobDigest, byteLength };
      const authorize = async () => {
        signal.throwIfAborted();
        if (!isDeepStrictEqual(attachmentHuman(this.persistence.snapshot(), token, input), actor)) denyAttachment();
        return scope;
      };
      await authorize();
      await this.persistence.transaction(state => {
        if (!isDeepStrictEqual(attachmentHuman(state, token, input), actor)) denyAttachment();
        const existing = state.messageAttachments[attachmentId];
        if (existing) {
          const { attachment: _attachment, publishedEventIds: _events, createdAt: _at, ...prior } = existing;
          if (!isDeepStrictEqual(prior, expected))
            throw new CollectiveServiceError('ATTACHMENT_UPLOAD_CONFLICT', 'Upload identity already names different content', 409);
        } else state.messageAttachments[attachmentId] = {
          ...expected, publishedEventIds: [], createdAt: new Date(this.now()).toISOString(),
        };
      });
      const attachment = collectiveMessageAttachmentSchema.parse(await owner.retain({ scope, fileName: input.fileName,
        mediaType: input.mediaType, blobDigest: input.blobDigest, bytes }, { reauthorize: authorize }, signal));
      if (attachment.attachmentId !== attachmentId || attachment.blobDigest !== input.blobDigest ||
          attachment.byteLength !== byteLength || attachment.fileName !== input.fileName || attachment.mediaType !== input.mediaType)
        throw new CollectiveServiceError('ATTACHMENT_OWNER_MISMATCH', 'Owner receipt does not match this upload', 502);
      return this.persistence.transaction(state => {
        if (!isDeepStrictEqual(attachmentHuman(state, token, input), actor)) denyAttachment();
        const record = state.messageAttachments[attachmentId];
        if (!record || (record.attachment && !isDeepStrictEqual(record.attachment, attachment))) denyAttachment();
        record.attachment = attachment;
        return attachment;
      });
    } finally { this.uploads--; }
  }

  async open(token: string, unsafe: unknown, signal: AbortSignal) {
    const input = readSchema.parse(unsafe);
    const initial = authorizeAttachmentRead(this.persistence.snapshot(), token, input);
    const authorize = async () => {
      signal.throwIfAborted();
      const fresh = authorizeAttachmentRead(this.persistence.snapshot(), token, input);
      if (!isDeepStrictEqual(initial.actor, fresh.actor) || !isDeepStrictEqual(initial.record.attachment, fresh.record.attachment)) denyAttachment();
      return fresh.record.scope;
    };
    const attachment = initial.record.attachment!;
    const result = await this.requireOwner().open({ scope: initial.record.scope, attachment,
      ...(input.range ? { range: input.range } : {}) }, { reauthorize: authorize }, signal);
    try { await authorize(); if (!isDeepStrictEqual(result.attachment, attachment)) denyAttachment(); }
    catch (error) { result.body.destroy(); throw error; }
    return result;
  }
  private requireOwner() {
    if (!this.owner) throw new CollectiveServiceError('ATTACHMENT_OWNER_UNAVAILABLE', 'Content custodian is unavailable', 503);
    return this.owner;
  }
}
