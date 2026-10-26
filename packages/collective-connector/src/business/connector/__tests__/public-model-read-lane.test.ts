import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import type { CollectiveMessageAttachmentOwnerPort } from '../../contracts/message-attachment-owner.js';
import { fixture } from './communication-work-custody.fixture.js';

it('bounds the shared model-read lane, releases it after errors and rejects a response for another original', async () => {
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: () => void = () => {};
  const twoEntered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let entered = 0,
    wrongOriginal = false;
  const owner: CollectiveMessageAttachmentOwnerPort = {
    async retain(input, auth) {
      await auth.reauthorize();
      return {
        v: 1,
        attachmentId: input.scope.attachmentId,
        contentRef: `collective-attachment:${input.scope.attachmentId}`,
        ownerRevision: 1,
        ownerReceiptRef: 'explicit-model-lane-fixture',
        fileName: input.fileName,
        mediaType: input.mediaType,
        byteLength: input.bytes.length,
        blobDigest: input.blobDigest,
      };
    },
    async open() {
      throw new Error('Unused owner transport');
    },
    async modelContent(input, auth) {
      await auth.reauthorize();
      entered++;
      if (entered === 2) ready();
      await blocked;
      await auth.reauthorize();
      return {
        kind: 'collective_model_media',
        v: 1,
        attachmentId: input.attachment.attachmentId,
        sourceDigest: wrongOriginal ? `sha256:${'a'.repeat(64)}` : input.attachment.blobDigest,
        fileName: input.attachment.fileName,
        mediaType: input.attachment.mediaType,
        content: {
          type: 'text',
          text: 'x',
          encoding: 'utf-8',
          offset: 0,
          totalCharacters: 1,
          truncated: false,
        },
      };
    },
  };
  const f = await fixture({ messageAttachmentOwner: owner });
  try {
    const coordinates = {
      serviceInstanceId: f.connection.serviceInstanceId,
      collectiveId: f.connection.collectiveId,
    };
    const bytes = Buffer.from('x');
    const attachment = await f.store.uploadMessageAttachment(
      f.owner.sessionToken,
      {
        ...coordinates,
        channelId: 'general',
        clientUploadId: 'model-read-lane',
        fileName: 'original.txt',
        mediaType: 'text/plain',
        blobDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      },
      Readable.from([bytes]),
      new AbortController().signal,
    );
    const event = await f.store.postHumanMessage(f.owner.sessionToken, {
      ...coordinates,
      clientEventId: 'model-lane-source',
      body: '',
      attachments: [attachment],
      location: { channelId: 'general' },
      recipient: { kind: 'channel' },
    });
    const read = () =>
      f.connector.readParticipationMedia(f.source, {
        eventId: event.eventId,
        attachmentId: attachment.attachmentId,
      });
    const first = read(),
      second = read();
    await twoEntered;
    await expect(read()).rejects.toMatchObject({
      code: 'MODEL_CONTENT_BUSY',
      statusCode: 429,
    });
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    wrongOriginal = true;
    await expect(read()).rejects.toMatchObject({
      code: 'ATTACHMENT_OWNER_MISMATCH',
    });
    wrongOriginal = false;
    await expect(read()).resolves.toMatchObject({
      content: { type: 'text', text: 'x' },
    });
  } finally {
    release();
    await f.close();
  }
});
