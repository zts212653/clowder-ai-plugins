import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import type { z } from 'zod';
import {
  type CollectiveAttachmentScope,
  collectiveAttachmentScopeSchema,
  collectiveContextAttachmentSelectionSchema,
  collectiveMessageAttachmentSchema,
  collectiveStickerScopeSchema,
  parseMediaByteRange,
} from '../business/contracts/index.js';
import type { CollectiveMessageAttachmentOwnerPort } from '../business/contracts/message-attachment-owner.js';
import { authorizedAttachmentStream } from './authorized-stream.js';
import { attachmentDigest, AttachmentFileStore } from './file-store.js';
import { readCollectiveModelImage } from './message-model-image.js';
import { readCollectiveModelMedia } from './message-model-media.js';
import type { CollectiveAudioTranscriber } from './message-model-av.js';
import { openSticker, type StickerDirectories } from './sticker-catalog.js';

function contentRef(scope: CollectiveAttachmentScope) {
  return `collective-attachment:${createHash('sha256')
    .update(
      JSON.stringify([scope.serviceInstanceId, scope.collectiveId, scope.humanId, scope.channelId, scope.attachmentId]),
    )
    .digest('hex')}`;
}

export function attachmentAuthorization<T>(
  value: T,
  authority: { reauthorize(): Promise<T> },
  signal: AbortSignal,
  schema: z.ZodType<T>,
) {
  const scope = schema.parse(value);
  return async () => {
    signal.throwIfAborted();
    if (!isDeepStrictEqual(schema.parse(await authority.reauthorize()), scope))
      throw new Error('Attachment authority changed');
    signal.throwIfAborted();
  };
}

/** This adapter owns only new ordinary uploads. Existing shared Works continue through their original owner relay. */
export function createFileAttachmentOwner(
  dataDirectory: string,
  options: {
    stickerDirectories?: StickerDirectories;
    transcribeAudio?: CollectiveAudioTranscriber;
  } = {},
): CollectiveMessageAttachmentOwnerPort {
  const files = new AttachmentFileStore(dataDirectory);
  const port: CollectiveMessageAttachmentOwnerPort = {
    ...(options.stickerDirectories
      ? ({
          async catalogImage(input, authority, signal) {
            const authorize = attachmentAuthorization(input.scope, authority, signal, collectiveStickerScopeSchema);
            return openSticker(options.stickerDirectories!, input.stickerId, authorize, signal);
          },
        } satisfies Pick<CollectiveMessageAttachmentOwnerPort, 'catalogImage'>)
      : {}),
    async modelImage(input, authority, signal) {
      const readSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
      const authorize = attachmentAuthorization(input.scope, authority, readSignal, collectiveAttachmentScopeSchema);
      const opened = await port.open(input, authority, readSignal);
      return readCollectiveModelImage(opened.attachment, opened.body, authorize);
    },
    async modelContent(input, authority, signal) {
      const selection = collectiveContextAttachmentSelectionSchema.parse(input.selection);
      if (selection.attachmentId !== input.attachment.attachmentId)
        throw new Error('Attachment model selection mismatch');
      const readSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
      const authorize = attachmentAuthorization(input.scope, authority, readSignal, collectiveAttachmentScopeSchema);
      const opened = await port.open(input, authority, readSignal);
      if (input.attachment.mediaType.startsWith('image/'))
        return readCollectiveModelImage(opened.attachment, opened.body, authorize);
      return readCollectiveModelMedia(
        opened.attachment,
        opened.body,
        authorize,
        readSignal,
        selection,
        options.transcribeAudio,
      );
    },
    async retain(input, authority, signal) {
      const scope = collectiveAttachmentScopeSchema.parse(input.scope);
      const authorize = attachmentAuthorization(scope, authority, signal, collectiveAttachmentScopeSchema);
      await authorize();
      const bytes = Buffer.from(input.bytes);
      const metadata = collectiveMessageAttachmentSchema.parse({
        v: 1,
        attachmentId: scope.attachmentId,
        contentRef: contentRef(scope),
        ownerRevision: 1,
        ownerReceiptRef: 'pending',
        blobDigest: input.blobDigest,
        byteLength: bytes.length,
        mediaType: input.mediaType,
        fileName: input.fileName,
        ...(input.sticker ? { sticker: input.sticker } : {}),
      });
      if (
        metadata.sticker &&
        (metadata.sticker.blobDigest !== metadata.blobDigest || metadata.mediaType !== 'image/png')
      )
        throw new Error('Sticker identity does not match the original image');
      if (attachmentDigest(bytes) !== metadata.blobDigest) throw new Error('Attachment digest mismatch');
      const attachment = {
        ...metadata,
        ownerReceiptRef: `attachment-receipt:${createHash('sha256').update(JSON.stringify(metadata)).digest('hex')}`,
      };
      await files.retain({ scope, attachment }, bytes, authorize);
      return attachment;
    },
    async open(input, authority, signal) {
      const scope = collectiveAttachmentScopeSchema.parse(input.scope);
      const authorize = attachmentAuthorization(scope, authority, signal, collectiveAttachmentScopeSchema);
      await authorize();
      const attachment = collectiveMessageAttachmentSchema.parse(input.attachment);
      if (attachment.contentRef !== contentRef(scope) || attachment.attachmentId !== scope.attachmentId)
        throw new Error('Attachment scope mismatch');
      const file = await files.open({ scope, attachment });
      try {
        await authorize();
        const range = input.range === undefined ? undefined : parseMediaByteRange(input.range, attachment.byteLength);
        if (range === null) {
          await file.close();
          return { attachment, status: 416, body: Readable.from([]) };
        }
        const source = file.createReadStream({ start: 0, ...(range ?? {}), autoClose: true });
        return {
          attachment,
          status: range ? 206 : 200,
          ...(range ?? {}),
          body: authorizedAttachmentStream(source, authorize, signal),
        };
      } catch (error) {
        await file.close();
        throw error;
      }
    },
  };
  return port;
}
