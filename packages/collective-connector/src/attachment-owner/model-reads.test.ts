import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { openCollectiveContextReferences } from '../collective-context-refs.js';
import { createCollectivePublicNativeActions } from '../collective-public-native-context.js';
import { collectiveNativeToolResult } from '../collective-native-tool-result.js';
import { publicSourceFixture } from '../business/connector/__tests__/public-source-caller.fixture.js';
import { createFileAttachmentOwner } from './file-owner.js';
import { attachmentDigest } from './file-store.js';

it('an authorized native image read uses the independent original bytes and is denied after endpoint revocation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collective-independent-model-'));
  const f = await publicSourceFixture({
    messageAttachmentOwner: createFileAttachmentOwner(directory),
    invocationId: 'fixture-running-turn',
  });
  try {
    const pixels = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#d46b35' } })
      .png()
      .toBuffer();
    const scope = { serviceInstanceId: f.connection.serviceInstanceId, collectiveId: f.connection.collectiveId };
    const attachment = await f.store.uploadMessageAttachment(
      f.serviceOwner.sessionToken,
      {
        ...scope,
        channelId: 'general',
        clientUploadId: 'independent-image',
        fileName: 'picture.png',
        mediaType: 'image/png',
        blobDigest: attachmentDigest(pixels),
      },
      Readable.from([pixels]),
      new AbortController().signal,
    );
    const event = await f.store.postHumanMessage(f.serviceOwner.sessionToken, {
      ...scope,
      clientEventId: 'published-image',
      location: { channelId: 'general' },
      recipient: { kind: 'channel' },
      body: '',
      attachments: [attachment],
    });
    await f.admit();
    const references = await openCollectiveContextReferences(join(f.root, 'refs'), () => {});
    const actions = createCollectivePublicNativeActions({
      connector: f.connector,
      references,
      sourceCaller: f.sourceCaller,
    });
    const { contextRef } = z
      .object({ contextRef: z.string() })
      .passthrough()
      .parse(await actions['collective.context.current']!({}, f.action));
    const read = () =>
      Promise.resolve(
        actions['collective.context.read']!(
          { contextRef, image: { eventId: event.eventId, attachmentId: attachment.attachmentId } },
          f.action,
        ),
      );
    const result = await read();
    expect(result).toMatchObject({
      sourceDigest: attachment.blobDigest,
      width: 8,
      height: 6,
      dataBase64: pixels.toString('base64'),
    });
    expect(collectiveNativeToolResult('collective.context.read', result).content[1]).toEqual({
      type: 'image',
      data: pixels.toString('base64'),
      mimeType: 'image/png',
    });
    await f.store.revokeConnection({
      sessionToken: f.serviceOwner.sessionToken,
      collectiveId: f.connection.collectiveId,
      connectionId: f.connection.connectionId,
    });
    await expect(read()).rejects.toMatchObject({ code: 'CONNECTION_REVOKED' });
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('bounds image derivatives, preserves original digests and uses the same UTF-8 continuation contract', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collective-independent-derivatives-'));
  const owner = createFileAttachmentOwner(directory);
  const scope = {
    serviceInstanceId: 'svc_original1',
    collectiveId: 'col_original1',
    humanId: 'human_original1',
    channelId: 'general',
    attachmentId: 'att_original1',
  };
  const auth = {
    async reauthorize() {
      return scope;
    },
  };
  const signal = new AbortController().signal;
  try {
    const bytes = await sharp({ create: { width: 2048, height: 1024, channels: 3, background: '#397589' } })
      .png()
      .toBuffer();
    const attachment = await owner.retain(
      { scope, bytes, blobDigest: attachmentDigest(bytes), fileName: 'wide.png', mediaType: 'image/png' },
      auth,
      signal,
    );
    const image = await owner.modelImage!({ scope, attachment }, auth, signal);
    expect(image).toMatchObject({
      sourceDigest: attachment.blobDigest,
      originalWidth: 2048,
      originalHeight: 1024,
      transformed: true,
      width: 1536,
      height: 768,
    });
    expect(Buffer.from(image.dataBase64, 'base64').length).toBeLessThanOrEqual(512 * 1024);
    const textScope = { ...scope, attachmentId: 'att_textfile1' };
    const textAuth = {
      async reauthorize() {
        return textScope;
      },
    };
    const text = 'x'.repeat(63_999) + '🐾原文';
    const file = await owner.retain(
      {
        scope: textScope,
        bytes: Buffer.from(text),
        blobDigest: attachmentDigest(Buffer.from(text)),
        fileName: 'notes.md',
        mediaType: 'text/markdown',
      },
      textAuth,
      signal,
    );
    const read = (textOffset?: number) =>
      owner.modelContent!(
        {
          scope: textScope,
          attachment: file,
          selection: {
            eventId: 'published-source',
            attachmentId: file.attachmentId,
            ...(textOffset === undefined ? {} : { textOffset }),
          },
        },
        textAuth,
        signal,
      );
    const first = await read();
    expect(first).toMatchObject({
      sourceDigest: file.blobDigest,
      content: { type: 'text', nextOffset: 63_999, truncated: true },
    });
    expect(await read(63_999)).toMatchObject({ content: { text: '🐾原文', totalCharacters: text.length } });
    await expect(read(64_000)).rejects.toThrow('nextOffset');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
