import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { openCollectiveContextReferences } from '../../../collective-context-refs.js';
import { createCollectivePublicNativeActions } from '../../../collective-public-native-context.js';
import { collectiveNativeToolResult } from '../../../collective-native-tool-result.js';
import type { CollectiveMessageAttachmentOwnerPort } from '../../contracts/message-attachment-owner.js';
import { publicSourceFixture } from './public-source-caller.fixture.js';

// Explicit rendering adapter fixture. Core separately exercises real decoding and original byte custody.
const pixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
async function setup(options: { imageAsSource?: boolean } = {}) {
  const owner: CollectiveMessageAttachmentOwnerPort = {
    async retain(input, auth) {
      await auth.reauthorize();
      return { v: 1, attachmentId: input.scope.attachmentId,
        contentRef: `collective-attachment:${input.scope.attachmentId}`, ownerRevision: 1,
        ownerReceiptRef: 'fixture-owner-receipt', blobDigest: input.blobDigest, byteLength: input.bytes.length,
        mediaType: input.mediaType, fileName: input.fileName };
    },
    async open(input, auth) { await auth.reauthorize(); return { status: 200, attachment: input.attachment, body: Readable.from([pixels]) }; },
    async modelImage(input, auth) {
      await auth.reauthorize();
      return { kind: 'collective_model_image', v: 1, attachmentId: input.attachment.attachmentId,
        sourceDigest: input.attachment.blobDigest, dataBase64: pixels.toString('base64'), mediaType: 'image/png',
        width: 1, height: 1, originalWidth: 1, originalHeight: 1, transformed: false };
    },
  };
  const f = await publicSourceFixture({ messageAttachmentOwner: owner,
    invocationId: 'fixture-running-turn' });
  try {
    const refs = await openCollectiveContextReferences(join(f.root, 'native-refs'), () => {});
    const actions = createCollectivePublicNativeActions({ connector: f.connector, references: refs, sourceCaller: f.sourceCaller });
    const scope = { serviceInstanceId: f.connection.serviceInstanceId, collectiveId: f.connection.collectiveId };
    const stage = (channelId = 'general') => f.store.uploadMessageAttachment(f.serviceOwner.sessionToken, { ...scope,
      channelId, clientUploadId: `native-image-${channelId}`, fileName: 'pixel.png', mediaType: 'image/png',
      blobDigest: `sha256:${createHash('sha256').update(pixels).digest('hex')}` }, Readable.from([pixels]), new AbortController().signal);
    const attachment = await stage();
    let sourceImageEvent;
    if (options.imageAsSource) {
      sourceImageEvent = await f.store.postHumanMessage(f.serviceOwner.sessionToken, { ...scope,
        clientEventId: 'only-picture-source', location: { channelId: 'general' },
        recipient: { kind: 'agent', humanId: f.serviceOwner.human.humanId, connectionId: f.source.connectionId,
          agentId: f.source.catId, participationRevision: f.source.participationRevision }, body: '', attachments: [attachment] });
      await f.connector.sync(f.connection.connectionId);
      await f.sourceCaller.admitAgentEvent(f.connection.connectionId, sourceImageEvent.eventId, f.owner);
    } else await f.admit();
    const current = z.object({ contextRef: z.string() }).passthrough().parse(await actions['collective.context.current']!({}, f.action));
    const read = (eventId: string, attachmentId = attachment.attachmentId, contextRef = current.contextRef) =>
      Promise.resolve(actions['collective.context.read']!({ contextRef, image: { eventId, attachmentId } }, f.action));
    const publish = (channelId = 'general') => f.store.postHumanMessage(f.serviceOwner.sessionToken,
      { ...scope, clientEventId: `image-${channelId}`, location: { channelId }, recipient: { kind: 'channel' }, body: '', attachments: [attachment] });
    return { ...f, owner, actions, scope, current, attachment, read, publish, stage, sourceImageEvent };
  } catch (error) { await f.close(); throw error; }
}

it('returns actual native image data from a published event through fresh endpoint participation', async () => {
  const f = await setup();
  try {
    const event = await f.publish();
    const result = await f.read(event.eventId);
    expect(result).toMatchObject({ kind: 'collective_model_image', attachmentId: f.attachment.attachmentId,
      sourceDigest: f.attachment.blobDigest, dataBase64: pixels.toString('base64'), mediaType: 'image/png' });
    const native = collectiveNativeToolResult('collective.context.read', result);
    expect(native.content[1]).toEqual({ type: 'image', data: pixels.toString('base64'), mimeType: 'image/png' });
    expect(native.content[0]).toMatchObject({ type: 'text' });
    expect(JSON.stringify(native.content[0])).not.toContain(pixels.toString('base64'));
  } finally { await f.close(); }
});

it('admits a picture-only source with readable attachment instructions and retains its exact native identity', async () => {
  const f = await setup({ imageAsSource: true });
  try {
    expect(f.sourceImageEvent).toBeDefined();
    const source = f.sourceImageEvent;
    if (!source) throw new Error('Expected picture-only source');
    expect(f.native.source.content).toContain(source.eventId);
    expect(f.native.source.content).toContain(f.attachment.attachmentId);
    expect(f.native.source.content).toContain('cat_cafe_collective_read_context');
    expect(f.native.source.content).not.toContain(pixels.toString('base64'));
    expect(await f.read(source.eventId)).toMatchObject({ kind: 'collective_model_image', sourceDigest: f.attachment.blobDigest });
  } finally { await f.close(); }
});

it('rejects private staging, another event, bad context refs and revoked endpoint participation', async () => {
  const f = await setup();
  try {
    await expect(f.read(f.source.eventId)).rejects.toMatchObject({ code: 'ATTACHMENT_ACCESS_DENIED' });
    const event = await f.publish();
    await expect(f.read(event.eventId, 'att_otherimage01')).rejects.toMatchObject({ code: 'ATTACHMENT_ACCESS_DENIED' });
    await expect(f.read(event.eventId, f.attachment.attachmentId, 'wrong')).rejects.toMatchObject({ code: 'RETURN_REF_INVALID' });
    await expect(f.store.readParticipationImage(f.serviceOwner.sessionToken, {
      ...f.scope, connectionId: f.source.connectionId, eventId: f.source.eventId, catId: f.source.catId,
      participationRevision: f.source.participationRevision,
      image: { eventId: event.eventId, attachmentId: f.attachment.attachmentId },
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
    await f.store.revokeConnection({ sessionToken: f.serviceOwner.sessionToken,
      collectiveId: f.connection.collectiveId, connectionId: f.connection.connectionId });
    await expect(f.read(event.eventId)).rejects.toMatchObject({ code: 'CONNECTION_REVOKED' });
  } finally { await f.close(); }
});

it('does not let a current Channel context read a published image in another Channel', async () => {
  const f = await setup();
  try {
    await f.store.createChannel(f.serviceOwner.sessionToken, {
      collectiveId: f.scope.collectiveId,
      name: 'other',
      clientOperationId: 'native-image-other-channel',
    });
    const other = await f.stage('other');
    const event = await f.store.postHumanMessage(f.serviceOwner.sessionToken, { ...f.scope,
      clientEventId: 'other-image', location: { channelId: 'other' }, recipient: { kind: 'channel' }, body: '', attachments: [other] });
    await expect(f.read(event.eventId, other.attachmentId)).rejects.toMatchObject({ code: 'ATTACHMENT_ACCESS_DENIED' });
  } finally { await f.close(); }
});

it('withholds a completed image response when participation is revoked during owner rendering', async () => {
  const f = await setup();
  try {
    const event = await f.publish();
    const render = f.owner.modelImage;
    if (!render) throw new Error('Expected fixture renderer');
    f.owner.modelImage = async (...args) => {
      const image = await render(...args);
      await f.store.revokeConnection({ sessionToken: f.serviceOwner.sessionToken,
        collectiveId: f.connection.collectiveId, connectionId: f.connection.connectionId });
      return image;
    };
    await expect(f.read(event.eventId)).rejects.toMatchObject({ code: 'CONNECTION_REVOKED' });
  } finally { await f.close(); }
});

it('does not reinterpret arbitrary module actions or malformed objects as MCP image content', () => {
  const arbitrary = { kind: 'collective_model_image', v: 1, dataBase64: pixels.toString('base64') };
  expect(collectiveNativeToolResult('collective.reply.submit', arbitrary).content).toEqual([
    { type: 'text', text: JSON.stringify(arbitrary) },
  ]);
  expect(() => collectiveNativeToolResult('collective.context.read', arbitrary)).toThrow();
});
