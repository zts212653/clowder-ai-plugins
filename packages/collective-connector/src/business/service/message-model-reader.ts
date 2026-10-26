import { isDeepStrictEqual } from 'node:util';
import {
  collectiveModelContentSchema,
  collectiveModelImageSchema,
  collectiveParticipationImageReadRequestSchema,
  collectiveParticipationMediaReadRequestSchema,
} from '../contracts/index.js';
import type { CollectiveMessageAttachmentOwnerPort } from '../contracts/message-attachment-owner.js';
import { CollectiveServiceError } from './errors.js';
import { denyAttachment } from './message-attachment-authority.js';
import { authorizeModelAttachmentRead } from './message-model-authority.js';
import type { PersistentServiceState } from './persistence.js';

/** Shared fresh-public-source fence and bounded decoder lane for images, files and audio/video. */
export class CollectiveMessageModelReads {
  private active = 0;
  constructor(
    private readonly persistence: PersistentServiceState,
    private readonly owner?: CollectiveMessageAttachmentOwnerPort,
  ) {}

  image(token: string, unsafe: unknown, signal: AbortSignal) {
    const input = collectiveParticipationImageReadRequestSchema.parse(unsafe);
    return this.read(token, input, input.image, signal, async (attachment, scope, reauthorize) => {
      if (!this.owner?.modelImage)
        throw new CollectiveServiceError('ATTACHMENT_OWNER_UNAVAILABLE', 'Image reader is unavailable', 503);
      return collectiveModelImageSchema.parse(
        await this.owner.modelImage({ scope, attachment }, { reauthorize }, signal),
      );
    });
  }
  media(token: string, unsafe: unknown, signal: AbortSignal) {
    const input = collectiveParticipationMediaReadRequestSchema.parse(unsafe);
    return this.read(token, input, input.attachment, signal, async (attachment, scope, reauthorize) => {
      if (!this.owner?.modelContent)
        throw new CollectiveServiceError(
          'ATTACHMENT_OWNER_UNAVAILABLE',
          'Update this content custodian to read original model media',
          503,
        );
      if (
        (input.attachment.startSeconds !== undefined || input.attachment.durationSeconds !== undefined) &&
        !/^(audio|video)\//u.test(attachment.mediaType)
      )
        throw new CollectiveServiceError(
          'ATTACHMENT_READ_RANGE_INVALID',
          'Time windows apply only to audio/video',
          400,
        );
      if (input.attachment.textOffset !== undefined && /^(audio|video|image)\//u.test(attachment.mediaType))
        throw new CollectiveServiceError('ATTACHMENT_READ_RANGE_INVALID', 'Text offsets apply only to text files', 400);
      const result = collectiveModelContentSchema.parse(
        await this.owner.modelContent({ scope, attachment, selection: input.attachment }, { reauthorize }, signal),
      );
      if (result.kind === 'collective_model_image' && !attachment.mediaType.startsWith('image/')) denyAttachment();
      if (
        result.kind === 'collective_model_media' &&
        (result.fileName !== attachment.fileName || result.mediaType !== attachment.mediaType)
      )
        denyAttachment();
      return result;
    });
  }

  private async read<T extends { attachmentId: string; sourceDigest: string }>(
    token: string,
    input: Parameters<typeof authorizeModelAttachmentRead>[2],
    selection: { eventId: string; attachmentId: string },
    signal: AbortSignal,
    consume: (
      attachment: NonNullable<ReturnType<typeof authorizeModelAttachmentRead>['record']['attachment']>,
      scope: ReturnType<typeof authorizeModelAttachmentRead>['record']['scope'],
      reauthorize: () => Promise<ReturnType<typeof authorizeModelAttachmentRead>['record']['scope']>,
    ) => Promise<T>,
  ) {
    const initial = authorizeModelAttachmentRead(this.persistence.snapshot(), token, input, selection);
    signal.throwIfAborted();
    if (this.active >= 2)
      throw new CollectiveServiceError('MODEL_CONTENT_BUSY', 'Two model media reads are already in progress', 429);
    this.active++;
    try {
      const reauthorize = async () => {
        signal.throwIfAborted();
        const fresh = authorizeModelAttachmentRead(this.persistence.snapshot(), token, input, selection);
        if (
          fresh.membershipRevision !== initial.membershipRevision ||
          !isDeepStrictEqual(fresh.record.attachment, initial.record.attachment)
        )
          denyAttachment();
        return fresh.record.scope;
      };
      await reauthorize();
      const attachment = initial.record.attachment!;
      const result = await consume(attachment, initial.record.scope, reauthorize);
      await reauthorize();
      if (result.attachmentId !== attachment.attachmentId || result.sourceDigest !== attachment.blobDigest)
        throw new CollectiveServiceError(
          'ATTACHMENT_OWNER_MISMATCH',
          'Model content does not name the requested original',
          502,
        );
      return result;
    } finally {
      this.active--;
    }
  }
}
